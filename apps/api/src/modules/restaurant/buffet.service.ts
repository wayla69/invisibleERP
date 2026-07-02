import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, inArray, desc, ne } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { buffetPackages, buffetPackageItems, menuItems, dineInOrders, dineInOrderItems, tableSessions, diningTables } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { DineInService } from './dine-in.service';
import { TableService } from './table.service';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const CHARGE_REF = '__buffet_charge__';
const OVERTIME_REF = '__buffet_overtime__';

// Buffet self-ordering (Phase 2): per-pax tiers with a dining time window. A session runs in ONE mode.
// Buffet food posts at ฿0 (DineInService stamps is_buffet); the per-pax charge + optional overtime
// surcharge are non-kitchen lines (kds_status 'served') so they bill but never reach the kitchen feed.
@Injectable()
export class BuffetService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly dineIn: DineInService,
    private readonly tables: TableService,
  ) {}

  // staff at the POS/floor start a buffet on a table: open (or re-join) the session, then start the tier.
  async startBuffetForTable(tableId: number, packageId: number, pax: number, user: JwtUser) {
    const opened: any = await this.tables.openTable(tableId, pax, user.username, user);
    return this.startBuffet({ tenantId: user.tenantId as number, tableId, sessionId: Number(opened.session_id) }, packageId, pax, user);
  }

  // ── admin (back office) ──
  async listPackages(_user: JwtUser) {
    const db = this.db;
    const pkgs = await db.select().from(buffetPackages).where(eq(buffetPackages.active, true)).orderBy(buffetPackages.id);
    const links = await db.select().from(buffetPackageItems);
    const skuById = await this.skuMap(links.map((l: any) => Number(l.menuItemId)));
    return {
      packages: pkgs.map((p: any) => ({
        ...shapePkg(p),
        item_skus: links.filter((l: any) => Number(l.packageId) === Number(p.id)).map((l: any) => skuById.get(Number(l.menuItemId))).filter(Boolean),
      })),
    };
  }

  async createPackage(dto: { code: string; name: string; name_en?: string; price_per_pax: number; time_limit_min?: number; overtime_fee_per_pax?: number; item_skus?: string[] }, user: JwtUser) {
    const db = this.db;
    const [p] = await db.insert(buffetPackages).values({
      tenantId: user.tenantId ?? null, code: dto.code, name: dto.name, nameEn: dto.name_en ?? null,
      pricePerPax: fx(dto.price_per_pax, 2), timeLimitMin: dto.time_limit_min ?? 90,
      overtimeFeePerPax: fx(dto.overtime_fee_per_pax ?? 0, 2),
    }).onConflictDoNothing().returning();
    if (!p) throw new BadRequestException({ code: 'PACKAGE_EXISTS', message: 'Package code exists', messageTh: 'รหัสแพ็กเกจซ้ำ' });
    if (dto.item_skus?.length) await this.setItems(Number(p.id), dto.item_skus, user);
    return this.getPackage(Number(p.id));
  }

  async updatePackage(id: number, dto: { name?: string; name_en?: string; price_per_pax?: number; time_limit_min?: number; overtime_fee_per_pax?: number; active?: boolean; item_skus?: string[] }, user: JwtUser) {
    const db = this.db;
    const set: any = {};
    if (dto.name != null) set.name = dto.name;
    if (dto.name_en != null) set.nameEn = dto.name_en;
    if (dto.price_per_pax != null) set.pricePerPax = fx(dto.price_per_pax, 2);
    if (dto.time_limit_min != null) set.timeLimitMin = dto.time_limit_min;
    if (dto.overtime_fee_per_pax != null) set.overtimeFeePerPax = fx(dto.overtime_fee_per_pax, 2);
    if (dto.active != null) set.active = dto.active;
    if (Object.keys(set).length) await db.update(buffetPackages).set(set).where(eq(buffetPackages.id, id));
    if (dto.item_skus) await this.setItems(id, dto.item_skus, user);
    return this.getPackage(id);
  }

  // ── diner (public) ──
  async publicTiers() {
    const db = this.db;
    const pkgs = await db.select().from(buffetPackages).where(eq(buffetPackages.active, true)).orderBy(buffetPackages.id);
    return { tiers: pkgs.map(shapePkg) };
  }

  // diner (or staff) starts a buffet on the table → set the session mode + window, open the order with the
  // per-pax charge line. One mode per session: rejected if the session already has an order (à la carte).
  async startBuffet(claim: { tenantId: number; tableId: number; sessionId: number }, packageId: number, pax: number, user: JwtUser) {
    const db = this.db;
    const existing = await this.openOrderForSession(claim.sessionId);
    if (existing) throw new BadRequestException({ code: 'MODE_LOCKED', message: 'Session already has an order; cannot switch to buffet', messageTh: 'โต๊ะนี้มีรายการสั่งแล้ว เริ่มบุฟเฟต์ไม่ได้' });
    const [pkg] = await db.select().from(buffetPackages).where(and(eq(buffetPackages.id, packageId), eq(buffetPackages.active, true))).limit(1);
    if (!pkg) throw new NotFoundException({ code: 'PACKAGE_NOT_FOUND', message: 'Buffet package not found', messageTh: 'ไม่พบแพ็กเกจบุฟเฟต์' });
    const seats = Math.max(1, Math.floor(pax || 1));
    const now = new Date();
    const expires = new Date(now.getTime() + Number(pkg.timeLimitMin) * 60000);

    const orderNo = await this.docNo.nextDaily('DIN');
    const [h] = await db.insert(dineInOrders).values({
      orderNo, tenantId: claim.tenantId, tableId: claim.tableId, sessionId: claim.sessionId,
      status: 'open', guestCount: seats, server: user.username, createdBy: user.username,
    }).returning({ id: dineInOrders.id });
    await this.insertChargeLine(Number(h!.id), claim.tenantId, packageId, CHARGE_REF, `บุฟเฟต์ ${pkg.name} × ${seats}`, n(pkg.pricePerPax), seats, user);
    await this.dineIn.refreshOrderTotals(Number(h!.id));

    await db.update(tableSessions).set({ orderMode: 'buffet', buffetPackageId: packageId, pax: seats, buffetStartedAt: now, buffetExpiresAt: expires }).where(eq(tableSessions.id, claim.sessionId));
    await db.update(diningTables).set({ status: 'occupied', updatedAt: now }).where(and(eq(diningTables.id, claim.tableId), inArray(diningTables.status, ['available', 'reserved'] as any)));
    return { package: shapePkg(pkg), pax: seats, expires_at: expires.toISOString() };
  }

  // reject orders placed after the window elapsed
  assertActive(session: any) {
    if (session?.buffetExpiresAt && Date.now() > new Date(session.buffetExpiresAt).getTime())
      throw new BadRequestException({ code: 'BUFFET_EXPIRED', message: 'Buffet time is up', messageTh: 'หมดเวลาบุฟเฟต์แล้ว' });
  }

  // every ordered item must belong to the chosen tier
  async assertEligible(packageId: number, items: { sku?: string; menu_item_id?: number }[]) {
    const db = this.db;
    const skus = items.filter((i) => i.sku != null).map((i) => i.sku!) as string[];
    const bySku = skus.length ? await db.select({ id: menuItems.id, sku: menuItems.sku }).from(menuItems).where(inArray(menuItems.sku, skus)) : [];
    const skuToId = new Map<string, number>(bySku.map((r: any) => [r.sku, Number(r.id)]));
    const wanted = items.map((i) => (i.menu_item_id != null ? Number(i.menu_item_id) : skuToId.get(i.sku!)) ?? -1);
    const links = await db.select({ menuItemId: buffetPackageItems.menuItemId }).from(buffetPackageItems).where(eq(buffetPackageItems.packageId, packageId));
    const eligible = new Set<number>(links.map((l: any) => Number(l.menuItemId)));
    if (wanted.some((id) => !eligible.has(id)))
      throw new BadRequestException({ code: 'NOT_IN_PACKAGE', message: 'Item is not part of this buffet tier', messageTh: 'เมนูนี้ไม่ได้อยู่ในบุฟเฟต์ที่เลือก' });
  }

  // at bill time: if the window elapsed and the tier carries an overtime fee, add a one-off surcharge (idempotent)
  async applyOvertime(orderNo: string, user: JwtUser) {
    const db = this.db;
    const [o] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, orderNo)).limit(1);
    if (!o || !o.sessionId) return;
    const [s] = await db.select().from(tableSessions).where(eq(tableSessions.id, Number(o.sessionId))).limit(1);
    if (!s || s.orderMode !== 'buffet' || !s.buffetPackageId || !s.buffetExpiresAt) return;
    if (Date.now() <= new Date(s.buffetExpiresAt).getTime()) return;
    const [pkg] = await db.select().from(buffetPackages).where(eq(buffetPackages.id, Number(s.buffetPackageId))).limit(1);
    if (!pkg || !(n(pkg.overtimeFeePerPax) > 0)) return;
    const [dupe] = await db.select({ id: dineInOrderItems.id }).from(dineInOrderItems).where(and(eq(dineInOrderItems.orderId, Number(o.id)), eq(dineInOrderItems.itemId, OVERTIME_REF))).limit(1);
    if (dupe) return;
    const pax = Number(s.pax) || 1;
    await this.insertChargeLine(Number(o.id), Number(o.tenantId), Number(s.buffetPackageId), OVERTIME_REF, 'ค่าปรับเกินเวลา (บุฟเฟต์)', n(pkg.overtimeFeePerPax), pax, user);
    await this.dineIn.refreshOrderTotals(Number(o.id));
  }

  // per-tier behaviour analytics: menu mix, covers, consumption per head, revenue + overtime (tenant-scoped)
  async analytics(_user: JwtUser) {
    const db = this.db;
    const pkgs = await db.select().from(buffetPackages).orderBy(buffetPackages.id);
    const tiers = [];
    for (const p of pkgs) {
      const pid = Number(p.id);
      const sess = await db.select().from(tableSessions).where(eq(tableSessions.buffetPackageId, pid));
      const sessions = sess.length;
      const covers = sess.reduce((a: number, s: any) => a + (Number(s.pax) || 0), 0);

      const food = await db.select().from(dineInOrderItems).where(and(eq(dineInOrderItems.buffetPackageId, pid), eq(dineInOrderItems.isBuffet, true)));
      const byItem = new Map<string, { name: string; qty: number; orders: number }>();
      let foodQty = 0;
      for (const it of food) {
        const q = n(it.qty); foodQty += q;
        const key = it.itemId || it.name;
        const e = byItem.get(key) ?? { name: it.name, qty: 0, orders: 0 };
        e.qty += q; e.orders += 1; byItem.set(key, e);
      }
      const topItems = [...byItem.values()].sort((a, b) => b.qty - a.qty).slice(0, 10).map((x) => ({ name: x.name, qty: round2(x.qty), orders: x.orders }));

      const charges = await db.select().from(dineInOrderItems).where(and(eq(dineInOrderItems.buffetPackageId, pid), eq(dineInOrderItems.isBuffet, false)));
      let revenue = 0; const overtimeOrders = new Set<number>();
      for (const c of charges) { revenue += n(c.amount); if (c.itemId === OVERTIME_REF) overtimeOrders.add(Number(c.orderId)); }

      tiers.push({
        tier: shapePkg(p),
        sessions, covers,
        food_qty: round2(foodQty),
        items_per_head: covers > 0 ? round2(foodQty / covers) : 0,
        top_items: topItems,
        revenue: round2(revenue),
        avg_bill_per_session: sessions > 0 ? round2(revenue / sessions) : 0,
        overtime_sessions: overtimeOrders.size,
        overtime_rate_pct: sessions > 0 ? round2((overtimeOrders.size / sessions) * 100) : 0,
      });
    }
    return { tiers, generated_at: new Date().toISOString() };
  }

  // ── helpers ──
  private async insertChargeLine(orderId: number, tenantId: number | null, packageId: number, ref: string, name: string, unit: number, qty: number, user: JwtUser) {
    const db = this.db;
    const now = new Date();
    await db.insert(dineInOrderItems).values({
      tenantId, orderId, stationId: null, itemId: ref, name,
      qty: String(qty), unitPrice: fx(unit, 2), amount: fx(round2(unit * qty), 2),
      modifiers: null, notes: null, isBuffet: false, buffetPackageId: packageId, kdsStatus: 'served', servedAt: now,
      createdBy: user.username, // non-kitchen line: 'served' keeps it off the KDS feed but in the bill
    });
  }

  private async openOrderForSession(sessionId: number) {
    const db = this.db;
    const [o] = await db.select().from(dineInOrders).where(and(eq(dineInOrders.sessionId, sessionId), ne(dineInOrders.status, 'cancelled'), ne(dineInOrders.status, 'closed'))).orderBy(desc(dineInOrders.id)).limit(1);
    return o;
  }

  private async setItems(packageId: number, skus: string[], user: JwtUser) {
    const db = this.db;
    await db.delete(buffetPackageItems).where(eq(buffetPackageItems.packageId, packageId));
    if (!skus.length) return;
    const rows = await db.select({ id: menuItems.id, sku: menuItems.sku }).from(menuItems).where(inArray(menuItems.sku, skus));
    const found = new Map<string, number>(rows.map((r: any) => [r.sku, Number(r.id)]));
    const missing = skus.filter((s) => !found.has(s));
    if (missing.length) throw new BadRequestException({ code: 'ITEM_NOT_FOUND', message: `Unknown menu sku(s): ${missing.join(', ')}`, messageTh: 'ไม่พบเมนูบางรายการ' });
    await db.insert(buffetPackageItems).values(skus.map((s) => ({ tenantId: user.tenantId ?? null, packageId, menuItemId: found.get(s)! })));
  }

  private async getPackage(id: number) {
    const db = this.db;
    const [p] = await db.select().from(buffetPackages).where(eq(buffetPackages.id, id)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PACKAGE_NOT_FOUND', message: 'Buffet package not found', messageTh: 'ไม่พบแพ็กเกจบุฟเฟต์' });
    const links = await db.select().from(buffetPackageItems).where(eq(buffetPackageItems.packageId, id));
    const skuById = await this.skuMap(links.map((l: any) => Number(l.menuItemId)));
    return { ...shapePkg(p), item_skus: links.map((l: any) => skuById.get(Number(l.menuItemId))).filter(Boolean) };
  }

  private async skuMap(ids: number[]) {
    const db = this.db;
    if (!ids.length) return new Map<number, string>();
    const rows = await db.select({ id: menuItems.id, sku: menuItems.sku }).from(menuItems).where(inArray(menuItems.id, ids));
    return new Map<number, string>(rows.map((r: any) => [Number(r.id), r.sku]));
  }
}

function shapePkg(p: any) {
  return { id: Number(p.id), code: p.code, name: p.name, name_en: p.nameEn, price_per_pax: n(p.pricePerPax), time_limit_min: p.timeLimitMin, overtime_fee_per_pax: n(p.overtimeFeePerPax), active: p.active };
}
