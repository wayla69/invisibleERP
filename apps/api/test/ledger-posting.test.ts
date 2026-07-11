import { describe, expect, it } from 'vitest';

import { LedgerPostingService } from '../src/modules/ledger/ledger-posting.service';

// Unit tests for the GL-05/GL-17 posting core (workstream 2.4 — unlocked by the docs/38 decomposition:
// LedgerPostingService is a PLAIN class constructible from (db, docNo), so the control-critical guard
// paths are testable without PGlite). Every path here throws BEFORE any write, so the db fake only has
// to answer the read chains (select().from().where().limit()) the guards perform.

// Minimal drizzle-shaped read fake: routes select().from(<table>) to a canned row list keyed by the
// schema table object's identity; every chain stage returns a thenable so both `await ....limit(1)`
// and `await ....where(...)` (the control-account guard has no .limit) resolve to the rows.
function fakeDb(routes: Array<{ rows: any[] }>): any {
  let call = 0;
  const chain = (rows: any[]) => {
    const p: any = {
      from: () => p, where: () => p, limit: () => p, orderBy: () => p,
      then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
    };
    return p;
  };
  return {
    select: () => chain(routes[Math.min(call++, routes.length - 1)]?.rows ?? []),
    insert: () => { throw new Error('unexpected write in a guard-path unit test'); },
    update: () => { throw new Error('unexpected write in a guard-path unit test'); },
    transaction: () => { throw new Error('unexpected transaction in a guard-path unit test'); },
  };
}

const docNo = { nextDaily: async () => 'JE-TEST-001' } as any;
const user = (username: string) => ({ username }) as any;

async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); } catch (e: any) { return e?.response?.code ?? e?.code ?? String(e); }
  return 'NO_THROW';
}

describe('LedgerPostingService — postEntry guards (GL-05, balanced by construction)', () => {
  const svc = new LedgerPostingService(fakeDb([]) as any, docNo);

  it('rejects an empty entry (UNBALANCED)', async () => {
    expect(await code(() => svc.postEntry({ source: 'T', createdBy: 'a', lines: [] } as any))).toBe('UNBALANCED');
  });

  it('rejects an all-zero entry (UNBALANCED) — zero legs are dropped before validation', async () => {
    expect(await code(() => svc.postEntry({ source: 'T', createdBy: 'a', lines: [
      { account_code: '1000', debit: 0 }, { account_code: '4000', credit: 0 },
    ] } as any))).toBe('UNBALANCED');
  });

  it('rejects a negative leg (INVALID_LINE)', async () => {
    expect(await code(() => svc.postEntry({ source: 'T', createdBy: 'a', lines: [
      { account_code: '1000', debit: -5 }, { account_code: '4000', credit: -5 },
    ] } as any))).toBe('INVALID_LINE');
  });

  it('rejects a two-sided leg (INVALID_LINE)', async () => {
    expect(await code(() => svc.postEntry({ source: 'T', createdBy: 'a', lines: [
      { account_code: '1000', debit: 5, credit: 5 },
    ] } as any))).toBe('INVALID_LINE');
  });

  it('rejects a scale-4 drift the float sum would miss (UNBALANCED, bigint minor units — docs/27 R1-4)', async () => {
    expect(await code(() => svc.postEntry({ source: 'T', createdBy: 'a', lines: [
      { account_code: '1000', debit: 100.0001 }, { account_code: '4000', credit: 100 },
    ] } as any))).toBe('UNBALANCED');
  });

  it('blocks posting into a LOCKED period regardless of allowClosedPeriod (GL-15/16 hard close)', async () => {
    const svcLocked = new LedgerPostingService(fakeDb([{ rows: [{ status: 'Locked' }] }]) as any, docNo);
    expect(await code(() => svcLocked.postEntry({ source: 'T', createdBy: 'a', tenantId: 1, allowClosedPeriod: true, lines: [
      { account_code: '1000', debit: 10 }, { account_code: '4000', credit: 10 },
    ] } as any))).toBe('PERIOD_LOCKED');
  });

  it('blocks posting into a Closed period without allowClosedPeriod (PERIOD_CLOSED)', async () => {
    const svcClosed = new LedgerPostingService(fakeDb([{ rows: [{ status: 'Closed' }] }]) as any, docNo);
    expect(await code(() => svcClosed.postEntry({ source: 'T', createdBy: 'a', tenantId: 1, lines: [
      { account_code: '1000', debit: 10 }, { account_code: '4000', credit: 10 },
    ] } as any))).toBe('PERIOD_CLOSED');
  });

  it('rejects a direct posting to a control account without viaSubledger (WS1.1 CONTROL_ACCOUNT)', async () => {
    // route 1: period lookup (open) · route 2: account-universe scan (both codes exist; 1100 is control)
    const svcCtl = new LedgerPostingService(fakeDb([
      { rows: [] },
      { rows: [
        { code: '1100', isPostable: true, isControl: true, controlSubledger: 'AR' },
        { code: '4000', isPostable: true, isControl: false, controlSubledger: null },
      ] },
    ]) as any, docNo);
    expect(await code(() => svcCtl.postEntry({ source: 'T', createdBy: 'a', tenantId: 1, lines: [
      { account_code: '1100', debit: 10 }, { account_code: '4000', credit: 10 },
    ] } as any))).toBe('CONTROL_ACCOUNT');
  });

  it('rejects a line whose account is NOT in the chart of accounts (GL-21 INVALID_POSTING_ACCOUNT)', async () => {
    // route 1: period lookup (open) · route 2: account scan finds only 4000 — 6666 is unknown
    const svcMissing = new LedgerPostingService(fakeDb([
      { rows: [] },
      { rows: [{ code: '4000', isPostable: true, isControl: false, controlSubledger: null }] },
    ]) as any, docNo);
    expect(await code(() => svcMissing.postEntry({ source: 'T', createdBy: 'a', tenantId: 1, lines: [
      { account_code: '6666', debit: 10 }, { account_code: '4000', credit: 10 },
    ] } as any))).toBe('INVALID_POSTING_ACCOUNT');
  });

  it('rejects a non-postable (header/deactivated) account even via a subledger (INVALID_POSTING_ACCOUNT)', async () => {
    const svcHeader = new LedgerPostingService(fakeDb([
      { rows: [] },
      { rows: [
        { code: '1000', isPostable: false, isControl: false, controlSubledger: null },
        { code: '4000', isPostable: true, isControl: false, controlSubledger: null },
      ] },
    ]) as any, docNo);
    expect(await code(() => svcHeader.postEntry({ source: 'T', createdBy: 'a', tenantId: 1, viaSubledger: true, lines: [
      { account_code: '1000', debit: 10 }, { account_code: '4000', credit: 10 },
    ] } as any))).toBe('INVALID_POSTING_ACCOUNT');
  });
});

describe('LedgerPostingService — approveEntry maker-checker (GL-05 SoD)', () => {
  it('the preparer cannot approve their own entry (SOD_VIOLATION), even before any period check', async () => {
    const svc = new LedgerPostingService(fakeDb([
      { rows: [{ id: 1, entryNo: 'JE-1', status: 'Draft', createdBy: 'alice', tenantId: null }] },
    ]) as any, docNo);
    expect(await code(() => svc.approveEntry('JE-1', user('alice')))).toBe('SOD_VIOLATION');
  });

  it('a non-Draft entry is NOT_PENDING', async () => {
    const svc = new LedgerPostingService(fakeDb([
      { rows: [{ id: 1, entryNo: 'JE-1', status: 'Posted', createdBy: 'alice', tenantId: null }] },
    ]) as any, docNo);
    expect(await code(() => svc.approveEntry('JE-1', user('bob')))).toBe('NOT_PENDING');
  });

  it('an unknown entry is NOT_FOUND', async () => {
    const svc = new LedgerPostingService(fakeDb([{ rows: [] }]) as any, docNo);
    expect(await code(() => svc.approveEntry('JE-404', user('bob')))).toBe('NOT_FOUND');
  });
});

describe('LedgerPostingService — reverseEntry immutability (GL-17)', () => {
  const orig = { id: 7, entryNo: 'JE-7', createdBy: 'alice', isReversed: false };

  it('only Posted entries can be reversed (NOT_POSTED)', async () => {
    const svc = new LedgerPostingService(fakeDb([{ rows: [{ ...orig, status: 'Draft' }] }]) as any, docNo);
    expect(await code(() => svc.reverseEntry({ entryId: 7, reversedBy: 'bob' }))).toBe('NOT_POSTED');
  });

  it('a second reversal is blocked (ALREADY_REVERSED)', async () => {
    const svc = new LedgerPostingService(fakeDb([{ rows: [{ ...orig, status: 'Posted', isReversed: true }] }]) as any, docNo);
    expect(await code(() => svc.reverseEntry({ entryId: 7, reversedBy: 'bob' }))).toBe('ALREADY_REVERSED');
  });

  it('the preparer cannot manually reverse their own approved entry (SOD_VIOLATION, audit G2)', async () => {
    const svc = new LedgerPostingService(fakeDb([{ rows: [{ ...orig, status: 'Posted' }] }]) as any, docNo);
    expect(await code(() => svc.reverseEntry({ entryId: 7, reversedBy: 'alice', requireDistinctApprover: true }))).toBe('SOD_VIOLATION');
  });
});
