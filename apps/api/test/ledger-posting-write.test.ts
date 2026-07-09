import { describe, expect, it } from 'vitest';

import { LedgerPostingService } from '../src/modules/ledger/ledger-posting.service';

// Write-path unit tests for postEntry (workstream 2.4 slice 3) — an insert-capable fake records what the
// transaction wrote so the GL-05 happy path, the ux_je_idem dedupe and the Draft (maker-checker) branch
// are pinned without PGlite: header status/postedAt, the R1-2 snapshot bump and the GL-17 POST audit row
// all land (or are correctly skipped) inside ONE transaction.

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
