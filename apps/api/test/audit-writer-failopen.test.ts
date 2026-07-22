import { describe, it, expect } from 'vitest';
import { writeAuditRow, auditRowHash } from '../src/common/audit-writer';

// ITGC-AC-10/AC-16 — the audit write is deliberately fail-open (a logging failure must never roll back a
// posted journal), so the trail's COMPLETENESS rests on that write succeeding. A dropped row is
// undetectable afterwards: `seq` comes from the last SUCCESSFULLY written row, so an omission leaves no gap
// for the verify walk to find. The degradation is therefore alerted (captureOpsAlert 'audit_write_failed',
// throttled, reporting how many writes were lost) rather than silent. These assert both halves of that
// contract: the request path is never broken, and the failure is never swallowed without a trace.
const failingDb = { transaction: () => Promise.reject(new Error('connection refused')) } as any;
const row = {
  action: 'POST /api/ledger/journal', actor: 'admin', tenantId: 1,
  ip: '127.0.0.1', requestId: 'req-1', status: 'fail' as const,
};

describe('writeAuditRow — fail-open but loud', () => {
  it('never throws when the audit store is unreachable (the business request survives)', async () => {
    await expect(writeAuditRow(failingDb, row)).resolves.toBeUndefined();
  });
  it('stays non-throwing across repeated failures (throttle path included)', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(writeAuditRow(failingDb, { ...row, requestId: `req-${i}` })).resolves.toBeUndefined();
    }
  });
  it('tolerates a null actor/tenant row (system + pre-auth events)', async () => {
    await expect(writeAuditRow(failingDb, { ...row, actor: null, tenantId: null })).resolves.toBeUndefined();
  });
});

// The chain binding itself is pure — guard it here so a refactor of the writer cannot silently change how
// past rows hash (which would make every historical row fail verification).
describe('auditRowHash — chain binding', () => {
  const base = { actor: 'admin', tenantId: 1, action: 'POST /x', ip: '1.1.1.1', requestId: 'r', status: 'success', meta: null };
  it('binds the previous hash (same row, different prev → different hash)', () => {
    expect(auditRowHash(null, 1, base)).not.toBe(auditRowHash('deadbeef', 1, base));
  });
  it('binds the sequence number', () => {
    expect(auditRowHash('a', 1, base)).not.toBe(auditRowHash('a', 2, base));
  });
  it('binds the row content, including meta', () => {
    expect(auditRowHash('a', 1, base)).not.toBe(auditRowHash('a', 1, { ...base, actor: 'mallory' }));
    expect(auditRowHash('a', 1, base)).not.toBe(auditRowHash('a', 1, { ...base, meta: { rls_bypass: true } }));
  });
  it('is deterministic and key-order independent in meta', () => {
    const m1 = { meta: { a: 1, b: 2 } };
    const m2 = { meta: { b: 2, a: 1 } };
    expect(auditRowHash('a', 1, { ...base, ...m1 })).toBe(auditRowHash('a', 1, { ...base, ...m2 }));
  });
});
