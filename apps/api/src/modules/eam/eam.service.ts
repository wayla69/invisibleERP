import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { fixedAssets, maintenanceWorkOrders, maintenanceWoLines, pmSchedules, assetMeters } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { FinanceService } from '../finance/finance.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface WorkOrderDto { asset_no: string; type?: string; priority?: string; description?: string; scheduled_date?: string; vendor_name?: string; cost_estimate?: number }
export interface WoStatusDto { status: string; actual_cost?: number; downtime_hours?: number; vendor_name?: string; meter_reading?: number; vat_treatment?: 'standard' | 'exempt' | 'zero' }
export interface PmScheduleDto { asset_no: string; name: string; interval_days?: number; meter_interval?: number; next_due_date?: string }
export interface MeterDto { meter_value: number; reading_date?: string; note?: string }
export interface WoLineDto { kind: 'labor' | 'part'; description?: string; quantity?: number; hours?: number; unit_cost: number }

const WO_TYPES = ['corrective', 'preventive', 'inspection'];
// Allowed work-order status transitions (open → in_progress → completed; either may be cancelled).
const WO_TRANSITIONS: Record<string, string[]> = { open: ['in_progress', 'completed', 'cancelled'], in_progress: ['completed', 'cancelled'], completed: [], cancelled: [] };

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Enterprise Asset Management — maintenance work orders, preventive-maintenance schedules, meter readings.
// Maintenance cost on completion is routed through AP (Dr 5710 Repairs & Maintenance / Cr 2000) so it's
// payable + reconciles. Tenant isolation by RLS; the asset register is the system of record for assets.
@Injectable()
export class EamService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly finance: FinanceService,
  ) {}

  // Resolve an asset by its number within the caller's tenant (RLS-scoped) — the maintenance anchor.
  private async resolveAsset(assetNo: string) {
    const db = this.db as any;
    const [a] = await db.select().from(fixedAssets).where(eq(fixedAssets.assetNo, assetNo)).limit(1);
    if (!a) throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: `Asset ${assetNo} not found`, messageTh: `ไม่พบสินทรัพย์ ${assetNo}` });
    return a;
  }

  private async latestMeter(assetId: number): Promise<number> {
    const db = this.db as any;
    const [r] = await db.select({ v: sql<string>`coalesce(max(${assetMeters.meterValue}),0)` }).from(assetMeters).where(eq(assetMeters.assetId, assetId));
    return n(r?.v);
  }

  // ───────────────────── Work orders ─────────────────────
  async createWorkOrder(dto: WorkOrderDto, user: JwtUser) {
    const db = this.db as any;
    const type = dto.type ?? 'corrective';
    if (!WO_TYPES.includes(type)) throw new BadRequestException({ code: 'BAD_WO_TYPE', message: `type must be ${WO_TYPES.join('|')}`, messageTh: 'ประเภทงานซ่อมไม่ถูกต้อง' });
    const asset = await this.resolveAsset(dto.asset_no);
    const woNo = await this.docNo.nextDaily('MWO');
    await db.insert(maintenanceWorkOrders).values({
      tenantId: asset.tenantId, woNo, assetId: Number(asset.id), assetNo: asset.assetNo, type, priority: dto.priority ?? 'medium',
      status: 'open', description: dto.description ?? null, scheduledDate: dto.scheduled_date ?? null,
      vendorName: dto.vendor_name ?? null, costEstimate: String(n(dto.cost_estimate)), createdBy: user.username,
    });
    return { wo_no: woNo, asset_no: asset.assetNo, type, priority: dto.priority ?? 'medium', status: 'open' };
  }

  async listWorkOrders(user: JwtUser, opts: { asset_no?: string; status?: string; type?: string; limit?: number }) {
    const db = this.db as any;
    const conds: any[] = [];
    if (opts.asset_no) conds.push(eq(maintenanceWorkOrders.assetNo, opts.asset_no));
    if (opts.status) conds.push(eq(maintenanceWorkOrders.status, opts.status));
    if (opts.type) conds.push(eq(maintenanceWorkOrders.type, opts.type));
    const rows = await db.select().from(maintenanceWorkOrders)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(maintenanceWorkOrders.id)).limit(opts.limit ?? 100);
    return { work_orders: rows.map((w: any) => this.fmtWo(w)), count: rows.length };
  }

  // Advance a work order. Completing it with a vendor + actual cost raises an AP payable (Dr 5710 / Cr 2000).
  async updateWorkOrderStatus(woNo: string, dto: WoStatusDto, user: JwtUser) {
    const db = this.db as any;
    const [wo] = await db.select().from(maintenanceWorkOrders).where(eq(maintenanceWorkOrders.woNo, woNo)).limit(1);
    if (!wo) throw new NotFoundException({ code: 'WO_NOT_FOUND', message: `Work order ${woNo} not found`, messageTh: `ไม่พบใบสั่งงานซ่อม ${woNo}` });
    const allowed = WO_TRANSITIONS[wo.status] ?? [];
    if (!allowed.includes(dto.status)) throw new BadRequestException({ code: 'BAD_TRANSITION', message: `Cannot move ${woNo} from ${wo.status} to ${dto.status}`, messageTh: `เปลี่ยนสถานะจาก ${wo.status} เป็น ${dto.status} ไม่ได้` });

    const patch: any = { status: dto.status };
    if (dto.status === 'in_progress' && !wo.startedAt) patch.startedAt = new Date();
    let apTxnNo: string | null = wo.apTxnNo ?? null;
    if (dto.status === 'completed') {
      // Cost precedence: explicit actual_cost → rolled-up labor/parts lines → estimate.
      const lineTotal = await this.lineTotal(Number(wo.id));
      const actualCost = dto.actual_cost != null ? n(dto.actual_cost) : (lineTotal > 0 ? lineTotal : n(wo.costEstimate));
      const vendorName = dto.vendor_name ?? wo.vendorName;
      patch.completedDate = ymd();
      patch.actualCost = String(actualCost);
      patch.downtimeHours = String(n(dto.downtime_hours));
      if (dto.meter_reading != null) patch.meterReading = String(n(dto.meter_reading));
      // External vendor cost → AP payable (payable + reconciles). In-house work (no vendor) records cost only.
      if (vendorName && actualCost > 0 && !apTxnNo) {
        const ap = await this.finance.createApTxn({
          vendor_name: vendorName, txn_type: 'Maintenance', invoice_no: woNo, invoice_date: ymd(), due_date: ymd(),
          amount: actualCost, vat_treatment: dto.vat_treatment ?? 'standard', expense_account: '5710',
          tenant_id: wo.tenantId, idempotency_key: woNo, remarks: `Maintenance ${woNo} ${wo.assetNo ?? ''}`.trim(),
        }, user);
        apTxnNo = ap?.txn_no ?? null;
        patch.apTxnNo = apTxnNo;
      }
    }
    await db.update(maintenanceWorkOrders).set(patch).where(eq(maintenanceWorkOrders.id, wo.id));
    return { wo_no: woNo, status: dto.status, ap_txn_no: apTxnNo };
  }

  // ───────────────────── Work-order cost lines (labor / parts) ─────────────────────
  private async lineTotal(woId: number): Promise<number> {
    const db = this.db as any;
    const [r] = await db.select({ s: sql<string>`coalesce(sum(${maintenanceWoLines.amount}),0)` }).from(maintenanceWoLines).where(eq(maintenanceWoLines.woId, woId));
    return n(r?.s);
  }

  // Add a labor (hours × rate) or part (qty × unit cost) line; the WO's actual_cost rolls up from the lines.
  async addWoLine(woNo: string, dto: WoLineDto, user: JwtUser) {
    const db = this.db as any;
    if (dto.kind !== 'labor' && dto.kind !== 'part') throw new BadRequestException({ code: 'BAD_LINE_KIND', message: 'kind must be labor|part', messageTh: 'ประเภทต้องเป็น labor หรือ part' });
    const [wo] = await db.select().from(maintenanceWorkOrders).where(eq(maintenanceWorkOrders.woNo, woNo)).limit(1);
    if (!wo) throw new NotFoundException({ code: 'WO_NOT_FOUND', message: `Work order ${woNo} not found`, messageTh: `ไม่พบใบสั่งงานซ่อม ${woNo}` });
    const qty = dto.kind === 'part' ? n(dto.quantity ?? 1) : 1;
    const hours = dto.kind === 'labor' ? n(dto.hours) : 0;
    const amount = dto.kind === 'labor' ? hours * n(dto.unit_cost) : qty * n(dto.unit_cost);
    await db.insert(maintenanceWoLines).values({
      tenantId: wo.tenantId, woId: Number(wo.id), woNo, kind: dto.kind, description: dto.description ?? null,
      quantity: String(qty), hours: String(hours), unitCost: String(n(dto.unit_cost)), amount: String(round2(amount)), createdBy: user.username,
    });
    const total = await this.lineTotal(Number(wo.id));
    await db.update(maintenanceWorkOrders).set({ actualCost: String(round2(total)) }).where(eq(maintenanceWorkOrders.id, wo.id));
    return { wo_no: woNo, kind: dto.kind, amount: round2(amount), actual_cost: round2(total) };
  }

  async listWoLines(woNo: string) {
    const db = this.db as any;
    const rows = await db.select().from(maintenanceWoLines).where(eq(maintenanceWoLines.woNo, woNo)).orderBy(desc(maintenanceWoLines.id));
    const labor = round2(rows.filter((l: any) => l.kind === 'labor').reduce((a: number, l: any) => a + n(l.amount), 0));
    const parts = round2(rows.filter((l: any) => l.kind === 'part').reduce((a: number, l: any) => a + n(l.amount), 0));
    return { wo_no: woNo, lines: rows.map((l: any) => ({ kind: l.kind, description: l.description, quantity: n(l.quantity), hours: n(l.hours), unit_cost: n(l.unitCost), amount: n(l.amount) })), labor_total: labor, parts_total: parts, total: round2(labor + parts) };
  }

  // ───────────────────── Per-asset reliability & cost analytics ─────────────────────
  // Failures (corrective WOs), total downtime, mean-time-between-failures (from corrective WO dates), and
  // total maintenance spend for an asset — the EAM KPIs.
  async reliability(assetNo: string, user: JwtUser) {
    const db = this.db as any;
    await this.resolveAsset(assetNo); // 404 if unknown / cross-tenant
    const wos = await db.select().from(maintenanceWorkOrders).where(eq(maintenanceWorkOrders.assetNo, assetNo)).orderBy(maintenanceWorkOrders.scheduledDate);
    const corrective = wos.filter((w: any) => w.type === 'corrective');
    const downtime = round2(wos.reduce((a: number, w: any) => a + n(w.downtimeHours), 0));
    const totalCost = round2(wos.reduce((a: number, w: any) => a + n(w.actualCost), 0));
    // MTBF from corrective failure dates (completed/scheduled); needs ≥2 failures.
    const dates = corrective.map((w: any) => w.completedDate ?? w.scheduledDate ?? w.createdAt).filter(Boolean).map((d: any) => Date.parse(String(d))).filter((t: number) => !isNaN(t)).sort((a: number, b: number) => a - b);
    const mtbfDays = dates.length >= 2 ? Math.round(((dates[dates.length - 1] - dates[0]) / 86400000) / (dates.length - 1) * 10) / 10 : null;
    return {
      asset_no: assetNo,
      work_orders: wos.length, corrective_failures: corrective.length,
      preventive: wos.filter((w: any) => w.type === 'preventive').length,
      open: wos.filter((w: any) => w.status === 'open' || w.status === 'in_progress').length,
      total_downtime_hours: downtime, mtbf_days: mtbfDays, total_maintenance_cost: totalCost,
    };
  }

  // ───────────────────── Preventive-maintenance schedules ─────────────────────
  async createPmSchedule(dto: PmScheduleDto, user: JwtUser) {
    const db = this.db as any;
    if (!dto.interval_days && !dto.meter_interval) throw new BadRequestException({ code: 'NO_CADENCE', message: 'interval_days or meter_interval required', messageTh: 'ต้องระบุรอบเวลา หรือรอบมิเตอร์' });
    const asset = await this.resolveAsset(dto.asset_no);
    const nextDue = dto.next_due_date ?? (dto.interval_days ? addDays(ymd(), dto.interval_days) : null);
    const [s] = await db.insert(pmSchedules).values({
      tenantId: asset.tenantId, assetId: Number(asset.id), assetNo: asset.assetNo, name: dto.name,
      intervalDays: dto.interval_days ?? null, meterInterval: dto.meter_interval != null ? String(dto.meter_interval) : null,
      lastServiceMeter: '0', nextDueDate: nextDue, active: 'true', createdBy: user.username,
    }).returning({ id: pmSchedules.id });
    return { id: Number(s.id), asset_no: asset.assetNo, name: dto.name, interval_days: dto.interval_days ?? null, meter_interval: dto.meter_interval ?? null, next_due_date: nextDue };
  }

  async listPmSchedules(user: JwtUser, assetNo?: string) {
    const db = this.db as any;
    const conds = [eq(pmSchedules.active, 'true')];
    if (assetNo) conds.push(eq(pmSchedules.assetNo, assetNo));
    const rows = await db.select().from(pmSchedules).where(and(...conds)).orderBy(desc(pmSchedules.id));
    return { schedules: rows.map((s: any) => ({ id: Number(s.id), asset_no: s.assetNo, name: s.name, interval_days: s.intervalDays != null ? Number(s.intervalDays) : null, meter_interval: n(s.meterInterval), last_service_date: s.lastServiceDate, last_service_meter: n(s.lastServiceMeter), next_due_date: s.nextDueDate, active: s.active === 'true' })), count: rows.length };
  }

  // ───────────────────── Meter readings ─────────────────────
  async recordMeter(assetNo: string, dto: MeterDto, user: JwtUser) {
    const db = this.db as any;
    const asset = await this.resolveAsset(assetNo);
    await db.insert(assetMeters).values({
      tenantId: asset.tenantId, assetId: Number(asset.id), assetNo: asset.assetNo,
      readingDate: dto.reading_date ?? ymd(), meterValue: String(n(dto.meter_value)), note: dto.note ?? null, createdBy: user.username,
    });
    return { asset_no: asset.assetNo, meter_value: n(dto.meter_value), reading_date: dto.reading_date ?? ymd() };
  }

  async listMeters(assetNo: string, user: JwtUser, limit = 100) {
    const db = this.db as any;
    const rows = await db.select().from(assetMeters).where(eq(assetMeters.assetNo, assetNo)).orderBy(desc(assetMeters.id)).limit(limit);
    return { asset_no: assetNo, readings: rows.map((m: any) => ({ reading_date: m.readingDate, meter_value: n(m.meterValue), note: m.note, created_by: m.createdBy })), count: rows.length };
  }

  // ───────────────────── PM due-generation sweep (cron-callable / scheduled) ─────────────────────
  // For every active schedule that is due (next_due_date passed, or meter overrun), raise a preventive
  // work order and roll the schedule forward. Idempotent: a schedule with an open/in-progress generated
  // WO is skipped, and the date is advanced on generation so a re-run produces nothing new.
  async runPmDue(user: JwtUser) {
    const db = this.db as any;
    const today = ymd();
    const schedules = await db.select().from(pmSchedules).where(eq(pmSchedules.active, 'true'));
    const generated: { wo_no: string; asset_no: string; schedule: string; reason: string }[] = [];
    for (const s of schedules) {
      // de-dupe: an outstanding generated WO means this schedule is already being serviced
      const [openWo] = await db.select({ id: maintenanceWorkOrders.id }).from(maintenanceWorkOrders)
        .where(and(eq(maintenanceWorkOrders.pmScheduleId, Number(s.id)), sql`${maintenanceWorkOrders.status} in ('open','in_progress')`)).limit(1);
      if (openWo) continue;
      const timeDue = !!s.nextDueDate && String(s.nextDueDate) <= today;
      const meter = s.meterInterval != null ? await this.latestMeter(Number(s.assetId)) : 0;
      const meterDue = s.meterInterval != null && meter >= n(s.lastServiceMeter) + n(s.meterInterval);
      if (!timeDue && !meterDue) continue;
      const woNo = await this.docNo.nextDaily('MWO');
      await db.insert(maintenanceWorkOrders).values({
        tenantId: s.tenantId, woNo, assetId: Number(s.assetId), assetNo: s.assetNo, type: 'preventive', priority: 'medium',
        status: 'open', description: `PM: ${s.name}`, scheduledDate: today, pmScheduleId: Number(s.id), createdBy: `${user?.username ?? 'system'} (pm-sweep)`,
      });
      await db.update(pmSchedules).set({
        lastServiceDate: today,
        nextDueDate: s.intervalDays != null ? addDays(today, Number(s.intervalDays)) : s.nextDueDate,
        lastServiceMeter: meterDue ? String(meter) : s.lastServiceMeter,
      }).where(eq(pmSchedules.id, s.id));
      generated.push({ wo_no: woNo, asset_no: s.assetNo, schedule: s.name, reason: meterDue ? 'meter' : 'time' });
    }
    return { as_of: today, scanned: schedules.length, generated: generated.length, work_orders: generated };
  }

  private fmtWo(w: any) {
    return {
      wo_no: w.woNo, asset_no: w.assetNo, type: w.type, priority: w.priority, status: w.status, description: w.description,
      scheduled_date: w.scheduledDate, completed_date: w.completedDate, vendor_name: w.vendorName,
      cost_estimate: n(w.costEstimate), actual_cost: n(w.actualCost), downtime_hours: n(w.downtimeHours),
      ap_txn_no: w.apTxnNo, pm_schedule_id: w.pmScheduleId != null ? Number(w.pmScheduleId) : null, created_by: w.createdBy,
    };
  }
}

function round2(x: number) { return Math.round((Number(x) || 0) * 100) / 100; }
