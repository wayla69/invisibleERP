import { Inject, Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, eq, lte, sql, desc, asc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { fluxAnalyses, fluxLines, glPeriodBalances, accounts, budgets } from '../../database/schema';
import { currentTenantStore } from '../../common/tenant-context';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const bad = (code: string, message: string, messageTh: string) => new BadRequestException({ code, message, messageTh });

type Basis = 'PL' | 'BS';
type Comparative = 'prior_period' | 'prior_year' | 'budget';
const BASES: Basis[] = ['PL', 'BS'];
const COMPARATIVES: Comparative[] = ['prior_period', 'prior_year', 'budget'];
// account types that belong to each basis (from the accounts.type enum)
const PL_TYPES = ['Revenue', 'Expense'];
const BS_TYPES = ['Asset', 'Liability', 'Equity'];
// natural balance: Revenue/Liability/Equity is a credit balance (credit − debit); Asset/Expense is debit − credit.
const signed = (type: string | null, debit: number, credit: number) =>
  (type === 'Revenue' || type === 'Liability' || type === 'Equity') ? r2(credit - debit) : r2(debit - credit);

// CLS-01 (GL-25) — Flux / variance analysis with forced explanation + sign-off. A SOX management-review
// control over the close. A preparer GENERATES a period movement analysis from gl_period_balances (P&L
// period activity, or BS cumulative balance through period-end) against a comparative (prior_period /
// prior_year / budget); each line's Δ$ / Δ% is tested against configurable thresholds. A threshold-BREACHING
// line REQUIRES a written explanation before the analysis can be signed off; an INDEPENDENT reviewer
// (≠ preparer) certifies. Posts NOTHING to the GL — a read-only aggregator over the posting snapshot.
@Injectable()
export class FluxService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private tenantId(): number | null {
    return currentTenantStore()?.tenantId ?? null;
  }

  private priorPeriod(period: string): string {
    const [y, m] = period.split('-').map(Number);
    const d = new Date(Date.UTC(y!, m! - 2, 1)); // m-2 = month before (0-indexed) the prior month
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  private priorYear(period: string): string {
    const [y, m] = period.split('-');
    return `${Number(y) - 1}-${m}`;
  }

  // ── Signed net amount per account for a period & basis, over the POSTED gl_period_balances snapshot. ──
  // P&L: the period's own activity. BS: cumulative through the end of the period (all periods ≤ period).
  private async amountsFor(tenantId: number | null, period: string, basis: Basis): Promise<Map<string, { amt: number; name: string | null; type: string | null }>> {
    const wantTypes = basis === 'PL' ? PL_TYPES : BS_TYPES;
    const conds: any[] = [];
    if (tenantId != null) conds.push(eq(glPeriodBalances.tenantId, tenantId));
    conds.push(basis === 'PL' ? eq(glPeriodBalances.period, period) : lte(glPeriodBalances.period, period));
    const rows = await this.db.select({
      account_code: glPeriodBalances.accountCode,
      account_name: accounts.name,
      account_type: accounts.type,
      debit: sql<string>`coalesce(sum(${glPeriodBalances.debit}),0)`,
      credit: sql<string>`coalesce(sum(${glPeriodBalances.credit}),0)`,
    }).from(glPeriodBalances).leftJoin(accounts, eq(glPeriodBalances.accountCode, accounts.code))
      .where(and(...conds)).groupBy(glPeriodBalances.accountCode, accounts.name, accounts.type);
    const map = new Map<string, { amt: number; name: string | null; type: string | null }>();
    for (const row of rows) {
      const type = (row.account_type as string | null) ?? null;
      if (!type || !wantTypes.includes(type)) continue; // basis filter
      map.set(row.account_code, { amt: signed(type, n(row.debit), n(row.credit)), name: (row.account_name as string | null) ?? null, type });
    }
    return map;
  }

  // ── Budget comparative: approved budgets summed per account for the period (P&L basis). ──
  private async budgetFor(tenantId: number | null, period: string): Promise<Map<string, number>> {
    const [y] = period.split('-');
    const conds: any[] = [eq(budgets.fiscalYear, Number(y)), eq(budgets.period, period), eq(budgets.status, 'Approved')];
    if (tenantId != null) conds.push(eq(budgets.tenantId, tenantId));
    const rows = await this.db.select({ account_code: budgets.accountCode, amount: sql<string>`coalesce(sum(${budgets.amount}),0)` })
      .from(budgets).where(and(...conds)).groupBy(budgets.accountCode);
    return new Map(rows.map((r: any) => [r.account_code, r2(n(r.amount))]));
  }

  // ───────────────────── Generate (build the analysis + lines) ─────────────────────
  async generate(dto: { period: string; basis?: Basis; comparative?: Comparative; threshold_abs?: number; threshold_pct?: number }, user: JwtUser) {
    if (!/^\d{4}-\d{2}$/.test(dto.period ?? '')) throw bad('BAD_PERIOD', 'period must be YYYY-MM', 'งวดต้องเป็น YYYY-MM');
    const basis: Basis = dto.basis ?? 'PL';
    if (!BASES.includes(basis)) throw bad('BAD_BASIS', `basis must be one of ${BASES.join('/')}`, 'ประเภทงบไม่ถูกต้อง');
    const comparative: Comparative = dto.comparative ?? 'prior_period';
    if (!COMPARATIVES.includes(comparative)) throw bad('BAD_COMPARATIVE', `comparative must be one of ${COMPARATIVES.join('/')}`, 'ฐานเปรียบเทียบไม่ถูกต้อง');
    if (comparative === 'budget' && basis !== 'PL') throw bad('BUDGET_PL_ONLY', 'Budget comparison is only available for the P&L basis', 'เปรียบเทียบกับงบประมาณได้เฉพาะงบกำไรขาดทุน');
    const thresholdAbs = r2(dto.threshold_abs != null ? dto.threshold_abs : 10000);
    const thresholdPct = r2(dto.threshold_pct != null ? dto.threshold_pct : 10);
    if (!(thresholdAbs >= 0) || !(thresholdPct >= 0)) throw bad('BAD_THRESHOLD', 'thresholds must be non-negative', 'เกณฑ์ต้องไม่เป็นค่าลบ');
    const tenantId = this.tenantId();

    const current = await this.amountsFor(tenantId, dto.period, basis);
    let compAmt: Map<string, number>;
    let compLabel: string;
    if (comparative === 'budget') {
      compAmt = await this.budgetFor(tenantId, dto.period);
      compLabel = 'budget';
    } else {
      compLabel = comparative === 'prior_year' ? this.priorYear(dto.period) : this.priorPeriod(dto.period);
      const compMap = await this.amountsFor(tenantId, compLabel, basis);
      compAmt = new Map([...compMap].map(([k, v]) => [k, v.amt]));
    }

    // union of accounts across the current + comparative sides
    const codes = new Set<string>([...current.keys(), ...compAmt.keys()]);
    const lineRows: any[] = [];
    let breachedCount = 0;
    for (const code of [...codes].sort()) {
      const cur = current.get(code);
      const curAmt = cur?.amt ?? 0;
      const cmp = compAmt.get(code) ?? 0;
      const delta = r2(curAmt - cmp);
      const deltaPct = Math.abs(cmp) > 1e-9 ? r2((delta / Math.abs(cmp)) * 100) : null;
      // breach = |Δ$| over the absolute threshold AND (no baseline → treat as breach if there's activity;
      // else |Δ%| over the percent threshold). Both must trip so a tiny % on a big number, or a big % on a
      // trivial number, is not flagged.
      const breached = Math.abs(delta) >= thresholdAbs && (deltaPct == null ? Math.abs(curAmt) > 1e-9 : Math.abs(deltaPct) >= thresholdPct);
      if (breached) breachedCount++;
      lineRows.push({
        accountCode: code, accountName: cur?.name ?? null, accountType: cur?.type ?? null,
        currentAmt: fx(curAmt, 2), comparativeAmt: fx(cmp, 2), deltaAmt: fx(delta, 2),
        deltaPct: deltaPct == null ? null : fx(deltaPct, 2), breached,
      });
    }

    const [analysis] = await this.db.insert(fluxAnalyses).values({
      tenantId: tenantId as number, period: dto.period, basis, comparative, comparativePeriod: compLabel,
      thresholdAbs: fx(thresholdAbs, 2), thresholdPct: fx(thresholdPct, 2), status: 'Draft',
      breachedCount, explainedCount: 0, preparedBy: user.username,
    }).returning();
    const analysisId = Number(analysis!.id);
    if (lineRows.length) {
      await this.db.insert(fluxLines).values(lineRows.map((l) => ({ ...l, tenantId: tenantId as number, analysisId })));
    }
    return this.get(analysisId);
  }

  // ───────────────────── Explain a breached line ─────────────────────
  async explain(analysisId: number, lineId: number, dto: { explanation: string }, user: JwtUser) {
    const a = await this.header(analysisId);
    if (a.status === 'Certified') throw bad('ALREADY_CERTIFIED', 'This flux analysis is already certified and can no longer be edited', 'การวิเคราะห์นี้ได้รับการรับรองแล้ว แก้ไขไม่ได้');
    if (!dto.explanation || !dto.explanation.trim()) throw bad('EXPLANATION_REQUIRED', 'An explanation is required', 'ต้องระบุคำอธิบาย');
    const [line] = await this.db.select().from(fluxLines).where(and(eq(fluxLines.id, lineId), eq(fluxLines.analysisId, analysisId))).limit(1);
    if (!line) throw new NotFoundException({ code: 'LINE_NOT_FOUND', message: `Flux line ${lineId} not found on analysis ${analysisId}`, messageTh: 'ไม่พบรายการวิเคราะห์' });
    if (!line.breached) throw bad('LINE_NOT_BREACHED', 'Only threshold-breaching lines require an explanation', 'อธิบายได้เฉพาะรายการที่เกินเกณฑ์');
    await this.db.update(fluxLines).set({ explanation: dto.explanation.trim(), explainedBy: user.username, explainedAt: new Date() }).where(eq(fluxLines.id, lineId));
    await this.recount(analysisId);
    return this.get(analysisId);
  }

  // Re-derive breached/explained counts + advance status Draft→Explained when every breached line is explained.
  private async recount(analysisId: number) {
    const lines = await this.db.select().from(fluxLines).where(eq(fluxLines.analysisId, analysisId));
    const breached = lines.filter((l: any) => l.breached);
    const explained = breached.filter((l: any) => l.explanation && String(l.explanation).trim());
    const a = await this.header(analysisId);
    const status = a.status === 'Certified' ? 'Certified' : (breached.length > 0 && explained.length === breached.length ? 'Explained' : 'Draft');
    await this.db.update(fluxAnalyses).set({ breachedCount: breached.length, explainedCount: explained.length, status }).where(eq(fluxAnalyses.id, analysisId));
  }

  // ───────────────────── Review / sign-off (maker-checker) ─────────────────────
  async review(analysisId: number, dto: { note?: string }, user: JwtUser) {
    const a = await this.header(analysisId);
    if (a.status === 'Certified') throw bad('ALREADY_CERTIFIED', 'This flux analysis is already certified', 'การวิเคราะห์นี้ได้รับการรับรองแล้ว');
    const lines = await this.db.select().from(fluxLines).where(eq(fluxLines.analysisId, analysisId));
    const unexplained = lines.filter((l: any) => l.breached && !(l.explanation && String(l.explanation).trim()));
    if (unexplained.length) {
      throw bad('UNEXPLAINED_LINES', `${unexplained.length} threshold-breaching line(s) must be explained before sign-off`, `มีรายการที่เกินเกณฑ์ ${unexplained.length} รายการที่ต้องอธิบายก่อนลงนามรับรอง`);
    }
    // Maker-checker (SoD): the reviewer must differ from the preparer.
    if (a.preparedBy && a.preparedBy === user.username) {
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot sign off a flux analysis you prepared', messageTh: 'ผู้จัดทำลงนามรับรองการวิเคราะห์ของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    await this.db.update(fluxAnalyses).set({ status: 'Certified', reviewedBy: user.username, reviewedAt: new Date(), note: dto.note?.trim() ?? a.note ?? null }).where(eq(fluxAnalyses.id, analysisId));
    return this.get(analysisId);
  }

  // ───────────────────── Read ─────────────────────
  async list() {
    const tenantId = this.tenantId();
    const rows = await this.db.select().from(fluxAnalyses)
      .where(tenantId == null ? undefined : eq(fluxAnalyses.tenantId, tenantId))
      .orderBy(desc(fluxAnalyses.id)).limit(200);
    return { analyses: rows.map((r: any) => this.mapHeader(r)), count: rows.length };
  }

  async get(analysisId: number) {
    const a = await this.header(analysisId);
    const lines = await this.db.select().from(fluxLines).where(eq(fluxLines.analysisId, analysisId)).orderBy(asc(fluxLines.accountCode));
    return { analysis: this.mapHeader(a), lines: lines.map((l: any) => this.mapLine(l)) };
  }

  private async header(analysisId: number) {
    const [a] = await this.db.select().from(fluxAnalyses).where(eq(fluxAnalyses.id, analysisId)).limit(1);
    if (!a) throw new NotFoundException({ code: 'ANALYSIS_NOT_FOUND', message: `Flux analysis ${analysisId} not found`, messageTh: 'ไม่พบการวิเคราะห์' });
    return a;
  }

  private mapHeader(a: any) {
    return {
      id: Number(a.id), period: a.period, basis: a.basis, comparative: a.comparative, comparative_period: a.comparativePeriod,
      threshold_abs: n(a.thresholdAbs), threshold_pct: n(a.thresholdPct), status: a.status,
      breached_count: Number(a.breachedCount), explained_count: Number(a.explainedCount),
      prepared_by: a.preparedBy, prepared_at: a.preparedAt ?? null, reviewed_by: a.reviewedBy ?? null, reviewed_at: a.reviewedAt ?? null, note: a.note ?? null,
    };
  }
  private mapLine(l: any) {
    return {
      id: Number(l.id), account_code: l.accountCode, account_name: l.accountName, account_type: l.accountType,
      current_amt: n(l.currentAmt), comparative_amt: n(l.comparativeAmt), delta_amt: n(l.deltaAmt), delta_pct: l.deltaPct == null ? null : n(l.deltaPct),
      breached: l.breached, explanation: l.explanation ?? null, explained_by: l.explainedBy ?? null, explained_at: l.explainedAt ?? null,
    };
  }
}
