import { describe, expect, it } from 'vitest';

import { CommitmentsService } from '../src/modules/commitments/commitments.service';

// Unit tests for the commitment/encumbrance ledger (2.4 slice 10 — M1/PROJ-12/FU1 joins the gate). This
// is the primitive that turns the BoQ-line budget from observed into ENFORCED — the real service behind
// the `commitments` ports the PO/GRN suites fake. The FOR UPDATE serialisation itself is a DB property
// (harness-tested); what's pinned here is the arithmetic: budget − Σ(open+consumed), the FU1 tolerance
// ceiling, the EPS boundary, and the authorised-overage bypass.
// STRICT routed env: select() answers reads in call order (works for both db and the tx `runner`).

type ComCap = { inserts: any[]; updates: any[] };

function comEnv(routes: any[][], opts: { updReturn?: any[] } = {}) {
  const cap: ComCap = { inserts: [], updates: [] };
  let call = 0;
  const chain = (rows: any[]) => {
    const p: any = { from: () => p, where: () => p, limit: () => p, orderBy: () => p, groupBy: () => p, for: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  const runner = {
    select: () => { if (call >= routes.length) throw new Error(`unexpected select #${call + 1} — add a route`); return chain(routes[call++] ?? []); },
    insert: () => ({ values: (v: any) => { cap.inserts.push(v); return { returning: () => Promise.resolve([{ id: 501 }]) }; } }),
    update: () => ({ set: (v: any) => ({ where: () => ({ returning: () => { cap.updates.push(v); return Promise.resolve(opts.updReturn ?? [{ id: 1 }, { id: 2 }]); } }) }) }),
  };
  const svc = new CommitmentsService(runner as any); // db and tx share the runner shape
  return { svc, runner, cap };
}

const code = async (fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e: any) { return e; }
  return null;
};

const LINE = { id: 7, projectId: 5, budgetAmount: '1000' };
const RESERVE = { projectId: 5, boqLineId: 7, amount: 300, qty: 3, sourceDocType: 'PO', sourceDocNo: 'PO-9', createdBy: 'buyer1', tenantId: 1 };

describe('CommitmentsService — reserve (M1: admit only what fits budget − Σ(open+consumed))', () => {
  // route order inside reserve: BoQ line (FOR UPDATE) → committed sum → project tolerance
  it('a draw within the remaining budget records an OPEN commitment and reports the new picture', async () => {
    const { svc, runner, cap } = comEnv([[LINE], [{ v: '400' }], [{ v: null }]]);
    const r = await svc.reserve(runner, RESERVE);
    expect(r).toEqual({ id: 501, remaining: 300, budget: 1000, committed: 700 });
    expect(cap.inserts[0]).toMatchObject({ projectId: 5, boqLineId: 7, sourceDocType: 'PO', sourceDocNo: 'PO-9', qty: '3', amount: '300', status: 'open', createdBy: 'buyer1' });
  });

  it('a draw past the budget is BUDGET_EXCEEDED with the full picture in the payload — nothing inserted', async () => {
    const { svc, runner, cap } = comEnv([[LINE], [{ v: '400' }], [{ v: null }]]);
    const e: any = await code(() => svc.reserve(runner, { ...RESERVE, amount: 700 }));
    expect(e?.response).toMatchObject({ code: 'BUDGET_EXCEEDED', remaining: 600, budget: 1000, committed: 400, tolerance_pct: 0, ceiling: 1000 });
    expect(cap.inserts).toHaveLength(0);
  });

  it('a draw of EXACTLY the remaining passes (EPS absorbs numeric(16,2) boundary rounding)', async () => {
    const { svc, runner } = comEnv([[LINE], [{ v: '400' }], [{ v: null }]]);
    const r = await svc.reserve(runner, { ...RESERVE, amount: 600 });
    expect(r.remaining).toBe(0);
  });

  it('FU1 tolerance: the project pct raises the ceiling — within it passes (remaining goes visibly negative), past it blocks', async () => {
    const within = comEnv([[LINE], [{ v: '400' }], [{ v: '10' }]]); // tolerance 10% → ceiling 1100
    const r = await within.svc.reserve(within.runner, { ...RESERVE, amount: 690 }); // 400+690 = 1090 ≤ 1100
    expect(r.remaining).toBe(-90); // over budget but within tolerance — visible, not hidden

    const past = comEnv([[LINE], [{ v: '400' }], [{ v: '10' }]]);
    const e: any = await code(() => past.svc.reserve(past.runner, { ...RESERVE, amount: 710 })); // 1110 > 1100
    expect(e?.response).toMatchObject({ code: 'BUDGET_EXCEEDED', tolerance_pct: 10, ceiling: 1100 });
  });

  it('allowOver (an AUTHORISED overage, e.g. an approved over-budget PMR) bypasses the check but still records', async () => {
    const { svc, runner, cap } = comEnv([[LINE], [{ v: '400' }], [{ v: null }]]);
    const r = await svc.reserve(runner, { ...RESERVE, amount: 5000, allowOver: true });
    expect(cap.inserts[0]).toMatchObject({ amount: '5000', status: 'open' }); // recorded — visibly over, authorised
    expect(r.remaining).toBe(-4400);
  });

  it('an unknown BoQ line is BOQ_LINE_NOT_FOUND', async () => {
    const { svc, runner } = comEnv([[]]);
    const e: any = await code(() => svc.reserve(runner, RESERVE));
    expect(e?.response?.code).toBe('BOQ_LINE_NOT_FOUND');
  });
});

describe('CommitmentsService — lifecycle (release frees budget; consume keeps counting)', () => {
  it('release flips every OPEN commitment of the doc to released and returns the count', async () => {
    const { svc, runner, cap } = comEnv([]);
    expect(await svc.release(runner, 'PO', 'PO-9')).toBe(2);
    expect(cap.updates[0]).toMatchObject({ status: 'released' });
  });

  it('consume marks them consumed — a lifecycle move that does NOT change the remaining', async () => {
    const { svc, runner, cap } = comEnv([]);
    expect(await svc.consume(runner, 'PO', 'PO-9')).toBe(2);
    expect(cap.updates[0]).toMatchObject({ status: 'consumed' });
  });
});

describe('CommitmentsService — read models', () => {
  it('lineBudget reports budget/committed/remaining + the FU1 ceiling and headroom', async () => {
    const { svc } = comEnv([[LINE], [{ v: '400' }], [{ v: '10' }]]);
    expect(await svc.lineBudget(7, 5)).toEqual({ budget: 1000, committed: 400, remaining: 600, tolerance_pct: 10, ceiling: 1100, headroom: 700 });
  });

  it('lineBudget honours an explicit tolerance override without reading the project', async () => {
    const { svc } = comEnv([[LINE], [{ v: '400' }]]); // strict: only 2 reads — no project lookup
    expect(await svc.lineBudget(7, 5, 0)).toMatchObject({ tolerance_pct: 0, ceiling: 1000, headroom: 600 });
  });

  it('committedByLine: empty input short-circuits with no read; rows land in the map', async () => {
    const empty = comEnv([]); // strict: a read would throw
    expect(await empty.svc.committedByLine([])).toEqual(new Map());
    const { svc } = comEnv([[{ line: 7, v: '400' }, { line: 8, v: '0' }]]);
    const m = await svc.committedByLine([7, 8]);
    expect(m.get(7)).toBe(400);
    expect(m.get(8)).toBe(0);
  });

  it('listForProject sums the status buckets (committed = open + consumed; released is free)', async () => {
    const rows = [
      { id: 3, boqLineId: 7, sourceDocType: 'PO', sourceDocNo: 'PO-9', qty: '3', amount: '300', status: 'open', createdBy: 'b', createdAt: 'T' },
      { id: 2, boqLineId: 7, sourceDocType: 'PO', sourceDocNo: 'PO-8', qty: '1', amount: '100', status: 'consumed', createdBy: 'b', createdAt: 'T' },
      { id: 1, boqLineId: 7, sourceDocType: 'PO', sourceDocNo: 'PO-7', qty: '2', amount: '50', status: 'released', createdBy: 'b', createdAt: 'T' },
    ];
    const { svc } = comEnv([rows]);
    const r = await svc.listForProject(5);
    expect(r.count).toBe(3);
    expect(r.summary).toEqual({ open: 300, consumed: 100, released: 50, committed: 400 });
    expect(r.commitments[0]).toMatchObject({ id: 3, amount: 300, status: 'open' });
  });
});
