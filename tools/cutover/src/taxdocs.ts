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
import { ymd } from '../../../apps/api/dist/database/queries';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;
// valid 13-digit Thai Tax ID from a 12-digit prefix (mod-11 check digit)
const taxId = (p12: string) => { let sum = 0; for (let i = 0; i < 12; i++) sum += Number(p12[i]) * (13 - i); return p12 + String((11 - (sum % 11)) % 10); };

// Anchor every fixture date + report period to the CURRENT business date (Asia/Bangkok, via ymd()) rather
// than a hardcoded month — a hardcoded "June 2026" broke this whole harness the instant the wall-clock
// crossed into July (tax invoices have no date override; they always stamp issueDate: ymd() = today).
const pad2 = (n: number) => String(n).padStart(2, '0');
const [curYear, curMonth] = ymd().split('-').map(Number);
const periodDate = (day: string) => `${curYear}-${pad2(curMonth)}-${day}`;
const nextMonth = curMonth === 12 ? 1 : curMonth + 1;
const nextMonthYear = curMonth === 12 ? curYear + 1 : curYear;
const nextMonthDeadline = `${nextMonthYear}-${pad2(nextMonth)}-15`;
const periodTag = `${curYear}-${pad2(curMonth)}`;

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
    { code: 'T1', name: 'ร้านหนึ่ง', legalName: 'บริษัท ร้านหนึ่ง จำกัด', taxId: T1_TAX, vatRegistered: true, branchCode: '00000', branchLabelTh: 'สำนักงานใหญ่', addressLine1: '123 ถนนสุขุมวิท', subDistrict: 'คลองเตย', district: 'คลองเตย', province: 'กรุงเทพมหานคร', postalCode: '10110', logoUrl: 'https://cdn.example.com/logo-t1.png' },
    { code: 'T2', name: 'ร้านสอง', legalName: 'บริษัท ร้านสอง จำกัด', taxId: T2_TAX, vatRegistered: true, branchCode: '00000', addressLine1: '456 ถนนพระราม 4', province: 'กรุงเทพมหานคร', postalCode: '10500' },
  ]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'cust1', passwordHash: await pw.hash('pw1'), role: 'Customer', tenantId: t1 },
    { username: 'cust2', passwordHash: await pw.hash('pw2'), role: 'Customer', tenantId: t2 },
    { username: 'sales1', passwordHash: await pw.hash('pw3'), role: 'Sales', tenantId: t1 },
    { username: 't1mgr', passwordHash: await pw.hash('pw6'), role: 'Admin', tenantId: t1 }, // T1 exec — authors the no-code document template
    { username: 'proc2', passwordHash: await pw.hash('pw4'), role: 'Procurement', tenantId: t2 }, // T2 creditors (AP per shop)
    { username: 't2mgr', passwordHash: await pw.hash('pw5'), role: 'Admin', tenantId: t2 }, // T2 exec — runs the scheduled tax jobs (docs/33 PR4)
  ]).onConflictDoNothing();
  // A T2 vendor WITH a tax ID → the WHT-cert batch can resolve the payee snapshot (docs/33 PR4).
  await db.insert(s.vendors).values({ tenantId: t2, name: 'บริษัท ผู้รับเหมา ทู จำกัด', taxId: taxId('010555700007'), address: '789 ถนนสาทร กรุงเทพฯ', isCreditor: true }).onConflictDoNothing();
  const t2VendorId = Number((await db.select().from(s.vendors).where(eq(s.vendors.name, 'บริษัท ผู้รับเหมา ทู จำกัด')))[0].id);
  // The Procurement role default is now SoD-clean (procurement/pr_raise only); proc2 books T2 AP bills
  // and reads input-VAT (creditors/ar) → grant the legacy bundle via an explicit per-user override.
  {
    const uid = Number((await db.select().from(s.users).where(eq(s.users.username, 'proc2')))[0].id);
    await db.insert(s.userPermissions).values(
      ['procurement', 'creditors', 'ar', 'delivery', 'masterdata', 'approvals'].map((perm) => ({ userId: uid, perm })),
    ).onConflictDoNothing();
  }

  // seed POS sales (VAT-separated) directly + items
  const seedSale = async (saleNo: string, tenantId: number, sub: number, vat: number, total: number, itemId: string) => {
    const [h] = await db.insert(s.custPosSales).values({ saleNo, saleDate: periodDate('21'), tenantId, subtotal: String(sub), discount: '0', taxAmount: String(vat), total: String(total), paymentMethod: 'Cash', pointsUsed: '0', pointsEarned: '0', status: 'Completed', createdBy: 'seed' }).returning({ id: s.custPosSales.id });
    await db.insert(s.custPosItems).values({ saleId: Number(h.id), itemId, itemDescription: `สินค้า ${itemId}`, qty: '1', uom: 'ชิ้น', unitPrice: String(sub), discountPct: '0', amount: String(sub), isCustom: false });
  };
  await seedSale('S-T1-1', t1, 100, 7, 107, 'A');
  await seedSale('S-T1-2', t1, 200, 14, 214, 'B');
  await seedSale('S-T2-1', t2, 50, 3.5, 53.5, 'C');
  // AR invoice for T1 (VAT-inclusive amount 107)
  await db.insert(s.arInvoices).values({ invoiceNo: 'INV-AR1', invoiceDate: periodDate('21'), tenantId: t1, orderNo: 'SO-1', amount: '107', status: 'Unpaid', currency: 'THB' });

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
  const t1mgr = await login('t1mgr', 'pw6'); // T1 exec — authors the no-code document template
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
  ok('Full/POS: Paid By auto-derived from the sale\'s own payment method (Cash)', full.json.payment?.paid_by === 'cash', JSON.stringify(full.json.payment));
  ok('Full/AR (no payment/due_date given): both null', fullAr.json.payment === null && fullAr.json.due_date === null);

  // ── WHT 50 ทวิ (ม.50 ทวิ) ──
  const wht = await inj('POST', '/api/wht/certificates', sales1, { date_paid: periodDate('21'), payee: { name: 'บริษัท ผู้รับเหมา จำกัด', tax_id: PAYEE_TAX, address: 'ที่อยู่ผู้รับเงิน', kind: 'company' }, lines: [{ income_type: '3tre-service', description: 'ค่าบริการ', amount_paid: 10000 }] });
  ok('WHT: issued WHT- + PND53 (company) + 3% rate', /^WHT-\d{6}-0001$/.test(wht.json.doc_no ?? '') && wht.json.pnd_type === 'PND53', `${wht.status} ${JSON.stringify(wht.json).slice(0, 90)}`);
  ok('WHT: tax withheld = 10000 × 3% = 300', near(wht.json.total_wht, 300) && near(wht.json.lines?.[0]?.tax_withheld, 300) && near(wht.json.lines?.[0]?.rate, 0.03));
  ok('WHT: payer (T1) + payee Tax IDs present (13-digit)', wht.json.payer?.tax_id === T1_TAX && wht.json.payee?.tax_id === PAYEE_TAX);
  // person → PND3, rate by type
  const wht2 = await inj('POST', '/api/wht/certificates', sales1, { date_paid: periodDate('21'), payee: { name: 'นายช่าง', tax_id: PAYEE_TAX, address: 'บ้าน', kind: 'person' }, lines: [{ income_type: '40(5)', amount_paid: 5000 }] });
  ok('WHT: person + ค่าเช่า 40(5) 5% → PND3, tax 250', wht2.json.pnd_type === 'PND3' && near(wht2.json.total_wht, 250));
  // gross-up (ผู้จ่ายออกภาษีให้ตลอดไป): net 10000 @3% → base 10309.28, tax 309.28
  const whtGross = await inj('POST', '/api/wht/certificates', sales1, { date_paid: periodDate('21'), condition: 'absorb_always', payee: { name: 'ผู้รับเหมา', tax_id: PAYEE_TAX, address: 'x', kind: 'company' }, lines: [{ income_type: '3tre-service', description: 'บริการ', amount_paid: 10000 }] });
  ok('WHT: gross-up (absorb) base 10309.28, tax 309.28', near(whtGross.json.lines?.[0]?.amount_paid, 10309.28) && near(whtGross.json.total_wht, 309.28), JSON.stringify(whtGross.json.lines?.[0] ?? {}).slice(0, 70));
  const whtBadRate = await inj('POST', '/api/wht/certificates', sales1, { date_paid: periodDate('21'), payee: { name: 'x', tax_id: PAYEE_TAX, address: 'x', kind: 'company' }, lines: [{ income_type: '3tre-service', description: 'b', amount_paid: 1000, rate: 0.5 }] });
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

  // ── No-code document template applied LIVE to the full tax invoice (presentation only; ม.86/4 fiscal
  // integrity forces the mandatory seller lines on regardless of the hide knobs) ──
  // The catalog advertises the full tax invoice as live.
  const dtTypes = await inj('GET', '/api/document-templates/doc-types', t1mgr);
  ok('Doc templates: full tax invoice is LIVE in the catalog', (dtTypes.json.doc_types ?? []).some((d: any) => d.key === 'tax_invoice_full' && d.status === 'live'), JSON.stringify((dtTypes.json.doc_types ?? []).map((d: any) => `${d.key}:${d.status}`)));
  // T1 authors an active template that recolours + adds a header note/footer terms, turns OFF amount-in-words,
  // and (illegally) tries to hide the seller tax-id + address.
  const tiTpl = await inj('POST', '/api/document-templates', t1mgr, { doc_type: 'tax_invoice_full', name: 'ใบกำกับภาษี ร้านหนึ่ง', config: { header: { accent_color: '#0F766E', header_note: 'HDR-NOTE-TIV', show_logo: true }, body: { show_seller_tax_id: false, show_seller_address: false }, totals: { show_amount_in_words: false }, footer: { terms_text: 'TERMS-TIV-XYZ' } } });
  ok('Doc templates: full tax-invoice template created (T1)', tiTpl.status < 300 && !!tiTpl.json.id, `${tiTpl.status} ${JSON.stringify(tiTpl.json).slice(0, 80)}`);
  const fullTpl = await inj('GET', `/api/tax-invoices/${full.json.doc_no}/pdf`, sales1);
  const ftHtml = typeof fullTpl.text === 'string' ? fullTpl.text : '';
  ok('PDF full LIVE: honours accent colour + header note + footer terms + logo', fullTpl.status === 200 && ftHtml.includes('#0F766E') && ftHtml.includes('HDR-NOTE-TIV') && ftHtml.includes('TERMS-TIV-XYZ') && ftHtml.includes('brandlogo'), `accent=${ftHtml.includes('#0F766E')} note=${ftHtml.includes('HDR-NOTE-TIV')} terms=${ftHtml.includes('TERMS-TIV-XYZ')} logo=${ftHtml.includes('brandlogo')}`);
  ok('PDF full LIVE: amount-in-words OFF toggle honoured (no baht-text line)', ftHtml.length > 0 && !ftHtml.includes('class="words"'), `hasWords=${ftHtml.includes('class="words"')}`);
  // FISCAL integrity: the mandatory ม.86/4 seller tax-id + address survive the hide knobs.
  ok('PDF full FISCAL: seller tax-id line forced ON despite hide knob (ม.86/4)', ftHtml.includes('เลขประจำตัวผู้เสียภาษีอากร') && ftHtml.includes('123 ถนนสุขุมวิท'), `taxId=${ftHtml.includes('เลขประจำตัวผู้เสียภาษีอากร')} addr=${ftHtml.includes('123 ถนนสุขุมวิท')}`);
  // core integrity: the statutory title + VAT + total survive a customized template.
  ok('PDF full core: "ใบกำกับภาษี" + "ภาษีมูลค่าเพิ่ม" + grand total still present under a template', ftHtml.includes('ใบกำกับภาษี') && ftHtml.includes('ภาษีมูลค่าเพิ่ม') && ftHtml.includes('107.00'), `total=${ftHtml.includes('107.00')}`);

  // ── No-code template applied LIVE to the abbreviated 80mm slip (ม.86/6): only the header/footer notes
  // apply on thermal paper; the mandatory seller identity + VAT-inclusive total are structural ──
  ok('Doc templates: abbreviated tax invoice is LIVE in the catalog', (dtTypes.json.doc_types ?? []).some((d: any) => d.key === 'tax_invoice_abbreviated' && d.status === 'live'), JSON.stringify((dtTypes.json.doc_types ?? []).map((d: any) => `${d.key}:${d.status}`)));
  const abTpl = await inj('POST', '/api/document-templates', t1mgr, { doc_type: 'tax_invoice_abbreviated', name: 'สลิปย่อ ร้านหนึ่ง', config: { header: { header_note: 'SLIP-HDR-T1' }, footer: { terms_text: 'SLIP-FTR-T1', extra_lines: ['SLIP-EXTRA-T1'] } } });
  ok('Doc templates: abbreviated slip template created (T1)', abTpl.status < 300 && !!abTpl.json.id, `${abTpl.status} ${JSON.stringify(abTpl.json).slice(0, 80)}`);
  const abTplPdf = await inj('GET', `/api/tax-invoices/${ab1.json.doc_no}/pdf`, cust1);
  const abtHtml = typeof abTplPdf.text === 'string' ? abTplPdf.text : '';
  ok('PDF abbreviated LIVE: honours header + footer notes on the slip', abTplPdf.status === 200 && abtHtml.includes('SLIP-HDR-T1') && abtHtml.includes('SLIP-FTR-T1') && abtHtml.includes('SLIP-EXTRA-T1'), `hdr=${abtHtml.includes('SLIP-HDR-T1')} ftr=${abtHtml.includes('SLIP-FTR-T1')} extra=${abtHtml.includes('SLIP-EXTRA-T1')}`);
  ok('PDF abbreviated FISCAL: title + seller tax-id + VAT-inclusive total still print (ม.86/6)', abtHtml.includes('ใบกำกับภาษีอย่างย่อ') && abtHtml.includes('เลขผู้เสียภาษี') && abtHtml.includes('ราคารวมภาษีมูลค่าเพิ่มแล้ว'), `len=${abtHtml.length}`);

  const whtPdf = await inj('GET', `/api/wht/certificates/${wht.json.doc_no}/pdf`, sales1);
  ok('PDF WHT: contains "มาตรา 50 ทวิ" + บาทตัวอักษร', whtPdf.status === 200 && whtPdf.text.includes('50 ทวิ') && whtPdf.text.includes('บาท'));

  // ── Tier 2: รายงานภาษีขาย/ซื้อ · ภ.พ.30 · ภ.ง.ด.3/53 (Phase 13) ──
  // AP bill 1,070 (incl) → input VAT 70, base 1000; posts Dr2100 70 to the GL (only 2100 movement here).
  const apBill = await inj('POST', '/api/finance/ap/transactions', admin, { vendor_name: 'ผู้ขายก', txn_type: 'Service', invoice_no: 'PV-1', invoice_date: periodDate('21'), amount: 1070 });
  ok('Tax-report setup: AP bill created (AP-) with stored VAT', /^AP-/.test(apBill.json.txn_no ?? ''), JSON.stringify(apBill.json).slice(0, 70));
  // รายงานภาษีขาย — admin (HQ/bypass) sees all issued invoices for the current filing period
  const ov = await inj('GET', `/api/tax-reports/output-vat?month=${curMonth}&year=${curYear}`, admin);
  ok('Output-VAT: issued full TIV appears in report', ov.json.rows?.some((r: any) => r.doc_no === full.json.doc_no), JSON.stringify(ov.json.totals));
  ok('Output-VAT: total VAT = Σ issued (7+14+3.5+7+7 = 38.5)', near(ov.json.totals?.vat, 38.5), JSON.stringify(ov.json.totals));
  // รายงานภาษีซื้อ
  const iv = await inj('GET', `/api/tax-reports/input-vat?month=${curMonth}&year=${curYear}`, admin);
  ok('Input-VAT: AP bill 1070 → base 1000 / vat 70', iv.json.rows?.some((r: any) => near(r.vat, 70) && near(r.base, 1000)), JSON.stringify(iv.json.totals));
  ok('Input-VAT: total vat = 70', near(iv.json.totals?.vat, 70));
  // ภ.พ.30
  const pp = await inj('GET', `/api/tax-reports/pp30?month=${curMonth}&year=${curYear}`, admin);
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
  ok('PP30: filing deadline = 15th of next month', pp.json.deadline === nextMonthDeadline, `${pp.json.deadline} vs ${nextMonthDeadline}`);
  // ภ.ง.ด.3 / ภ.ง.ด.53
  const p53 = await inj('GET', `/api/tax-reports/pnd?type=PND53&month=${curMonth}&year=${curYear}`, admin);
  ok('PND53: sums company WHT (300 + 309.28 = 609.28)', near(p53.json.totals?.tax_withheld, 609.28), JSON.stringify(p53.json.totals));
  const p3 = await inj('GET', `/api/tax-reports/pnd?type=PND3&month=${curMonth}&year=${curYear}`, admin);
  ok('PND3: sums person WHT (250)', near(p3.json.totals?.tax_withheld, 250), JSON.stringify(p3.json.totals));
  const badPnd = await inj('GET', `/api/tax-reports/pnd?type=PND99&month=${curMonth}&year=${curYear}`, admin);
  ok('PND: rejects invalid type (400)', badPnd.status === 400, `${badPnd.status}`);

  // ── TAX-05: filing register (DRAFT → SUBMITTED → ACCEPTED) + remittance calendar ──
  const fileP = await inj('POST', '/api/tax-reports/filings', admin, { filing_type: 'PP30', month: curMonth, year: curYear });
  ok('TAX-05: file PP30 → DRAFT snapshot (output 38.5, input 70)', fileP.json.status === 'DRAFT' && near(fileP.json.output_vat, 38.5) && near(fileP.json.input_vat, 70), JSON.stringify(fileP.json).slice(0, 130));
  const refileP = await inj('POST', '/api/tax-reports/filings', admin, { filing_type: 'PP30', month: curMonth, year: curYear });
  ok('TAX-05: re-file refreshes the same DRAFT (idempotent per period)', refileP.json.id === fileP.json.id && refileP.json.already_filed === false, JSON.stringify({ a: fileP.json.id, b: refileP.json.id }));
  const subNoRef = await inj('POST', `/api/tax-reports/filings/${fileP.json.id}/submit`, admin, {});
  ok('TAX-05: submit without a reference → 400', subNoRef.status === 400, `${subNoRef.status} ${subNoRef.json.error?.code}`);
  const sub = await inj('POST', `/api/tax-reports/filings/${fileP.json.id}/submit`, admin, { submission_ref: `RD-${periodTag}-PP30-001` });
  ok('TAX-05: submit with ref → SUBMITTED + submitted_at', sub.json.status === 'SUBMITTED' && sub.json.submission_ref === `RD-${periodTag}-PP30-001` && !!sub.json.submitted_at, JSON.stringify(sub.json).slice(0, 120));
  const acc = await inj('POST', `/api/tax-reports/filings/${fileP.json.id}/accept`, admin, {});
  ok('TAX-05: accept → ACCEPTED', acc.json.status === 'ACCEPTED', `${acc.json.status}`);
  const refileFiled = await inj('POST', '/api/tax-reports/filings', admin, { filing_type: 'PP30', month: curMonth, year: curYear });
  ok('TAX-05: re-file an already-filed period returns it (no overwrite)', refileFiled.json.already_filed === true && refileFiled.json.status === 'ACCEPTED', `${refileFiled.json.already_filed} ${refileFiled.json.status}`);
  const fileW = await inj('POST', '/api/tax-reports/filings', admin, { filing_type: 'PND53', month: curMonth, year: curYear });
  ok('TAX-05: file PND53 → tax_withheld 609.28', near(fileW.json.tax_withheld, 609.28), JSON.stringify(fileW.json).slice(0, 110));
  const cal = await inj('GET', `/api/tax-reports/remittance-calendar?year=${curYear}`, admin);
  const junePp = (cal.json.calendar ?? []).find((c: any) => c.filing_type === 'PP30' && c.period_month === curMonth);
  ok('TAX-05: remittance calendar shows the filed PP30 period ACCEPTED, deadline = 15th of next month', junePp?.status === 'ACCEPTED' && junePp?.deadline === nextMonthDeadline, JSON.stringify(junePp ?? {}));
  const listF = await inj('GET', `/api/tax-reports/filings?year=${curYear}`, admin);
  ok('TAX-05: filings list includes PP30 + PND53', (listF.json.filings ?? []).length >= 2, `n=${listF.json.count}`);
  // exports (PDF → HTML fallback when chromium absent): Thai title present
  const ovx = await inj('GET', `/api/tax-reports/output-vat/export?month=${curMonth}&year=${curYear}`, admin);
  ok('Export รายงานภาษีขาย: title present', ovx.status === 200 && ovx.text.includes('รายงานภาษีขาย'));
  const ppx = await inj('GET', `/api/tax-reports/pp30/export?month=${curMonth}&year=${curYear}`, admin);
  ok('Export ภ.พ.30: form present', ppx.status === 200 && ppx.text.includes('ภ.พ.30'));

  // ── verify-fix #1 (input VAT tenant-scoped) + #6 (exempt AP = 0 input VAT) ──
  const proc2 = await login('proc2', 'pw4');
  await inj('POST', '/api/finance/ap/transactions', proc2, { vendor_name: 'ผู้ขาย T2', txn_type: 'Service', invoice_no: 'PV-T2', invoice_date: periodDate('21'), amount: 2140 }); // T2 AP, input VAT 140
  await inj('POST', '/api/finance/ap/transactions', admin, { vendor_name: 'ยกเว้นภาษี', txn_type: 'Service', invoice_no: 'PV-EX', invoice_date: periodDate('21'), amount: 1000, vat_treatment: 'exempt' }); // exempt → 0 input VAT
  const ivT2 = await inj('GET', `/api/tax-reports/input-vat?month=${curMonth}&year=${curYear}`, proc2);
  ok('Fix#1: T2-scoped input VAT sees only T2 bill (vat 140, not T1/HQ)', near(ivT2.json.totals?.vat, 140) && ivT2.json.rows?.every((r: any) => r.doc_no?.startsWith('AP-')) && ivT2.json.rows?.some((r: any) => r.invoice_no === 'PV-T2') && !ivT2.json.rows?.some((r: any) => r.invoice_no === 'PV-1'), JSON.stringify(ivT2.json.totals));
  const ivAll = await inj('GET', `/api/tax-reports/input-vat?month=${curMonth}&year=${curYear}`, admin);
  ok('Fix#1: HQ/bypass sees all tenants (70 + 140 + 0 = 210)', near(ivAll.json.totals?.vat, 210), JSON.stringify(ivAll.json.totals));
  ok('Fix#6: exempt AP bill carries 0 input VAT', ivAll.json.rows?.some((r: any) => r.invoice_no === 'PV-EX' && near(r.vat, 0) && near(r.base, 1000)), JSON.stringify(ivAll.json.rows?.find((r: any) => r.invoice_no === 'PV-EX') ?? {}));

  // ── TAX-03: WHT withheld at AP payment → posted to GL 2361 → PND→GL tie-out ──
  // proc2 (creditors) books a T2 service bill ฿1070 (1000 + 70 VAT) and requests payment WITH 3% WHT; admin
  // (≠ requester, SoD) approves → the vendor is paid net ฿1040 and ฿30 is held in GL 2361 to remit to the RD.
  const whtBill = await inj('POST', '/api/finance/ap/transactions', proc2, { vendor_id: t2VendorId, vendor_name: 'บริษัท ผู้รับเหมา ทู จำกัด', txn_type: 'Service', invoice_no: 'PV-WHT-1', invoice_date: periodDate('22'), amount: 1070 });
  const whtReq = await inj('PATCH', `/api/finance/ap/transactions/${whtBill.json.txn_no}/pay`, proc2, { amount: 1070, wht_income_type: '3tre-service', wht_rate: 0.03 });
  ok('TAX-03: AP payment request captures a WHT rate (3%)', whtReq.status === 200 && near(whtReq.json.wht_rate, 0.03), `${whtReq.status} ${JSON.stringify(whtReq.json).slice(0, 90)}`);
  const whtAppr = await inj('POST', `/api/finance/ap/payments/${whtReq.json.payment_no}/approve`, admin, {});
  ok('TAX-03: approval withholds 3% on the ฿1000 pre-VAT base → WHT ฿30, vendor paid net ฿1040', whtAppr.status === 200 && near(whtAppr.json.wht_amount, 30) && near(whtAppr.json.net_paid, 1040), `${whtAppr.status} ${JSON.stringify(whtAppr.json).slice(0, 120)}`);
  // an out-of-range rate is rejected (fresh bill so the over-pay guard doesn't pre-empt the WHT check).
  const whtBill2 = await inj('POST', '/api/finance/ap/transactions', proc2, { vendor_name: 'x', txn_type: 'Service', invoice_no: 'PV-WHT-2', invoice_date: periodDate('22'), amount: 100 });
  const whtBad = await inj('PATCH', `/api/finance/ap/transactions/${whtBill2.json.txn_no}/pay`, proc2, { amount: 100, wht_rate: 0.5 });
  ok('TAX-03: AP payment rejects an out-of-range WHT rate (>30%) → 400', whtBad.status === 400 && ['VALIDATION_ERROR', 'INVALID_WHT_RATE'].includes(whtBad.json.error?.code), `${whtBad.status} ${whtBad.json.error?.code}`);
  // PND→GL tie-out for the business month the WHT posted in: GL 2361 net (฿30) ties to the WHT withheld (฿30).
  const tie = await inj('GET', `/api/tax-reports/pnd-tieout?month=${curMonth}&year=${curYear}`, admin);
  ok('TAX-03: PND→GL tie-out — GL 2361 net (฿30) ties to AP-payment WHT withheld (฿30)', tie.status === 200 && near(tie.json.gl_net_movement, 30) && near(tie.json.ap_wht_withheld, 30) && tie.json.tied_gl_ap === true, `${tie.status} ${JSON.stringify(tie.json).slice(0, 170)}`);

  // ── docs/33 PR4: scheduled tax automation — auto-issue the 50-ทวิ from the AP-payment WHT (labour/service) ──
  // The batch keys on the AP payment_no (not a period total), so it issues exactly one linked certificate for
  // the withheld payment and skips it on re-run.
  const t2mgr = await login('t2mgr', 'pw5');
  const subW = await inj('POST', '/api/bi/subscriptions', t2mgr, { name: 'WHT cert batch', report_type: 'tax_wht_cert_batch', frequency: 'monthly', filters: { month: curMonth, year: curYear } });
  ok('PR4: tax_wht_cert_batch is a schedulable report type', subW.status === 201 && subW.json.id > 0, `${subW.status} ${JSON.stringify(subW.json).slice(0, 90)}`);
  const runW = await inj('POST', `/api/bi/subscriptions/${subW.json.id}/run`, t2mgr, {});
  ok('PR4: running the batch issues the 50-ทวิ for the un-certificated WHT payment (issued 1)', runW.status === 200 && runW.json.status === 'success' && /issued 1 of 1/.test(runW.json.summary ?? ''), `${runW.status} ${runW.json.summary ?? JSON.stringify(runW.json).slice(0, 120)}`);
  const certs = await inj('GET', '/api/wht/certificates', t2mgr);
  const autoCert = (certs.json.certificates ?? []).find((c: any) => c.ap_txn_no === whtBill.json.txn_no || c.payment_no === whtReq.json.payment_no);
  ok('PR4: the auto-issued certificate is linked to the AP payment + withholds ฿30', !!autoCert && near(autoCert.total_wht, 30) && autoCert.pnd_type === 'PND53', JSON.stringify(autoCert ?? {}).slice(0, 130));
  const runW2 = await inj('POST', `/api/bi/subscriptions/${subW.json.id}/run`, t2mgr, {});
  ok('PR4: re-running the batch is idempotent — the certificated payment is skipped (issued 0)', runW2.status === 200 && /issued 0 of 1/.test(runW2.json.summary ?? ''), runW2.json.summary ?? '');
  const certs2 = await inj('GET', '/api/wht/certificates', t2mgr);
  ok('PR4: no duplicate certificate on re-run (exactly one for the payment)', (certs2.json.certificates ?? []).filter((c: any) => c.ap_txn_no === whtBill.json.txn_no).length === 1, `n=${(certs2.json.certificates ?? []).filter((c: any) => c.ap_txn_no === whtBill.json.txn_no).length}`);
  // tax_pp30_draft: register the period PP30 as a DRAFT filing (idempotent per period).
  const subP = await inj('POST', '/api/bi/subscriptions', t2mgr, { name: 'PP30 draft', report_type: 'tax_pp30_draft', frequency: 'monthly', filters: { month: curMonth, year: curYear } });
  const runP = await inj('POST', `/api/bi/subscriptions/${subP.json.id}/run`, t2mgr, {});
  ok('PR4: tax_pp30_draft runs and registers/refreshes the period PP30 filing', runP.status === 200 && runP.json.status === 'success' && /Draft filing PP30/.test(runP.json.summary ?? ''), runP.json.summary ?? JSON.stringify(runP.json).slice(0, 120));

  // ── docs/33 PR6: vat_code → VAT posting (makes the tax_codes table live) ──
  // A VAT code with DISTINCT output/input accounts proves the routing moved off the shared 2100.
  await db.insert(s.accounts).values([
    { code: '2101', name: 'Output VAT — determination test', type: 'Liability', normalBalance: 'C', isPostable: true },
    { code: '2102', name: 'Input VAT — determination test', type: 'Liability', normalBalance: 'C', isPostable: true },
  ]).onConflictDoNothing();
  await inj('PUT', '/api/feature-flags/posting_determination', t2mgr, { enabled: true }); // AR auto-resolution needs the flag
  const taxc = await inj('POST', '/api/item-setup/tax-codes', t2mgr, { code: 'VAT7X', kind: 'vat', rate: 0.07, inclusive: true, output_account: '2101', input_account: '2102', name_th: 'VAT 7% (แยกบัญชี)' });
  ok('PR6: create a VAT code with distinct output/input accounts', taxc.status === 201 && taxc.json.output_account === '2101' && taxc.json.input_account === '2102', JSON.stringify(taxc.json).slice(0, 90));
  // AP bill carrying the tax_code → input VAT (70 on a 1,070 inclusive bill) routes to 2102, not 2100.
  const apVat = await inj('POST', '/api/finance/ap/transactions', proc2, { vendor_name: 'ผู้ขาย VAT', txn_type: 'Service', invoice_no: 'PV-VAT', invoice_date: periodDate('23'), amount: 1070, tax_code: 'VAT7X' });
  ok('PR6: AP bill accepts a tax_code', /^AP-/.test(apVat.json.txn_no ?? ''), JSON.stringify(apVat.json).slice(0, 80));
  const acc2102 = (await inj('GET', '/api/ledger/account-ledger?account=2102', proc2)).json;
  ok('PR6: input VAT routed to the tax_code input account 2102 (Dr 70)', near(acc2102.total_debit, 70), `dr=${acc2102.total_debit}`);
  const apBadVat = await inj('POST', '/api/finance/ap/transactions', proc2, { vendor_name: 'x', txn_type: 'Service', invoice_no: 'PV-BADVAT', invoice_date: periodDate('23'), amount: 100, tax_code: 'NOPE' });
  ok('PR6: AP bill with an unknown tax_code is rejected fail-closed (UNKNOWN_TAX_CODE)', apBadVat.status === 400 && apBadVat.json.error?.code === 'UNKNOWN_TAX_CODE', `st=${apBadVat.status} code=${apBadVat.json.error?.code}`);
  // AR: an order whose item carries vat_code VAT7X + revenue_account 4001 → ar/sync routes OUTPUT VAT to 2101
  // (item→vat_code) AND revenue to 4001 (item→revenue_account, docs/33 PR7).
  await db.insert(s.accounts).values({ code: '4001', name: 'Revenue — determination test', type: 'Revenue', normalBalance: 'C', isPostable: true }).onConflictDoNothing();
  await db.insert(s.items).values({ itemId: 'VATITEM', itemDescription: 'VAT-coded item' }).onConflictDoNothing();
  await inj('PATCH', '/api/item-setup/items/VATITEM', t2mgr, { vat_code: 'VAT7X', revenue_account: '4001' });
  const [ord] = await db.insert(s.orders).values({ orderNo: 'SO-VAT-1', orderDate: periodDate('23'), status: 'Completed', tenantId: t2 }).returning({ id: s.orders.id });
  await db.insert(s.orderLines).values({ orderId: Number(ord.id), itemId: 'VATITEM', totalPrice: '1070' });
  const arSync = await inj('POST', '/api/finance/ar/sync', t2mgr, {});
  ok('PR6: ar/sync creates the invoice from the order', (arSync.status === 200 || arSync.status === 201) && (arSync.json.created ?? 0) >= 1, JSON.stringify(arSync.json).slice(0, 60));
  const acc2101 = (await inj('GET', '/api/ledger/account-ledger?account=2101', t2mgr)).json;
  ok('PR6: output VAT routed to the item vat_code account 2101 (Cr 70)', near(acc2101.total_credit, 70), `cr=${acc2101.total_credit}`);
  const acc4001 = (await inj('GET', '/api/ledger/account-ledger?account=4001', t2mgr)).json;
  ok('PR7: AR revenue routed to the item revenue_account 4001 (Cr 1000 net)', near(acc4001.total_credit, 1000), `cr=${acc4001.total_credit}`);
  // PR7 (C): a WHT tax_code defaults the income type + rate on an AP payment request (WHT side of tax_codes).
  const whtCode = await inj('POST', '/api/item-setup/tax-codes', t2mgr, { code: 'WHT3X', kind: 'wht', rate: 0.03, wht_income_type: '3tre-service', name_th: 'หัก ณ ที่จ่าย 3%' });
  ok('PR7: create a WHT tax code (3%, 3tre-service)', whtCode.status === 201 && whtCode.json.kind === 'wht', JSON.stringify(whtCode.json).slice(0, 80));
  const whtBillC = await inj('POST', '/api/finance/ap/transactions', proc2, { vendor_name: 'ผู้รับเหมา C', txn_type: 'Service', invoice_no: 'PV-WHTC', invoice_date: periodDate('24'), amount: 1070 });
  const whtReqC = await inj('PATCH', `/api/finance/ap/transactions/${whtBillC.json.txn_no}/pay`, proc2, { amount: 1070, wht_tax_code: 'WHT3X' });
  ok('PR7: WHT tax_code defaults the rate on the payment request (3% from the code)', whtReqC.status === 200 && near(whtReqC.json.wht_rate, 0.03), `${whtReqC.status} rate=${whtReqC.json.wht_rate}`);
  const whtBadC = await inj('POST', '/api/finance/ap/transactions', proc2, { vendor_name: 'x', txn_type: 'Service', invoice_no: 'PV-WHTBAD', invoice_date: periodDate('24'), amount: 100 });
  const whtReqBad = await inj('PATCH', `/api/finance/ap/transactions/${whtBadC.json.txn_no}/pay`, proc2, { amount: 100, wht_tax_code: 'VAT7X' });
  ok('PR7: a VAT code used as wht_tax_code is rejected (INVALID_WHT_TAX_CODE)', whtReqBad.status === 400 && whtReqBad.json.error?.code === 'INVALID_WHT_TAX_CODE', `st=${whtReqBad.status} code=${whtReqBad.json.error?.code}`);
  // TAX-04 stays correct under routing: the PP30 tie now spans the whole VAT-account set, not just 2100.
  const ppSet = (await inj('GET', `/api/tax-reports/pp30?month=${curMonth}&year=${curYear}`, t2mgr)).json;
  ok('PR6: PP30 reconciliation spans the VAT-account set (2100 + 2101 + 2102)', /2100/.test(ppSet.reconciliation.gl_account) && /2101/.test(ppSet.reconciliation.gl_account) && /2102/.test(ppSet.reconciliation.gl_account), ppSet.reconciliation.gl_account);

  // ── ใบลดหนี้ (ม.86/10) / ใบเพิ่มหนี้ (ม.86/9) — credit/debit note: maker-checker + VAT adjustment (TAX-07) ──
  // `full` (net 100 / vat 7) is the original. Deltas are measured against the running output-VAT so the block
  // is robust to the totals accumulated by the PR6/PR7 activity above.
  const ovBefore = (await inj('GET', `/api/tax-reports/output-vat?month=${curMonth}&year=${curYear}`, admin)).json.totals.vat;
  const cn = await inj('POST', '/api/tax-invoices/credit-note', sales1, { original_doc_no: full.json.doc_no, reason: 'สินค้าชำรุด คืนทั้งจำนวน', lines: [{ description: 'คืนสินค้า A', amount: 100 }] });
  ok('CN: issued CN-YYYYMM-NNNN as PendingApproval + a Draft GL entry', /^CN-\d{6}-\d{4}$/.test(cn.json.doc_no ?? '') && cn.json.status === 'PendingApproval' && !!cn.json.gl_entry_no && cn.json.gl_status === 'Draft', `${cn.status} ${JSON.stringify(cn.json).slice(0, 90)}`);
  ok('CN: VAT 7% of 100 = 7 (subtotal 100, total 107) + references the original', near(cn.json.subtotal, 100) && near(cn.json.vat_amount, 7) && near(cn.json.grand_total, 107) && cn.json.original_doc_no === full.json.doc_no);
  const ovPending = (await inj('GET', `/api/tax-reports/output-vat?month=${curMonth}&year=${curYear}`, admin)).json.totals.vat;
  ok('CN: a PENDING note is EXCLUDED from output-VAT until approved', near(ovPending, ovBefore), `before=${ovBefore} pending=${ovPending}`);
  const cnSelf = await inj('POST', `/api/tax-invoices/${cn.json.doc_no}/approve-note`, sales1);
  ok('CN: maker cannot approve their own note (SOD_VIOLATION 403)', cnSelf.status === 403 && cnSelf.json.error?.code === 'SOD_VIOLATION', `${cnSelf.status} ${cnSelf.json.error?.code}`);
  const cnAppr = await inj('POST', `/api/tax-invoices/${cn.json.doc_no}/approve-note`, admin);
  ok('CN: a DIFFERENT user approves → Issued + GL Posted', [200, 201].includes(cnAppr.status) && cnAppr.json.status === 'Issued' && cnAppr.json.gl?.status === 'Posted', `${cnAppr.status} ${JSON.stringify(cnAppr.json).slice(0, 90)}`);
  const ovAfter = (await inj('GET', `/api/tax-reports/output-vat?month=${curMonth}&year=${curYear}`, admin)).json.totals.vat;
  ok('CN: an approved credit note REDUCES output VAT by 7', near(ovAfter, ovBefore - 7), `before=${ovBefore} after=${ovAfter}`);
  const cnNoReason = await inj('POST', '/api/tax-invoices/credit-note', sales1, { original_doc_no: full.json.doc_no, reason: '', lines: [{ description: 'x', amount: 10 }] });
  ok('CN: reason is required (400)', cnNoReason.status === 400, `${cnNoReason.status}`);
  const cnOver = await inj('POST', '/api/tax-invoices/credit-note', sales1, { original_doc_no: full.json.doc_no, reason: 'เกินมูลค่า', lines: [{ description: 'x', amount: 5000 }] });
  ok('CN: cannot credit more than the original net (CREDIT_EXCEEDS_ORIGINAL 400)', cnOver.status === 400 && cnOver.json.error?.code === 'CREDIT_EXCEEDS_ORIGINAL', `${cnOver.status} ${cnOver.json.error?.code}`);
  // Debit note (ใบเพิ่มหนี้) — increases the sale + output VAT.
  const dn = await inj('POST', '/api/tax-invoices/debit-note', sales1, { original_doc_no: full.json.doc_no, reason: 'คิดราคาขาดไป', lines: [{ description: 'ส่วนต่างราคา', amount: 50 }] });
  ok('DN: issued DN-YYYYMM-NNNN PendingApproval + VAT 3.5', /^DN-\d{6}-\d{4}$/.test(dn.json.doc_no ?? '') && dn.json.status === 'PendingApproval' && near(dn.json.vat_amount, 3.5), `${dn.status} ${JSON.stringify(dn.json).slice(0, 80)}`);
  const dnAppr = await inj('POST', `/api/tax-invoices/${dn.json.doc_no}/approve-note`, admin);
  ok('DN: approved → Issued + GL Posted', dnAppr.json.status === 'Issued' && dnAppr.json.gl?.status === 'Posted', JSON.stringify(dnAppr.json).slice(0, 90));
  const ovDn = (await inj('GET', `/api/tax-reports/output-vat?month=${curMonth}&year=${curYear}`, admin)).json.totals.vat;
  ok('DN: an approved debit note INCREASES output VAT by 3.5', near(ovDn, ovAfter + 3.5), `after=${ovAfter} dn=${ovDn}`);
  const cnPdf = await inj('GET', `/api/tax-invoices/${cn.json.doc_no}/pdf`, sales1);
  ok('CN PDF: contains "ใบลดหนี้" + มาตรา 86/10 + original ref + reason', cnPdf.status === 200 && cnPdf.text.includes('ใบลดหนี้') && cnPdf.text.includes('86/10') && cnPdf.text.includes(full.json.doc_no) && cnPdf.text.includes('ชำรุด'), `${cnPdf.status}`);

  // ── G16 (maker-checker audit — detective): a void of an issued fiscal document must surface in the
  //    voided-fiscal-document EXCEPTION REPORT for independent periodic review. ──
  const vd = await inj('PATCH', `/api/tax-invoices/${fullAr.json.doc_no}/void`, sales1, { reason: 'ออกผิดฉบับ' });
  ok('G16: void an issued full tax invoice → Voided', vd.json.status === 'Voided', JSON.stringify(vd.json).slice(0, 60));
  const vExc = await inj('GET', '/api/tax-invoices/exceptions/voided', t1mgr);
  ok('G16: voided-fiscal-document exception report lists the voided invoice + reason', vExc.status === 200 && (vExc.json.voided ?? []).some((r: any) => r.doc_no === fullAr.json.doc_no && r.void_reason === 'ออกผิดฉบับ') && vExc.json.count >= 1, JSON.stringify({ c: vExc.json.count }));

  // ── docs/34: receipt-style "ชำระเงินโดย" (Paid By) + due date (migration 0268, presentation/data-adjacent).
  //    Issued LAST so its output VAT doesn't shift the earlier ภ.พ.30/output-VAT aggregate assertions above. ──
  await db.insert(s.arInvoices).values({ invoiceNo: 'INV-AR2', invoiceDate: periodDate('21'), tenantId: t1, orderNo: 'SO-2', amount: '107', status: 'Unpaid', currency: 'THB' });
  const fullArPaid = await inj('POST', '/api/tax-invoices/full', sales1, { source_type: 'AR', source_ref: 'INV-AR2', buyer: { name: 'ผู้ซื้อ AR2', tax_id: T2_TAX, address: 'ที่อยู่ AR2' }, due_date: periodDate('28'), payment: { paid_by: 'transfer', bank: 'กสิกรไทย', branch: 'สาขาสีลม' } });
  ok('Full/AR explicit payment + due_date persist', fullArPaid.json.due_date === periodDate('28') && fullArPaid.json.payment?.paid_by === 'transfer' && fullArPaid.json.payment?.bank === 'กสิกรไทย', JSON.stringify({ due: fullArPaid.json.due_date, pay: fullArPaid.json.payment }));
  const fullArPdf = await inj('GET', `/api/tax-invoices/${fullArPaid.json.doc_no}/pdf`, sales1);
  const fullArPdfHtml = typeof fullArPdf.text === 'string' ? fullArPdf.text : '';
  ok('PDF full: "ชำระเงินโดย" section ticks Transfer + shows the bank + due date', fullArPdf.status === 200 && fullArPdfHtml.includes('ชำระเงินโดย') && fullArPdfHtml.includes('☑') && fullArPdfHtml.includes('กสิกรไทย') && fullArPdfHtml.includes('วันครบกำหนดชำระเงิน'), `len=${fullArPdfHtml.length}`);

  // ── docs/34: issuing a full tax invoice keeps customer_master reusable (0269) — a new buyer is upserted
  //    with address/branch/tax-id; re-issuing for the SAME buyer name refreshes it (no duplicate). ──
  const custName = 'บริษัท ทดสอบมาสเตอร์ จำกัด';
  await db.insert(s.arInvoices).values({ invoiceNo: 'INV-AR3', invoiceDate: periodDate('21'), tenantId: t1, orderNo: 'SO-3', amount: '107', status: 'Unpaid', currency: 'THB' });
  const cm1 = await inj('POST', '/api/tax-invoices/full', sales1, { source_type: 'AR', source_ref: 'INV-AR3', buyer: { name: custName, tax_id: T2_TAX, branch_code: '00000', address: 'ที่อยู่เดิม กรุงเทพฯ' } });
  ok('Full: issuing for a new buyer succeeds', cm1.status === 201, `${cm1.status}`);
  const cmSearch1 = await inj('GET', `/api/customer-master?search=${encodeURIComponent(custName)}`, sales1);
  const cmRow1 = (cmSearch1.json.customers ?? [])[0];
  ok('customer_master: new buyer upserted with tax_id/branch/address', cmSearch1.status === 200 && cmSearch1.json.count === 1 && cmRow1?.tax_id === T2_TAX && cmRow1?.branch_code === '00000' && cmRow1?.address === 'ที่อยู่เดิม กรุงเทพฯ', JSON.stringify(cmRow1));
  await db.insert(s.arInvoices).values({ invoiceNo: 'INV-AR4', invoiceDate: periodDate('21'), tenantId: t1, orderNo: 'SO-4', amount: '107', status: 'Unpaid', currency: 'THB' });
  await inj('POST', '/api/tax-invoices/full', sales1, { source_type: 'AR', source_ref: 'INV-AR4', buyer: { name: custName, tax_id: T2_TAX, address: 'ที่อยู่ใหม่ (ย้ายสำนักงาน) กรุงเทพฯ' } });
  const cmSearch2 = await inj('GET', `/api/customer-master?search=${encodeURIComponent(custName)}`, sales1);
  const cmRow2 = (cmSearch2.json.customers ?? [])[0];
  ok('customer_master: re-issuing for the same buyer REFRESHES the address, no duplicate row', cmSearch2.status === 200 && cmSearch2.json.count === 1 && cmRow2?.address === 'ที่อยู่ใหม่ (ย้ายสำนักงาน) กรุงเทพฯ', JSON.stringify({ count: cmSearch2.json.count, address: cmRow2?.address }));

  await app.close();
  await pg.close();

  console.log('\n── Phase 10 Thai tax documents (ใบกำกับภาษีเต็ม/ย่อ · 50 ทวิ) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} tax-doc checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} tax-doc checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
