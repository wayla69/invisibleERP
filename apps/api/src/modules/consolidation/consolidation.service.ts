import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { consolidationGroups, consolidationEntities, consolidationRuns, consolidationRunLines, consolEliminationRules, segmentDefinitions } from '../../database/schema/consolidation';
import { journalEntries, journalLines } from '../../database/schema/ledger';
import { accounts } from '../../database/schema/ledger';
import { icTransactions } from '../../database/schema/intercompany';
import { icReconPeriods } from '../../database/schema/ic-recon';
import { fxRates } from '../../database/schema/fx';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

@Injectable()
export class ConsolidationService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private hqOnly(user: JwtUser) {
    if (user.role !== 'Admin') throw new ForbiddenException({ code: 'CONSOL_HQ_ONLY', message: 'Consolidation is HQ-only', messageTh: 'การรวมงบการเงินทำได้เฉพาะสำนักงานใหญ่' });
  }

  // ── Groups ──

  async createGroup(dto: { name: string; fiscal_year: number; base_currency?: string; notes?: string }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
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
    const db = this.db as any;
    const rows = await db.select().from(consolidationGroups).orderBy(consolidationGroups.fiscalYear);
    return { groups: rows.map((g: any) => this.fmtGroup(g)), count: rows.length };
  }

  async addEntity(groupId: number, dto: { entity_tenant_id: number; ownership_pct?: number; entity_currency?: string }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
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
    return { id: Number(e.id), group_id: groupId, entity_tenant_id: Number(e.entityTenantId), ownership_pct: n(e.ownershipPct), entity_currency: e.entityCurrency };
  }

  async removeEntity(groupId: number, entityTenantId: number, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
    await db.update(consolidationEntities)
      .set({ isActive: false })
      .where(and(eq(consolidationEntities.groupId, groupId), eq(consolidationEntities.entityTenantId, entityTenantId)));
    return { removed: true };
  }

  async listEntities(groupId: number, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
    const rows = await db.select().from(consolidationEntities).where(and(eq(consolidationEntities.groupId, groupId), eq(consolidationEntities.isActive, true)));
    return { entities: rows.map((e: any) => ({ id: Number(e.id), entity_tenant_id: Number(e.entityTenantId), ownership_pct: n(e.ownershipPct), entity_currency: e.entityCurrency })) };
  }

  // ── Consolidation Run ──

  async runConsolidation(groupId: number, dto: { period: string }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
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
    const runId = Number(run.id);

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
    // Prefetch the latest FX rate (≤ period end) for every distinct non-THB entity currency in one query.
    const periodEnd = `${period}-28`; // safe last-day proxy
    const currencies = [...new Set(entities.map((e: any) => e.entityCurrency ?? 'THB').filter((c: string) => c !== 'THB'))] as string[];
    const fxMap = new Map<string, number>();
    if (currencies.length) {
      const fxRows = await db.select({ currency: fxRates.currency, rate: fxRates.rate })
        .from(fxRates).where(and(inArray(fxRates.currency, currencies), eq(fxRates.status, 'Approved'), sql`${fxRates.rateDate} <= ${periodEnd}`))
        .orderBy(sql`${fxRates.rateDate} DESC`);
      for (const r of fxRows) if (!fxMap.has(r.currency)) fxMap.set(r.currency, n(r.rate)); // first per currency = latest (DESC)
    }

    // ── Step 1: Collect each entity's GL net by account ──
    for (const ent of entities) {
      const entityTenantId = Number(ent.entityTenantId);
      const ownerPct = n(ent.ownershipPct) / 100; // e.g. 0.8 for 80%
      const entCurrency = ent.entityCurrency ?? 'THB';
      const glRows = glByTenant.get(entityTenantId) ?? [];
      const fxRate = entCurrency === 'THB' ? 1 : (fxMap.get(entCurrency) ?? 1);

      // P&L net income calculation for NCI:  netIncome = -(SUM of P&L account nets)
      // P&L accounts are 4xxx (revenue, normal credit) and 5xxx (expense, normal debit).
      // net = debit - credit, so revenue net < 0, expense net > 0.
      // Net income = -SUM(net_4xxx) - SUM(net_5xxx) ... but revenue is negative and expense is positive:
      // netIncome = -(net_4xxx + net_5xxx) where 4xxx negative and 5xxx positive
      // = -( (-revenue) + expense ) = revenue - expense ✓
      let plNetSum = 0;

      for (const row of glRows) {
        const rawNet = n(row.net);
        const translatedNet = round4(rawNet * fxRate);
        runLineValues.push({ runId, lineType: 'Entity', entityTenantId, accountCode: row.accountCode, amountThb: fx(translatedNet, 4) });

        if (row.accountCode.startsWith('4') || row.accountCode.startsWith('5')) {
          plNetSum += rawNet * fxRate;
        }
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

    // Insert all lines
    if (runLineValues.length) {
      await db.insert(consolidationRunLines).values(runLineValues);
    }

    // Return consolidated totals by account
    const lines = await db.select().from(consolidationRunLines).where(eq(consolidationRunLines.runId, runId));
    const totals: Record<string, number> = {};
    for (const l of lines) totals[l.accountCode] = round4((totals[l.accountCode] ?? 0) + n(l.amountThb));

    // ── CON-03: elimination integrity — the consolidated TB must still balance ──
    // Each line amount is a signed net (debit − credit). By double-entry, every entity's lines net to 0
    // and each elimination pair (−amt on 1150, +amt on 2150) nets to 0, so the combined+eliminated TB must
    // sum to ~0. The NCI line is a single-sided presentation reclass within equity (not a posting), so it is
    // EXCLUDED from the balance check. If the remaining lines don't net to zero, eliminations are unbalanced.
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

    return {
      run_id: runId, group_id: groupId, period, status: 'Final', balanced,
      entity_count: entities.length, ic_eliminations: icRows.length,
      tb_net: tbSum, elimination_net: elimSum,
      consolidated_accounts: Object.entries(totals).map(([account_code, net_thb]) => ({ account_code, net_thb })),
    };
  }

  // ── CON-03: maker-checker post — freeze the consolidated TB as the official group result for the period.
  // A DIFFERENT user must post (self-post → SELF_POST). Eliminations are NOT pushed into any operating
  // entity's GL — they live at the group layer (consolidation_run_lines); posting only freezes the run.
  async postConsolidation(runId: number, dto: { postedBy: string }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
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
    const db = this.db as any;
    await this.assertGroup(groupId);
    const rows = await db.select().from(consolidationRuns).where(eq(consolidationRuns.groupId, groupId)).orderBy(consolidationRuns.runAt);
    return { runs: rows.map((r: any) => ({ id: Number(r.id), period: r.period, status: r.status, run_by: r.runBy, run_at: r.runAt })) };
  }

  async getRunLines(runId: number, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
    const lines = await db.select().from(consolidationRunLines).where(eq(consolidationRunLines.runId, runId));
    return {
      run_id: runId,
      lines: lines.map((l: any) => ({ id: Number(l.id), line_type: l.lineType, entity_tenant_id: l.entityTenantId ? Number(l.entityTenantId) : null, account_code: l.accountCode, amount_thb: n(l.amountThb), notes: l.notes })),
    };
  }

  // ── Elimination rules (config) ──

  async defineEliminationRule(dto: { group_id: number; name: string; rule_type?: string; match_account_pattern?: string; debit_account?: string; credit_account?: string }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
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
    const db = this.db as any;
    const rows = await db.select().from(consolEliminationRules).where(and(eq(consolEliminationRules.groupId, groupId), eq(consolEliminationRules.active, true)));
    return { rules: rows.map((r: any) => this.fmtRule(r)), count: rows.length };
  }

  // ── Segment definitions (config) ──

  async defineSegment(dto: { code: string; name: string; dimension?: string; member_keys?: any }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
    const [s] = await db.insert(segmentDefinitions).values({
      tenantId: user.tenantId ?? null, code: dto.code, name: dto.name,
      dimension: dto.dimension ?? 'branch', memberKeys: dto.member_keys ?? null, active: true,
    }).returning();
    return this.fmtSegment(s);
  }

  async listSegments(user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
    const rows = await db.select().from(segmentDefinitions).where(eq(segmentDefinitions.active, true)).orderBy(segmentDefinitions.dimension);
    return { segments: rows.map((s: any) => this.fmtSegment(s)), count: rows.length };
  }

  // ── CON-04: Segment reporting (IFRS 8) ──
  // P&L (revenue/expense/net) grouped by segment, sourced from the WS1.3 dimension columns on journal_lines
  // (branch_id / project_id / department_id) and mapped through segment_definitions. If no segment defs match
  // the dimension, raw dimension values are returned as their own segments (key + 'unassigned' bucket).
  async segmentReport(dto: { period: string; dimension?: string }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
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
    for (const r of rows as any[]) {
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
    const db = this.db as any;
    const [g] = await db.select().from(consolidationGroups).where(eq(consolidationGroups.id, groupId)).limit(1);
    if (!g) throw new NotFoundException({ code: 'GROUP_NOT_FOUND', message: `Consolidation group ${groupId} not found` });
    return g;
  }

  private fmtGroup(g: any) {
    return { id: Number(g.id), name: g.name, base_currency: g.baseCurrency, fiscal_year: g.fiscalYear, notes: g.notes, created_by: g.createdBy, created_at: g.createdAt };
  }
}
