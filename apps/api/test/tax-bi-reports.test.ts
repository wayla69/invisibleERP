import { describe, it, expect, vi } from 'vitest';
import { TaxBiReports } from '../src/modules/tax/tax-bi-reports';

// docs/46 Phase 1 — the tax BI report generators moved out of bi-generate.service.ts into this
// module-owned provider. These guards lock the generator↔TaxJobsService mapping (types, argument
// coercion, summary shapes) exactly as the old if-chain branches behaved, using a fake TaxJobsService
// (same drizzle-free unit-test pattern as the docs/38 sub-service suites).
const user: any = { username: 'tester', tenantId: 1 };

const fakeJobs = () => ({
  runWhtCertBatch: vi.fn(async () => ({ period: '2026-06', issued: 2, scanned: 3, skipped: 1 })),
  runFilingDraft: vi.fn(async (_u: any, type: string) => ({ period: '2026-06', status: 'Draft', already_filed: false, type })),
  remittanceReminder: vi.fn(async () => ({ period: '2026-06', pp30: { net_vat_payable: 700, deadline: '2026-07-15' }, pnd: { wht_withheld: 30, deadline: '2026-07-07', uncertificated_wht: 10 } })),
  runEtaxSubmissionRetry: vi.fn(async () => ({ scanned: 4, succeeded: 3, failed: 1 })),
});

const providerMap = (jobs: any) => {
  const map = new Map<string, any>();
  for (const g of new TaxBiReports(jobs).biReports()) map.set(g.type, g);
  return map;
};

describe('TaxBiReports — module-owned BI report generators (docs/46 Phase 1)', () => {
  it('registers exactly the five tax report types', () => {
    expect([...providerMap(fakeJobs()).keys()].sort()).toEqual([
      'etax_submission_retry', 'tax_pnd_draft', 'tax_pp30_draft', 'tax_remittance_reminder', 'tax_wht_cert_batch',
    ]);
  });

  it('tax_wht_cert_batch coerces month/year filters and reports issued/skipped', async () => {
    const jobs = fakeJobs();
    const r = await providerMap(jobs).get('tax_wht_cert_batch').generate({ month: '6', year: '2026' }, user);
    expect(jobs.runWhtCertBatch).toHaveBeenCalledWith(user, 6, 2026);
    expect(r.summary).toBe('WHT certificates 2026-06: issued 2 of 3 (1 skipped)');
    expect(r.summaryTh).toContain('หนังสือรับรองหัก ณ ที่จ่าย 2026-06');
  });

  it('tax_wht_cert_batch leaves unset month/year undefined (period defaults in the service)', async () => {
    const jobs = fakeJobs();
    await providerMap(jobs).get('tax_wht_cert_batch').generate({}, user);
    expect(jobs.runWhtCertBatch).toHaveBeenCalledWith(user, undefined, undefined);
  });

  it('tax_pp30_draft files PP30; tax_pnd_draft defaults to PND53 and honours pnd_type', async () => {
    const jobs = fakeJobs();
    const map = providerMap(jobs);
    const pp30 = await map.get('tax_pp30_draft').generate({}, user);
    expect(jobs.runFilingDraft).toHaveBeenLastCalledWith(user, 'PP30', undefined, undefined);
    expect(pp30.summary).toBe('Draft filing PP30 2026-06: status Draft');
    await map.get('tax_pnd_draft').generate({}, user);
    expect(jobs.runFilingDraft).toHaveBeenLastCalledWith(user, 'PND53', undefined, undefined);
    await map.get('tax_pnd_draft').generate({ pnd_type: 'PND3', month: '5', year: '2026' }, user);
    expect(jobs.runFilingDraft).toHaveBeenLastCalledWith(user, 'PND3', 5, 2026);
  });

  it('filing-draft summary flags an already-filed period', async () => {
    const jobs = fakeJobs();
    jobs.runFilingDraft = vi.fn(async () => ({ period: '2026-06', status: 'Filed', already_filed: true }));
    const r = await providerMap(jobs).get('tax_pp30_draft').generate({}, user);
    expect(r.summary).toBe('Draft filing PP30 2026-06: status Filed (already filed)');
  });

  it('tax_remittance_reminder carries both PP30 and PND legs with deadlines', async () => {
    const r = await providerMap(fakeJobs()).get('tax_remittance_reminder').generate({}, user);
    expect(r.summary).toBe('Remittance 2026-06: PP30 net VAT ฿700 (due 2026-07-15); WHT ฿30 (due 2026-07-07), un-certificated ฿10');
    expect(r.summaryTh).toContain('นำส่งภาษี 2026-06');
  });

  it('etax_submission_retry coerces the limit filter and reports the retry tallies', async () => {
    const jobs = fakeJobs();
    const r = await providerMap(jobs).get('etax_submission_retry').generate({ limit: '25' }, user);
    expect(jobs.runEtaxSubmissionRetry).toHaveBeenCalledWith(user, 25);
    expect(r.summary).toBe('e-Tax retry: 3 of 4 succeeded (1 still failed)');
  });
});
