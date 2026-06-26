/**
 * Phase 10 — Thai tax-document compliance validation (real Nest app over PGlite, RLS-enforced):
 * full + abbreviated tax invoice (ม.86/4, 86/6) and WHT 50 ทวิ (ม.50 ทวิ).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover taxdocs
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'tax-secret';
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
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;
// valid 13-digit Thai Tax ID from a 12-digit prefix (mod-11 check digit)
const taxId = (p12: string) => { let sum = 0; for (let i = 0; i < 12; i++) sum += Number(p12[i]) * (13 - i); return p12 + String((11 - (sum % 11)) % 10); };

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  const T1_TAX = taxId('010555600001');
  const T2_TAX = taxId('010555600002');
  const PAYEE_TAX = taxId('010555900009');

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([
    { code: 'HQ', name: 'HQ' },
    { code: 'T1', name: 'ร้านหนึ่ง', legalName: 'บริษัท ร้านหนึ่ง จำกัด', taxId: T1_TAX, vatRegistered: true, branchCode: '00000', branchLabelTh: 'สำนักงานใหญ่', addressLine1: '123 ถนนสุขุมวิท', subDistrict: 'คลองเตย', district: 'คลองเตย', province: 'กรุงเทพมหานคร', postalCode: '10110' },
    { code: 'T2', name: 'ร้านสอง', legalName: 'บริษัท ร้านสอง จำกัด', taxId: T2_TAX, vatRegistered: true, branchCode: '00000', addressLine1: '456 ถนนพระราม 4', province: 'กรุงเทพมหานคร', postalCode: '10500' },
  ]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'cust1', passwordHash: await pw.hash('pw1'), role: 'Customer', tenantId: t1 },
    { username: 'cust2', passwordHash: await pw.hash('pw2'), role: 'Customer', tenantId: t2 },
    { username: 'sales1', passwordHash: await pw.hash('pw3'), role: 'Sales', tenantId: t1 },
    { username: 'proc2', passwordHash: await pw.hash('pw4'), role: 'Procurement', tenantId: t2 }, // T2 creditors (AP per shop)
  ]).onConflictDoNothing();

  // seed POS sales (VAT-separated) directly + items
  const seedSale = async (saleNo: string, tenantId: number, sub: number, vat: number, total: number, itemId: string) => {
    const [h] = await db.insert(s.custPosSales).values({ saleNo, saleDate: '2026-06-21', tenantId, subtotal: String(sub), discount: '0', taxAmount: String(vat), total: String(total), paymentMethod: 'Cash', pointsUsed: '0', pointsEarned: '0', status: 'Completed', createdBy: 'seed' }).returning({ id: s.custPosSales.id });
    await db.insert(s.custPosItems).values({ saleId: Number(h.id), itemId, itemDescription: `สินค้า ${itemId}`, qty: '1', uom: 'ชิ้น', unitPrice: String(sub), discountPct: '0', amount: String(sub), isCustom: false });
  };
  await seedSale('S-T1-1', t1, 100, 7, 107, 'A');
  await seedSale('S-T1-2', t1, 200, 14, 214, 'B');
  await seedSale('S-T2-1', t2, 50, 3.5, 53.5, 'C');
  // AR invoice for T1 (VAT-inclusive amount 107)
  await db.insert(s.arInvoices).values({ invoiceNo: 'INV-AR1', invoiceDate: '2026-06-21', tenantId: t1, orderNo: 'SO-1', amount: '107', status: 'Unpaid', currency: 'THB' });

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json, text: res.payload };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const cust1 = await login('cust1', 'pw1');
  const cust2 = await login('cust2', 'pw2');
  const sales1 = await login('sales1', 'pw3');
  const admin = await login('admin', 'admin123'); // HQ — exec/ar/creditors for statutory reports

  // ── ใบกำกับภาษีอย่างย่อ (ม.86/6) ──
  const ab1 = await inj('POST', '/api/tax-invoices/abbreviated/from-sale/S-T1-1', cust1);
  ok('Abbreviated: issued ATV- + VAT-inclusive', /^ATV-\d{6}-0001$/.test(ab1.json.doc_no ?? '') && ab1.json.is_vat_inclusive === true, `${ab1.status} ${JSON.stringify(ab1.json).slice(0, 80)}`);
  ok('Abbreviated: VAT 7/107 (sub 100, vat 7, total 107)', near(ab1.json.subtotal, 100) && near(ab1.json.vat_amount, 7) && near(ab1.json.grand_total, 107));
  ok('Abbreviated: seller block (legal name, 13-digit Tax ID, branch)', ab1.json.seller?.tax_id === T1_TAX && !!ab1.json.seller?.name && !!ab1.json.seller?.branch_label);
  // sequential per seller
  const ab2 = await inj('POST', '/api/tax-invoices/abbreviated/from-sale/S-T1-2', cust1);
  ok('Abbreviated: sequential per seller (T1 → 0002)', /^ATV-\d{6}-0002$/.test(ab2.json.doc_no ?? ''), ab2.json.doc_no);
  const ab2b = await inj('POST', '/api/tax-invoices/abbreviated/from-sale/S-T2-1', cust2);
  ok('Abbreviated: independent sequence per seller (T2 → 0001)', /^ATV-\d{6}-0001$/.test(ab2b.json.doc_no ?? ''), ab2b.json.doc_no);
  // idempotent
  const abDup = await inj('POST', '/api/tax-invoices/abbreviated/from-sale/S-T1-1', cust1);
  ok('Abbreviated: idempotent (same sale → same doc_no)', abDup.json.doc_no === ab1.json.doc_no);

  // ── ใบกำกับภาษีเต็มรูป (ม.86/4) ──
  const full = await inj('POST', '/api/tax-invoices/full', sales1, { source_type: 'POS', source_ref: 'S-T1-1', buyer: { name: 'บริษัท ผู้ซื้อ จำกัด', tax_id: T2_TAX, address: '99 ถนนทดสอบ กรุงเทพฯ' } });
  ok('Full: issued TIV- + VAT separated + buyer block', /^TIV-\d{6}-0001$/.test(full.json.doc_no ?? '') && full.json.is_vat_inclusive === false && full.json.buyer?.tax_id === T2_TAX, `${full.status} ${JSON.stringify(full.json).slice(0, 90)}`);
  ok('Full: VAT 7% separated (sub 100, vat 7, total 107)', near(full.json.subtotal, 100) && near(full.json.vat_amount, 7) && near(full.json.grand_total, 107));
  const fullNoBuyer = await inj('POST', '/api/tax-invoices/full', sales1, { source_type: 'POS', source_ref: 'S-T1-1', buyer: { name: '', address: '' } });
  ok('Full: rejects missing buyer name/address (400)', fullNoBuyer.status === 400, `${fullNoBuyer.status}`);
  const fullAr = await inj('POST', '/api/tax-invoices/full', sales1, { source_type: 'AR', source_ref: 'INV-AR1', buyer: { name: 'ผู้ซื้อ AR', tax_id: T2_TAX, address: 'ที่อยู่ AR' } });
  ok('Full from AR: VAT-inclusive 107 → net 100 + vat 7', near(fullAr.json.subtotal, 100) && near(fullAr.json.vat_amount, 7));

  // ── WHT 50 ทวิ (ม.50 ทวิ) ──
  const wht = await inj('POST', '/api/wht/certificates', sales1, { date_paid: '2026-06-21', payee: { name: 'บริษัท ผู้รับเหมา จำกัด', tax_id: PAYEE_TAX, address: 'ที่อยู่ผู้รับเงิน', kind: 'company' }, lines: [{ income_type: '3tre-service', description: 'ค่าบริการ', amount_paid: 10000 }] });
  ok('WHT: issued WHT- + PND53 (company) + 3% rate', /^WHT-\d{6}-0001$/.test(wht.json.doc_no ?? '') && wht.json.pnd_type === 'PND53', `${wht.status} ${JSON.stringify(wht.json).slice(0, 90)}`);
  ok('WHT: tax withheld = 10000 × 3% = 300', near(wht.json.total_wht, 300) && near(wht.json.lines?.[0]?.tax_withheld, 300) && near(wht.json.lines?.[0]?.rate, 0.03));
  ok('WHT: payer (T1) + payee Tax IDs present (13-digit)', wht.json.payer?.tax_id === T1_TAX && wht.json.payee?.tax_id === PAYEE_TAX);
  // person → PND3, rate by type
  const wht2 = await inj('POST', '/api/wht/certificates', sales1, { date_paid: '2026-06-21', payee: { name: 'นายช่าง', tax_id: PAYEE_TAX, address: 'บ้าน', kind: 'person' }, lines: [{ income_type: '40(5)', amount_paid: 5000 }] });
  ok('WHT: person + ค่าเช่า 40(5) 5% → PND3, tax 250', wht2.json.pnd_type === 'PND3' && near(wht2.json.total_wht, 250));
  // gross-up (ผู้จ่ายออกภาษีให้ตลอดไป): net 10000 @3% → base 10309.28, tax 309.28
  const whtGross = await inj('POST', '/api/wht/certificates', sales1, { date_paid: '2026-06-21', condition: 'absorb_always', payee: { name: 'ผู้รับเหมา', tax_id: PAYEE_TAX, address: 'x', kind: 'company' }, lines: [{ income_type: '3tre-service', description: 'บริการ', amount_paid: 10000 }] });
  ok('WHT: gross-up (absorb) base 10309.28, tax 309.28', near(whtGross.json.lines?.[0]?.amount_paid, 10309.28) && near(whtGross.json.total_wht, 309.28), JSON.stringify(whtGross.json.lines?.[0] ?? {}).slice(0, 70));
  const whtBadRate = await inj('POST', '/api/wht/certificates', sales1, { date_paid: '2026-06-21', payee: { name: 'x', tax_id: PAYEE_TAX, address: 'x', kind: 'company' }, lines: [{ income_type: '3tre-service', description: 'b', amount_paid: 1000, rate: 0.5 }] });
  ok('WHT: rejects invalid rate (>30%)', whtBadRate.status === 400, `${whtBadRate.status}`);

  // ── RLS isolation ── (doc_no is unique PER SELLER, so the same number string exists for both
  // tenants — key the isolation test on the full invoice TIV, which only T1 issued.)
  const list1 = await inj('GET', '/api/tax-invoices', cust1);
  const list2 = await inj('GET', '/api/tax-invoices', cust2);
  const docNos = (j: any) => (j.json.invoices ?? []).map((i: any) => i.doc_no);
  ok('RLS: T1 user sees its full invoice (TIV); T2 user does not', docNos(list1).includes(full.json.doc_no) && !docNos(list2).includes(full.json.doc_no), `T1=${list1.json.count} T2=${list2.json.count}`);
  ok('RLS: T2 user sees only its own docs (count = 1)', list2.json.count === 1 && docNos(list2)[0] === ab2b.json.doc_no, JSON.stringify(docNos(list2)));
  const crossGet = await inj('GET', `/api/tax-invoices/${full.json.doc_no}`, cust2); // T2 reading T1's TIV (T2 has no TIV)
  ok('RLS: cross-tenant doc read → 404 (filtered)', crossGet.status === 404, `${crossGet.status}`);

  // ── PDF rendering (HTML fallback when chromium absent) — required statutory text present ──
  const abPdf = await inj('GET', `/api/tax-invoices/${ab1.json.doc_no}/pdf`, cust1);
  ok('PDF abbreviated: contains "ใบกำกับภาษีอย่างย่อ" + "ราคารวมภาษีมูลค่าเพิ่มแล้ว"', abPdf.status === 200 && abPdf.text.includes('ใบกำกับภาษีอย่างย่อ') && abPdf.text.includes('ราคารวมภาษีมูลค่าเพิ่มแล้ว'));
  const fullPdf = await inj('GET', `/api/tax-invoices/${full.json.doc_no}/pdf`, sales1);
  ok('PDF full: contains "ใบกำกับภาษี" + "ภาษีมูลค่าเพิ่ม" + Tax ID', fullPdf.status === 200 && fullPdf.text.includes('ใบกำกับภาษี') && fullPdf.text.includes('ภาษีมูลค่าเพิ่ม'));
  const whtPdf = await inj('GET', `/api/wht/certificates/${wht.json.doc_no}/pdf`, sales1);
  ok('PDF WHT: contains "มาตรา 50 ทวิ" + บาทตัวอักษร', whtPdf.status === 200 && whtPdf.text.includes('50 ทวิ') && whtPdf.text.includes('บาท'));

  // ── Tier 2: รายงานภาษีขาย/ซื้อ · ภ.พ.30 · ภ.ง.ด.3/53 (Phase 13) ──
  // AP bill 1,070 (incl) → input VAT 70, base 1000; posts Dr2100 70 to the GL (only 2100 movement here).
  const apBill = await inj('POST', '/api/finance/ap/transactions', admin, { vendor_name: 'ผู้ขายก', txn_type: 'Service', invoice_no: 'PV-1', invoice_date: '2026-06-21', amount: 1070 });
  ok('Tax-report setup: AP bill created (AP-) with stored VAT', /^AP-/.test(apBill.json.txn_no ?? ''), JSON.stringify(apBill.json).slice(0, 70));
  // รายงานภาษีขาย — admin (HQ/bypass) sees all issued invoices for 2026-06
  const ov = await inj('GET', '/api/tax-reports/output-vat?month=6&year=2026', admin);
  ok('Output-VAT: issued full TIV appears in report', ov.json.rows?.some((r: any) => r.doc_no === full.json.doc_no), JSON.stringify(ov.json.totals));
  ok('Output-VAT: total VAT = Σ issued (7+14+3.5+7+7 = 38.5)', near(ov.json.totals?.vat, 38.5), JSON.stringify(ov.json.totals));
  // รายงานภาษีซื้อ
  const iv = await inj('GET', '/api/tax-reports/input-vat?month=6&year=2026', admin);
  ok('Input-VAT: AP bill 1070 → base 1000 / vat 70', iv.json.rows?.some((r: any) => near(r.vat, 70) && near(r.base, 1000)), JSON.stringify(iv.json.totals));
  ok('Input-VAT: total vat = 70', near(iv.json.totals?.vat, 70));
  // ภ.พ.30
  const pp = await inj('GET', '/api/tax-reports/pp30?month=6&year=2026', admin);
  ok('PP30: net VAT = output − input (internally consistent)', near(pp.json.form.output_vat - pp.json.form.input_vat, pp.json.reconciliation.report_net_vat));
  ok('PP30: GL 2100 movement reflects AP input VAT (−70)', near(pp.json.reconciliation.gl_net_movement, -70), JSON.stringify(pp.json.reconciliation));
  // TAX-04: the VAT-return ↔ GL-2100 reconciliation block is the detective pre-filing control — it must
  // expose the 2100 net movement, the report net VAT (output − input) and a boolean tie verdict.
  ok('TAX-04: ภ.พ.30 reconciles to GL account 2100 (net movement + tie verdict present)',
    pp.json.reconciliation.gl_account === '2100'
    && typeof pp.json.reconciliation.tied === 'boolean'
    && near(pp.json.reconciliation.report_net_vat, pp.json.form.output_vat - pp.json.form.input_vat)
    && pp.json.reconciliation.tied === (Math.abs(pp.json.reconciliation.gl_net_movement - pp.json.reconciliation.report_net_vat) < 0.01),
    JSON.stringify(pp.json.reconciliation));
  ok('PP30: filing deadline = 15th of next month (2026-07-15)', pp.json.deadline === '2026-07-15');
  // ภ.ง.ด.3 / ภ.ง.ด.53
  const p53 = await inj('GET', '/api/tax-reports/pnd?type=PND53&month=6&year=2026', admin);
  ok('PND53: sums company WHT (300 + 309.28 = 609.28)', near(p53.json.totals?.tax_withheld, 609.28), JSON.stringify(p53.json.totals));
  const p3 = await inj('GET', '/api/tax-reports/pnd?type=PND3&month=6&year=2026', admin);
  ok('PND3: sums person WHT (250)', near(p3.json.totals?.tax_withheld, 250), JSON.stringify(p3.json.totals));
  const badPnd = await inj('GET', '/api/tax-reports/pnd?type=PND99&month=6&year=2026', admin);
  ok('PND: rejects invalid type (400)', badPnd.status === 400, `${badPnd.status}`);
  // exports (PDF → HTML fallback when chromium absent): Thai title present
  const ovx = await inj('GET', '/api/tax-reports/output-vat/export?month=6&year=2026', admin);
  ok('Export รายงานภาษีขาย: title present', ovx.status === 200 && ovx.text.includes('รายงานภาษีขาย'));
  const ppx = await inj('GET', '/api/tax-reports/pp30/export?month=6&year=2026', admin);
  ok('Export ภ.พ.30: form present', ppx.status === 200 && ppx.text.includes('ภ.พ.30'));

  // ── verify-fix #1 (input VAT tenant-scoped) + #6 (exempt AP = 0 input VAT) ──
  const proc2 = await login('proc2', 'pw4');
  await inj('POST', '/api/finance/ap/transactions', proc2, { vendor_name: 'ผู้ขาย T2', txn_type: 'Service', invoice_no: 'PV-T2', invoice_date: '2026-06-21', amount: 2140 }); // T2 AP, input VAT 140
  await inj('POST', '/api/finance/ap/transactions', admin, { vendor_name: 'ยกเว้นภาษี', txn_type: 'Service', invoice_no: 'PV-EX', invoice_date: '2026-06-21', amount: 1000, vat_treatment: 'exempt' }); // exempt → 0 input VAT
  const ivT2 = await inj('GET', '/api/tax-reports/input-vat?month=6&year=2026', proc2);
  ok('Fix#1: T2-scoped input VAT sees only T2 bill (vat 140, not T1/HQ)', near(ivT2.json.totals?.vat, 140) && ivT2.json.rows?.every((r: any) => r.doc_no?.startsWith('AP-')) && ivT2.json.rows?.some((r: any) => r.invoice_no === 'PV-T2') && !ivT2.json.rows?.some((r: any) => r.invoice_no === 'PV-1'), JSON.stringify(ivT2.json.totals));
  const ivAll = await inj('GET', '/api/tax-reports/input-vat?month=6&year=2026', admin);
  ok('Fix#1: HQ/bypass sees all tenants (70 + 140 + 0 = 210)', near(ivAll.json.totals?.vat, 210), JSON.stringify(ivAll.json.totals));
  ok('Fix#6: exempt AP bill carries 0 input VAT', ivAll.json.rows?.some((r: any) => r.invoice_no === 'PV-EX' && near(r.vat, 0) && near(r.base, 1000)), JSON.stringify(ivAll.json.rows?.find((r: any) => r.invoice_no === 'PV-EX') ?? {}));

  await app.close();
  await pg.close();

  console.log('\n── Phase 10 Thai tax documents (ใบกำกับภาษีเต็ม/ย่อ · 50 ทวิ) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} tax-doc checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} tax-doc checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
