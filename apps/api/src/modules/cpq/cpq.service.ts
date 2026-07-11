import { Inject, Injectable, Optional, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, sql, lte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { productConfigs, configOptions, pricingRules, quotes, quoteLines, cpqSettings, quoteApprovals } from '../../database/schema/cpq';
import { crmOpportunities } from '../../database/schema/crm-pipeline';
import { docCountersTenant } from '../../database/schema/system';
import { tenants } from '../../database/schema';
import { n, fx } from '../../database/queries';
import { LedgerService } from '../ledger/ledger.service';
import { QuotePdfService, type QuotePrintData } from './quote-pdf.service';
import { DocEmailService } from '../mail/doc-email.service';
import { sellerParty } from '../../common/doc-party';
import { normalizeA4Template } from '../../common/a4-template';
import { DocumentTemplatesService } from '../document-templates/document-templates.service';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

@Injectable()
export class CpqService {
  // @Optional ledger so the standalone cpq harness still compiles; when present, an accepted quote
  // is booked to AR + revenue (quote-to-cash).
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly ledger?: LedgerService,
    // @Optional so the standalone cpq harness (which constructs the service directly) still compiles; both
    // are provided when the app boots via CpqModule.
    @Optional() private readonly quotePdf?: QuotePdfService,
    @Optional() private readonly docEmail?: DocEmailService,
    // Resolve the tenant's active no-code quotation template at print time (presentation only). @Optional so
    // the standalone cpq harness still constructs; absent ⇒ the built-in default layout.
    @Optional() private readonly docTemplates?: DocumentTemplatesService,
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
    qty?: number; selected_options?: { group_name: string; option_code: string }[]; unit_cost?: number;
    validity_days?: number; notes?: string; lines?: { description: string; qty?: number; unit_price?: number; unit_cost?: number }[];
  }, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId!;
    const quoteNo = await this.nextQuoteNo(tenantId);
    const qty = dto.qty ?? 1;

    // CRM-1 unification (0293): opportunity_id in the DTO now references the unified spine
    // (crm_opportunities — the id every /api/pipeline and /api/crm/pipeline response returns). Validate it
    // so a dangling reference is a clean 404, and persist it on crm_opportunity_id (quotes.opportunity_id
    // is read-legacy → the retired Batch 2A table; no new row writes it).
    if (dto.opportunity_id != null) {
      const [opp] = await db.select({ id: crmOpportunities.id }).from(crmOpportunities).where(eq(crmOpportunities.id, dto.opportunity_id)).limit(1);
      if (!opp) throw new NotFoundException({ code: 'OPP_NOT_FOUND', message: `Opportunity ${dto.opportunity_id} not found`, messageTh: 'ไม่พบโอกาสการขาย' });
    }

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
      lineValues.push({ lineNo: 1, description: cfg.name, qty: fx(qty, 2), unitPrice: fx(unitPrice, 4), unitCost: fx(dto.unit_cost ?? 0, 2), discountPct: fx(discountPct, 4), lineTotal: fx(lineTotal, 4) });
      subtotal = lineTotal;
    } else if (dto.lines?.length) {
      let lineNo = 1;
      for (const l of dto.lines) {
        const q = l.qty ?? 1; const up = l.unit_price ?? 0;
        const lt = round4(q * up);
        lineValues.push({ lineNo: lineNo++, description: l.description, qty: fx(q, 2), unitPrice: fx(up, 4), unitCost: fx(l.unit_cost ?? 0, 2), discountPct: '0', lineTotal: fx(lt, 4) });
        subtotal += lt;
      }
    }

    // SVC-1 (CPQ-01): compute the quote's effective discount% (gross→net) and margin% (net vs unit cost) up
    // front so the list surfaces them; they are RE-computed authoritatively on send (the floor gate).
    const metrics = this.metricsFromLines(lineValues);

    const validityDays = dto.validity_days ?? 30;
    const issuedDate = new Date().toISOString().slice(0, 10);
    const expiresDate = new Date(Date.now() + validityDays * 86400000).toISOString().slice(0, 10);

    const [quote] = await db.insert(quotes).values({
      tenantId, quoteNo, crmOpportunityId: dto.opportunity_id ?? null, configId: dto.config_id ?? null,
      customerName: dto.customer_name, status: 'Draft', validityDays,
      issuedDate, expiresDate, currency: 'THB',
      subtotal: fx(subtotal, 4), discountTotal: '0', total: fx(subtotal, 4),
      discountPct: fx(metrics.discountPct, 3), marginPct: fx(metrics.marginPct, 3),
      notes: dto.notes ?? null, createdBy: user.username,
    }).returning();

    if (lineValues.length) {
      await db.insert(quoteLines).values(lineValues.map((l) => ({ ...l, quoteId: Number(quote!.id) })));
    }

    return this.fmtQuote(quote);
  }

  // CPQ-01 (SVC-1): sending computes the quote's effective discount% + margin% from its lines and checks the
  // per-tenant floor (cpq_settings). Within the floor → Sent as before. Breaching max_discount_pct OR below
  // min_margin_pct → the quote parks in 'PendingApproval' and a `quote_approvals` maker-checker row is opened;
  // it CANNOT reach Accepted until a DIFFERENT authorised user approves. An already-approved quote (returning
  // to send after an edit) is not re-gated.
  async sendQuote(quoteId: number, user: JwtUser) {
    const db = this.db;
    const q = await this.assertQuote(quoteId);
    if (q.status !== 'Draft') throw new BadRequestException({ code: 'INVALID_TRANSITION', message: `Cannot move from ${q.status} to Sent` });

    const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
    const m = this.metricsFromLines(lines);
    const floor = await this.getFloor(q.tenantId ?? null);
    const breach = m.discountPct > floor.maxDiscountPct + 1e-6 || m.marginPct < floor.minMarginPct - 1e-6;

    if (breach && !q.approvedBy) {
      const [updated] = await db.update(quotes)
        .set({ status: 'PendingApproval', requiresApproval: true, discountPct: fx(m.discountPct, 3), marginPct: fx(m.marginPct, 3) })
        .where(eq(quotes.id, quoteId)).returning();
      // Open (or refresh) the pending maker-checker row with the floor snapshot + the breaching actuals.
      await db.delete(quoteApprovals).where(and(eq(quoteApprovals.quoteId, quoteId), eq(quoteApprovals.status, 'pending')));
      await db.insert(quoteApprovals).values({
        tenantId: q.tenantId ?? null, quoteId, requestedBy: user.username, status: 'pending',
        reason: m.discountPct > floor.maxDiscountPct + 1e-6
          ? `Discount ${m.discountPct.toFixed(2)}% exceeds max ${floor.maxDiscountPct}%`
          : `Margin ${m.marginPct.toFixed(2)}% below floor ${floor.minMarginPct}%`,
        minMarginPct: fx(floor.minMarginPct, 3), maxDiscountPct: fx(floor.maxDiscountPct, 3),
        marginPct: fx(m.marginPct, 3), discountPct: fx(m.discountPct, 3),
      });
      return this.fmtQuote(updated);
    }

    const [updated] = await db.update(quotes)
      .set({ status: 'Sent', discountPct: fx(m.discountPct, 3), marginPct: fx(m.marginPct, 3) })
      .where(eq(quotes.id, quoteId)).returning();
    return this.fmtQuote(updated);
  }

  // CPQ-01 (SVC-1): approve a floor-breaching quote (PendingApproval → Sent). The approver MUST differ from
  // the quote's author — one person may not both discount below the floor and approve it (SOD_SELF_APPROVAL).
  async approveDiscount(quoteId: number, user: JwtUser) {
    const db = this.db;
    const q = await this.assertQuote(quoteId);
    if (q.status !== 'PendingApproval') throw new BadRequestException({ code: 'INVALID_TRANSITION', message: `Quote ${q.quoteNo} is not pending approval (status ${q.status})` });
    if (q.createdBy && q.createdBy === user.username) {
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Quote author cannot approve their own discount/margin breach — a different authorised user must approve', messageTh: 'ผู้จัดทำใบเสนอราคาไม่สามารถอนุมัติส่วนลด/มาร์จิ้นของตนเองได้ ต้องให้ผู้อื่นอนุมัติ' });
    }
    await db.update(quoteApprovals)
      .set({ status: 'approved', approvedBy: user.username, decidedAt: new Date() })
      .where(and(eq(quoteApprovals.quoteId, quoteId), eq(quoteApprovals.status, 'pending')));
    const [updated] = await db.update(quotes)
      .set({ status: 'Sent', approvedBy: user.username, approvedAt: new Date() })
      .where(eq(quotes.id, quoteId)).returning();
    return this.fmtQuote(updated);
  }

  async acceptQuote(quoteId: number, user: JwtUser) {
    const q = await this.assertQuote(quoteId);
    if (q.expiresDate && new Date(q.expiresDate) < new Date()) {
      throw new BadRequestException({ code: 'QUOTE_EXPIRED', message: 'Cannot accept expired quote', messageTh: 'ใบเสนอราคาหมดอายุแล้ว' });
    }
    // G12 (SoD R07/R10): accepting a billable quote recognises revenue (Dr 1100 AR / Cr 4000). The acceptor
    // must be a DIFFERENT user from the quote's author — one person may not both build/discount a quote and
    // self-recognise its revenue. Enforced only when revenue actually posts (ledger wired + billable total),
    // which is always so in production (CpqModule provides the ledger); the ledger-less standalone quote
    // pipeline (no GL) is a pure status transition and is unaffected.
    if (this.ledger && n(q.total) > 0 && q.createdBy && q.createdBy === user.username) {
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Quote author cannot accept their own quote — revenue recognition needs a second person', messageTh: 'ผู้จัดทำใบเสนอราคาไม่สามารถอนุมัติรับใบเสนอราคาของตนเองได้ ต้องให้ผู้อื่นอนุมัติ' });
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

  // Rejecting a quote in 'PendingApproval' is the CHECKER declining the discount/margin breach (CPQ-01): the
  // quote returns to Draft for re-work and the approver must differ from the author (SOD_SELF_APPROVAL). A
  // quote in Sent/Draft is rejected the classic way (→ Rejected).
  async rejectQuote(quoteId: number, user: JwtUser) {
    const db = this.db;
    const q = await this.assertQuote(quoteId);
    if (q.status === 'PendingApproval') {
      if (q.createdBy && q.createdBy === user.username) {
        throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Quote author cannot decide their own discount/margin breach — a different authorised user must approve/reject', messageTh: 'ผู้จัดทำใบเสนอราคาไม่สามารถอนุมัติ/ปฏิเสธส่วนลดของตนเองได้ ต้องให้ผู้อื่นดำเนินการ' });
      }
      await db.update(quoteApprovals)
        .set({ status: 'rejected', approvedBy: user.username, decidedAt: new Date() })
        .where(and(eq(quoteApprovals.quoteId, quoteId), eq(quoteApprovals.status, 'pending')));
      return this.transitionQuote(quoteId, 'Draft', ['PendingApproval'], user);
    }
    return this.transitionQuote(quoteId, 'Rejected', ['Sent', 'Draft'], user);
  }

  // ── CPQ-01: discount/margin floor settings (per tenant) ──

  async getSettings(user: JwtUser) {
    const f = await this.getFloor(user.tenantId ?? null);
    return { min_margin_pct: f.minMarginPct, max_discount_pct: f.maxDiscountPct };
  }

  async updateSettings(dto: { min_margin_pct?: number; max_discount_pct?: number }, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId!;
    const cur = await this.getFloor(tenantId);
    const minMargin = dto.min_margin_pct ?? cur.minMarginPct;
    const maxDiscount = dto.max_discount_pct ?? cur.maxDiscountPct;
    await db.insert(cpqSettings)
      .values({ tenantId, minMarginPct: fx(minMargin, 3), maxDiscountPct: fx(maxDiscount, 3), updatedBy: user.username, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [cpqSettings.tenantId], set: { minMarginPct: fx(minMargin, 3), maxDiscountPct: fx(maxDiscount, 3), updatedBy: user.username, updatedAt: new Date() } });
    return { min_margin_pct: minMargin, max_discount_pct: maxDiscount };
  }

  async listApprovals(filter: { status?: string }, user: JwtUser) {
    const db = this.db;
    const conds: any[] = [eq(quoteApprovals.tenantId, user.tenantId!)];
    if (filter.status) conds.push(eq(quoteApprovals.status, filter.status));
    const rows = await db.select().from(quoteApprovals).where(and(...conds)).orderBy(sql`${quoteApprovals.id} DESC`);
    return {
      approvals: rows.map((a: any) => ({
        id: Number(a.id), quote_id: Number(a.quoteId), status: a.status, reason: a.reason,
        requested_by: a.requestedBy, approved_by: a.approvedBy,
        min_margin_pct: n(a.minMarginPct), max_discount_pct: n(a.maxDiscountPct),
        margin_pct: n(a.marginPct), discount_pct: n(a.discountPct),
      })),
      count: rows.length,
    };
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
    return { lines: lines.map((l: any) => ({ line_no: l.lineNo, description: l.description, qty: n(l.qty), unit_price: n(l.unitPrice), unit_cost: n(l.unitCost), discount_pct: n(l.discountPct), line_total: n(l.lineTotal) })) };
  }

  // Assemble the printable ใบเสนอราคา (header + lines + our-company seller block) for the PDF/email path.
  async getQuoteForPrint(quoteId: number): Promise<QuotePrintData> {
    const db = this.db;
    const q = await this.assertQuote(quoteId);
    const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId)).orderBy(quoteLines.lineNo);
    const [t] = q.tenantId != null ? await db.select().from(tenants).where(eq(tenants.id, Number(q.tenantId))).limit(1) : [null];
    // Resolve the tenant's active quotation template (presentation only); a lookup failure never blocks the doc.
    let template = normalizeA4Template({});
    try { if (this.docTemplates) template = normalizeA4Template(await this.docTemplates.resolveActive('quotation')); } catch { /* keep default */ }
    return {
      quote_no: q.quoteNo, status: q.status, issued_date: q.issuedDate ?? null, expires_date: q.expiresDate ?? null,
      currency: q.currency ?? 'THB', customer_name: q.customerName, notes: q.notes ?? null, created_by: q.createdBy ?? null,
      seller: sellerParty(t),
      lines: lines.map((l: any) => ({ line_no: l.lineNo, item_code: l.itemCode ?? null, description: l.description, qty: n(l.qty), unit_price: n(l.unitPrice), discount_pct: n(l.discountPct), line_total: n(l.lineTotal) })),
      subtotal: n(q.subtotal), discount_total: n(q.discountTotal), total: n(q.total), template,
    };
  }

  quotationHtml(q: QuotePrintData): string {
    if (!this.quotePdf) throw new NotFoundException({ code: 'RENDERER_UNAVAILABLE', message: 'Quote renderer not wired' });
    return this.quotePdf.quotationHtml(q, q.template);
  }

  async renderQuotePdf(q: QuotePrintData): Promise<Buffer | null> {
    return this.quotePdf ? this.quotePdf.renderToPdf(this.quotePdf.quotationHtml(q, q.template)) : null;
  }

  // Email the ใบเสนอราคา to the customer as a PDF attachment (HTML fallback when Chromium is absent),
  // and mark the quote Sent (Draft → Sent) so the pipeline reflects that it went out.
  async emailQuote(quoteId: number, toEmail: string, user: JwtUser) {
    if (!this.docEmail) throw new NotFoundException({ code: 'EMAIL_UNAVAILABLE', message: 'Email path not wired' });
    const q = await this.getQuoteForPrint(quoteId);
    const html = this.quotationHtml(q);
    const res = await this.docEmail.sendDocument({
      to: toEmail, from: q.seller.email ?? undefined, filename: q.quote_no,
      subject: `ใบเสนอราคา ${q.quote_no} จาก ${q.seller.name}`,
      text: `เรียน ${q.customer_name},\n\nแนบใบเสนอราคาเลขที่ ${q.quote_no} ยอดรวม ${q.total.toLocaleString()} ${q.currency} (ยืนราคาถึง ${q.expires_date ?? '-'})\n\nขอบคุณครับ\n${q.seller.name}`,
      html,
    });
    // Transition Draft → Sent (best-effort; a re-send of an already-Sent quote just re-emails).
    if (q.status === 'Draft') { try { await this.sendQuote(quoteId, user); } catch { /* keep the email result */ } }
    return { ...res, quote_no: q.quote_no };
  }

  // ── Helpers ──

  private async transitionQuote(quoteId: number, toStatus: string, allowedFrom: string[], user: JwtUser) {
    const db = this.db;
    const q = await this.assertQuote(quoteId);
    if (!allowedFrom.includes(q.status)) throw new BadRequestException({ code: 'INVALID_TRANSITION', message: `Cannot move from ${q.status} to ${toStatus}` });
    const [updated] = await db.update(quotes).set({ status: toStatus }).where(eq(quotes.id, quoteId)).returning();
    return this.fmtQuote(updated);
  }

  // CPQ-01: derive a quote's effective discount% (gross list vs net after discounts) and margin% (net vs unit
  // cost) from its line rows. Works on either freshly-built line values (fx-string fields) or persisted rows.
  private metricsFromLines(lines: { qty: any; unitPrice: any; unitCost: any; lineTotal: any }[]) {
    let gross = 0, net = 0, cost = 0;
    for (const l of lines) {
      const qty = n(l.qty);
      gross += n(l.unitPrice) * qty;
      net += n(l.lineTotal);
      cost += n(l.unitCost) * qty;
    }
    const discountPct = gross > 0 ? ((gross - net) / gross) * 100 : 0;
    const marginPct = net > 0 ? ((net - cost) / net) * 100 : (cost > 0 ? -100 : 100);
    return { discountPct: round4(discountPct), marginPct: round4(marginPct), gross, net, cost };
  }

  // The per-tenant discount/margin floor; defaults (20% margin / 15% discount) when no row is configured.
  private async getFloor(tenantId: number | null) {
    const db = this.db;
    const rows = tenantId != null
      ? await db.select().from(cpqSettings).where(eq(cpqSettings.tenantId, tenantId)).limit(1)
      : [];
    const s = rows[0];
    return { minMarginPct: s ? n(s.minMarginPct) : 20, maxDiscountPct: s ? n(s.maxDiscountPct) : 15 };
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
  // opportunity_id resolves the unified spine link first (crm_opportunity_id), falling back to the
  // read-legacy Batch 2A pointer for pre-0293 rows that predate the data-migration backfill.
  private fmtQuote(q: any) { return { id: Number(q.id), quote_no: q.quoteNo, opportunity_id: q.crmOpportunityId != null ? Number(q.crmOpportunityId) : (q.opportunityId != null ? Number(q.opportunityId) : null), customer_name: q.customerName, status: q.status, issued_date: q.issuedDate, expires_date: q.expiresDate, subtotal: n(q.subtotal), discount_total: n(q.discountTotal), total: n(q.total), discount_pct: n(q.discountPct), margin_pct: q.marginPct != null ? n(q.marginPct) : null, requires_approval: !!q.requiresApproval, approved_by: q.approvedBy ?? null, notes: q.notes, created_by: q.createdBy }; }
}
