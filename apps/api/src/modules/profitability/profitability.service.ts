import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { profitSegments, allocationRules, allocationWeights, allocationRuns, allocationLines } from '../../database/schema/reconciliation';
import { journalEntries, journalLines } from '../../database/schema/ledger';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

@Injectable()
export class ProfitabilityService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Segments ──

  async createSegment(dto: { segment_type: string; code: string; name: string }, user: JwtUser) {
    const db = this.db as any;
    const [s] = await db.insert(profitSegments).values({
      tenantId: user.tenantId!, segmentType: dto.segment_type, code: dto.code, name: dto.name, isActive: true,
    }).onConflictDoUpdate({
      target: [profitSegments.tenantId, profitSegments.segmentType, profitSegments.code],
      set: { name: dto.name, isActive: true },
    }).returning();
    return { id: Number(s.id), segment_type: s.segmentType, code: s.code, name: s.name };
  }

  async listSegments(segmentType?: string, user?: JwtUser) {
    const db = this.db as any;
    const conds: any[] = [eq(profitSegments.tenantId, user!.tenantId!), eq(profitSegments.isActive, true)];
    if (segmentType) conds.push(eq(profitSegments.segmentType, segmentType));
    const rows = await db.select().from(profitSegments).where(and(...conds)).orderBy(profitSegments.segmentType, profitSegments.code);
    return { segments: rows.map((s: any) => ({ id: Number(s.id), segment_type: s.segmentType, code: s.code, name: s.name })), count: rows.length };
  }

  // ── Allocation Rules ──

  async createRule(dto: { name: string; from_account_code: string; to_segment_type: string; driver?: string; weights?: { segment_code: string; weight: number }[] }, user: JwtUser) {
    const db = this.db as any;
    const [rule] = await db.insert(allocationRules).values({
      tenantId: user.tenantId!, name: dto.name,
      fromAccountCode: dto.from_account_code, toSegmentType: dto.to_segment_type,
      driver: dto.driver ?? 'equal', isActive: true,
    }).returning();
    const ruleId = Number(rule.id);

    if (dto.weights?.length) {
      await db.insert(allocationWeights).values(
        dto.weights.map((w) => ({ ruleId, segmentCode: w.segment_code, weight: fx(w.weight, 4) }))
      ).onConflictDoUpdate({
        target: [allocationWeights.ruleId, allocationWeights.segmentCode],
        set: { weight: sql`excluded.weight` },
      });
    }
    return { id: ruleId, name: rule.name, from_account_code: rule.fromAccountCode, to_segment_type: rule.toSegmentType, driver: rule.driver };
  }

  async listRules(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(allocationRules).where(and(eq(allocationRules.tenantId, user.tenantId!), eq(allocationRules.isActive, true)));
    return { rules: rows.map((r: any) => ({ id: Number(r.id), name: r.name, from_account_code: r.fromAccountCode, to_segment_type: r.toSegmentType, driver: r.driver })), count: rows.length };
  }

  // ── Allocation Run ──

  async runAllocation(dto: { period: string }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId!;
    const period = dto.period;

    const rules = await db.select().from(allocationRules).where(and(eq(allocationRules.tenantId, tenantId), eq(allocationRules.isActive, true)));

    const [run] = await db.insert(allocationRuns).values({ tenantId, period, status: 'Draft', runBy: user.username }).returning();
    const runId = Number(run.id);

    const lineValues: any[] = [];

    for (const rule of rules) {
      // Get GL net for fromAccountCode this period
      const [glRow] = await db.select({
        net: sql<string>`coalesce(sum(${journalLines.debit}) - sum(${journalLines.credit}), 0)`,
      }).from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
        .where(and(
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.period, period),
          eq(journalEntries.status, 'Posted'),
          eq(journalLines.accountCode, rule.fromAccountCode),
        ));

      const totalAmount = n(glRow?.net ?? 0);
      if (Math.abs(totalAmount) < 1e-6) continue;

      // Get active segments of the target type
      const segs = await db.select().from(profitSegments).where(and(eq(profitSegments.tenantId, tenantId), eq(profitSegments.segmentType, rule.toSegmentType), eq(profitSegments.isActive, true)));
      if (!segs.length) continue;

      const ruleId = Number(rule.id);
      const driver = rule.driver ?? 'equal';

      if (driver === 'percent') {
        const weights = await db.select().from(allocationWeights).where(eq(allocationWeights.ruleId, ruleId));
        const weightMap = new Map(weights.map((w: any) => [w.segmentCode, n(w.weight)]));
        const totalWeight = ([...weightMap.values()] as number[]).reduce((a, b) => a + b, 0) || 1;

        for (const seg of segs) {
          const w = (weightMap.get(seg.code) ?? 0) as number;
          if (w <= 0) continue;
          lineValues.push({ runId, ruleId, segmentCode: seg.code, segmentType: seg.segmentType, accountCode: rule.fromAccountCode, allocatedAmount: fx(round4(totalAmount * w / totalWeight), 4) });
        }
      } else {
        // 'equal' and 'revenue' fallback — split equally
        const perSeg = round4(totalAmount / segs.length);
        for (const seg of segs) {
          lineValues.push({ runId, ruleId, segmentCode: seg.code, segmentType: seg.segmentType, accountCode: rule.fromAccountCode, allocatedAmount: fx(perSeg, 4) });
        }
      }
    }

    if (lineValues.length) await db.insert(allocationLines).values(lineValues);
    await db.update(allocationRuns).set({ status: 'Final' }).where(eq(allocationRuns.id, runId));

    return { run_id: runId, period, rules_applied: rules.length, lines_created: lineValues.length, status: 'Final' };
  }

  // ── Profitability Report ──
  // Returns contribution margin = revenue (4xxx) - direct expenses (5xxx) + allocated amounts per segment

  async profitabilityReport(dto: { period: string; segment_type?: string }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId!;
    const period = dto.period;

    // Last allocation run for this period
    const [lastRun] = await db.select().from(allocationRuns)
      .where(and(eq(allocationRuns.tenantId, tenantId), eq(allocationRuns.period, period), eq(allocationRuns.status, 'Final')))
      .orderBy(sql`${allocationRuns.id} DESC`)
      .limit(1);

    // Allocated costs per segment
    const allocMap: Record<string, number> = {};
    if (lastRun) {
      const allocRows = await db.select().from(allocationLines).where(eq(allocationLines.runId, lastRun.id));
      for (const l of allocRows) {
        const segKey = `${l.segmentType}::${l.segmentCode}`;
        allocMap[segKey] = round4((allocMap[segKey] ?? 0) + n(l.allocatedAmount));
      }
    }

    // Direct GL P&L — net by account for this period
    const glPnl = await db.select({
      accountCode: journalLines.accountCode,
      net: sql<string>`sum(${journalLines.debit}) - sum(${journalLines.credit})`,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.period, period),
        eq(journalEntries.status, 'Posted'),
        sql`(${journalLines.accountCode} LIKE '4%' OR ${journalLines.accountCode} LIKE '5%')`,
      ))
      .groupBy(journalLines.accountCode);

    // netIncome at entity level: -(sum of all P&L nets) because revenue is negative and expense is positive
    const plNetSum = glPnl.reduce((s: number, r: any) => s + n(r.net), 0);
    const entityNetIncome = round4(-plNetSum);

    // Segments
    const segConds: any[] = [eq(profitSegments.tenantId, tenantId), eq(profitSegments.isActive, true)];
    if (dto.segment_type) segConds.push(eq(profitSegments.segmentType, dto.segment_type));
    const segs = await db.select().from(profitSegments).where(and(...segConds));

    const segReport = segs.map((seg: any) => {
      const segKey = `${seg.segmentType}::${seg.code}`;
      const allocated = allocMap[segKey] ?? 0;
      return {
        segment_type: seg.segmentType, code: seg.code, name: seg.name,
        allocated_costs: allocated,
        contribution_margin: round4(entityNetIncome - allocated),
      };
    });

    return {
      period, entity_net_income: entityNetIncome,
      segments: segReport,
      run_id: lastRun ? Number(lastRun.id) : null,
    };
  }
}
