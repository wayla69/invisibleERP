import { describe, it, expect, afterEach, vi } from 'vitest';
import { tenantAwareProxy, runGlobalDb } from '../src/database/database.module';
import { tenantALS } from '../src/common/tenant-context';

// SOX-ICFR #2 — the fail-closed tenant proxy (staged behind STRICT_TENANT_PROXY). Proves: OFF ⇒ legacy
// base-pool fallback (unchanged); ON ⇒ a direct query with NO tenant context throws TENANT_CONTEXT_MISSING;
// a tenant tx (tenantALS) or an explicit runGlobalDb() context is allowed; and `transaction` is NEVER
// guarded (context is established BY opening a tx, so guarding it would deadlock the mechanism).
const fakeBase = {
  select: () => 'BASE_SELECT',
  insert: () => 'BASE_INSERT',
  transaction: (cb: any) => cb({ select: () => 'TX_SELECT' }),
} as any;
const proxy = tenantAwareProxy(fakeBase);

afterEach(() => { delete process.env.STRICT_TENANT_PROXY; });

describe('tenantAwareProxy — fail-closed (#2)', () => {
  it('flag OFF: a context-free query falls through to the base pool (unchanged behaviour)', () => {
    expect((proxy as any).select()).toBe('BASE_SELECT');
  });

  it('flag ON: a context-free query throws TENANT_CONTEXT_MISSING', () => {
    process.env.STRICT_TENANT_PROXY = '1';
    expect(() => (proxy as any).select()).toThrowError(/TENANT_CONTEXT_MISSING|tenant context/);
    expect(() => (proxy as any).insert()).toThrowError(/tenant context/);
  });

  it('flag ON: a query inside a tenant tx (tenantALS) uses the tx', () => {
    process.env.STRICT_TENANT_PROXY = '1';
    const out = tenantALS.run({ tx: { select: () => 'TX_SELECT' } } as any, () => (proxy as any).select());
    expect(out).toBe('TX_SELECT');
  });

  it('flag ON: a query inside runGlobalDb() is allowed on the base pool', async () => {
    process.env.STRICT_TENANT_PROXY = '1';
    const out = await runGlobalDb('unit-test', async () => (proxy as any).select());
    expect(out).toBe('BASE_SELECT');
  });

  it('flag ON: transaction() is never guarded (context is established by opening a tx)', () => {
    process.env.STRICT_TENANT_PROXY = '1';
    // Accessing/calling transaction outside a context must NOT throw — it is how a scoping tx is opened.
    expect(() => (proxy as any).transaction((tx: any) => tx.select())).not.toThrow();
    expect((proxy as any).transaction((tx: any) => tx.select())).toBe('TX_SELECT');
  });

  it('mode WARN: a context-free query is logged (call site + stack) but STILL falls through to the base pool', () => {
    process.env.STRICT_TENANT_PROXY = 'warn';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Audit-only: no throw, base pool is used, and the site is logged so a rollout sweep can enumerate it.
      expect((proxy as any).select()).toBe('BASE_SELECT');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toMatch(/base-pool select\(\) with NO tenant context/);
    } finally {
      spy.mockRestore();
    }
  });
});
