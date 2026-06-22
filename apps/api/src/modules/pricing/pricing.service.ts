import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { priceRules, comboComponents, menuItems } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const pad = (x: number) => String(x).padStart(2, '0');

export interface QuoteLine { sku: string; qty: number; unit_price?: number; category?: string }
export interface QuoteDto {
  channel?: string; location?: string; party_size?: number; at?: string;
  service_charge_pct?: number; service_min_party?: number; surcharge_pct?: number; rounding?: number;
  lines: QuoteLine[];
}
export interface RuleDto {
  id?: number; name: string; scope?: string; target_id?: string; channel?: string; location?: string;
  dow?: string; time_start?: string; time_end?: string; type: string; value?: number; min_qty?: number;
  priority?: number; stackable?: boolean; active?: boolean; valid_from?: string; valid_to?: string;
}

// Pricing/promotion engine. quote() explodes combos, then applies time/channel/scope-gated rules
// (happy-hour %, amount-off, fixed price, BOGO, qty-break) by priority + stacking, adds an auto
// service charge for large parties, an optional card surcharge, and satang rounding.
@Injectable()
export class PricingService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Rules CRUD ──────────────────────────────────────────────────────────────
  async listRules() {
    const db = this.db as any;
    const rows = await db.select().from(priceRules).orderBy(priceRules.priority);
    return { rules: rows.map(mapRule), count: rows.length };
  }
  async upsertRule(dto: RuleDto, user: JwtUser) {
    const db = this.db as any;
    const vals = {
      tenantId: user.tenantId ?? null, name: dto.name, scope: dto.scope ?? 'all', targetId: dto.target_id ?? null,
      channel: dto.channel ?? 'any', location: dto.location ?? null, dow: dto.dow ?? null, timeStart: dto.time_start ?? null,
      timeEnd: dto.time_end ?? null, type: dto.type, value: String(dto.value ?? 0), minQty: dto.min_qty ?? 1,
      priority: dto.priority ?? 100, stackable: dto.stackable ?? false, active: dto.active ?? true,
      validFrom: dto.valid_from ?? null, validTo: dto.valid_to ?? null,
    };
    if (dto.id) {
      await db.update(priceRules).set(vals).where(eq(priceRules.id, dto.id));
      return { id: dto.id, updated: true };
    }
    const [r] = await db.insert(priceRules).values({ ...vals, createdBy: user.username }).returning({ id: priceRules.id });
    return { id: r.id, created: true };
  }
  async deleteRule(id: number) {
    const db = this.db as any;
    await db.delete(priceRules).where(eq(priceRules.id, id));
    return { id, deleted: true };
  }

  // ── Combo components ─────────────────────────────────────────────────────────
  async setCombo(comboSku: string, components: { component_sku: string; qty?: number; unit_price_override?: number }[], user: JwtUser) {
    const db = this.db as any;
    await db.delete(comboComponents).where(eq(comboComponents.comboSku, comboSku));
    for (const c of components)
      await db.insert(comboComponents).values({ tenantId: user.tenantId ?? null, comboSku, componentSku: c.component_sku, qty: String(c.qty ?? 1), unitPriceOverride: c.unit_price_override != null ? String(c.unit_price_override) : null });
    return { combo_sku: comboSku, components: components.length };
  }
  async getCombo(comboSku: string) {
    const db = this.db as any;
    const rows = await db.select().from(comboComponents).where(eq(comboComponents.comboSku, comboSku));
    return { combo_sku: comboSku, components: rows.map((r: any) => ({ component_sku: r.componentSku, qty: n(r.qty), unit_price_override: r.unitPriceOverride != null ? n(r.unitPriceOverride) : null })) };
  }

  // ── Quote ────────────────────────────────────────────────────────────────────
  async quote(dto: QuoteDto, _user: JwtUser) {
    const db = this.db as any;
    // 1. explode combos into component lines
    const exploded: QuoteLine[] = [];
    for (const l of dto.lines) {
      const comps = await db.select().from(comboComponents).where(eq(comboComponents.comboSku, l.sku));
      if (comps.length) {
        for (const c of comps) exploded.push({ sku: c.componentSku, qty: l.qty * n(c.qty), unit_price: c.unitPriceOverride != null ? n(c.unitPriceOverride) : undefined });
      } else exploded.push({ ...l });
    }
    // 2. resolve unit_price + category from menu for lines missing them
    for (const l of exploded) {
      if (l.unit_price == null || l.category == null) {
        const [mi] = await db.select().from(menuItems).where(eq(menuItems.sku, l.sku)).limit(1);
        if (mi) { if (l.unit_price == null) l.unit_price = n(mi.price); if (l.category == null) l.category = mi.categoryId != null ? String(mi.categoryId) : undefined; }
      }
      if (l.unit_price == null) l.unit_price = 0;
    }
    // 3. load applicable rules (date/channel/dow/time gated)
    const at = dto.at ? new Date(dto.at) : new Date();
    const bkk = new Date(at.getTime() + 7 * 3600 * 1000); // Bangkok wall-clock
    const isoDow = ((bkk.getUTCDay() + 6) % 7) + 1;        // Mon=1 … Sun=7
    const hhmm = `${pad(bkk.getUTCHours())}:${pad(bkk.getUTCMinutes())}`;
    const today = ymd(at);
    const allRules = await db.select().from(priceRules).where(eq(priceRules.active, true));
    const rules = allRules.filter((r: any) => ruleApplies(r, { channel: dto.channel, location: dto.location, isoDow, hhmm, today }));
    rules.sort((a: any, b: any) => (a.priority ?? 100) - (b.priority ?? 100));

    // 4. apply per-line rules
    const outLines = exploded.map((l) => {
      const gross = round2(l.qty * (l.unit_price ?? 0));
      const applicable = rules.filter((r: any) => scopeMatches(r, l));
      let discount = 0;
      const applied: string[] = [];
      const nonStack = applicable.filter((r: any) => !r.stackable);
      const stack = applicable.filter((r: any) => r.stackable);
      // best single non-stackable, then add all stackable
      let best: { d: number; name: string } | null = null;
      for (const r of nonStack) { const d = lineDiscount(r, l, gross); if (d > 0 && (!best || d > best.d)) best = { d, name: r.name }; }
      if (best) { discount += best.d; applied.push(best.name); }
      for (const r of stack) { const d = lineDiscount(r, l, gross); if (d > 0) { discount += d; applied.push(r.name); } }
      discount = round2(Math.min(discount, gross));
      return { sku: l.sku, qty: l.qty, unit_price: round2(l.unit_price ?? 0), gross, discount, net: round2(gross - discount), applied_rules: applied };
    });

    const subtotal = round2(outLines.reduce((a, l) => a + l.gross, 0));
    const lineDiscountTotal = round2(outLines.reduce((a, l) => a + l.discount, 0));
    // order-level rules (scope all, type percent/amount) on net subtotal
    const netSubtotal = round2(subtotal - lineDiscountTotal);
    let orderDiscount = 0;
    const orderApplied: string[] = [];
    for (const r of rules.filter((x: any) => x.scope === 'all' && (x.type === 'percent' || x.type === 'amount'))) {
      const d = r.type === 'percent' ? round2(netSubtotal * n(r.value) / 100) : Math.min(n(r.value), netSubtotal - orderDiscount);
      if (d > 0) { orderDiscount += d; orderApplied.push(r.name); if (!r.stackable) break; }
    }
    orderDiscount = round2(Math.min(orderDiscount, netSubtotal));
    const afterDiscount = round2(netSubtotal - orderDiscount);

    // 5. service charge (auto for large party), card surcharge, satang rounding
    const minParty = dto.service_min_party ?? 6;
    const scPct = dto.service_charge_pct ?? 0;
    const serviceCharge = (dto.party_size ?? 0) >= minParty && scPct > 0 ? round2(afterDiscount * scPct / 100) : 0;
    const surcharge = dto.surcharge_pct ? round2((afterDiscount + serviceCharge) * dto.surcharge_pct / 100) : 0;
    const preRound = round2(afterDiscount + serviceCharge + surcharge);
    const rounding = dto.rounding && dto.rounding > 0 ? dto.rounding : 0;
    const total = rounding ? round2(Math.round(preRound / rounding) * rounding) : preRound;
    const roundingAdj = round2(total - preRound);

    return {
      lines: outLines, subtotal, line_discount_total: lineDiscountTotal, order_discount: orderDiscount,
      order_rules: orderApplied, service_charge: serviceCharge, surcharge, rounding_adjustment: roundingAdj, total,
      context: { iso_dow: isoDow, hhmm, channel: dto.channel ?? 'any', party_size: dto.party_size ?? 0 },
    };
  }

  async getRule(id: number) {
    const db = this.db as any;
    const [r] = await db.select().from(priceRules).where(eq(priceRules.id, id)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Rule not found', messageTh: 'ไม่พบกฎราคา' });
    return mapRule(r);
  }
}

function mapRule(r: any) {
  return { id: r.id, name: r.name, scope: r.scope, target_id: r.targetId, channel: r.channel, location: r.location, dow: r.dow, time_start: r.timeStart, time_end: r.timeEnd, type: r.type, value: n(r.value), min_qty: r.minQty, priority: r.priority, stackable: r.stackable, active: r.active, valid_from: r.validFrom, valid_to: r.validTo };
}

function ruleApplies(r: any, ctx: { channel?: string; location?: string; isoDow: number; hhmm: string; today: string }): boolean {
  if (r.channel && r.channel !== 'any' && r.channel !== ctx.channel) return false;
  if (r.location && ctx.location && r.location !== ctx.location) return false;
  if (r.validFrom && ctx.today < r.validFrom) return false;
  if (r.validTo && ctx.today > r.validTo) return false;
  if (r.dow) { const days = String(r.dow).split(',').map((x: string) => x.trim()); if (!days.includes(String(ctx.isoDow))) return false; }
  if (r.timeStart && r.timeEnd) {
    const inWin = r.timeStart <= r.timeEnd ? (ctx.hhmm >= r.timeStart && ctx.hhmm <= r.timeEnd) : (ctx.hhmm >= r.timeStart || ctx.hhmm <= r.timeEnd);
    if (!inWin) return false;
  }
  return true;
}

function scopeMatches(r: any, l: QuoteLine): boolean {
  if (r.scope === 'all') return false; // order-level handled separately
  if (r.scope === 'item') return r.targetId === l.sku;
  if (r.scope === 'category') return l.category != null && r.targetId === l.category;
  return false;
}

function lineDiscount(r: any, l: QuoteLine, gross: number): number {
  const v = n(r.value);
  const price = l.unit_price ?? 0;
  switch (r.type) {
    case 'percent': return round2(gross * v / 100);
    case 'amount': return round2(Math.min(v * l.qty, gross)); // v = amount off per unit
    case 'fixed': return price > v ? round2((price - v) * l.qty) : 0; // v = fixed unit price
    case 'bogo': { const grp = (r.minQty ?? 1) + 1; const free = Math.floor(l.qty / grp); return round2(free * price); }
    case 'qty_break': return l.qty >= (r.minQty ?? 1) ? round2(gross * v / 100) : 0;
    default: return 0;
  }
}
