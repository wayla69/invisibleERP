import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { timeClock, employees, custPosSales, geofenceZones } from '../../../database/schema';
import { n, ymd } from '../../../database/queries';
import type { JwtUser } from '../../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
// Anti-buddy-punch: reject a re-punch within this window of the employee's last clock-out (a colleague
// clocking someone back in immediately). Supervisor override bypasses it.
const DUP_PUNCH_WINDOW_MIN = 15;
const CLOCK_METHODS = ['PIN', 'QR', 'FACE_HASH', 'SUPERVISOR'];
// Haversine distance in metres between two lat/lng points.
function distM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// P2c — labor time & attendance: clock in/out, hours, and sales-per-labor-hour productivity.
@Injectable()
export class TimeClockService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async emp(empCode: string) {
    const db = this.db;
    const [e] = await db.select().from(employees).where(eq(employees.empCode, empCode)).limit(1);
    if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: `Employee ${empCode} not found`, messageTh: 'ไม่พบพนักงาน' });
    return e;
  }

  async clockIn(empCode: string, user: JwtUser, opts?: { method?: string; lat?: number; lng?: number; branch_id?: number }) {
    const db = this.db;
    const e = await this.emp(empCode);
    const method = opts?.method && CLOCK_METHODS.includes(opts.method) ? opts.method : 'PIN';
    const [open] = await db.select().from(timeClock).where(and(eq(timeClock.employeeId, e.id), eq(timeClock.status, 'Open'))).limit(1);
    if (open) throw new BadRequestException({ code: 'ALREADY_IN', message: 'Already clocked in', messageTh: 'ลงเวลาเข้าไว้แล้ว' });
    // Anti-buddy-punch: block a re-punch within DUP_PUNCH_WINDOW_MIN of the last clock-out (unless a
    // supervisor is forcing it). A genuine same-day re-clock after a real break is fine once the window passes.
    if (method !== 'SUPERVISOR') {
      const [last] = await db.select().from(timeClock).where(and(eq(timeClock.employeeId, e.id), eq(timeClock.status, 'Closed'))).orderBy(desc(timeClock.id)).limit(1);
      if (last?.clockOut) {
        const minsSince = (Date.now() - new Date(last.clockOut).getTime()) / 60000;
        if (minsSince >= 0 && minsSince < DUP_PUNCH_WINDOW_MIN) {
          throw new BadRequestException({ code: 'DUPLICATE_PUNCH', message: `Re-punch within ${DUP_PUNCH_WINDOW_MIN} min of clock-out is blocked`, messageTh: 'ลงเวลาซ้ำเร็วเกินไปหลังออกงาน' });
        }
      }
    }
    // Geofence: if a zone is configured for the branch and GPS is supplied, compute pass/fail. No zone or no
    // GPS → geofence_pass null (accept + flag for review; kiosks may lack GPS — E13). An out-of-fence punch
    // is accepted but flagged so a supervisor can review (not hard-rejected, to avoid blocking real shifts).
    let geofencePass: boolean | null = null;
    if (opts?.lat != null && opts?.lng != null) {
      const [zone] = await db.select().from(geofenceZones)
        .where(and(eq(geofenceZones.tenantId, user.tenantId as number), opts.branch_id != null ? eq(geofenceZones.branchId, opts.branch_id) : isNull(geofenceZones.branchId))).limit(1);
      if (zone) geofencePass = distM(n(opts.lat), n(opts.lng), n(zone.lat), n(zone.lng)) <= Number(zone.radiusM);
    }
    const [r] = await db.insert(timeClock).values({
      tenantId: user.tenantId ?? null, employeeId: e.id, empCode, clockIn: new Date(), status: 'Open',
      clockInMethod: method, clockInLat: opts?.lat != null ? String(opts.lat) : null, clockInLng: opts?.lng != null ? String(opts.lng) : null,
      geofencePass, createdBy: user.username,
    }).returning({ id: timeClock.id });
    return { id: r!.id, emp_code: empCode, status: 'Open', clock_in_method: method, geofence_pass: geofencePass };
  }

  // Supervisor override: a supervisor force-clocks-in an employee (method SUPERVISOR), bypassing the
  // duplicate-punch window. The reason is recorded on the note and the POST is captured by the append-only
  // audit_log, so every override is attributable.
  async supervisorOverride(empCode: string, reason: string, supervisor: JwtUser) {
    const db = this.db;
    if (!reason || !reason.trim()) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A reason is required for a supervisor override', messageTh: 'ต้องระบุเหตุผลในการลงเวลาแทน' });
    const r = await this.clockIn(empCode, supervisor, { method: 'SUPERVISOR' });
    await db.update(timeClock).set({ note: `SUPERVISOR OVERRIDE by ${supervisor.username}: ${reason.trim()}` }).where(eq(timeClock.id, r.id));
    return { ...r, override_by: supervisor.username, reason: reason.trim() };
  }

  async setGeofenceZone(dto: { branch_id?: number; lat: number; lng: number; radius_m?: number }, user: JwtUser) {
    const db = this.db;
    await db.insert(geofenceZones).values({ tenantId: user.tenantId, branchId: dto.branch_id ?? null, lat: String(dto.lat), lng: String(dto.lng), radiusM: dto.radius_m ?? 150 })
      .onConflictDoUpdate({ target: [geofenceZones.tenantId, geofenceZones.branchId], set: { lat: String(dto.lat), lng: String(dto.lng), radiusM: dto.radius_m ?? 150 } });
    return this.listGeofenceZones(user);
  }

  async listGeofenceZones(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(geofenceZones).where(eq(geofenceZones.tenantId, user.tenantId as number));
    return { zones: rows.map((z: any) => ({ id: Number(z.id), branch_id: z.branchId, lat: n(z.lat), lng: n(z.lng), radius_m: z.radiusM })), count: rows.length };
  }

  async clockOut(empCode: string, breakMinutes: number | undefined) {
    const db = this.db;
    const e = await this.emp(empCode);
    const [open] = await db.select().from(timeClock).where(and(eq(timeClock.employeeId, e.id), eq(timeClock.status, 'Open'))).orderBy(desc(timeClock.id)).limit(1);
    if (!open) throw new BadRequestException({ code: 'NOT_IN', message: 'Not clocked in', messageTh: 'ยังไม่ได้ลงเวลาเข้า' });
    const out = new Date();
    const brk = breakMinutes ?? 0;
    const hours = round2((out.getTime() - new Date(open.clockIn!).getTime()) / 3600000 - brk / 60);
    await db.update(timeClock).set({ clockOut: out, breakMinutes: brk, hours: String(Math.max(0, hours)), status: 'Closed' }).where(eq(timeClock.id, open.id));
    return { id: open.id, emp_code: empCode, hours: Math.max(0, hours), status: 'Closed' };
  }

  async report(limit = 100) {
    const db = this.db;
    const rows = await db.select().from(timeClock).where(eq(timeClock.status, 'Closed')).orderBy(desc(timeClock.id)).limit(limit);
    const totalHours = round2(rows.reduce((a: number, r: any) => a + n(r.hours), 0));
    const open = await db.select().from(timeClock).where(eq(timeClock.status, 'Open'));
    return { entries: rows.map((r: any) => ({ id: r.id, emp_code: r.empCode, clock_in: r.clockIn, clock_out: r.clockOut, break_minutes: r.breakMinutes, hours: n(r.hours), clock_in_method: r.clockInMethod, geofence_pass: r.geofencePass, note: r.note })), total_hours: totalHours, open_count: open.length, count: rows.length };
  }

  // Sales-per-labor-hour for a day = Σ sales total / Σ closed labor hours that day.
  async productivity(date?: string) {
    const db = this.db;
    const d = date ?? ymd();
    const closed = await db.select().from(timeClock).where(eq(timeClock.status, 'Closed'));
    const hours = round2(closed.filter((r: any) => r.clockIn && ymd(new Date(r.clockIn)) === d).reduce((a: number, r: any) => a + n(r.hours), 0));
    const sales = await db.select().from(custPosSales).where(eq(custPosSales.saleDate, d));
    const totalSales = round2(sales.reduce((a: number, r: any) => a + n(r.total), 0));
    return { date: d, total_sales: totalSales, labor_hours: hours, sales_per_labor_hour: hours > 0 ? round2(totalSales / hours) : null };
  }
}
