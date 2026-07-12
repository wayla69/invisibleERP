import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { consolidationGroups, consolidationEntities, consolidationRuns, consolidationRunLines, consolEliminationRules, segmentDefinitions } from '../../database/schema/consolidation';
import { journalEntries, journalLines } from '../../database/schema/ledger';
import { accounts } from '../../database/schema/ledger';
import { icTransactions } from '../../database/schema/intercompany';
import { icLoans, icLoanAccruals } from '../../database/schema/treasury-pool';
import { icReconPeriods } from '../../database/schema/ic-recon';
import { fxRates } from '../../database/schema/fx';
import { n, fx } from '../../database/queries';
import { CASH_ACCOUNTS, CF_CLASSIFY } from '../ledger/ledger-constants';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// FIN-5 — CTA/OCI translation reserve equity account (parks the average-vs-closing translation difference).
const CTA_ACCOUNT = '3400';
// P&L accounts (revenue 4xxx, expense 5xxx) translate at the period AVERAGE rate; everything else (the
// balance sheet) at the CLOSING rate. The dual-rate difference is the cumulative translation adjustment.
const isPnl = (code: string) => code.startsWith('4') || code.startsWith('5');

@Injectable()
export class ConsolidationService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private hqOnly(user: JwtUser) {
    if (user.role !== 'Admin') throw new ForbiddenException({ code: 'CONSOL_HQ_ONLY', message: 'Consolidation is HQ-only', messageTh: 'การรวมงบการเงินทำได้เฉพาะสำนักงานใหญ่' });
  }

  // ── Groups ──

  async createGroup(dto: { name: string; fiscal_year: number; base_currency?: string; notes?: string }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    const [g] = await db.insert(consolidationGroups).values({
      tenantId: user.tenantId ?? null,
      name: dto.name,
      baseCurrency: dto.base_currency ?? 'THB',
      fiscalYear: dto.fiscal_year,
      notes: dto.notes ?? null,
      createdBy: user.username,
    }).returning();
    return this.fmtGroup(g);
  }

  async listGroups(user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    const rows = await db.select().from(consolidationGroups).orderBy(consolidationGroups.fiscalYear);
    return { groups: rows.map((g: any) => this.fmtGroup(g)), count: rows.length };
  }

  async addEntity(groupId: number, dto: { entity_tenant_id: number; ownership_pct?: number; entity_currency?: string }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    await this.assertGroup(groupId);
    const [e] = await db.insert(consolidationEntities).values({
      groupId, entityTenantId: dto.entity_tenant_id,
      ownershipPct: fx(dto.ownership_pct ?? 100, 4),
      entityCurrency: dto.entity_currency ?? 'THB',
      isActive: true,
    }).onConflictDoUpdate({
      target: [consolidationEntities.groupId, consolidationEntities.entityTenantId],
      set: { ownershipPct: fx(dto.ownership_pct ?? 100, 4), entityCurrency: dto.entity_currency ?? 'THB', isActive: true },
    }).returning();
    return { id: Number(e!.id), group_id: groupId, entity_tenant_id: Number(e!.entityTenantId), ownership_pct: n(e!.ownershipPct), entity_currency: e!.entityCurrency };
  }

  async removeEntity(groupId: number, entityTenantId: number, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    await db.update(consolidationEntities)
      .set({ isActive: false })
      .where(and(eq(consolidationEntities.groupId, groupId), eq(consolidationEntities.entityTenantId, entityTenantId)));
    return { removed: true };
  }

  async listEntities(groupId: number, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    const rows = await db.select().from(consolidationEntities).where(and(eq(consolidationEntities.groupId, groupId), eq(consolidationEntities.isActive, true)));
    return { entities: rows.map((e: any) => ({ id: Number(e.id), entity_tenant_id: Number(e.entityTenantId), ownership_pct: n(e.ownershipPct), entity_currency: e.entityCurrency })) };
  }

  // ── Consolidation Run ──

  async runConsolidation(groupId: number, dto: { period: string }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    await this.assertGroup(groupId);
    const period = dto.period; // 'YYYY-MM'

    // REC-03 — intercompany reconciliation sign-off gate: the period's IC balances (Due-From 1150 vs Due-To
    // 2150) must be reconciled and independently APPROVED before consolidation eliminates them. A re-run of an
    // existing (Draft/Final, not Posted) consolidation is allowed once the period's sign-off is Approved.
    const [icr] = await db.select().from(icReconPeriods)
      .where(and(eq(icReconPeriods.groupId, groupId), eq(icReconPeriods.period, period))).limit(1);
    if (!icr || icr.status !== 'Approved') {
      throw new BadRequestException({ code: 'IC_RECON_NOT_APPROVED', message: `Intercompany reconciliation for ${period} must be reviewed and approved before consolidation elimination`, messageTh: `ต้องกระทบยอดและอนุมัติรายการระหว่างกันงวด ${period} ก่อนการรวมงบ` });
    }

    const entities = await db.select().from(consolidationEntities)
      .where(and(eq(consolidationEntities.groupId, groupId), eq(consolidationEntities.isActive, true)));
    if (!entities.length) throw new BadRequestException({ code: 'NO_ENTITIES', message: 'Group has no active entities', messageTh: 'ไม่มีบริษัทในกลุ่ม' });

    const entityTenantIds = entities.map((e: any) => Number(e.entityTenantId));

    // Idempotent per (group, period): a Posted run is frozen — block recompute (CON-03 maker-checker).
    // A prior Draft/Final run for the same period is superseded by a fresh recompute (delete its lines).
    const [prior] = await db.select().from(consolidationRuns)
      .where(and(eq(consolidationRuns.groupId, groupId), eq(consolidationRuns.period, period)))
      .orderBy(sql`${consolidationRuns.id} DESC`).limit(1);
    if (prior?.status === 'Posted') {
      throw new BadRequestException({ code: 'ALREADY_POSTED', message: `Consolidation for ${period} is already posted`, messageTh: `การรวมงบงวด ${period} โพสต์แล้ว` });
    }
    if (prior) {
      await db.delete(consolidationRunLines).where(eq(consolidationRunLines.runId, Number(prior.id)));
      await db.delete(consolidationRuns).where(eq(consolidationRuns.id, Number(prior.id)));
    }

    // Insert run header
    const [run] = await db.insert(consolidationRuns).values({ groupId, period, status: 'Draft', runBy: user.username }).returning();
    const runId = Number(run!.id);

    const runLineValues: any[] = [];

    // Batch ALL entities' GL nets in one grouped query (was one aggregate per entity → N+1).
    const glAll = await db.select({
      tenantId: journalEntries.tenantId,
      accountCode: journalLines.accountCode,
      net: sql<string>`sum(${journalLines.debit}) - sum(${journalLines.credit})`,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(inArray(journalEntries.tenantId, entityTenantIds), eq(journalEntries.period, period), eq(journalEntries.status, 'Posted')))
      .groupBy(journalEntries.tenantId, journalLines.accountCode);
    const glByTenant = new Map<number, { accountCode: string; net: string }[]>();
    for (const r of glAll) { const k = Number(r.tenantId); const a = glByTenant.get(k) ?? []; a.push({ accountCode: r.accountCode, net: r.net }); glByTenant.set(k, a); }
    // ── FIN-5: dual-rate translation (IAS 21 / TAS 21) ──
    // Prefetch, per distinct non-THB entity currency, BOTH a CLOSING rate (latest approved rate ≤ period end,
    // for the balance sheet) and an AVERAGE rate (mean of approved rates within the period month, for the P&L).
    const periodEnd = `${period}-28`;   // safe last-day proxy (closing-rate cutoff — unchanged behaviour)
    const monthStart = `${period}-01`;
    const monthEnd = `${period}-31`;    // lexical upper bound over YYYY-MM-DD (captures the whole month)
    const currencies = [...new Set(entities.map((e: any) => e.entityCurrency ?? 'THB').filter((c: string) => c !== 'THB'))] as string[];
    const closingMap = new Map<string, number>();
    const avgMap = new Map<string, number>();
    if (currencies.length) {
      const fxRows = await db.select({ currency: fxRates.currency, rateDate: fxRates.rateDate, rate: fxRates.rate })
        .from(fxRates).where(and(inArray(fxRates.currency, currencies), eq(fxRates.status, 'Approved'), sql`${fxRates.rateDate} <= ${monthEnd}`))
        .orderBy(sql`${fxRates.rateDate} DESC`);
      const avgAccum = new Map<string, { sum: number; count: number }>();
      for (const r of fxRows) {
        const d = String(r.rateDate);
        // closing = latest approved rate on/before the period-end cutoff (first hit per currency, rows are DESC)
        if (d <= periodEnd && !closingMap.has(r.currency)) closingMap.set(r.currency, n(r.rate));
        // average = mean of the approved rates dated within the period month
        if (d >= monthStart && d <= monthEnd) {
          const a = avgAccum.get(r.currency) ?? { sum: 0, count: 0 };
          a.sum += n(r.rate); a.count += 1; avgAccum.set(r.currency, a);
        }
      }
      for (const [c, a] of avgAccum) if (a.count) avgMap.set(c, round4(a.sum / a.count));
    }

    // ── Step 1: Collect each entity's GL net by account, translating P&L at average / BS at closing (FIN-5) ──
    for (const ent of entities) {
      const entityTenantId = Number(ent.entityTenantId);
      const ownerPct = n(ent.ownershipPct) / 100; // e.g. 0.8 for 80%
      const entCurrency = ent.entityCurrency ?? 'THB';
      const isThb = entCurrency === 'THB';
      const glRows = glByTenant.get(entityTenantId) ?? [];
      const closingRate = isThb ? 1 : (closingMap.get(entCurrency) ?? 1);
      // No in-month average rate ⇒ fall back to the closing rate (degenerate: no CTA arises).
      const averageRate = isThb ? 1 : (avgMap.get(entCurrency) ?? closingRate);

      // P&L net income calculation for NCI:  netIncome = -(SUM of P&L account nets)
      // P&L accounts are 4xxx (revenue, normal credit) and 5xxx (expense, normal debit).
      // net = debit - credit, so revenue net < 0, expense net > 0.
      // Net income = -SUM(net_4xxx) - SUM(net_5xxx) ... but revenue is negative and expense is positive:
      // netIncome = -(net_4xxx + net_5xxx) where 4xxx negative and 5xxx positive
      // = -( (-revenue) + expense ) = revenue - expense ✓ — evaluated at the AVERAGE rate.
      let plNetSum = 0;
      // Sum of every translated entity line; under dual-rate translation this no longer nets to zero — the
      // residual is the cumulative translation adjustment (CTA), parked in the OCI reserve below.
      let entityTranslated = 0;

      for (const row of glRows) {
        const rawNet = n(row.net);
        const pnl = isPnl(row.accountCode);
        const rate = pnl ? averageRate : closingRate;
        const translatedNet = round4(rawNet * rate);
        entityTranslated = round4(entityTranslated + translatedNet);
        runLineValues.push({ runId, lineType: 'Entity', entityTenantId, accountCode: row.accountCode, amountThb: fx(translatedNet, 4), fxRate: fx(rate, 8), rateType: isThb ? null : (pnl ? 'average' : 'closing') });

        if (pnl) plNetSum += rawNet * averageRate;
      }

      // ── CTA / OCI: the average-rate-P&L vs closing-rate-BS translation difference (IAS 21) ──
      // Adding CTA = −(Σ translated entity lines) makes each foreign entity's translated trial balance
      // balance again; for a THB (base-currency) entity the residual is 0, so no CTA line is produced.
      if (Math.abs(entityTranslated) > 1e-6) {
        const cta = round4(-entityTranslated);
        runLineValues.push({ runId, lineType: 'FX_CTA', entityTenantId, accountCode: CTA_ACCOUNT, amountThb: fx(cta, 4), rateType: 'cta', notes: `CTA (avg-rate P&L vs closing-rate BS) entity ${entityTenantId}` });
      }

      // ── NCI for entities not 100% owned ──
      if (ownerPct < 1 - 1e-6) {
        const nciPct = 1 - ownerPct;
        const netIncome = round4(-plNetSum); // flip sign: see derivation above
        const nciAmount = round4(netIncome * nciPct);
        if (Math.abs(nciAmount) > 1e-6) {
          runLineValues.push({ runId, lineType: 'NCI', entityTenantId: null, accountCode: '3300', amountThb: fx(nciAmount, 4), notes: `NCI ${Math.round(nciPct * 100)}% of entity ${entityTenantId}` });
        }
      }
    }

    // ── Step 2: IC Elimination ──
    // Find IC transactions where BOTH sides are within the group for the period
    const icRows = await db.select().from(icTransactions).where(
      and(
        inArray(icTransactions.fromTenantId, entityTenantIds),
        inArray(icTransactions.toTenantId, entityTenantIds),
        sql`to_char(${icTransactions.txnDate},'YYYY-MM') = ${period}`,
      )
    );

    for (const ic of icRows) {
      const amt = n(ic.amount);
      // Eliminate Due-From (1150) on creditor side: debit by amt → offset is credit (negative net)
      runLineValues.push({ runId, lineType: 'Elimination', entityTenantId: null, accountCode: '1150', amountThb: fx(-amt, 4), notes: `Elim IC ${ic.icNo}` });
      // Eliminate Due-To (2150) on debtor side: credit by amt → offset is debit (positive net)
      runLineValues.push({ runId, lineType: 'Elimination', entityTenantId: null, accountCode: '2150', amountThb: fx(amt, 4), notes: `Elim IC ${ic.icNo}` });
    }

    // ── Step 2b: IC-loan elimination (TRE-05) ──
    // An intercompany LOAN posts a Due-From-loan receivable (1155, creditor) mirrored by a Due-To-loan payable
    // (2155, debtor), and its EIR interest posts creditor income (4700) mirrored by debtor expense (5900). For a
    // loan whose BOTH legs are in the group, these must ELIMINATE at the group layer — so group balances net to
    // zero (1155 vs 2155) AND group finance cost/income nets to zero (4700 vs 5900) — mirroring the trade-IC
    // 1150/2150 pair above. This IS control TRE-05's core. Per period: the receivable eliminated = the principal
    // drawn in the period (drawdown posted at approval, dated start_date) + the interest accrued in the period;
    // the payable is its mirror; the interest nets the creditor 4700 income against the debtor 5900 expense.
    const loanRows = await db.select().from(icLoans).where(
      and(inArray(icLoans.creditorTenantId, entityTenantIds), inArray(icLoans.debtorTenantId, entityTenantIds)),
    );
    let icLoanEliminations = 0;
    for (const loan of loanRows) {
      if (loan.status === 'PendingApproval' || loan.status === 'Rejected') continue; // no GL yet
      const principalInPeriod = String(loan.startDate ?? '').slice(0, 7) === period ? n(loan.principal) : 0;
      const [accr] = await db.select({ sum: sql<string>`coalesce(sum(${icLoanAccruals.interest}),0)` })
        .from(icLoanAccruals).where(and(eq(icLoanAccruals.loanId, Number(loan.id)), eq(icLoanAccruals.period, period)));
      const interestInPeriod = round4(n(accr?.sum));
      const receivableInPeriod = round4(principalInPeriod + interestInPeriod);
      if (Math.abs(receivableInPeriod) < 1e-6 && Math.abs(interestInPeriod) < 1e-6) continue;
      icLoanEliminations++;
      if (Math.abs(receivableInPeriod) > 1e-6) {
        // Eliminate 1155 (creditor receivable, positive net) ↔ 2155 (debtor payable, negative net).
        runLineValues.push({ runId, lineType: 'Elimination', entityTenantId: null, accountCode: '1155', amountThb: fx(-receivableInPeriod, 4), notes: `Elim IC loan ${loan.loanNo} receivable` });
        runLineValues.push({ runId, lineType: 'Elimination', entityTenantId: null, accountCode: '2155', amountThb: fx(receivableInPeriod, 4), notes: `Elim IC loan ${loan.loanNo} payable` });
      }
      if (Math.abs(interestInPeriod) > 1e-6) {
        // Eliminate the IC interest: 4700 creditor income (negative net) ↔ 5900 debtor expense (positive net).
        runLineValues.push({ runId, lineType: 'Elimination', entityTenantId: null, accountCode: '4700', amountThb: fx(interestInPeriod, 4), notes: `Elim IC loan ${loan.loanNo} interest income` });
        runLineValues.push({ runId, lineType: 'Elimination', entityTenantId: null, accountCode: '5900', amountThb: fx(-interestInPeriod, 4), notes: `Elim IC loan ${loan.loanNo} interest expense` });
      }
    }

    // Insert all lines
    if (runLineValues.length) {
      await db.insert(consolidationRunLines).values(runLineValues);
    }

    // Return consolidated totals by account
    const lines = await db.select().from(consolidationRunLines).where(eq(consolidationRunLines.runId, runId));
    const totals: Record<string, number> = {};
    for (const l of lines) totals[l.accountCode] = round4((totals[l.accountCode] ?? 0) + n(l.amountThb));

    // ── CON-03: elimination integrity — the consolidated TB must still balance ──
    // Each line amount is a signed net (debit − credit). Under dual-rate translation an entity's raw lines no
    // longer net to 0, but each entity's FX_CTA plug restores balance (Entity + FX_CTA net to 0 per entity),
    // and each elimination pair (−amt on 1150, +amt on 2150) nets to 0 — so the combined+eliminated+CTA TB
    // must sum to ~0. The NCI line is a single-sided presentation reclass within equity (not a posting), so it
    // is EXCLUDED from the balance check. If the remaining lines don't net to zero, translation/eliminations
    // are unbalanced.
    const tbSum = round4(lines.filter((l: any) => l.lineType !== 'NCI').reduce((a: number, l: any) => a + n(l.amountThb), 0));
    // Eliminations alone must net to zero (reciprocal IC cancels).
    const elimSum = round4(lines.filter((l: any) => l.lineType === 'Elimination').reduce((a: number, l: any) => a + n(l.amountThb), 0));
    const balanced = Math.abs(tbSum) < 0.01 && Math.abs(elimSum) < 0.01;

    if (!balanced) {
      // Roll back the unbalanced run so a failed integrity check leaves no half-finished Draft behind.
      await db.delete(consolidationRunLines).where(eq(consolidationRunLines.runId, runId));
      await db.delete(consolidationRuns).where(eq(consolidationRuns.id, runId));
      throw new BadRequestException({ code: 'CONSOL_UNBALANCED', message: `Consolidated TB does not balance (TB net ${tbSum}, eliminations net ${elimSum})`, messageTh: `งบรวมไม่สมดุล (TB ${tbSum}, รายการตัดบัญชี ${elimSum})` });
    }

    // Mark run Final (computed + balanced); maker-checker post happens via postConsolidation.
    await db.update(consolidationRuns).set({ status: 'Final', balanced }).where(eq(consolidationRuns.id, runId));

    // FIN-5: total cumulative translation adjustment parked in OCI (3400) this run.
    const ctaTotal = round4(lines.filter((l: any) => l.lineType === 'FX_CTA').reduce((a: number, l: any) => a + n(l.amountThb), 0));

    return {
      run_id: runId, group_id: groupId, period, status: 'Final', balanced,
      entity_count: entities.length, ic_eliminations: icRows.length, ic_loan_eliminations: icLoanEliminations,
      tb_net: tbSum, elimination_net: elimSum, cta_total: ctaTotal,
      consolidated_accounts: Object.entries(totals).map(([account_code, net_thb]) => ({ account_code, net_thb })),
    };
  }

  // ── CON-03: maker-checker post — freeze the consolidated TB as the official group result for the period.
  // A DIFFERENT user must post (self-post → SELF_POST). Eliminations are NOT pushed into any operating
  // entity's GL — they live at the group layer (consolidation_run_lines); posting only freezes the run.
  async postConsolidation(runId: number, dto: { postedBy: string }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    const [run] = await db.select().from(consolidationRuns).where(eq(consolidationRuns.id, runId)).limit(1);
    if (!run) throw new NotFoundException({ code: 'CONSOL_RUN_NOT_FOUND', message: `Consolidation run ${runId} not found` });
    if (run.status === 'Posted') throw new BadRequestException({ code: 'ALREADY_POSTED', message: 'This consolidation run is already posted', messageTh: 'การรวมงบนี้โพสต์แล้ว' });
    if (run.balanced === false) throw new BadRequestException({ code: 'CONSOL_UNBALANCED', message: 'Cannot post an unbalanced consolidation run', messageTh: 'โพสต์งบรวมที่ไม่สมดุลไม่ได้' });
    const postedBy = dto.postedBy;
    if (run.runBy && run.runBy === postedBy) {
      throw new ForbiddenException({ code: 'SELF_POST', message: 'Maker-checker: you cannot post a consolidation run you produced', messageTh: 'ผู้จัดทำโพสต์งบรวมของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    await db.update(consolidationRuns).set({ status: 'Posted', postedBy, postedAt: new Date() }).where(eq(consolidationRuns.id, runId));
    return { run_id: runId, group_id: Number(run.groupId), period: run.period, status: 'Posted', posted_by: postedBy };
  }

  async listRuns(groupId: number, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    await this.assertGroup(groupId);
    const rows = await db.select().from(consolidationRuns).where(eq(consolidationRuns.groupId, groupId)).orderBy(consolidationRuns.runAt);
    return { runs: rows.map((r: any) => ({ id: Number(r.id), period: r.period, status: r.status, run_by: r.runBy, run_at: r.runAt })) };
  }

  async getRunLines(runId: number, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    const lines = await db.select().from(consolidationRunLines).where(eq(consolidationRunLines.runId, runId));
    return {
      run_id: runId,
      lines: lines.map((l: any) => ({ id: Number(l.id), line_type: l.lineType, entity_tenant_id: l.entityTenantId ? Number(l.entityTenantId) : null, account_code: l.accountCode, amount_thb: n(l.amountThb), fx_rate: l.fxRate != null ? n(l.fxRate) : null, rate_type: l.rateType, notes: l.notes })),
    };
  }

  // ── FIN-5: consolidated statement of cash flows (indirect method, POST-elimination) ──
  // Derives a group-level SCF from the consolidated run lines (which are the period's translated + eliminated
  // movement per account). NCI lines are excluded (a single-sided equity presentation reclass — the sub's full
  // net income is already in the P&L rows); the remaining lines (Entity + Elimination + FX_CTA) net to zero by
  // double-entry, so the statement reconciles to the movement in the consolidated cash accounts. The CTA is
  // shown as a dedicated "effect of exchange-rate changes on cash" reconciling section (IAS 7 ¶28).
  async consolidatedCashFlow(runId: number, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    const [run] = await db.select().from(consolidationRuns).where(eq(consolidationRuns.id, runId)).limit(1);
    if (!run) throw new NotFoundException({ code: 'CONSOL_RUN_NOT_FOUND', message: `Consolidation run ${runId} not found` });
    const rawLines = await db.select().from(consolidationRunLines).where(eq(consolidationRunLines.runId, runId));

    // Consolidated period movement per account (exclude NCI — see above).
    const netByAcct: Record<string, number> = {};
    for (const l of rawLines) {
      if (l.lineType === 'NCI') continue;
      netByAcct[l.accountCode] = round4((netByAcct[l.accountCode] ?? 0) + n(l.amountThb));
    }
    const codes = Object.keys(netByAcct);
    const acctRows = codes.length ? await db.select({ code: accounts.code, type: accounts.type, name: accounts.name }).from(accounts).where(inArray(accounts.code, codes)) : [];
    const meta = new Map<string, { type: string; name: string }>();
    for (const a of acctRows) meta.set(a.code, { type: String(a.type), name: a.name });

    const move = (net: number) => round4(-net); // cash effect of a BS movement = credit − debit = −net

    // Net income = −(Σ P&L net) (P&L already at average rate).
    let netIncome = 0;
    for (const [code, net] of Object.entries(netByAcct)) if (isPnl(code)) netIncome = round4(netIncome - net);

    const addbacks: any[] = [], operating: any[] = [], investing: any[] = [], financing: any[] = [], fxEffect: any[] = [];
    let cashMovement = 0;
    for (const [code, net] of Object.entries(netByAcct)) {
      if (isPnl(code)) continue;                                   // captured in net income
      if (CASH_ACCOUNTS.includes(code)) { cashMovement = round4(cashMovement + net); continue; } // the cash explained
      const amount = move(net);
      if (Math.abs(amount) < 1e-9) continue;
      const m = meta.get(code);
      const line = { account_code: code, label: CF_CLASSIFY[code]?.label ?? m?.name ?? code, amount };
      if (code === CTA_ACCOUNT) { fxEffect.push(line); continue; } // OCI translation reserve → FX-on-cash effect
      const cls = CF_CLASSIFY[code];
      const bucket = cls?.bucket ?? (m?.type === 'Equity' ? 'financing' : 'operating');
      if (bucket === 'addback') addbacks.push(line);
      else if (bucket === 'investing') investing.push(line);
      else if (bucket === 'financing') financing.push(line);
      else operating.push(line);
    }

    const sum = (xs: any[]) => round4(xs.reduce((a, x) => a + x.amount, 0));
    const netOperating = round4(netIncome + sum(addbacks) + sum(operating));
    const netInvesting = sum(investing);
    const netFinancing = sum(financing);
    const fxOnCash = sum(fxEffect);
    const netChange = round4(netOperating + netInvesting + netFinancing + fxOnCash);
    const cashNet = round4(cashMovement); // Δ consolidated cash = Σ cash-account (debit − credit)

    return {
      run_id: runId, group_id: Number(run.groupId), period: run.period, method: 'indirect', post_elimination: true,
      operating: { net_income: netIncome, adjustments: addbacks, working_capital: operating, net: netOperating },
      investing: { lines: investing, net: netInvesting },
      financing: { lines: financing, net: netFinancing },
      fx_effect: { lines: fxEffect, net: fxOnCash },
      net_change_in_cash: netChange,
      consolidated_cash_movement: cashNet,
      // Independent tie-out: the classified activity sections must equal the movement in the cash accounts.
      reconciled: Math.abs(round4(netChange - cashNet)) < 0.01,
    };
  }

  // ── Elimination rules (config) ──

  async defineEliminationRule(dto: { group_id: number; name: string; rule_type?: string; match_account_pattern?: string; debit_account?: string; credit_account?: string }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    await this.assertGroup(dto.group_id);
    const [r] = await db.insert(consolEliminationRules).values({
      tenantId: user.tenantId ?? null, groupId: dto.group_id, name: dto.name,
      ruleType: dto.rule_type ?? 'ic_balance', matchAccountPattern: dto.match_account_pattern ?? null,
      debitAccount: dto.debit_account ?? null, creditAccount: dto.credit_account ?? null, active: true,
    }).returning();
    return this.fmtRule(r);
  }

  async listRules(groupId: number, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    const rows = await db.select().from(consolEliminationRules).where(and(eq(consolEliminationRules.groupId, groupId), eq(consolEliminationRules.active, true)));
    return { rules: rows.map((r: any) => this.fmtRule(r)), count: rows.length };
  }

  // ── Segment definitions (config) ──

  async defineSegment(dto: { code: string; name: string; dimension?: string; member_keys?: any }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    const [s] = await db.insert(segmentDefinitions).values({
      tenantId: user.tenantId ?? null, code: dto.code, name: dto.name,
      dimension: dto.dimension ?? 'branch', memberKeys: dto.member_keys ?? null, active: true,
    }).returning();
    return this.fmtSegment(s);
  }

  async listSegments(user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    const rows = await db.select().from(segmentDefinitions).where(eq(segmentDefinitions.active, true)).orderBy(segmentDefinitions.dimension);
    return { segments: rows.map((s: any) => this.fmtSegment(s)), count: rows.length };
  }

  // ── CON-04: Segment reporting (IFRS 8) ──
  // P&L (revenue/expense/net) grouped by segment, sourced from the WS1.3 dimension columns on journal_lines
  // (branch_id / project_id / department_id) and mapped through segment_definitions. If no segment defs match
  // the dimension, raw dimension values are returned as their own segments (key + 'unassigned' bucket).
  async segmentReport(dto: { period: string; dimension?: string }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    const dimension = dto.dimension ?? 'branch';
    const period = dto.period; // 'YYYY-MM'
    const dimCol = dimension === 'project' ? journalLines.projectId
      : dimension === 'department' ? journalLines.departmentId
      : journalLines.branchId;

    const rows = await db.select({
      dim: dimCol,
      type: accounts.type,
      net: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)`,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .leftJoin(accounts, eq(journalLines.accountCode, accounts.code))
      .where(and(eq(journalEntries.status, 'Posted'), eq(journalEntries.period, period), inArray(accounts.type, ['Revenue', 'Expense'])))
      .groupBy(dimCol, accounts.type);

    // Build dimension-value → segment mapping from segment_definitions for this dimension.
    const defs = await db.select().from(segmentDefinitions).where(and(eq(segmentDefinitions.dimension, dimension), eq(segmentDefinitions.active, true)));
    const keyToSeg = new Map<string, { code: string; name: string }>();
    for (const d of defs) {
      const keys: any[] = Array.isArray(d.memberKeys) ? d.memberKeys : [];
      for (const k of keys) keyToSeg.set(String(k), { code: d.code, name: d.name });
    }

    const bySeg: Record<string, { segment: string; name: string; revenue: number; expense: number; net: number }> = {};
    for (const r of rows) {
      const rawKey = r.dim != null ? String(r.dim) : 'unassigned';
      const seg = keyToSeg.get(rawKey);
      const segKey = seg?.code ?? rawKey;
      const segName = seg?.name ?? (r.dim != null ? `${dimension} ${rawKey}` : 'Unassigned');
      if (!bySeg[segKey]) bySeg[segKey] = { segment: segKey, name: segName, revenue: 0, expense: 0, net: 0 };
      const net = n(r.net);
      if (r.type === 'Revenue') bySeg[segKey].revenue = round4(bySeg[segKey].revenue + -net); // revenue net is negative
      else bySeg[segKey].expense = round4(bySeg[segKey].expense + net);
    }
    for (const s of Object.values(bySeg)) s.net = round4(s.revenue - s.expense);

    return { period, dimension, segments: Object.values(bySeg) };
  }

  // ── Helpers ──

  private fmtRule(r: any) {
    return { id: Number(r.id), group_id: Number(r.groupId), name: r.name, rule_type: r.ruleType, match_account_pattern: r.matchAccountPattern, debit_account: r.debitAccount, credit_account: r.creditAccount, active: r.active };
  }

  private fmtSegment(s: any) {
    return { id: Number(s.id), code: s.code, name: s.name, dimension: s.dimension, member_keys: s.memberKeys, active: s.active };
  }

  private async assertGroup(groupId: number) {
    const db = this.db;
    const [g] = await db.select().from(consolidationGroups).where(eq(consolidationGroups.id, groupId)).limit(1);
    if (!g) throw new NotFoundException({ code: 'GROUP_NOT_FOUND', message: `Consolidation group ${groupId} not found` });
    return g;
  }

  private fmtGroup(g: any) {
    return { id: Number(g.id), name: g.name, base_currency: g.baseCurrency, fiscal_year: g.fiscalYear, notes: g.notes, created_by: g.createdBy, created_at: g.createdAt };
  }
}
