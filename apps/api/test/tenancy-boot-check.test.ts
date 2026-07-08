import { describe, it, expect } from 'vitest';
import {
  evaluateTenancyBootRisk,
  evaluateRlsBackstop,
  assertTenancyBootSafe,
  assertRlsBackstop,
} from '../src/common/tenancy-boot-check';

const nullLogger = { warn: () => {}, error: () => {} };

// H-4 — tenancy-mode risk. The dangerous state (single-company + several companies) is now fail-closed
// (refuse) by default in production; multi-company and single-tenant are always safe.
describe('evaluateTenancyBootRisk (H-4 — fail-closed by default)', () => {
  it('multi-company is always ok', () => {
    expect(evaluateTenancyBootRisk({ mode: 'multi-company', tenantCount: 99, allowOptOut: false }).level).toBe('ok');
  });
  it('single-company with 0 or 1 tenant is ok', () => {
    expect(evaluateTenancyBootRisk({ mode: 'single-company', tenantCount: 0, allowOptOut: false }).level).toBe('ok');
    expect(evaluateTenancyBootRisk({ mode: 'single-company', tenantCount: 1, allowOptOut: false }).level).toBe('ok');
  });
  it('single-company with >1 tenant REFUSES by default (was warn-only)', () => {
    const r = evaluateTenancyBootRisk({ mode: 'single-company', tenantCount: 2, allowOptOut: false });
    expect(r.level).toBe('refuse');
    expect(r.message).toMatch(/DATA-ISOLATION RISK/);
  });
  it('the opt-out downgrades the dangerous case to a warning', () => {
    expect(evaluateTenancyBootRisk({ mode: 'single-company', tenantCount: 2, allowOptOut: true }).level).toBe('warn');
  });
});

// H-3 — RLS backstop. A base role that is superuser or has BYPASSRLS does not enforce RLS on the
// connection; that is fail-closed (refuse) by default in production.
describe('evaluateRlsBackstop (H-3 — fail-closed by default)', () => {
  it('a non-superuser, non-bypass role is ok', () => {
    expect(evaluateRlsBackstop({ isSuperuser: false, bypassRls: false, allowOptOut: false }).level).toBe('ok');
  });
  it('a SUPERUSER base role REFUSES by default', () => {
    const r = evaluateRlsBackstop({ isSuperuser: true, bypassRls: false, allowOptOut: false });
    expect(r.level).toBe('refuse');
    expect(r.message).toMatch(/RLS BACKSTOP MISSING/);
  });
  it('a BYPASSRLS base role REFUSES by default', () => {
    expect(evaluateRlsBackstop({ isSuperuser: false, bypassRls: true, allowOptOut: false }).level).toBe('refuse');
  });
  it('the opt-out downgrades to a warning', () => {
    expect(evaluateRlsBackstop({ isSuperuser: true, bypassRls: true, allowOptOut: true }).level).toBe('warn');
  });
});

// The async wrappers are a no-op outside production and never throw on a probe/read failure.
describe('assert* wrappers — prod-only, best-effort', () => {
  it('assertTenancyBootSafe is a no-op outside production', async () => {
    await expect(assertTenancyBootSafe({ isProd: false, mode: 'single-company', allowOptOut: false, countTenants: async () => 9, logger: nullLogger })).resolves.toBeUndefined();
  });
  it('assertTenancyBootSafe throws on the dangerous state in prod', async () => {
    await expect(assertTenancyBootSafe({ isProd: true, mode: 'single-company', allowOptOut: false, countTenants: async () => 9, logger: nullLogger })).rejects.toThrow(/Refusing to boot/);
  });
  it('assertTenancyBootSafe never blocks boot on a read error', async () => {
    await expect(assertTenancyBootSafe({ isProd: true, mode: 'single-company', allowOptOut: false, countTenants: async () => { throw new Error('db down'); }, logger: nullLogger })).resolves.toBeUndefined();
  });
  it('assertRlsBackstop is a no-op outside production', async () => {
    await expect(assertRlsBackstop({ isProd: false, allowOptOut: false, probe: async () => ({ isSuperuser: true, bypassRls: true }), logger: nullLogger })).resolves.toBeUndefined();
  });
  it('assertRlsBackstop throws when the base role bypasses RLS in prod', async () => {
    await expect(assertRlsBackstop({ isProd: true, allowOptOut: false, probe: async () => ({ isSuperuser: true, bypassRls: false }), logger: nullLogger })).rejects.toThrow(/Refusing to boot/);
  });
  it('assertRlsBackstop never blocks boot when the probe fails', async () => {
    await expect(assertRlsBackstop({ isProd: true, allowOptOut: false, probe: async () => { throw new Error('no db'); }, logger: nullLogger })).resolves.toBeUndefined();
  });
});
