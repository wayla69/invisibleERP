import { and, eq, inArray, desc } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { projectBoq, projectBoqLines, projectCommitments } from '../../database/schema';
import type { CommitmentsService } from '../commitments/commitments.service';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const n = (x: unknown) => Number(x ?? 0);

// A3 (docs/50 Wave 3) — the material control tower: two READ models that make a PM trust the numbers.
// Everything here aggregates data the docs/32 spine already writes (BoQ lines carry wbs_code; the
// commitment ledger carries every material draw: sourceDocType 'RES' = issue-to-project, 'MRET' =
// return-to-stock with a NEGATIVE amount, plus PO/PMR paper commitments) — no new writes, no new tables.
// A ctor-body plain class (not a DI provider) like projects-evm/wbs — the service-size ratchet keeps
// the facade to thin delegators.
export class ProjectsMaterialService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly projectRow: (code: string) => Promise<any>,
    private readonly commitments?: CommitmentsService,
  ) {}

  private async latestBoqLines(projectId: number) {
    const [boq] = await this.db.select().from(projectBoq).where(eq(projectBoq.projectId, projectId)).orderBy(desc(projectBoq.id)).limit(1);
    const lines = boq
      ? await this.db.select().from(projectBoqLines).where(eq(projectBoqLines.boqId, Number(boq.id))).orderBy(projectBoqLines.lineNo)
      : [];
    return { boq: boq ?? null, lines };
  }

  // ── WBS-level material rollup: budget / committed / issued / returned / remaining per WBS node ──
  // committed = the encumbrance read model (open+consumed, MRET's negative rows already net it down);
  // issued/returned split the PHYSICAL draws out of the same ledger so "committed" paper (PO/PMR) and
  // consumed stock are distinguishable per node. Lines without a wbs_code roll into '—'.
  async boqByWbs(code: string) {
    const p = await this.projectRow(code);
    const { boq, lines } = await this.latestBoqLines(Number(p.id));
    if (!boq) return { project_code: code, boq: null, nodes: [], count: 0 };
    const ids = lines.map((l: any) => Number(l.id));
    const committedByLine = this.commitments ? await this.commitments.committedByLine(ids) : new Map<number, number>();
    const draws = ids.length
      ? await this.db.select().from(projectCommitments)
          .where(and(inArray(projectCommitments.boqLineId, ids), eq(projectCommitments.status, 'consumed'), inArray(projectCommitments.sourceDocType, ['RES', 'MRET'])))
      : [];
    const issuedByLine = new Map<number, number>(), returnedByLine = new Map<number, number>();
    for (const d of draws) {
      const lid = Number(d.boqLineId), amt = n(d.amount);
      if (d.sourceDocType === 'RES') issuedByLine.set(lid, r2((issuedByLine.get(lid) ?? 0) + amt));
      else returnedByLine.set(lid, r2((returnedByLine.get(lid) ?? 0) + Math.abs(amt)));
    }
    const nodes = new Map<string, any>();
    for (const l of lines) {
      const key = l.wbsCode ?? '—';
      const node = nodes.get(key) ?? { wbs_code: key, budget: 0, committed: 0, issued: 0, returned: 0, remaining: 0, lines: 0, categories: new Set<string>() };
      const committed = committedByLine.get(Number(l.id)) ?? 0;
      node.budget = r2(node.budget + n(l.budgetAmount));
      node.committed = r2(node.committed + committed);
      node.issued = r2(node.issued + (issuedByLine.get(Number(l.id)) ?? 0));
      node.returned = r2(node.returned + (returnedByLine.get(Number(l.id)) ?? 0));
      node.remaining = r2(node.budget - node.committed);
      node.lines += 1;
      if (l.category) node.categories.add(l.category);
      nodes.set(key, node);
    }
    const shaped = Array.from(nodes.values()).map((x) => ({ ...x, categories: Array.from(x.categories).sort() }))
      .sort((a, b) => String(a.wbs_code).localeCompare(String(b.wbs_code), undefined, { numeric: true }));
    return {
      project_code: code, boq: { id: Number(boq.id), boq_no: boq.boqNo, status: boq.status },
      nodes: shaped, count: shaped.length,
      totals: {
        budget: r2(shaped.reduce((s, x) => s + x.budget, 0)), committed: r2(shaped.reduce((s, x) => s + x.committed, 0)),
        issued: r2(shaped.reduce((s, x) => s + x.issued, 0)), returned: r2(shaped.reduce((s, x) => s + x.returned, 0)),
        remaining: r2(shaped.reduce((s, x) => s + x.remaining, 0)),
      },
    };
  }

  // ── Planned-vs-actual material draw curve ──
  // actual = cumulative PHYSICAL material draw value by business month (RES issues net of MRET returns,
  // stamped when the commitment row was written); planned = the approved material budget spread linearly
  // across the project window (start_date → end_date; degenerate windows collapse to the activity range).
  // over_plan flags the months where the site is drawing faster than the linear plan.
  async drawCurve(code: string) {
    const p = await this.projectRow(code);
    const { boq, lines } = await this.latestBoqLines(Number(p.id));
    const budget = r2(lines.reduce((s, l) => s + n(l.budgetAmount), 0));
    const ids = lines.map((l) => Number(l.id));
    const draws = ids.length
      ? await this.db.select().from(projectCommitments)
          .where(and(inArray(projectCommitments.boqLineId, ids), eq(projectCommitments.status, 'consumed'), inArray(projectCommitments.sourceDocType, ['RES', 'MRET'])))
      : [];
    const byMonth = new Map<string, number>();
    for (const d of draws) {
      const m = (d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? '')).slice(0, 7);
      if (!m) continue;
      byMonth.set(m, r2((byMonth.get(m) ?? 0) + n(d.amount)));
    }
    const activityMonths = Array.from(byMonth.keys()).sort();
    const startM = (p.startDate ? String(p.startDate) : activityMonths[0] ?? '').slice(0, 7);
    const endM = (p.endDate ? String(p.endDate) : activityMonths[activityMonths.length - 1] ?? '').slice(0, 7);
    if (!startM) return { project_code: code, budget_total: budget, points: [], count: 0 };
    const months: string[] = [];
    for (let cur = startM; cur && cur <= (endM >= startM ? endM : startM) && months.length < 120; ) {
      months.push(cur);
      const [y, m] = cur.split('-').map(Number) as [number, number];
      const d = new Date(Date.UTC(y, m - 1, 1)); d.setUTCMonth(d.getUTCMonth() + 1);
      cur = d.toISOString().slice(0, 7);
    }
    for (const m of activityMonths) if (!months.includes(m)) months.push(m); // draws outside the window still show
    months.sort();
    let cum = 0;
    const points = months.map((m, i) => {
      cum = r2(cum + (byMonth.get(m) ?? 0));
      const planned = r2(budget * ((i + 1) / months.length));
      return { month: m, actual: r2(byMonth.get(m) ?? 0), actual_cum: cum, planned_cum: planned, over_plan: cum > planned + 0.005 };
    });
    return { project_code: code, boq_status: boq?.status ?? null, budget_total: budget, points, count: points.length };
  }
}
