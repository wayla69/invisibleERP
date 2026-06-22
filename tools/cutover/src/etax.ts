/**
 * C2 — e-Tax Invoice XML. Seed a tax invoice + lines → GET /api/tax-invoices/:docNo/etax-xml
 * returns a well-formed UBL 2.1 (ETDA) document with the right parties, tax, totals, lines. Over PGlite.
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

  console.log('\n── C2 — e-Tax Invoice XML (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} e-Tax checks failed` : `\n✅ All ${checks.length} e-Tax checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
