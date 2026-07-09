import { describe, expect, it } from 'vitest';

import { LedgerRecurringService } from '../src/modules/ledger/ledger-recurring.service';
import { ymd } from '../src/database/queries';

// Unit tests for the GL-08 recurring-journal template guards (workstream 2.4 slice 2 — the docs/38
// ledger PR-2 sub-service is a plain class). createRecurring validates the template UP FRONT so a
// malformed template can never be saved and then fail silently every night — every path here throws
// before any insert, so the db fake hard-throws on writes to prove it.
// Slice 5 adds the WRITE paths: the create happy paths and the two idempotent scheduled sweeps
// (runDueRecurring GL-08 / runDuePrepaid GL-09) — the postEntry port captures what each sweep posts and
// the db fake captures how each schedule is rolled forward.

const noDb = {
  select: () => { throw new Error('unexpected read'); },
  insert: () => { throw new Error('unexpected write in a guard-path unit test'); },
} as any;
const docNo = { nextDaily: async () => 'PPD-TEST-001' } as any;
const postEntry = async () => ({ entry_no: 'JE-TEST-001' });
const user = { username: 'maker1' } as any;

async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); } catch (e: any) { return e?.response?.code ?? e?.code ?? String(e); }
  return 'NO_THROW';
}

describe('LedgerRecurringService — createRecurring template guards (GL-08)', () => {
  const svc = new LedgerRecurringService(noDb, docNo, postEntry);

  it('rejects an unknown cadence (BAD_FREQUENCY)', async () => {
    expect(await code(() => svc.createRecurring({ name: 'r', frequency: 'yearly', lines: [
      { account_code: '5100', debit: 10 }, { account_code: '1000', credit: 10 },
    ] } as any, user))).toBe('BAD_FREQUENCY');
  });

  it('rejects an all-zero template (UNBALANCED)', async () => {
    expect(await code(() => svc.createRecurring({ name: 'r', frequency: 'monthly', lines: [
      { account_code: '5100', debit: 0 }, { account_code: '1000', credit: 0 },
    ] } as any, user))).toBe('UNBALANCED');
  });

  it('rejects an unbalanced template in bigint minor units (UNBALANCED, scale-4 drift)', async () => {
    expect(await code(() => svc.createRecurring({ name: 'r', frequency: 'monthly', lines: [
      { account_code: '5100', debit: 100.0001 }, { account_code: '1000', credit: 100 },
    ] } as any, user))).toBe('UNBALANCED');
  });
});

describe('LedgerRecurringService — createPrepaid guards (GL-09)', () => {
  const svc = new LedgerRecurringService(noDb, docNo, postEntry);

  it('rejects a non-positive total (BAD_AMOUNT)', async () => {
    expect(await code(() => svc.createPrepaid({ name: 'ins', totalAmount: 0, months: 12 } as any, user))).toBe('BAD_AMOUNT');
  });

  it('rejects fractional or zero months (BAD_MONTHS)', async () => {
    expect(await code(() => svc.createPrepaid({ name: 'ins', totalAmount: 1200, months: 2.5 } as any, user))).toBe('BAD_MONTHS');
    expect(await code(() => svc.createPrepaid({ name: 'ins', totalAmount: 1200, months: 0 } as any, user))).toBe('BAD_MONTHS');
  });
});

describe('LedgerRecurringService — setRecurringActive lookup', () => {
  it('an unknown schedule id is NOT_FOUND', async () => {
    const empty: any = { from: () => empty, where: () => empty, limit: () => empty, then: (r: any, j: any) => Promise.resolve([]).then(r, j) };
    const svc = new LedgerRecurringService({ select: () => empty } as any, docNo, postEntry);
    expect(await code(() => svc.setRecurringActive(99, false))).toBe('NOT_FOUND');
  });
});

// ───────────────────── write paths (slice 5) ─────────────────────
// A routed fake: select() answers the due-rows scan, insert() captures create writes (returning an id),
// update() captures how each sweep rolls its schedule forward; the postEntry PORT captures every JE the
// sweep hands to the GL-05 posting core, and its scripted return exercises the ux_je_idem dedupe branch.

type SweepCap = { inserts: any[]; updates: any[]; posts: any[] };

function sweepEnv(dueRows: any[], postReturns?: (string | null)[]): { db: any; post: any; cap: SweepCap } {
  const cap: SweepCap = { inserts: [], updates: [], posts: [] };
  const chain = (rows: any[]) => {
    const p: any = { from: () => p, where: () => p, limit: () => p, orderBy: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  const db = {
    select: () => chain(dueRows),
    insert: () => ({ values: (v: any) => { cap.inserts.push(v); return { returning: () => Promise.resolve([{ id: 11 }]) }; } }),
    update: () => ({ set: (v: any) => ({ where: () => { cap.updates.push(v); return Promise.resolve(); } }) }),
  };
  let call = 0;
  const post = async (dto: any) => { cap.posts.push(dto); return { entry_no: postReturns ? postReturns[call++] ?? null : `JE-R-${cap.posts.length}` }; };
  return { db, post, cap };
}

// The cadence contract (module-level addByFrequency): pin the expected roll in UTC date arithmetic.
const roll = (dateStr: string, f: 'daily' | 'weekly' | 'monthly') => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (f === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (f === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const TEMPLATE_LINES = [
  { account_code: '5100', debit: 100 },
  { account_code: '1000', credit: 100 },
];

describe('LedgerRecurringService — createRecurring/createPrepaid happy paths (GL-08/GL-09)', () => {
  it('a balanced template saves active with next_run_date = start date', async () => {
    const { db, post, cap } = sweepEnv([]);
    const svc = new LedgerRecurringService(db as any, docNo, post);
    const r = await svc.createRecurring({ name: 'rent', frequency: 'monthly', startDate: '2026-08-01', lines: [
      ...TEMPLATE_LINES, { account_code: '2100', credit: 0 },
    ] } as any, user);
    expect(r).toMatchObject({ id: 11, name: 'rent', frequency: 'monthly', next_run_date: '2026-08-01' });
    expect(cap.inserts[0]).toMatchObject({ name: 'rent', frequency: 'monthly', active: 'true', nextRunDate: '2026-08-01', createdBy: 'maker1' });
    expect(cap.inserts[0].lines).toHaveLength(2); // zero legs already dropped at save time
    expect(cap.posts).toHaveLength(0);            // creating a template posts nothing
  });

  it('capitalize:true records the up-front prepayment (Dr prepaid / Cr cash) and the schedule starts at zero', async () => {
    const { db, post, cap } = sweepEnv([]);
    const svc = new LedgerRecurringService(db as any, docNo, post);
    const r = await svc.createPrepaid({ name: 'insurance', totalAmount: 1200, months: 12, startDate: '2026-08-01', capitalize: true } as any, user);
    expect(r).toMatchObject({ id: 11, schedule_no: 'PPD-TEST-001', total_amount: 1200, months: 12, monthly_amount: 100, next_run_date: '2026-08-01' });
    expect(cap.posts).toHaveLength(1);
    expect(cap.posts[0]).toMatchObject({ source: 'PPD-CAP', sourceRef: 'PPD-TEST-001', date: '2026-08-01' });
    expect(cap.posts[0].lines).toEqual([{ account_code: '1280', debit: 1200 }, { account_code: '1000', credit: 1200 }]);
    expect(cap.inserts[0]).toMatchObject({ scheduleNo: 'PPD-TEST-001', totalAmount: '1200', months: 12, amortizedAmount: '0', periodsPosted: 0, status: 'active' });
  });

  it('without capitalize nothing posts — the prepayment is assumed already on the books', async () => {
    const { db, post, cap } = sweepEnv([]);
    const svc = new LedgerRecurringService(db as any, docNo, post);
    await svc.createPrepaid({ name: 'insurance', totalAmount: 1200, months: 12 } as any, user);
    expect(cap.posts).toHaveLength(0);
    expect(cap.inserts).toHaveLength(1);
  });
});

describe('LedgerRecurringService — listing mappings (GL-08/GL-09 registers)', () => {
  it('listRecurring maps a template row (active flag from the string column, both null-sides of last-run)', async () => {
    const { db, post } = sweepEnv([{
      id: 3, name: 'rent', frequency: 'monthly', memo: null, ledgerCode: null, currency: 'THB',
      lines: TEMPLATE_LINES, active: 'true', nextRunDate: '2026-08-01', lastRunDate: null, lastEntryNo: null, createdBy: 'maker1',
    }]);
    const svc = new LedgerRecurringService(db as any, docNo, post);
    const r = await svc.listRecurring(1);
    expect(r.count).toBe(1);
    expect(r.recurring[0]).toMatchObject({ id: 3, name: 'rent', active: true, next_run_date: '2026-08-01', last_run_date: null, last_entry_no: null });
  });

  it('listPrepaid derives the remaining balance (total − amortized) per schedule', async () => {
    const { db, post } = sweepEnv([{
      id: 5, scheduleNo: 'PPD-5', name: 'ins', totalAmount: '1200', months: 12, amortizedAmount: '300',
      periodsPosted: 3, expenseAccount: '5100', nextRunDate: '2026-08-01', status: 'active',
    }]);
    const svc = new LedgerRecurringService(db as any, docNo, post);
    const r = await svc.listPrepaid();
    expect(r.schedules[0]).toMatchObject({ schedule_no: 'PPD-5', total_amount: 1200, amortized_amount: 300, remaining: 900, periods_posted: 3, status: 'active' });
  });
});

describe('LedgerRecurringService — runDueRecurring sweep (GL-08, Draft + idempotent)', () => {
  const today = ymd();
  const rec = (id: number, frequency: string, extra: any = {}) => ({
    id, name: `rec-${id}`, frequency, tenantId: 1, currency: 'THB', memo: null, ledgerCode: null,
    lines: TEMPLATE_LINES, lastEntryNo: null, ...extra,
  });

  it('posts each due template as a DRAFT (maker-checker) with the REC-<id>-<date> idem ref, and rolls the cadence', async () => {
    const { db, post, cap } = sweepEnv([rec(7, 'monthly'), rec(8, 'weekly'), rec(9, 'daily')]);
    const svc = new LedgerRecurringService(db as any, docNo, post);
    const r = await svc.runDueRecurring(user);
    expect(r).toMatchObject({ as_of: today, scanned: 3, posted: 3 });
    expect(r.entries.map((e: any) => e.recurring_id)).toEqual([7, 8, 9]);
    // GL-05: the sweep NEVER posts straight to the GL — every template lands pendingApproval (Draft).
    for (const p of cap.posts) expect(p).toMatchObject({ source: 'Recurring', pendingApproval: true, date: today });
    expect(cap.posts[0]).toMatchObject({ sourceRef: `REC-7-${today}`, createdBy: 'maker1 (recurring)' });
    // The schedule rolls forward by each template's own cadence.
    expect(cap.updates[0]).toMatchObject({ lastRunDate: today, lastEntryNo: 'JE-R-1', nextRunDate: roll(today, 'monthly') });
    expect(cap.updates[1].nextRunDate).toBe(roll(today, 'weekly'));
    expect(cap.updates[2].nextRunDate).toBe(roll(today, 'daily'));
  });

  it('a deduped posting (entry_no null) still rolls the schedule but keeps the previous last_entry_no and reports 0 posted', async () => {
    const { db, post, cap } = sweepEnv([rec(7, 'monthly', { lastEntryNo: 'JE-OLD' })], [null]);
    const svc = new LedgerRecurringService(db as any, docNo, post);
    const r = await svc.runDueRecurring(user);
    expect(r).toMatchObject({ scanned: 1, posted: 0, entries: [] });
    expect(cap.updates[0]).toMatchObject({ lastRunDate: today, lastEntryNo: 'JE-OLD', nextRunDate: roll(today, 'monthly') });
  });
});

describe('LedgerRecurringService — runDuePrepaid sweep (GL-09 straight line)', () => {
  const today = ymd();
  const period = today.slice(0, 7);
  const sched = (extra: any = {}) => ({
    id: 5, scheduleNo: 'PPD-5', tenantId: 1, totalAmount: '1200', months: 12, periodsPosted: 0, amortizedAmount: '0',
    expenseAccount: '5100', prepaidAccount: '1280', ...extra,
  });

  it('amortizes one straight-line slice (Dr expense / Cr prepaid), idempotent per (schedule, period), advances a month', async () => {
    const { db, post, cap } = sweepEnv([sched()]);
    const svc = new LedgerRecurringService(db as any, docNo, post);
    const r = await svc.runDuePrepaid(user);
    expect(r).toMatchObject({ scanned: 1, posted: 1 });
    expect(r.entries[0]).toMatchObject({ schedule_no: 'PPD-5', amount: 100 });
    expect(cap.posts[0]).toMatchObject({ source: 'PPD', sourceRef: `PPD-5-${period}` });
    expect(cap.posts[0].lines).toEqual([{ account_code: '5100', debit: 100 }, { account_code: '1280', credit: 100 }]);
    expect(cap.updates[0]).toMatchObject({ amortizedAmount: '100', periodsPosted: 1, status: 'active', nextRunDate: roll(today, 'monthly') });
  });

  it('the LAST period takes the remainder so the schedule fully clears and completes', async () => {
    // 1000 over 3 months: 333.33 + 333.33 posted → final slice is 333.34, not 333.33
    const { db, post, cap } = sweepEnv([sched({ totalAmount: '1000', months: 3, periodsPosted: 2, amortizedAmount: '666.66' })]);
    const svc = new LedgerRecurringService(db as any, docNo, post);
    const r = await svc.runDuePrepaid(user);
    expect(r.entries[0].amount).toBe(333.34);
    expect(cap.updates[0]).toMatchObject({ amortizedAmount: '1000', periodsPosted: 3, status: 'complete' });
  });

  it('an over-posted schedule is closed defensively without posting anything', async () => {
    const { db, post, cap } = sweepEnv([sched({ periodsPosted: 12 })]);
    const svc = new LedgerRecurringService(db as any, docNo, post);
    const r = await svc.runDuePrepaid(user);
    expect(r).toMatchObject({ scanned: 1, posted: 0 });
    expect(cap.posts).toHaveLength(0);
    expect(cap.updates[0]).toEqual({ status: 'complete' });
  });

  it('a deduped period (entry_no null) does not double-count amortized_amount', async () => {
    const { db, post, cap } = sweepEnv([sched()], [null]);
    const svc = new LedgerRecurringService(db as any, docNo, post);
    const r = await svc.runDuePrepaid(user);
    expect(r).toMatchObject({ posted: 0 });
    expect(cap.updates[0]).toMatchObject({ amortizedAmount: '0', periodsPosted: 1 });
  });
});
