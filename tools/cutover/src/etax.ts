/**
 * C2 — e-Tax Invoice XML. Seed a tax invoice + lines → GET /api/tax-invoices/:docNo/etax-xml
 * returns a well-formed UBL 2.1 (ETDA) document with the right parties, tax, totals, lines. Over PGlite.
 * Also covers submission durability (gap #5, docs/ops/etax-production-spike.md): a thrown SP error is
 * persisted (not silently swallowed), visible via list/status, and recoverable by the retry-failed sweep.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover etax
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'etax-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();

  // seed a full tax invoice + 2 lines (subtotal 300, VAT 7% = 21, grand 321)
  const docNo = 'TIV-202606-0007';
  const [tiv] = await db.insert(s.taxInvoices).values({
    tenantId: hq, docNo, type: 'full', issueDate: '2026-06-22', sourceType: 'AR', sourceRef: 'INV-1',
    sellerName: 'บริษัท ทดสอบ จำกัด', sellerTaxId: '0105551234567', sellerBranchCode: '00000', sellerBranchLabel: 'สำนักงานใหญ่',
    sellerAddress: '1 ถนนสุขุมวิท กรุงเทพฯ 10110', buyerName: 'ลูกค้า เอ แอนด์ บี', buyerTaxId: '0992001234567',
    buyerBranchCode: '00000', buyerAddress: '99 ถนนพระราม 9', currency: 'THB',
    subtotal: '300.00', discount: '0', vatRate: '0.0700', vatAmount: '21.00', grandTotal: '321.00', isVatInclusive: false, status: 'Issued',
  }).returning({ id: s.taxInvoices.id });
  await db.insert(s.taxInvoiceLines).values([
    { taxInvoiceId: Number(tiv.id), tenantId: hq, lineNo: '1', description: 'ค่าบริการ <ที่ปรึกษา> A&B', qty: '1', uom: 'EA', unitPrice: '200.00', discount: '0', amount: '200.00' },
    { taxInvoiceId: Number(tiv.id), tenantId: hq, lineNo: '2', description: 'สินค้าตัวอย่าง', qty: '2', uom: 'EA', unitPrice: '50.00', discount: '0', amount: '100.00' },
  ]);

  // a second invoice, dedicated to the submission-durability (gap #5) checks below — the first docNo
  // is already Accepted (mock) by check #7 and submit() is idempotent per docNo once Accepted.
  const docNo2 = 'TIV-202606-0008';
  const [tiv2] = await db.insert(s.taxInvoices).values({
    tenantId: hq, docNo: docNo2, type: 'full', issueDate: '2026-06-23', sourceType: 'AR', sourceRef: 'INV-2',
    sellerName: 'บริษัท ทดสอบ จำกัด', sellerTaxId: '0105551234567', sellerBranchCode: '00000', sellerBranchLabel: 'สำนักงานใหญ่',
    sellerAddress: '1 ถนนสุขุมวิท กรุงเทพฯ 10110', buyerName: 'ลูกค้า ซี', buyerTaxId: '0992009876543',
    buyerBranchCode: '00000', buyerAddress: '1 ถนนสีลม', currency: 'THB',
    subtotal: '100.00', discount: '0', vatRate: '0.0700', vatAmount: '7.00', grandTotal: '107.00', isVatInclusive: false, status: 'Issued',
  }).returning({ id: s.taxInvoices.id });
  await db.insert(s.taxInvoiceLines).values([
    { taxInvoiceId: Number(tiv2.id), tenantId: hq, lineNo: '1', description: 'สินค้า', qty: '1', uom: 'EA', unitPrice: '100.00', discount: '0', amount: '100.00' },
  ]);

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.statusCode, body: res.body as string, ctype: res.headers['content-type'] as string, cdisp: res.headers['content-disposition'] as string };
  };
  const admin = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'admin123' } })).json().token;

  // ── 1. route returns XML with download headers ──
  const r = await inj('GET', `/api/tax-invoices/${docNo}/etax-xml`, admin);
  const x = r.body ?? '';
  ok('GET etax-xml → 200, application/xml, attachment filename', r.status === 200 && /application\/xml/.test(r.ctype) && (r.cdisp ?? '').includes(`${docNo}.xml`), JSON.stringify({ s: r.status, ct: r.ctype }));

  // ── 2. well-formed UBL 2.1 envelope ──
  ok('UBL 2.1 Invoice envelope (declaration + root open/close)',
    x.startsWith('<?xml') && x.includes('<Invoice ') && x.trimEnd().endsWith('</Invoice>') && x.includes('<cbc:UBLVersionID>2.1</cbc:UBLVersionID>'),
    JSON.stringify({ head: x.slice(0, 14) }));

  // ── 3. header fields ──
  ok('doc id + issue date + type 388 + THB',
    x.includes(`<cbc:ID>${docNo}</cbc:ID>`) && x.includes('<cbc:IssueDate>2026-06-22</cbc:IssueDate>') && x.includes('>388</cbc:InvoiceTypeCode>') && x.includes('<cbc:DocumentCurrencyCode>THB</cbc:DocumentCurrencyCode>'),
    '');

  // ── 4. parties: seller + buyer tax ids ──
  ok('seller + buyer tax ids present (PartyTaxScheme)',
    x.includes('<cbc:CompanyID>0105551234567</cbc:CompanyID>') && x.includes('<cbc:CompanyID>0992001234567</cbc:CompanyID>'), '');

  // ── 5. tax + totals ──
  ok('VAT 7.00% · taxable 300.00 · tax 21.00 · payable 321.00',
    x.includes('<cbc:Percent>7.00</cbc:Percent>') && x.includes('<cbc:TaxableAmount currencyID="THB">300.00</cbc:TaxableAmount>') &&
    x.includes('<cbc:TaxAmount currencyID="THB">21.00</cbc:TaxAmount>') && x.includes('<cbc:PayableAmount currencyID="THB">321.00</cbc:PayableAmount>'), '');

  // ── 6. two lines + XML escaping (no raw angle brackets / ampersand leak) ──
  const lineCount = (x.match(/<cac:InvoiceLine>/g) || []).length;
  ok('2 invoice lines + special chars escaped (no raw <ที่ปรึกษา> or & A&B)',
    lineCount === 2 && x.includes('&lt;ที่ปรึกษา&gt;') && x.includes('A&amp;B') && !x.includes('<ที่ปรึกษา>') && !x.includes('A&B'),
    `lines=${lineCount}`);

  // ── 7. submit to the (mock) RD provider → Accepted, recorded unsigned (no cert configured) ──
  const sub = await app.inject({ method: 'POST', url: `/api/tax/etax/submit/${docNo}`, headers: { authorization: `Bearer ${admin}` }, payload: {} });
  const subJson = sub.json();
  const st = await app.inject({ method: 'GET', url: `/api/tax/etax/status/${docNo}`, headers: { authorization: `Bearer ${admin}` } });
  const stJson = st.json();
  ok('submit (mock) → Accepted, signed=false (no cert), status persisted',
    sub.statusCode === 201 && subJson.status === 'Accepted' && subJson.signed === false && stJson.status === 'Accepted' && stJson.rd_response?.signed === false,
    JSON.stringify({ s: subJson.status, signed: subJson.signed }));

  // ── 8. re-submit → idempotent (no second Accepted row, returns the first provider ref) ──
  const sub2 = (await app.inject({ method: 'POST', url: `/api/tax/etax/submit/${docNo}`, headers: { authorization: `Bearer ${admin}` }, payload: {} })).json();
  ok('re-submit → idempotent (same provider ref)', sub2.idempotent === true && sub2.provider_ref === subJson.provider_ref, JSON.stringify(sub2));

  // ── 9. ?signed=1 with no cert configured → graceful unsigned fallback (valid UBL, no signature) ──
  const unsignedFallback = await inj('GET', `/api/tax-invoices/${docNo}/etax-xml?signed=1`, admin);
  ok('etax-xml?signed=1 without a cert → unsigned UBL fallback (no <ds:Signature>, plain filename)',
    unsignedFallback.status === 200 && !unsignedFallback.body.includes('<ds:Signature') && (unsignedFallback.cdisp ?? '').includes(`${docNo}.xml`) && !(unsignedFallback.cdisp ?? '').includes('-signed'),
    '');

  // ── 10. submission durability (gap #5): a thrown provider error surfaces as ITSELF, not a generic 500 ──
  // 'http' provider with ETAX_PROVIDER_URL unset throws ETAX_PROVIDER_NOT_CONFIGURED. The failure-audit write
  // (EtaxService.submit's catch) runs on the AUTOCOMMIT raw pg client (PG_CLIENT) so it survives this
  // request's transaction rolling back — but this harness has no real Postgres behind PG_CLIENT (PGlite-only,
  // same constraint as login_attempts/ai_token_usage), so that write itself fails too. The inner try/catch
  // around it must swallow THAT failure and still surface the ORIGINAL error — not mask it with a generic
  // 500 (which would be a worse regression: the real cause becomes invisible).
  delete process.env.ETAX_PROVIDER_URL;
  const failSub = await app.inject({ method: 'POST', url: `/api/tax/etax/submit/${docNo2}`, headers: { authorization: `Bearer ${admin}` }, payload: { provider: 'http' } });
  const failSubJson = failSub.json();
  ok('submit w/ unconfigured http provider → 400 ETAX_PROVIDER_NOT_CONFIGURED (real cause, not a masked 500)',
    failSub.statusCode === 400 && failSubJson.error?.code === 'ETAX_PROVIDER_NOT_CONFIGURED', JSON.stringify(failSubJson));

  // Seed a Rejected row directly (standing in for what the raw-client write persists in a real deployment
  // with a reachable Postgres) so the retry-sweep + operator-surface logic below can be exercised end to end.
  await db.insert(s.etaxSubmissions).values({
    tenantId: hq, docNo: docNo2, provider: 'http', status: 'Rejected', providerRef: null,
    rdResponse: { error: 'ETAX_PROVIDER_URL is not set', signed: false }, submittedBy: 'admin', submittedAt: new Date(),
  });

  const failStatus = (await app.inject({ method: 'GET', url: `/api/tax/etax/status/${docNo2}`, headers: { authorization: `Bearer ${admin}` } })).json();
  ok('status reflects the persisted failure: status=Rejected, error visible in rd_response', failStatus.status === 'Rejected' && !!failStatus.rd_response?.error, JSON.stringify(failStatus));

  const failList = (await app.inject({ method: 'GET', url: '/api/tax/etax?status=Rejected', headers: { authorization: `Bearer ${admin}` } })).json();
  const failRow = failList.submissions?.find((r: any) => r.doc_no === docNo2);
  ok('list(status=Rejected) surfaces the failed doc with a non-null error field (operator surface)', !!failRow && !!failRow.error, JSON.stringify(failRow));

  // ── 11. retry sweep (still unconfigured) → re-attempts the doc, it fails again, still tracked in results ──
  const retry1 = (await app.inject({ method: 'POST', url: '/api/tax/etax/retry-failed', headers: { authorization: `Bearer ${admin}` } })).json();
  const retry1Row = retry1.results?.find((r: any) => r.doc_no === docNo2);
  ok('retry-failed sweep scans the failed doc and re-attempts (still fails, still tracked)',
    retry1.scanned >= 1 && !!retry1Row && retry1Row.status === 'Rejected', JSON.stringify({ scanned: retry1.scanned, failed: retry1.failed, retry1Row }));

  // ── 12. once the SP becomes reachable, the SAME retry sweep recovers the doc to Accepted ──
  const spServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'Accepted', ref: 'sp-ref-recovered' })); });
  });
  await new Promise<void>((r) => spServer.listen(0, '127.0.0.1', r));
  process.env.ETAX_PROVIDER_URL = `http://127.0.0.1:${(spServer.address() as AddressInfo).port}`;
  const retry2 = (await app.inject({ method: 'POST', url: '/api/tax/etax/retry-failed', headers: { authorization: `Bearer ${admin}` } })).json();
  const retry2Row = retry2.results?.find((r: any) => r.doc_no === docNo2);
  ok('retry-failed sweep recovers once the SP is reachable → Accepted', !!retry2Row && retry2Row.status === 'Accepted', JSON.stringify(retry2Row));

  const recoveredStatus = (await app.inject({ method: 'GET', url: `/api/tax/etax/status/${docNo2}`, headers: { authorization: `Bearer ${admin}` } })).json();
  ok('status endpoint reflects the recovered Accepted submission', recoveredStatus.status === 'Accepted' && recoveredStatus.provider_ref === 'sp-ref-recovered', JSON.stringify(recoveredStatus));
  await new Promise<void>((r) => spServer.close(() => r()));
  delete process.env.ETAX_PROVIDER_URL;

  console.log('\n── C2 — e-Tax Invoice XML (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} e-Tax checks failed` : `\n✅ All ${checks.length} e-Tax checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
