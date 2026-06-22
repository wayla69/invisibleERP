import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { consolidationGroups, consolidationEntities, consolidationRuns, consolidationRunLines } from '../../database/schema/consolidation';
import { journalEntries, journalLines } from '../../database/schema/ledger';
import { icTransactions } from '../../database/schema/intercompany';
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

    const entities = await db.select().from(consolidationEntities)
      .where(and(eq(consolidationEntities.groupId, groupId), eq(consolidationEntities.isActive, true)));
    if (!entities.length) throw new BadRequestException({ code: 'NO_ENTITIES', message: 'Group has no active entities', messageTh: 'ไม่มีบริษัทในกลุ่ม' });

    const entityTenantIds = entities.map((e: any) => Number(e.entityTenantId));

    // Insert run header
    const [run] = await db.insert(consolidationRuns).values({ groupId, period, status: 'Draft', runBy: user.username }).returning();
    const runId = Number(run.id);

    const runLineValues: any[] = [];

    // ── Step 1: Collect each entity's GL net by account ──
    for (const ent of entities) {
      const entityTenantId = Number(ent.entityTenantId);
      const ownerPct = n(ent.ownershipPct) / 100; // e.g. 0.8 for 80%
      const entCurrency = ent.entityCurrency ?? 'THB';

      const glRows = await db.select({
        accountCode: journalLines.accountCode,
        net: sql<string>`sum(${journalLines.debit}) - sum(${journalLines.credit})`,
      }).from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
        .where(and(
          eq(journalEntries.tenantId, entityTenantId),
          eq(journalEntries.period, period),
          eq(journalEntries.status, 'Posted'),
        ))
        .groupBy(journalLines.accountCode);

      // FX rate for non-THB entities
      let fxRate = 1;
      if (entCurrency !== 'THB') {
        const periodEnd = `${period}-28`; // safe last-day proxy
        const [rateRow] = await db.select({ rate: fxRates.rate })
          .from(fxRates)
          .where(and(eq(fxRates.currency, entCurrency), sql`${fxRates.rateDate} <= ${periodEnd}`))
          .orderBy(sql`${fxRates.rateDate} DESC`)
          .limit(1);
        if (rateRow) fxRate = n(rateRow.rate);
      }

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

    // Mark run Final
    await db.update(consolidationRuns).set({ status: 'Final' }).where(eq(consolidationRuns.id, runId));

    // Return consolidated totals by account
    const lines = await db.select().from(consolidationRunLines).where(eq(consolidationRunLines.runId, runId));
    const totals: Record<string, number> = {};
    for (const l of lines) totals[l.accountCode] = round4((totals[l.accountCode] ?? 0) + n(l.amountThb));

    return {
      run_id: runId, group_id: groupId, period, status: 'Final',
      entity_count: entities.length, ic_eliminations: icRows.length,
      consolidated_accounts: Object.entries(totals).map(([account_code, net_thb]) => ({ account_code, net_thb })),
    };
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

  // ── Helpers ──

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
