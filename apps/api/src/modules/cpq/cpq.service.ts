import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, sql, lte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { productConfigs, configOptions, pricingRules, quotes, quoteLines } from '../../database/schema/cpq';
import { docCountersTenant } from '../../database/schema/system';
import { n, fx } from '../../database/queries';
import { LedgerService } from '../ledger/ledger.service';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

@Injectable()
export class CpqService {
  // @Optional ledger so the standalone cpq harness still compiles; when present, an accepted quote
  // is booked to AR + revenue (quote-to-cash).
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  // ── Product Configs ──

  async createConfig(dto: { code: string; name: string; base_price?: number; description?: string }, user: JwtUser) {
    const db = this.db;
    const [cfg] = await db.insert(productConfigs).values({
      tenantId: user.tenantId!, code: dto.code, name: dto.name,
      basePrice: fx(dto.base_price ?? 0, 4), description: dto.description ?? null, isActive: true,
    }).onConflictDoUpdate({
      target: [productConfigs.tenantId, productConfigs.code],
      set: { name: dto.name, basePrice: fx(dto.base_price ?? 0, 4), description: dto.description ?? null },
    }).returning();
    return this.fmtConfig(cfg);
  }

  async addOption(configId: number, dto: { group_name: string; option_code: string; option_name: string; price_delta?: number; is_default?: boolean }, user: JwtUser) {
    const db = this.db;
    await this.assertConfig(configId);
    const [opt] = await db.insert(configOptions).values({
      configId, groupName: dto.group_name, optionCode: dto.option_code,
      optionName: dto.option_name, priceDelta: fx(dto.price_delta ?? 0, 4),
      isDefault: dto.is_default ?? false, isActive: true,
    }).onConflictDoUpdate({
      target: [configOptions.configId, configOptions.groupName, configOptions.optionCode],
      set: { optionName: dto.option_name, priceDelta: fx(dto.price_delta ?? 0, 4) },
    }).returning();
    return { id: Number(opt!.id), group_name: opt!.groupName, option_code: opt!.optionCode, option_name: opt!.optionName, price_delta: n(opt!.priceDelta) };
  }

  async listConfigs(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(productConfigs).where(and(eq(productConfigs.tenantId, user.tenantId!), eq(productConfigs.isActive, true)));
    return { configs: rows.map((c: any) => this.fmtConfig(c)), count: rows.length };
  }

  // ── Pricing Rules ──

  async createRule(dto: { config_id?: number; name: string; rule_type?: string; discount_pct: number; min_qty?: number }, user: JwtUser) {
    const db = this.db;
    const [rule] = await db.insert(pricingRules).values({
      tenantId: user.tenantId!, configId: dto.config_id ?? null,
      name: dto.name, ruleType: dto.rule_type ?? 'volume',
      discountPct: fx(dto.discount_pct, 4), minQty: dto.min_qty ?? 1, isActive: true,
    }).returning();
    return { id: Number(rule!.id), name: rule!.name, rule_type: rule!.ruleType, discount_pct: n(rule!.discountPct), min_qty: rule!.minQty };
  }

  // ── Quotes ──

  private async nextQuoteNo(tenantId: number) {
    const db = this.db;
    const r = await db.insert(docCountersTenant)
      .values({ docType: 'QT', tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `QT-${String(Number(r[0]!.n)).padStart(5, '0')}`;
  }

  async createQuote(dto: {
    customer_name: string; opportunity_id?: number; config_id?: number;
    qty?: number; selected_options?: { group_name: string; option_code: string }[];
    validity_days?: number; notes?: string; lines?: { description: string; qty?: number; unit_price?: number }[];
  }, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId!;
    const quoteNo = await this.nextQuoteNo(tenantId);
    const qty = dto.qty ?? 1;

    let subtotal = 0;
    const lineValues: any[] = [];

    if (dto.config_id) {
      const cfg = await this.assertConfig(dto.config_id);
      let unitPrice = n(cfg.basePrice);

      // Add selected option deltas
      if (dto.selected_options?.length) {
        const opts = await db.select().from(configOptions)
          .where(and(eq(configOptions.configId, dto.config_id), eq(configOptions.isActive, true)));
        for (const sel of dto.selected_options) {
          const opt = opts.find((o: any) => o.groupName === sel.group_name && o.optionCode === sel.option_code);
          if (opt) unitPrice += n(opt.priceDelta);
        }
      }

      // Apply best matching pricing rule (volume discount)
      const rules = await db.select().from(pricingRules)
        .where(and(eq(pricingRules.configId, dto.config_id), eq(pricingRules.isActive, true), lte(pricingRules.minQty, qty)))
        .orderBy(sql`${pricingRules.discountPct} DESC`);
      const bestRule = rules[0];
      const discountPct = bestRule ? n(bestRule.discountPct) : 0;

      const lineTotal = round4(unitPrice * qty * (1 - discountPct / 100));
      lineValues.push({ lineNo: 1, description: cfg.name, qty: fx(qty, 2), unitPrice: fx(unitPrice, 4), discountPct: fx(discountPct, 4), lineTotal: fx(lineTotal, 4) });
      subtotal = lineTotal;
    } else if (dto.lines?.length) {
      let lineNo = 1;
      for (const l of dto.lines) {
        const q = l.qty ?? 1; const up = l.unit_price ?? 0;
        const lt = round4(q * up);
        lineValues.push({ lineNo: lineNo++, description: l.description, qty: fx(q, 2), unitPrice: fx(up, 4), discountPct: '0', lineTotal: fx(lt, 4) });
        subtotal += lt;
      }
    }

    const validityDays = dto.validity_days ?? 30;
    const issuedDate = new Date().toISOString().slice(0, 10);
    const expiresDate = new Date(Date.now() + validityDays * 86400000).toISOString().slice(0, 10);

    const [quote] = await db.insert(quotes).values({
      tenantId, quoteNo, opportunityId: dto.opportunity_id ?? null, configId: dto.config_id ?? null,
      customerName: dto.customer_name, status: 'Draft', validityDays,
      issuedDate, expiresDate, currency: 'THB',
      subtotal: fx(subtotal, 4), discountTotal: '0', total: fx(subtotal, 4),
      notes: dto.notes ?? null, createdBy: user.username,
    }).returning();

    if (lineValues.length) {
      await db.insert(quoteLines).values(lineValues.map((l) => ({ ...l, quoteId: Number(quote!.id) })));
    }

    return this.fmtQuote(quote);
  }

  async sendQuote(quoteId: number, user: JwtUser) {
    return this.transitionQuote(quoteId, 'Sent', ['Draft'], user);
  }

  async acceptQuote(quoteId: number, user: JwtUser) {
    const q = await this.assertQuote(quoteId);
    if (q.expiresDate && new Date(q.expiresDate) < new Date()) {
      throw new BadRequestException({ code: 'QUOTE_EXPIRED', message: 'Cannot accept expired quote', messageTh: 'ใบเสนอราคาหมดอายุแล้ว' });
    }
    const res = await this.transitionQuote(quoteId, 'Accepted', ['Sent'], user);
    // quote-to-cash: book the won quote to AR + revenue (idempotent per quote)
    if (this.ledger && n(q.total) > 0) {
      const tenantId = user.tenantId ?? null;
      if (!(await this.ledger.alreadyPosted('CPQ-WIN', q.quoteNo, tenantId))) {
        const je: any = await this.ledger.postEntry({
          source: 'CPQ-WIN', sourceRef: q.quoteNo, tenantId, memo: `Quote accepted ${q.quoteNo}`, createdBy: user.username,
          lines: [
            { account_code: '1100', debit: n(q.total), memo: `AR — ${q.customerName}` },
            { account_code: '4000', credit: n(q.total), memo: 'Sales revenue (CPQ)' },
          ],
        });
        return { ...res, entry_no: je.entry_no, ar_posted: n(q.total) };
      }
    }
    return res;
  }

  async rejectQuote(quoteId: number, user: JwtUser) {
    return this.transitionQuote(quoteId, 'Rejected', ['Sent', 'Draft'], user);
  }

  async listQuotes(filter: { status?: string }, user: JwtUser) {
    const db = this.db;
    const conds: any[] = [eq(quotes.tenantId, user.tenantId!)];
    if (filter.status) conds.push(eq(quotes.status, filter.status));
    const rows = await db.select().from(quotes).where(and(...conds)).orderBy(sql`${quotes.id} DESC`);
    return { quotes: rows.map((q: any) => this.fmtQuote(q)), count: rows.length };
  }

  async getQuoteLines(quoteId: number) {
    const db = this.db;
    const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId)).orderBy(quoteLines.lineNo);
    return { lines: lines.map((l: any) => ({ line_no: l.lineNo, description: l.description, qty: n(l.qty), unit_price: n(l.unitPrice), discount_pct: n(l.discountPct), line_total: n(l.lineTotal) })) };
  }

  // ── Helpers ──

  private async transitionQuote(quoteId: number, toStatus: string, allowedFrom: string[], user: JwtUser) {
    const db = this.db;
    const q = await this.assertQuote(quoteId);
    if (!allowedFrom.includes(q.status)) throw new BadRequestException({ code: 'INVALID_TRANSITION', message: `Cannot move from ${q.status} to ${toStatus}` });
    const [updated] = await db.update(quotes).set({ status: toStatus }).where(eq(quotes.id, quoteId)).returning();
    return this.fmtQuote(updated);
  }

  private async assertConfig(id: number) {
    const db = this.db;
    const [c] = await db.select().from(productConfigs).where(eq(productConfigs.id, id)).limit(1);
    if (!c) throw new NotFoundException({ code: 'CONFIG_NOT_FOUND', message: `Product config ${id} not found` });
    return c;
  }

  private async assertQuote(id: number) {
    const db = this.db;
    const [q] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
    if (!q) throw new NotFoundException({ code: 'QUOTE_NOT_FOUND', message: `Quote ${id} not found` });
    return q;
  }

  private fmtConfig(c: any) { return { id: Number(c.id), code: c.code, name: c.name, base_price: n(c.basePrice), currency: c.currency, description: c.description }; }
  private fmtQuote(q: any) { return { id: Number(q.id), quote_no: q.quoteNo, customer_name: q.customerName, status: q.status, issued_date: q.issuedDate, expires_date: q.expiresDate, subtotal: n(q.subtotal), discount_total: n(q.discountTotal), total: n(q.total), notes: q.notes, created_by: q.createdBy }; }
}
