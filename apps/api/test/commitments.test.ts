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
    const p: any = { from: () => p, where: () => p, limit: () => p, orderBy: () => p, groupBy: () => p, for: () => p, innerJoin: () => p, leftJoin: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  const runner = {
    select: () => { if (call >= routes.length) throw new Error(`unexpected select #${call + 1} — add a route`); return chain(routes[call++] ?? []); },
    // insert().values() captures immediately and exposes .returning() (reserve/glReserve) — a bare
    // `await insert().values()` (glUpdateControlSettings' insert path) just resolves the wrapper, no throw.
    insert: () => ({ values: (v: any) => { cap.inserts.push(v); return { returning: () => Promise.resolve([{ id: 501 }]) }; } }),
    // update().set() captures the SET payload; the returned where() is BOTH awaitable (glUpdateControlSettings
    // does a bare `await …where()`) AND exposes .returning() (release/consume/glRelease/glConsume read length).
    update: () => ({ set: (v: any) => { cap.updates.push(v); const res = opts.updReturn ?? [{ id: 1 }, { id: 2 }]; return { where: () => ({ returning: () => Promise.resolve(res), then: (r: any, j: any) => Promise.resolve(res).then(r, j) }) }; } }),
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

// ══ FIN-3 (BUD-02) — GL-budget commitments / encumbrance for non-project procurement ═══════════════════
// The same routed-env fake drives the gl* engine: policy read → item→account resolution → per-account
// availability (budget − actuals − open commitments) → the gate's policy verdict → the recorded encumbrance.

const SETTINGS = (policy: string, def = '5000') => ({ policy, defaultExpenseAccount: def });
// availability route-quads (yearBudget{v,c} → ytdBudget{v} → actuals{d,c} → open{v}):
const AVAIL_OK = [[{ v: '1000', c: '1' }], [{ v: '1000' }], [{ d: '0', c: '0' }], [{ v: '0' }]];      // available 1000
const AVAIL_TIGHT = [[{ v: '100', c: '1' }], [{ v: '100' }], [{ d: '0', c: '0' }], [{ v: '0' }]];      // available 100 (has budget)
const AVAIL_NOBUDGET = [[{ v: '0', c: '0' }], [{ v: '0' }], [{ d: '0', c: '0' }], [{ v: '0' }]];       // has_budget false

describe('CommitmentsService — glControlSettings (BUD-02 policy)', () => {
  it('a stored row yields its custom policy / default account / audit; tenant-scoped lookup', async () => {
    const { svc } = comEnv([[{ policy: 'block', defaultExpenseAccount: '6000', updatedBy: 'boss', updatedAt: 'T1' }]]);
    expect(await svc.glControlSettings(1)).toEqual({ policy: 'block', default_expense_account: '6000', updated_by: 'boss', updated_at: 'T1' });
  });
  it('no row → the fail-safe defaults (off / 5000); a null tenant uses the isNull branch', async () => {
    const { svc } = comEnv([[]]);
    expect(await svc.glControlSettings(null)).toEqual({ policy: 'off', default_expense_account: '5000', updated_by: null, updated_at: null });
  });
});

describe('CommitmentsService — glUpdateControlSettings', () => {
  const exec = { username: 'boss', tenantId: 1, role: 'Admin', permissions: ['exec'] } as any;
  it('an unknown policy is BAD_POLICY (thrown before any read)', async () => {
    const { svc } = comEnv([]); // strict: no select happens
    const e: any = await code(() => svc.glUpdateControlSettings({ policy: 'loose' }, exec));
    expect(e?.response?.code).toBe('BAD_POLICY');
  });
  it('updates the existing row (trimmed default account) and returns the refreshed settings', async () => {
    const { svc, cap } = comEnv([[{ id: 9 }], [{ policy: 'warn', defaultExpenseAccount: '6100', updatedBy: 'boss', updatedAt: 'T' }]]);
    const r = await svc.glUpdateControlSettings({ policy: 'warn', default_expense_account: '  6100  ' }, exec);
    expect(cap.updates[0]).toMatchObject({ policy: 'warn', defaultExpenseAccount: '6100', updatedBy: 'boss' });
    expect(cap.inserts).toHaveLength(0);
    expect(r).toMatchObject({ policy: 'warn', default_expense_account: '6100' });
  });
  it('inserts a new row when none exists; a blank default account is skipped (not written); null tenant', async () => {
    const { svc, cap } = comEnv([[], [{ policy: 'advise', defaultExpenseAccount: '5000', updatedBy: 'boss', updatedAt: 'T' }]]);
    const r = await svc.glUpdateControlSettings({ policy: 'advise', default_expense_account: '   ' }, { username: 'boss', tenantId: null, role: 'Admin' } as any);
    expect(cap.updates).toHaveLength(0);
    expect(cap.inserts[0]).toMatchObject({ tenantId: null, policy: 'advise' });
    expect(cap.inserts[0].defaultExpenseAccount).toBeUndefined();
    expect(r.policy).toBe('advise');
  });
});

describe('CommitmentsService — glResolveAccounts', () => {
  it('empty / blank-only ids short-circuit with no read', async () => {
    const { svc } = comEnv([]); // strict: any select throws
    expect(await svc.glResolveAccounts([], '5000')).toEqual(new Map());
    expect(await svc.glResolveAccounts(['', ''] as any, '5000')).toEqual(new Map());
  });
  it('item → own cogs, else category cogs, else the tenant default', async () => {
    const { svc } = comEnv([[
      { itemId: 'A', own: '6000', cat: '6100' },
      { itemId: 'B', own: null, cat: '6200' },
      { itemId: 'C', own: null, cat: null },
    ]]);
    const m = await svc.glResolveAccounts(['A', 'B', 'C', 'A'], '5000');
    expect(m.get('A')).toBe('6000');
    expect(m.get('B')).toBe('6200');
    expect(m.get('C')).toBe('5000');
  });
});

describe('CommitmentsService — glAvailability (budget − actual − open commitments)', () => {
  it('a budgeted account: available = ytd budget − (debit−credit) − open commitments; no cost centre; tenant-scoped', async () => {
    const { svc } = comEnv([[{ v: '1000', c: '2' }], [{ v: '600' }], [{ debit: '400', credit: '50' }], [{ v: '100' }]]);
    const a = await svc.glAvailability(1, '6000', null, '2026-06');
    expect(a).toMatchObject({ fiscal_year: 2026, period: '2026-06', account_code: '6000', cost_center: null, has_budget: true, budget_year: 1000, budget_ytd: 600, actual_ytd: 350, open_commitments: 100, available: 150 });
  });
  it('no approved budget line → has_budget false; a cost centre + null tenant take their branches', async () => {
    const { svc } = comEnv([[{ v: '0', c: '0' }], [{ v: '0' }], [{ debit: '0', credit: '0' }], [{ v: '0' }]]);
    const a = await svc.glAvailability(null, '6000', 'CC1', '2026-06');
    expect(a).toMatchObject({ has_budget: false, cost_center: 'CC1', available: 0 });
  });
  it('a December period rolls the actuals window into the next year (m===12 branch)', async () => {
    const { svc } = comEnv([[{ v: '1000', c: '1' }], [{ v: '1000' }], [{ d: '0', c: '0' }], [{ v: '0' }]]);
    const a = await svc.glAvailability(1, '6000', null, '2026-12');
    expect(a).toMatchObject({ fiscal_year: 2026, period: '2026-12', available: 1000 });
  });
});

describe('CommitmentsService — glGate (the PR/PO approval budget gate)', () => {
  const buyer = { username: 'buyer1', role: 'Purchasing', permissions: [] } as any;
  const exec = { username: 'boss', role: 'Admin', permissions: ['exec'] } as any;
  const EXCEED = { item_id: null, amount: 500 };

  it("policy 'off' returns null (zero behaviour change)", async () => {
    const { svc } = comEnv([[SETTINGS('off')]]);
    expect(await svc.glGate({ tenantId: 1, lines: [{ item_id: null, amount: 100 }], user: buyer })).toBeNull();
  });
  it('no positive line returns null (nothing gateable)', async () => {
    const { svc } = comEnv([[SETTINGS('block')]]);
    expect(await svc.glGate({ tenantId: 1, lines: [{ item_id: null, amount: 0 }], user: buyer })).toBeNull();
  });
  it('within budget → not exceeded; an item_id resolves to its own budget account', async () => {
    const { svc } = comEnv([[SETTINGS('block')], [{ itemId: 'A', own: '6000', cat: null }], ...AVAIL_OK]);
    const g = await svc.glGate({ tenantId: 1, lines: [{ item_id: 'A', amount: 100 }], user: buyer });
    expect(g).toMatchObject({ policy: 'block', exceeded: false, overridden: false, override_reason: null });
    expect(g!.checks[0]).toMatchObject({ account_code: '6000', doc_amount: 100, exceeded: false });
  });
  it('exceeded under block → BUDGET_EXCEEDED (422)', async () => {
    const { svc } = comEnv([[SETTINGS('block')], ...AVAIL_TIGHT]);
    const e: any = await code(() => svc.glGate({ tenantId: 1, lines: [EXCEED], user: buyer }));
    expect(e?.response?.code).toBe('BUDGET_EXCEEDED');
  });
  it('exceeded under warn without confirm → BUDGET_CONFIRM_REQUIRED', async () => {
    const { svc } = comEnv([[SETTINGS('warn')], ...AVAIL_TIGHT]);
    const e: any = await code(() => svc.glGate({ tenantId: 1, lines: [EXCEED], user: buyer }));
    expect(e?.response?.code).toBe('BUDGET_CONFIRM_REQUIRED');
  });
  it('warn + confirm_over_budget passes with exceeded:true, overridden:false', async () => {
    const { svc } = comEnv([[SETTINGS('warn')], ...AVAIL_TIGHT]);
    const g = await svc.glGate({ tenantId: 1, lines: [EXCEED], user: buyer, confirm: true });
    expect(g).toMatchObject({ exceeded: true, overridden: false });
  });
  it('an override by a non-exec → BUDGET_OVERRIDE_DENIED', async () => {
    const { svc } = comEnv([[SETTINGS('block')], ...AVAIL_TIGHT]);
    const e: any = await code(() => svc.glGate({ tenantId: 1, lines: [EXCEED], user: buyer, override: true }));
    expect(e?.response?.code).toBe('BUDGET_OVERRIDE_DENIED');
  });
  it('an exec override with no reason → BUDGET_OVERRIDE_REASON_REQUIRED', async () => {
    const { svc } = comEnv([[SETTINGS('block')], ...AVAIL_TIGHT]);
    const e: any = await code(() => svc.glGate({ tenantId: 1, lines: [EXCEED], user: exec, override: true, overrideReason: '   ' }));
    expect(e?.response?.code).toBe('BUDGET_OVERRIDE_REASON_REQUIRED');
  });
  it('an exec override with a reason → overridden:true (reason trimmed)', async () => {
    const { svc } = comEnv([[SETTINGS('block')], ...AVAIL_TIGHT]);
    const g = await svc.glGate({ tenantId: 1, lines: [EXCEED], user: exec, override: true, overrideReason: '  urgent  ' });
    expect(g).toMatchObject({ exceeded: true, overridden: true, override_reason: 'urgent' });
  });
  it('a has_budget=false account never exceeds even under block', async () => {
    const { svc } = comEnv([[SETTINGS('block')], ...AVAIL_NOBUDGET]);
    const g = await svc.glGate({ tenantId: 1, lines: [EXCEED], user: buyer });
    expect(g).toMatchObject({ exceeded: false });
  });
});

describe('CommitmentsService — glGateForDoc (policy gate before loading doc lines)', () => {
  const buyer = { username: 'buyer1', role: 'Purchasing', permissions: [] } as any;
  it("policy 'off' → null WITHOUT loading any doc line", async () => {
    const { svc } = comEnv([[SETTINGS('off')]]); // strict: a line-load select would throw
    expect(await svc.glGateForDoc('PR', 'PR-1', { tenantId: 1, user: buyer })).toBeNull();
  });
  it('policy on → loads the doc lines and delegates to glGate (PO branch)', async () => {
    const { svc } = comEnv([
      [SETTINGS('block')],                                                     // glControlSettings (glGateForDoc)
      [{ id: 1 }],                                                             // PO head
      [{ itemId: null, boqLineId: null, isCapital: false, amount: '100' }],    // po items
      [SETTINGS('block')],                                                     // glControlSettings (glGate)
      ...AVAIL_OK,                                                             // availability for the default account
    ]);
    const g = await svc.glGateForDoc('PO', 'PO-1', { tenantId: 1, user: buyer });
    expect(g).toMatchObject({ policy: 'block', exceeded: false });
    expect(g!.checks[0]).toMatchObject({ account_code: '5000', doc_amount: 100 });
  });
});

describe('CommitmentsService — glGateLinesFor (doc line extraction)', () => {
  it('PO: excludes BoQ-tagged + capital lines; amount from l.amount or qty×price', async () => {
    const { svc } = comEnv([
      [{ id: 1 }],
      [
        { itemId: 'A', boqLineId: null, isCapital: false, amount: '250' },
        { itemId: 'B', boqLineId: null, isCapital: false, amount: null, orderQty: '2', unitPrice: '30' },
        { itemId: 'C', boqLineId: 9, isCapital: false, amount: '99' },   // BoQ-tagged → excluded (PROJ-12 encumbers it)
        { itemId: 'D', boqLineId: null, isCapital: true, amount: '99' },  // capital → excluded (CAPEX ≠ opex budget)
      ],
    ]);
    expect(await svc.glGateLinesFor('PO', 'PO-1')).toEqual([{ item_id: 'A', amount: 250 }, { item_id: 'B', amount: 60 }]);
  });
  it('an unknown PO → NOT_FOUND', async () => {
    const { svc } = comEnv([[]]);
    expect((await code(() => svc.glGateLinesFor('PO', 'PO-404')) as any)?.response?.code).toBe('NOT_FOUND');
  });
  it('PR: excludes BoQ lines, prices the rest from the item master', async () => {
    const { svc } = comEnv([
      [{ id: 1 }],
      [
        { itemId: 'A', boqLineId: null, requestQty: '2' },
        { itemId: 'X', boqLineId: 7, requestQty: '5' }, // BoQ-tagged → excluded
      ],
      [{ itemId: 'A', price: '50' }],
    ]);
    expect(await svc.glGateLinesFor('PR', 'PR-1')).toEqual([{ item_id: 'A', amount: 100 }]);
  });
  it('PR with no priced item ids skips the item-master read', async () => {
    const { svc } = comEnv([
      [{ id: 1 }],
      [{ itemId: null, boqLineId: null, requestQty: '2' }], // no itemId → item-master lookup skipped
    ]);
    expect(await svc.glGateLinesFor('PR', 'PR-1')).toEqual([{ item_id: null, amount: 0 }]);
  });
  it('an unknown PR → NOT_FOUND', async () => {
    const { svc } = comEnv([[]]);
    expect((await code(() => svc.glGateLinesFor('PR', 'PR-404')) as any)?.response?.code).toBe('NOT_FOUND');
  });
});

describe('CommitmentsService — glReserve (one commitment per gate check, idempotent)', () => {
  const user = { username: 'boss' } as any;
  const gate = (overridden: boolean, checks: any[]) => ({ policy: 'block', period: '2026-07', exceeded: true, overridden, override_reason: overridden ? 'urgent' : null, checks } as any);
  it('a doc already committed records nothing (returns 0)', async () => {
    const { svc, runner, cap } = comEnv([[{ id: 77 }]]);
    const r = await svc.glReserve(runner, gate(false, [{ fiscal_year: 2026, account_code: '6000', doc_amount: 100, exceeded: false }]), { docType: 'PR', docNo: 'PR-1', tenantId: 1, user });
    expect(r).toBe(0);
    expect(cap.inserts).toHaveLength(0);
  });
  it('records one row per check; an over-budget + overridden check carries the override evidence', async () => {
    const { svc, runner, cap } = comEnv([[]]);
    const r = await svc.glReserve(runner, gate(true, [
      { fiscal_year: 2026, account_code: '6000', doc_amount: 500, exceeded: true },
      { fiscal_year: 2026, account_code: '5000', doc_amount: 50, exceeded: false },
    ]), { docType: 'PR', docNo: 'PR-1', tenantId: 1, user });
    expect(r).toBe(2);
    expect(cap.inserts[0]).toMatchObject({ accountCode: '6000', amount: '500', status: 'open', overBudget: true, overrideBy: 'boss', overrideReason: 'urgent', sourceDocType: 'PR', sourceDocNo: 'PR-1' });
    expect(cap.inserts[1]).toMatchObject({ accountCode: '5000', overBudget: false, overrideBy: null, overrideReason: null });
  });
});

describe('CommitmentsService — glRelease / glConsume lifecycle', () => {
  it('glRelease flips open GL commitments to released and returns the count', async () => {
    const { svc, runner, cap } = comEnv([], { updReturn: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect(await svc.glRelease(runner, 'PR', 'PR-1')).toBe(3);
    expect(cap.updates[0]).toMatchObject({ status: 'released' });
  });
  it('glConsume marks them consumed and returns the count', async () => {
    const { svc, runner, cap } = comEnv([], { updReturn: [{ id: 1 }] });
    expect(await svc.glConsume(runner, 'PO', 'PO-1')).toBe(1);
    expect(cap.updates[0]).toMatchObject({ status: 'consumed' });
  });
});

describe('CommitmentsService — glDocPreview / glPreviewChecks (read-only approval chip)', () => {
  it("policy 'off' → an empty, non-exceeded preview (no line load)", async () => {
    const { svc } = comEnv([[SETTINGS('off')]]);
    expect(await svc.glDocPreview('PR', 'PR-1', 1)).toEqual({ policy: 'off', checks: [], exceeded: false });
  });
  it('policy on → per-account checks with exceeded flags (PR priced from the item master)', async () => {
    const { svc } = comEnv([
      [SETTINGS('block')],                                   // glControlSettings
      [{ id: 1 }],                                           // PR head
      [{ itemId: 'A', boqLineId: null, requestQty: '10' }],  // pr items
      [{ itemId: 'A', price: '50' }],                        // item price → amount 500
      [{ itemId: 'A', own: '6000', cat: null }],             // resolveAccounts
      ...AVAIL_TIGHT,                                        // available 100 → exceeded
    ]);
    const p = await svc.glDocPreview('PR', 'PR-1', 1);
    expect(p.policy).toBe('block');
    expect(p.exceeded).toBe(true);
    expect(p.checks[0]).toMatchObject({ account_code: '6000', doc_amount: 500, exceeded: true });
  });
});

describe('CommitmentsService — glListCommitments (audit read model)', () => {
  const ROW = { id: 5, fiscalYear: 2026, period: '2026-07', accountCode: '6000', costCenterCode: 'CC1', sourceDocType: 'PR', sourceDocNo: 'PR-1', amount: '500', status: 'open', overBudget: true, overrideBy: 'boss', overrideReason: 'urgent', createdBy: 'boss', createdAt: 'T' };
  it('maps rows + count with every filter applied (tenant + account + period + doc + status)', async () => {
    const { svc } = comEnv([[ROW]]);
    const r = await svc.glListCommitments(1, { account: '6000', period: '2026-07', source_doc_no: 'PR-1', status: 'open' });
    expect(r.count).toBe(1);
    expect(r.commitments[0]).toMatchObject({ id: 5, fiscal_year: 2026, period: '2026-07', account_code: '6000', cost_center_code: 'CC1', amount: 500, status: 'open', over_budget: true, override_by: 'boss', override_reason: 'urgent', created_by: 'boss' });
  });
  it('no filters (null tenant, empty query) still lists (undefined WHERE branch)', async () => {
    const { svc } = comEnv([[]]);
    expect(await svc.glListCommitments(null, {})).toEqual({ commitments: [], count: 0 });
  });
});

// ── A5 (docs/50 Wave 5): the project-scrap guards — wipDrawn (net drawn value + BOLA/line validation)
//    and projectIdByCode (code→id with the combined id+tenant check). Route order inside wipDrawn:
//    project row → (BoQ line when given) → consumed RES/MRET sum.
describe('CommitmentsService — wipDrawn (A5 net drawn value for project scrap)', () => {
  const PRJ = { id: 5, tenantId: 1 };
  it('project scope: sums consumed RES + MRET (returns net down) with no line read', async () => {
    const { svc } = comEnv([[PRJ], [{ v: '450.5' }]]);
    expect(await svc.wipDrawn(5, null, 1)).toEqual({ net_issued: 450.5 });
  });
  it('line scope: validates the line belongs to the project, then sums line-scoped', async () => {
    const { svc } = comEnv([[PRJ], [{ pid: 5 }], [{ v: '300' }]]);
    expect(await svc.wipDrawn(5, 7, 1)).toEqual({ net_issued: 300 });
  });
  it('a line of ANOTHER project is BOQ_LINE_MISMATCH', async () => {
    const { svc } = comEnv([[PRJ], [{ pid: 99 }]]);
    expect((await code(() => svc.wipDrawn(5, 7, 1)))?.response?.code).toBe('BOQ_LINE_MISMATCH');
  });
  it('a missing line is BOQ_LINE_MISMATCH too (fail-closed)', async () => {
    const { svc } = comEnv([[PRJ], []]);
    expect((await code(() => svc.wipDrawn(5, 7, 1)))?.response?.code).toBe('BOQ_LINE_MISMATCH');
  });
  it('an unknown project is PROJECT_NOT_FOUND', async () => {
    const { svc } = comEnv([[]]);
    expect((await code(() => svc.wipDrawn(999, null, 1)))?.response?.code).toBe('PROJECT_NOT_FOUND');
  });
  it("another tenant's project is PROJECT_NOT_FOUND (combined id+tenant BOLA check)", async () => {
    const { svc } = comEnv([[{ id: 5, tenantId: 2 }]]);
    expect((await code(() => svc.wipDrawn(5, null, 1)))?.response?.code).toBe('PROJECT_NOT_FOUND');
  });
  it('an HQ caller (null tenant) may read any project; a null-tenant project row passes any caller', async () => {
    const { svc } = comEnv([[{ id: 5, tenantId: 2 }], [{ v: '0' }]]);
    expect(await svc.wipDrawn(5, null, null)).toEqual({ net_issued: 0 });
    const { svc: svc2 } = comEnv([[{ id: 5, tenantId: null }], [{ v: null }]]);
    expect(await svc2.wipDrawn(5, null, 1)).toEqual({ net_issued: 0 });
  });
});

describe('CommitmentsService — projectIdByCode (A5 code→id resolution)', () => {
  it('resolves a code to its numeric id', async () => {
    const { svc } = comEnv([[{ id: 42, tenantId: 1 }]]);
    expect(await svc.projectIdByCode('PRJ-A', 1)).toBe(42);
  });
  it("an unknown code, or another tenant's code, is PROJECT_NOT_FOUND", async () => {
    const { svc } = comEnv([[]]);
    expect((await code(() => svc.projectIdByCode('NOPE', 1)))?.response?.code).toBe('PROJECT_NOT_FOUND');
    const { svc: svc2 } = comEnv([[{ id: 42, tenantId: 2 }]]);
    expect((await code(() => svc2.projectIdByCode('PRJ-B', 1)))?.response?.code).toBe('PROJECT_NOT_FOUND');
  });
});
