import { describe, expect, it } from 'vitest';

import { LedgerPostingService } from '../src/modules/ledger/ledger-posting.service';

// Write-path unit tests for postEntry (workstream 2.4 slice 3) — an insert-capable fake records what the
// transaction wrote so the GL-05 happy path, the ux_je_idem dedupe and the Draft (maker-checker) branch
// are pinned without PGlite: header status/postedAt, the R1-2 snapshot bump and the GL-17 POST audit row
// all land (or are correctly skipped) inside ONE transaction.
// Slice 4 extends the same pattern to approveEntry (Draft→Posted transition + APPROVE audit + R1-2 bump
// in one tx, and the period re-check at approval time) and reverseEntry (contra Dr/Cr swap through the
// normal posting path, is_reversed flag, REVERSE audit) — see the describes at the bottom.

type Captured = { headers: any[]; lines: any[][]; audits: any[]; executes: number };

function writeDb(opts: { dedupe?: boolean } = {}): { db: any; cap: Captured } {
  const cap: Captured = { headers: [], lines: [], audits: [], executes: 0 };
  const selectChain = () => {
    const p: any = { from: () => p, where: () => p, limit: () => p, then: (r: any, j: any) => Promise.resolve([]).then(r, j) };
    return p;
  };
  const tx = {
    insert: (_table: any) => ({
      values: (v: any) => {
        const isHeader = !Array.isArray(v) && 'entryNo' in v;
        const isAudit = !Array.isArray(v) && 'action' in v;
        if (isHeader) {
          cap.headers.push(v);
          return { onConflictDoNothing: () => ({ returning: () => Promise.resolve(opts.dedupe ? [] : [{ id: 42 }]) }) };
        }
        if (isAudit) { cap.audits.push(v); return Promise.resolve(); }
        cap.lines.push(v);
        return Promise.resolve();
      },
    }),
    execute: () => { cap.executes++; return Promise.resolve(); }, // the gl_period_balances upsert (R1-2)
  };
  const db = {
    select: selectChain, // period lookup skipped (tenantId null); control-account scan → no hits
    transaction: async (cb: any) => cb(tx),
  };
  return { db, cap };
}

const docNo = { nextDaily: async () => 'JE-TEST-001' } as any;
const LINES = [
  { account_code: '5100', debit: 100 },
  { account_code: '1000', credit: 100 },
];

describe('LedgerPostingService — postEntry write path (GL-05/GL-17/R1-2)', () => {
  it('posts a balanced entry: Posted header with postedAt, lines, ONE snapshot bump, a POST audit row', async () => {
    const { db, cap } = writeDb();
    const svc = new LedgerPostingService(db, docNo);
    const r = await svc.postEntry({ source: 'T', createdBy: 'maker', lines: LINES } as any);
    expect(r).toMatchObject({ entry_no: 'JE-TEST-001', balanced: true, status: 'Posted', pending: false });
    expect(r.lines).toHaveLength(2);
    expect(cap.headers[0]).toMatchObject({ entryNo: 'JE-TEST-001', status: 'Posted' });
    expect(cap.headers[0].postedAt).toBeInstanceOf(Date);       // GL-17 posting moment
    expect(cap.lines[0]).toHaveLength(2);                        // both legs in one insert
    expect(cap.executes).toBe(1);                                // R1-2 period-balance bump, same tx
    expect(cap.audits[0]).toMatchObject({ action: 'POST', actor: 'maker' });
  });

  it('a concurrent identical posting dedupes (ux_je_idem): no lines, no snapshot, no audit — deduped:true', async () => {
    const { db, cap } = writeDb({ dedupe: true });
    const svc = new LedgerPostingService(db, docNo);
    const r = await svc.postEntry({ source: 'T', sourceRef: 'REF-1', createdBy: 'maker', lines: LINES } as any);
    expect(r).toMatchObject({ entry_no: null, balanced: true, deduped: true });
    expect(cap.lines).toHaveLength(0);
    expect(cap.executes).toBe(0);
    expect(cap.audits).toHaveLength(0);
  });

  it('pendingApproval posts a DRAFT: no postedAt, no snapshot bump, no POST audit (GL-05 maker-checker)', async () => {
    const { db, cap } = writeDb();
    const svc = new LedgerPostingService(db, docNo);
    const r = await svc.postEntry({ source: 'T', createdBy: 'maker', pendingApproval: true, lines: LINES } as any);
    expect(r).toMatchObject({ status: 'Draft', pending: true });
    expect(cap.headers[0]).toMatchObject({ status: 'Draft', postedAt: null });
    expect(cap.executes).toBe(0);   // balances exclude Drafts — bump happens on approve
    expect(cap.audits).toHaveLength(0); // APPROVE logs it later
  });

  it('zero-value legs are dropped but the entry still posts the non-zero legs (POS vat=0 case)', async () => {
    const { db, cap } = writeDb();
    const svc = new LedgerPostingService(db, docNo);
    const r = await svc.postEntry({ source: 'POS', createdBy: 'pos', lines: [
      ...LINES, { account_code: '2100', credit: 0 },
    ] } as any);
    expect(r.lines).toHaveLength(2);
    expect(cap.lines[0]).toHaveLength(2);
  });
});

// ───────────────────── approveEntry write path (slice 4) ─────────────────────
// The fake answers the two read chains (entry by entryNo; fiscal-period re-check) sequentially, then
// captures everything approveEntry's transaction writes: the header UPDATE, the APPROVE audit row, the
// line re-read that feeds the snapshot, and the gl_period_balances execute.

type ApproveCap = { updates: any[]; audits: any[]; executes: number; txCalls: number };

function approveDb(entry: any | null, opts: { periodStatus?: string; drLines?: any[] } = {}): { db: any; cap: ApproveCap } {
  const cap: ApproveCap = { updates: [], audits: [], executes: 0, txCalls: 0 };
  const chain = (rows: any[]) => {
    const p: any = { from: () => p, where: () => p, limit: () => p, orderBy: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  const routes = [entry ? [entry] : [], opts.periodStatus ? [{ status: opts.periodStatus }] : []];
  let call = 0;
  const tx = {
    update: () => ({ set: (v: any) => ({ where: () => { cap.updates.push(v); return Promise.resolve(); } }) }),
    insert: () => ({ values: (v: any) => { cap.audits.push(v); return Promise.resolve(); } }),
    select: () => chain(opts.drLines ?? []),
    execute: () => { cap.executes++; return Promise.resolve(); },
  };
  const db = {
    select: () => chain(routes[Math.min(call++, routes.length - 1)] ?? []),
    transaction: async (cb: any) => { cap.txCalls++; return cb(tx); },
  };
  return { db, cap };
}

const DRAFT = {
  id: 5, entryNo: 'JE-5', status: 'Draft', createdBy: 'alice',
  tenantId: 1, period: '2026-07', ledgerCode: null,
};
const DR_LINES = [
  { account_code: '5100', debit: '100', credit: '0', cost_center: null },
  { account_code: '1000', debit: '0', credit: '100', cost_center: null },
];

describe('LedgerPostingService — approveEntry write path (GL-05 → GL-17/R1-2 on approve)', () => {
  it('approving a Draft: Posted+postedAt update, APPROVE audit with preparer, ONE snapshot bump — one tx', async () => {
    const { db, cap } = approveDb(DRAFT, { drLines: DR_LINES });
    const svc = new LedgerPostingService(db, docNo);
    const r = await svc.approveEntry('JE-5', { username: 'bob' } as any);
    expect(r).toEqual({ entry_no: 'JE-5', status: 'Posted', approved_by: 'bob', prepared_by: 'alice' });
    expect(cap.txCalls).toBe(1);
    expect(cap.updates[0]).toMatchObject({ status: 'Posted' });
    expect(cap.updates[0].postedAt).toBeInstanceOf(Date);       // GL-17: approval IS the posting moment
    expect(cap.audits[0]).toMatchObject({ action: 'APPROVE', actor: 'bob', entryId: 5, tenantId: 1 });
    expect(cap.audits[0].detail).toMatchObject({ entry_no: 'JE-5', prepared_by: 'alice' });
    expect(cap.executes).toBe(1);                                // R1-2 bump deferred from postEntry lands here
  });

  it('the period re-check at approval time blocks a since-Closed period (PERIOD_CLOSED) before any write', async () => {
    const { db, cap } = approveDb(DRAFT, { periodStatus: 'Closed', drLines: DR_LINES });
    const svc = new LedgerPostingService(db, docNo);
    await expect(svc.approveEntry('JE-5', { username: 'bob' } as any)).rejects.toMatchObject({ response: { code: 'PERIOD_CLOSED' } });
    expect(cap.txCalls).toBe(0);
    expect(cap.updates).toHaveLength(0);
    expect(cap.audits).toHaveLength(0);
  });
});

// ───────────────────── reverseEntry write path (slice 4) ─────────────────────
// Sequential read routes: 1) the original Posted entry, 2) its lines, 3) the reversal-id lookup after the
// contra posts. The reversal itself runs through the REAL postEntry inside db.transaction (header/lines/
// audit/snapshot captured like slice 3); the is_reversed flag and the REVERSE audit write on the plain db.

type ReverseCap = Captured & { dbUpdates: any[]; dbAudits: any[] };

function reverseDb(orig: any, origLines: any[]): { db: any; cap: ReverseCap } {
  const cap: ReverseCap = { headers: [], lines: [], audits: [], executes: 0, dbUpdates: [], dbAudits: [] };
  const chain = (rows: any[]) => {
    const p: any = { from: () => p, where: () => p, limit: () => p, orderBy: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  const routes = [[orig], origLines, [{ id: 99 }]]; // entry → lines → reversal-id lookup
  let call = 0;
  const tx = {
    insert: (_table: any) => ({
      values: (v: any) => {
        const isHeader = !Array.isArray(v) && 'entryNo' in v;
        const isAudit = !Array.isArray(v) && 'action' in v;
        if (isHeader) { cap.headers.push(v); return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: 99 }]) }) }; }
        if (isAudit) { cap.audits.push(v); return Promise.resolve(); }
        cap.lines.push(v);
        return Promise.resolve();
      },
    }),
    execute: () => { cap.executes++; return Promise.resolve(); },
  };
  const db = {
    select: () => chain(routes[Math.min(call++, routes.length - 1)] ?? []),
    transaction: async (cb: any) => cb(tx),
    update: () => ({ set: (v: any) => ({ where: () => { cap.dbUpdates.push(v); return Promise.resolve(); } }) }),
    insert: () => ({ values: (v: any) => { cap.dbAudits.push(v); return Promise.resolve(); } }),
  };
  return { db, cap };
}

const POSTED = {
  id: 7, entryNo: 'JE-7', status: 'Posted', isReversed: false, createdBy: 'alice',
  tenantId: null, currency: 'THB', ledgerCode: null,
};
const POSTED_LINES = [
  { accountCode: '5100', debit: '100', credit: '0', memo: null, costCenterCode: null, branchId: null, projectId: null, departmentId: null },
  { accountCode: '1000', debit: '0', credit: '100', memo: 'cash', costCenterCode: 'CC1', branchId: 2, projectId: null, departmentId: null },
];

describe('LedgerPostingService — reverseEntry write path (GL-17 contra reversal)', () => {
  it('reverses a Posted entry: contra swaps every leg, posts via the normal path, flags is_reversed, REVERSE audit', async () => {
    const { db, cap } = reverseDb(POSTED, POSTED_LINES);
    const svc = new LedgerPostingService(db, docNo);
    const r = await svc.reverseEntry({ entryId: 7, reversedBy: 'bob', reason: 'duplicate' });
    expect(r).toEqual({ reversalId: 99, originalId: 7, reversal_entry_no: 'JE-TEST-001', original_entry_no: 'JE-7' });

    // The contra header posts immediately (source REVERSAL, back-linked via reversal_of).
    expect(cap.headers[0]).toMatchObject({
      entryNo: 'JE-TEST-001', source: 'REVERSAL', sourceRef: 'REV-7', status: 'Posted', reversalOf: 7,
      memo: 'Reversal of JE-7 — duplicate',
    });
    expect(cap.headers[0].postedAt).toBeInstanceOf(Date);

    // Every line swaps Dr↔Cr and carries its dimensions (cost center, branch) over.
    const [l1, l2] = cap.lines[0];
    expect(l1).toMatchObject({ accountCode: '5100', debit: '0.0000', credit: '100.0000', costCenterCode: null });
    expect(l2).toMatchObject({ accountCode: '1000', debit: '100.0000', credit: '0.0000', costCenterCode: 'CC1', branchId: 2 });
    expect(l2.memo).toBe('Reversal of JE-7 — cash');

    // The reversal is itself a normal posting: R1-2 bump + POST audit inside the tx…
    expect(cap.executes).toBe(1);
    expect(cap.audits[0]).toMatchObject({ action: 'POST', actor: 'bob' });
    expect(cap.audits[0].detail).toMatchObject({ reversal_of: 7 });

    // …then the original is flagged (the ONE column the DB immutability trigger permits) and REVERSE is logged.
    expect(cap.dbUpdates[0]).toEqual({ isReversed: true });
    expect(cap.dbAudits[0]).toMatchObject({ action: 'REVERSE', actor: 'bob', entryId: 7 });
    expect(cap.dbAudits[0].detail).toMatchObject({
      originalId: 7, original_entry_no: 'JE-7', reversalId: 99, reversal_entry_no: 'JE-TEST-001', reason: 'duplicate',
    });
  });

  it('an entry with no lines cannot be reversed (NOT_POSTED) — nothing written', async () => {
    const { db, cap } = reverseDb(POSTED, []);
    const svc = new LedgerPostingService(db, docNo);
    await expect(svc.reverseEntry({ entryId: 7, reversedBy: 'bob' })).rejects.toMatchObject({ response: { code: 'NOT_POSTED' } });
    expect(cap.headers).toHaveLength(0);
    expect(cap.dbUpdates).toHaveLength(0);
    expect(cap.dbAudits).toHaveLength(0);
  });
});
