import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, gte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { posDevices, drawerEvents, customerDisplays, scaleReadings, menuItems } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { PrintService } from '../printing/print.service';
import { PaymentService } from '../payments/payments.service';

const n = (x: any) => Number(x) || 0;
const r2 = (x: number) => Math.round(x * 100) / 100;
const DRAWER_REASONS = ['sale', 'no_sale', 'refund', 'paid_in', 'paid_out', 'manual'] as const;
type DrawerReason = typeof DRAWER_REASONS[number];

// ESC/POS cash-drawer kick (DLE DC4 pin-2 pulse) — the universal "open drawer" pulse on pin 2.
function drawerKickBytes(): string { return '\x10\x14\x01\x00\x05'; }

// POS hardware peripherals: device registry, cash-drawer kick + audit, customer-facing display state, and
// weighing-scale capture. The drawer kick rides the print queue (printer fires the pulse).
@Injectable()
export class PeripheralsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly print: PrintService,
    private readonly payments: PaymentService,
  ) {}

  // ── device registry ──
  async registerDevice(dto: { device_code: string; kind: string; terminal?: string; printer_id?: string; config?: any }, user: JwtUser) {
    const db = this.db as any;
    if (!['printer', 'cash_drawer', 'display', 'scale'].includes(dto.kind)) throw new BadRequestException({ code: 'BAD_KIND', message: 'Unknown device kind', messageTh: 'ชนิดอุปกรณ์ไม่ถูกต้อง' });
    const [existing] = await db.select().from(posDevices).where(and(eq(posDevices.tenantId, user.tenantId as any), eq(posDevices.deviceCode, dto.device_code))).limit(1);
    if (existing) {
      await db.update(posDevices).set({ kind: dto.kind, terminal: dto.terminal ?? null, printerId: dto.printer_id ?? null, config: dto.config ?? null, status: 'active' }).where(eq(posDevices.id, existing.id));
      return { id: Number(existing.id), device_code: dto.device_code, kind: dto.kind, updated: true };
    }
    const [d] = await db.insert(posDevices).values({ tenantId: user.tenantId ?? null, deviceCode: dto.device_code, kind: dto.kind, terminal: dto.terminal ?? null, printerId: dto.printer_id ?? null, config: dto.config ?? null, status: 'active', createdBy: user.username }).returning({ id: posDevices.id });
    return { id: Number(d.id), device_code: dto.device_code, kind: dto.kind, updated: false };
  }

  async listDevices(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(posDevices).orderBy(posDevices.kind, posDevices.deviceCode);
    return { devices: rows.map((d: any) => ({ id: Number(d.id), device_code: d.deviceCode, kind: d.kind, terminal: d.terminal, printer_id: d.printerId, status: d.status, last_seen_at: d.lastSeenAt })) };
  }

  async heartbeat(deviceCode: string, user: JwtUser) {
    const db = this.db as any;
    const upd = await db.update(posDevices).set({ lastSeenAt: new Date(), status: 'active' }).where(and(eq(posDevices.tenantId, user.tenantId as any), eq(posDevices.deviceCode, deviceCode))).returning({ id: posDevices.id });
    if (!upd.length) throw new NotFoundException({ code: 'DEVICE_NOT_FOUND', message: 'Device not registered', messageTh: 'ไม่พบอุปกรณ์' });
    return { device_code: deviceCode, ok: true };
  }

  // ── cash drawer ──
  // Kick the drawer (via the printer) and log the open. Every open is audited (reason + operator + till).
  async kickDrawer(dto: { terminal?: string; reason?: DrawerReason; sale_no?: string; amount?: number; printer_id?: string }, user: JwtUser) {
    const db = this.db as any;
    const reason: DrawerReason = (dto.reason && DRAWER_REASONS.includes(dto.reason)) ? dto.reason : 'manual';
    // resolve the kicking printer: explicit > the drawer device attached to this terminal
    let printerId = dto.printer_id ?? null;
    if (!printerId && dto.terminal) {
      const [drawer] = await db.select().from(posDevices).where(and(eq(posDevices.tenantId, user.tenantId as any), eq(posDevices.kind, 'cash_drawer'), eq(posDevices.terminal, dto.terminal))).limit(1);
      printerId = drawer?.printerId ?? null;
    }
    let printJobId: number | null = null;
    try { const j = await this.print.enqueue({ job_type: 'drawer', format: 'escpos', payload: drawerKickBytes(), printer_id: printerId ?? undefined }, user); printJobId = j.id; } catch { /* drawer audit must record even if the printer is offline */ }
    const till = user.tenantId != null ? await this.payments.currentOpenTill(user.tenantId) : null;
    const [e] = await db.insert(drawerEvents).values({ tenantId: user.tenantId ?? null, terminal: dto.terminal ?? null, tillSessionId: till?.id ?? null, reason, saleNo: dto.sale_no ?? null, amount: dto.amount != null ? String(r2(n(dto.amount))) : null, printJobId, openedBy: user.username }).returning({ id: drawerEvents.id });
    return { id: Number(e.id), reason, terminal: dto.terminal ?? null, till_session_id: till?.id ?? null, print_job_id: printJobId, kicked: printJobId != null };
  }

  async drawerEventsList(_user: JwtUser, opts?: { reason?: string; limit?: number }) {
    const db = this.db as any;
    const where = opts?.reason ? eq(drawerEvents.reason, opts.reason) : undefined;
    const rows = await (where ? db.select().from(drawerEvents).where(where) : db.select().from(drawerEvents)).orderBy(desc(drawerEvents.id)).limit(opts?.limit ?? 100);
    return { events: rows.map((e: any) => ({ id: Number(e.id), reason: e.reason, terminal: e.terminal, till_session_id: e.tillSessionId != null ? Number(e.tillSessionId) : null, sale_no: e.saleNo, amount: e.amount != null ? n(e.amount) : null, opened_by: e.openedBy, created_at: e.createdAt })) };
  }

  // Detective control: summarise drawer opens by reason for a day; no-sale (drawer opened without a sale) is
  // the audited anomaly reconciled against the Z-report.
  async drawerReconciliation(_user: JwtUser, sinceIso?: string) {
    const db = this.db as any;
    const since = sinceIso ? new Date(sinceIso) : new Date(Date.now() - 24 * 3600 * 1000);
    const rows = await db.select({ reason: drawerEvents.reason, c: sql<number>`count(*)` }).from(drawerEvents).where(gte(drawerEvents.createdAt, since)).groupBy(drawerEvents.reason);
    const byReason: Record<string, number> = {};
    for (const r of rows) byReason[r.reason] = Number(r.c);
    const total = Object.values(byReason).reduce((a, b) => a + b, 0);
    return { since: since.toISOString(), total_opens: total, by_reason: byReason, no_sale_opens: byReason['no_sale'] ?? 0 };
  }

  // ── customer-facing display ──
  async setDisplay(terminal: string, state: any, user: JwtUser) {
    const db = this.db as any;
    const [existing] = await db.select({ id: customerDisplays.id }).from(customerDisplays).where(and(eq(customerDisplays.tenantId, user.tenantId as any), eq(customerDisplays.terminal, terminal))).limit(1);
    if (existing) await db.update(customerDisplays).set({ state, updatedBy: user.username, updatedAt: new Date() }).where(eq(customerDisplays.id, existing.id));
    else await db.insert(customerDisplays).values({ tenantId: user.tenantId ?? null, terminal, state, updatedBy: user.username });
    return { terminal, ok: true };
  }

  async getDisplay(terminal: string, user: JwtUser) {
    const db = this.db as any;
    const [row] = await db.select().from(customerDisplays).where(and(eq(customerDisplays.tenantId, user.tenantId as any), eq(customerDisplays.terminal, terminal))).limit(1);
    return { terminal, state: row?.state ?? { message: 'ยินดีต้อนรับ / Welcome', lines: [], total: 0 }, updated_at: row?.updatedAt ?? null };
  }

  // ── weighing scale ──
  // Capture a weight reading for a weighed SKU and compute the line amount from the CATALOG unit price
  // (server-side — staff can't tamper the per-kg price). Returns a ready-to-add priced line + logs the read.
  async readScale(dto: { sku: string; gross_weight: number; tare_weight?: number; terminal?: string; device_code?: string; sale_no?: string; order_no?: string }, user: JwtUser) {
    const db = this.db as any;
    const [item] = await db.select().from(menuItems).where(and(eq(menuItems.tenantId, user.tenantId as any), eq(menuItems.sku, dto.sku))).limit(1);
    if (!item) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'Menu item not found', messageTh: 'ไม่พบสินค้า' });
    if (!item.soldByWeight) throw new BadRequestException({ code: 'NOT_WEIGHED', message: 'Item is not sold by weight', messageTh: 'สินค้านี้ไม่ได้ขายแบบชั่งน้ำหนัก' });
    const gross = n(dto.gross_weight), tare = Math.max(0, n(dto.tare_weight));
    const net = r2_3(gross - tare);
    if (net <= 0) throw new BadRequestException({ code: 'BAD_WEIGHT', message: 'Net weight must be positive', messageTh: 'น้ำหนักสุทธิต้องมากกว่า 0' });
    const unit = item.weightUnit ?? 'kg';
    const unitPrice = n(item.price);
    const amount = r2(net * unitPrice);
    const [rec] = await db.insert(scaleReadings).values({ tenantId: user.tenantId ?? null, terminal: dto.terminal ?? null, deviceCode: dto.device_code ?? null, sku: dto.sku, grossWeight: String(gross), tareWeight: String(tare), netWeight: String(net), weightUnit: unit, unitPrice: String(unitPrice), amount: String(amount), saleNo: dto.sale_no ?? null, orderNo: dto.order_no ?? null, capturedBy: user.username }).returning({ id: scaleReadings.id });
    return {
      id: Number(rec.id), sku: dto.sku, name: item.name, net_weight: net, weight_unit: unit, unit_price: unitPrice, amount,
      // a POS line the caller can add through the normal order/sale path (priced server-side)
      line: { sku: dto.sku, name: `${item.name} (${net} ${unit})`, qty: 1, unit_price: amount, station_code: item.stationCode ?? 'main' },
    };
  }

  // Mark a catalog item as weighed (price becomes the per-unit price).
  async setWeighed(sku: string, dto: { sold_by_weight: boolean; weight_unit?: string }, user: JwtUser) {
    const db = this.db as any;
    if (dto.weight_unit && !['kg', 'g'].includes(dto.weight_unit)) throw new BadRequestException({ code: 'BAD_UNIT', message: 'weight_unit must be kg or g', messageTh: 'หน่วยน้ำหนักต้องเป็น kg หรือ g' });
    const upd = await db.update(menuItems).set({ soldByWeight: dto.sold_by_weight, ...(dto.weight_unit ? { weightUnit: dto.weight_unit } : {}) }).where(and(eq(menuItems.tenantId, user.tenantId as any), eq(menuItems.sku, sku))).returning({ id: menuItems.id });
    if (!upd.length) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'Menu item not found', messageTh: 'ไม่พบสินค้า' });
    return { sku, sold_by_weight: dto.sold_by_weight, weight_unit: dto.weight_unit ?? 'kg' };
  }
}

function r2_3(x: number) { return Math.round(x * 1000) / 1000; }
