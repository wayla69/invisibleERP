import { describe, expect, it } from 'vitest';

import { LedgerRecurringService } from '../src/modules/ledger/ledger-recurring.service';

// Unit tests for the GL-08 recurring-journal template guards (workstream 2.4 slice 2 — the docs/38
// ledger PR-2 sub-service is a plain class). createRecurring validates the template UP FRONT so a
// malformed template can never be saved and then fail silently every night — every path here throws
// before any insert, so the db fake hard-throws on writes to prove it.

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
