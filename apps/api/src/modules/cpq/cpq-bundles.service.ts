import { BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { productConfigs, quotes, quoteLines, cpqBundles, cpqBundleItems } from '../../database/schema/cpq';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// CRM-14 (CRM-12) bundles + guided-selling recommendations — extracted off CpqService (600-LOC
// service-size headroom round; ctor-body plain class, no DI). The quote/config primitives the block
// needs stay canonical on the facade and arrive as ctor closures (procurement-facade pattern).
export class CpqBundlesService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly assertConfig: (id: number) => Promise<unknown>,
    private readonly assertQuote: (id: number) => Promise<any>,
    private readonly fmtQuote: (q: any) => Record<string, unknown>,
  ) {}

  // ── CRM-14 (CRM-12): bundles — a bundle SKU priced as the discounted sum of its component configs ──

  async createBundle(dto: { code: string; name: string; description?: string; items: { config_id: number; qty?: number; unit_cost?: number }[] }, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId!;
    for (const it of dto.items) await this.assertConfig(it.config_id); // every component must be a real config
    const [b] = await db.insert(cpqBundles).values({
      tenantId, code: dto.code, name: dto.name, description: dto.description ?? null, createdBy: user.username,
    }).onConflictDoUpdate({
      target: [cpqBundles.tenantId, cpqBundles.code],
      set: { name: dto.name, description: dto.description ?? null },
    }).returning();
    const bundleId = Number(b!.id);
    await db.delete(cpqBundleItems).where(eq(cpqBundleItems.bundleId, bundleId)); // re-create items on update
    let seq = 1;
    for (const it of dto.items) {
      await db.insert(cpqBundleItems).values({
        tenantId, bundleId, configId: it.config_id, qty: fx(it.qty ?? 1, 2), unitCost: fx(it.unit_cost ?? 0, 2), sequence: seq++,
      });
    }
    return { code: b!.code, name: b!.name, items: dto.items.length };
  }

  async listBundles(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(cpqBundles).where(eq(cpqBundles.tenantId, user.tenantId!));
    return { bundles: rows.map((b: any) => ({ code: b.code, name: b.name, description: b.description, active: b.active })) };
  }

  async getBundle(code: string, user: JwtUser) {
    const db = this.db;
    const b = await this.assertBundle(code, user);
    const items = await db.select({ item: cpqBundleItems, cfg: productConfigs }).from(cpqBundleItems)
      .innerJoin(productConfigs, eq(cpqBundleItems.configId, productConfigs.id))
      .where(eq(cpqBundleItems.bundleId, Number(b.id))).orderBy(cpqBundleItems.sequence);
    return {
      code: b.code, name: b.name, description: b.description, active: b.active,
      items: items.map((r: any) => ({ config_code: r.cfg.code, config_name: r.cfg.name, qty: n(r.item.qty), unit_cost: n(r.item.unitCost), unit_price: n(r.cfg.basePrice) })),
    };
  }

  // Expand a bundle into ordinary quote_lines (bundle_code-tagged) at the quote's current line count. Pricing
  // = Σ(component base price × component qty) × bundle qty, less an optional bundle-level discount%; unit_cost
  // per component line carries the component's captured cost — so the EXISTING CPQ-01 metricsFromLines() floor
  // check on send() automatically covers the bundle's blended margin, no core service duplication.
  async addBundleLine(quoteId: number, dto: { bundle_code: string; qty?: number; discount_pct?: number }, user: JwtUser) {
    const db = this.db;
    const q = await this.assertQuote(quoteId);
    if (q.status !== 'Draft') throw new BadRequestException({ code: 'INVALID_TRANSITION', message: 'Bundle lines can only be added to a Draft quote' });
    const b = await this.assertBundle(dto.bundle_code, user);
    const items = await db.select({ item: cpqBundleItems, cfg: productConfigs }).from(cpqBundleItems)
      .innerJoin(productConfigs, eq(cpqBundleItems.configId, productConfigs.id))
      .where(eq(cpqBundleItems.bundleId, Number(b.id))).orderBy(cpqBundleItems.sequence);
    if (!items.length) throw new BadRequestException({ code: 'BUNDLE_EMPTY', message: 'Bundle has no components' });
    const bundleQty = dto.qty ?? 1;
    const discountPct = dto.discount_pct ?? 0;
    const existing = await db.select({ lineNo: quoteLines.lineNo }).from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
    let lineNo = existing.length ? Math.max(...existing.map((r: any) => r.lineNo)) + 1 : 1;
    const instanceTag = `${b.code}-${Date.now().toString(36)}`;
    const rows = items.map((r: any) => {
      const qty = round4(n(r.item.qty) * bundleQty);
      const lineTotal = round4(n(r.cfg.basePrice) * qty * (1 - discountPct / 100));
      return {
        quoteId, lineNo: lineNo++, itemCode: r.cfg.code, description: `${b.name}: ${r.cfg.name}`,
        qty: fx(qty, 2), unitPrice: fx(r.cfg.basePrice, 4), unitCost: fx(r.item.unitCost, 2),
        discountPct: fx(discountPct, 4), lineTotal: fx(lineTotal, 4), bundleCode: instanceTag,
      };
    });
    await db.insert(quoteLines).values(rows);
    const addedTotal = rows.reduce((t: number, r: any) => t + n(r.lineTotal), 0);
    const [updated] = await db.update(quotes)
      .set({ subtotal: fx(n(q.subtotal) + addedTotal, 4), total: fx(n(q.total) + addedTotal, 4) })
      .where(eq(quotes.id, quoteId)).returning();
    return { ...this.fmtQuote(updated), bundle_instance: instanceTag, lines_added: rows.length };
  }

  private async assertBundle(code: string, user: JwtUser) {
    const db = this.db;
    const [b] = await db.select().from(cpqBundles).where(and(eq(cpqBundles.code, code), eq(cpqBundles.tenantId, user.tenantId!))).limit(1);
    if (!b) throw new NotFoundException({ code: 'BUNDLE_NOT_FOUND', message: `Bundle ${code} not found`, messageTh: 'ไม่พบชุดสินค้า' });
    return b;
  }

  // ── CRM-14 (CRM-12): guided-selling recommendations ── explainable co-purchase read: for a target config,
  // which OTHER configs were bought (in a different Accepted quote) by the same customer — ranked by
  // frequency across all customers. No trained model; a pure historical co-occurrence count (mirrors the
  // G2 market-basket-affinity posture: support/count based, not ML). Considers both a single-config quote
  // (quotes.configId) and a bundle-expanded quote (quote_lines.itemCode, set to the component's config code).
  async recommendations(configCode: string, user: JwtUser) {
    const db = this.db;
    const target = await this.assertConfigByCode(configCode, user);
    const accepted = await db.select({ id: quotes.id, customerName: quotes.customerName, configId: quotes.configId })
      .from(quotes).where(and(eq(quotes.tenantId, user.tenantId!), eq(quotes.status, 'Accepted')));
    if (!accepted.length) return { config_code: configCode, recommendations: [] };
    const byCustomer = new Map<string, Set<number>>();
    const add = (customerName: string, configId: number) => {
      if (!byCustomer.has(customerName)) byCustomer.set(customerName, new Set());
      byCustomer.get(customerName)!.add(configId);
    };
    for (const r of accepted) if (r.configId != null) add(r.customerName, Number(r.configId));
    const quoteIds = accepted.map((r: any) => Number(r.id));
    const lineRows = await db.select({ quoteId: quoteLines.quoteId, itemCode: quoteLines.itemCode }).from(quoteLines).where(inArray(quoteLines.quoteId, quoteIds));
    const cfgAll = await db.select().from(productConfigs).where(eq(productConfigs.tenantId, user.tenantId!));
    const codeToId = new Map(cfgAll.map((c: any) => [c.code, Number(c.id)]));
    const quoteById = new Map(accepted.map((r: any) => [Number(r.id), r]));
    for (const l of lineRows) {
      if (!l.itemCode) continue;
      const cid = codeToId.get(l.itemCode);
      const parent = quoteById.get(Number(l.quoteId));
      if (cid == null || !parent) continue;
      add(parent.customerName, cid);
    }
    const counts = new Map<number, number>();
    for (const configs of byCustomer.values()) {
      if (!configs.has(Number(target.id))) continue;
      for (const cid of configs) { if (cid === Number(target.id)) continue; counts.set(cid, (counts.get(cid) ?? 0) + 1); }
    }
    if (!counts.size) return { config_code: configCode, recommendations: [] };
    const cfgRows = await db.select().from(productConfigs).where(eq(productConfigs.tenantId, user.tenantId!));
    const byId = new Map(cfgRows.map((c: any) => [Number(c.id), c]));
    const recs = [...counts.entries()]
      .map(([cid, count]) => ({ config_code: byId.get(cid)?.code, config_name: byId.get(cid)?.name, co_purchase_count: count }))
      .filter((r) => r.config_code)
      .sort((a, b2) => b2.co_purchase_count - a.co_purchase_count);
    return { config_code: configCode, recommendations: recs };
  }

  private async assertConfigByCode(code: string, user: JwtUser) {
    const db = this.db;
    const [c] = await db.select().from(productConfigs).where(and(eq(productConfigs.code, code), eq(productConfigs.tenantId, user.tenantId!))).limit(1);
    if (!c) throw new NotFoundException({ code: 'CONFIG_NOT_FOUND', message: `Product config ${code} not found` });
    return c;
  }
}
