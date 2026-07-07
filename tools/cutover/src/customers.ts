/**
 * Review W6 — coverage for the customer-360 endpoint (GET /api/customers/:name) and the analytics HTTP
 * layer (replenishment / dashboard-summary) through the real guard stack (auth + @Permissions + RLS).
 * These were previously untested at the HTTP layer.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover customers
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'customers-secret';
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

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: hq },
    { username: 'crmT2', passwordHash: await pw.hash('pw'), role: 'MasterDataAdmin', tenantId: t2 }, // + crm grant → RLS test
    { username: 'noperm', passwordHash: await pw.hash('pw'), role: 'MasterDataAdmin', tenantId: t1 }, // no crm/dashboard/ar
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  for (const p of ['crm', 'dashboard', 'ar']) await db.insert(s.userPermissions).values({ userId: await uid('crmT2'), perm: p }).onConflictDoNothing();

  // T1 sales: 2 Completed (100 + 200) + 1 Voided (excluded from stats); one unpaid AR invoice (outstanding 150)
  await db.insert(s.custPosSales).values([
    { saleNo: 'SALE-C1', saleDate: '2026-06-01', tenantId: t1, status: 'Completed', total: '100' },
    { saleNo: 'SALE-C2', saleDate: '2026-06-02', tenantId: t1, status: 'Completed', total: '200' },
    { saleNo: 'SALE-C3', saleDate: '2026-06-03', tenantId: t1, status: 'Voided', total: '999' },
  ]);
  await db.insert(s.arInvoices).values({ invoiceNo: 'INV-C1', tenantId: t1, amount: '150', paidAmount: '0', status: 'Unpaid' }).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw' })).json.token as string;
  const [admin, crmT2, noperm] = [await login('admin'), await login('crmT2'), await login('noperm')];

  // ── customer-360 ──
  const c = await inj('GET', '/api/customers/T1', admin);
  ok('Customer 360: stats exclude Voided (count 2, lifetime 300)', c.status === 200 && c.json.stats?.order_count === 2 && near(c.json.stats?.lifetime_value, 300), JSON.stringify(c.json.stats));
  ok('Customer 360: AR balance (outstanding 150, 1 open invoice)', near(c.json.ar_balance?.outstanding, 150) && c.json.ar_balance?.open_invoices === 1, JSON.stringify(c.json.ar_balance));
  ok('Customer 360: recent orders listed (2 non-… all statuses incl Voided)', Array.isArray(c.json.orders) && c.json.orders.length === 3, `orders=${c.json.orders?.length}`);

  // ── permission gate: a user without crm/dashboard/ar is denied ──
  const denied = await inj('GET', '/api/customers/T1', noperm);
  ok('Customer 360 permission gate → 403 without crm/dashboard/ar', denied.status === 403, `status=${denied.status}`);

  // ── RLS: a T2 user resolving T1's code sees NONE of T1's data (count 0) ──
  const cross = await inj('GET', '/api/customers/T1', crmT2);
  ok('Customer 360 RLS: T2 user gets 0 of T1 sales/AR', cross.status === 200 && cross.json.stats?.order_count === 0 && near(cross.json.ar_balance?.outstanding, 0), JSON.stringify({ n: cross.json.stats?.order_count, ar: cross.json.ar_balance?.outstanding }));

  // ── analytics HTTP layer through the guard stack ──
  const repl = await inj('GET', '/api/analytics/replenishment', admin);
  ok('Analytics replenishment → 200 through guard stack', repl.status === 200, `status=${repl.status}`);
  const dash = await inj('GET', '/api/analytics/dashboard-summary', admin);
  ok('Analytics dashboard-summary → 200', dash.status === 200, `status=${dash.status}`);
  const anom = await inj('GET', '/api/analytics/anomalies?days=abc', admin);
  ok('Analytics anomalies with bad days → 400 BAD_QUERY (qint)', anom.status === 400 && anom.json.error?.code === 'BAD_QUERY', `${anom.status} ${anom.json.error?.code}`);
  const aDenied = await inj('GET', '/api/analytics/replenishment', noperm);
  ok('Analytics permission gate → 403 without planner/dashboard/warehouse', aDenied.status === 403, `status=${aDenied.status}`);

  // ── customer_master CRUD (master-data audit Phase 3) — create/read/update with the new fields
  // (credit_terms/sales_rep/category/language/external_ref); previously only create + link + the
  // invoice-issuance auto-upsert existed, with no way to correct/enrich a record through any endpoint. ──
  const cmCreate = await inj('POST', '/api/customer-master', admin, {
    name: 'บริษัท ทดสอบ จำกัด', kind: 'company', email: 'test@example.com', phone: '02-000-1111',
    credit_terms: 'Net 30', sales_rep: 'สมชาย', category: 'Wholesale', language: 'en', external_ref: 'EXT-001',
  });
  ok('Customer master: create with Phase-3 fields (credit_terms/sales_rep/category/language/external_ref)', cmCreate.status === 200 || cmCreate.status === 201, `${cmCreate.status} ${JSON.stringify(cmCreate.json).slice(0, 100)}`);
  const cmNo = cmCreate.json.customer_no as string;
  const cmGet1 = await inj('GET', `/api/customer-master/${cmNo}`, admin);
  ok('Customer master: GET projects the new fields', cmGet1.json.credit_terms === 'Net 30' && cmGet1.json.sales_rep === 'สมชาย' && cmGet1.json.category === 'Wholesale' && cmGet1.json.language === 'en' && cmGet1.json.external_ref === 'EXT-001', JSON.stringify(cmGet1.json).slice(0, 200));
  const cmUpdate = await inj('PATCH', `/api/customer-master/${cmNo}`, admin, { credit_terms: 'Net 60', category: 'Key Account', status: 'inactive' });
  ok('Customer master: direct-edit update (no maker-checker — no payment-redirection risk)', cmUpdate.status === 200 && cmUpdate.json.credit_terms === 'Net 60' && cmUpdate.json.category === 'Key Account' && cmUpdate.json.status === 'inactive', JSON.stringify(cmUpdate.json).slice(0, 150));
  const cmEmpty = await inj('PATCH', `/api/customer-master/${cmNo}`, admin, {});
  ok('Customer master: PATCH with no fields → 400 NO_FIELDS', cmEmpty.status === 400 && cmEmpty.json.error?.code === 'NO_FIELDS', `${cmEmpty.status} ${cmEmpty.json.error?.code}`);
  const cmList = await inj('GET', '/api/customer-master?search=ทดสอบ', admin);
  ok('Customer master: list search finds the created customer with updated fields', (cmList.json.customers ?? []).some((c: any) => c.customer_no === cmNo && c.category === 'Key Account'), `n=${cmList.json.count}`);

  // ── Party-model depth (master-data audit Phase 4) — multi-address / multi-contact / parent company.
  // customer_master previously carried exactly one scalar address and no contact rows at all. ──
  const cmParentCreate = await inj('POST', '/api/customer-master', admin, { name: 'บริษัท แม่ จำกัด', kind: 'company' });
  const cmParentNo = cmParentCreate.json.customer_no as string;

  const addr1 = await inj('POST', `/api/customer-master/${cmNo}/addresses`, admin, { address_type: 'billing', address_line1: '99 ถนนสุขุมวิท', district: 'วัฒนา', province: 'กรุงเทพฯ', postal_code: '10110', is_primary: true });
  ok('Customer address: add billing address as primary', addr1.status === 201 || addr1.status === 200, `${addr1.status} ${JSON.stringify(addr1.json).slice(0, 150)}`);
  const addr2 = await inj('POST', `/api/customer-master/${cmNo}/addresses`, admin, { address_type: 'shipping', address_line1: '100 ถนนพระราม 4', is_primary: true });
  ok('Customer address: add second (shipping) address as primary', addr2.status === 201 || addr2.status === 200, `${addr2.status}`);
  const addrList = await inj('GET', `/api/customer-master/${cmNo}/addresses`, admin);
  ok('Customer address: list returns both, only the newest primary', addrList.json.addresses?.length === 2 && addrList.json.addresses.filter((a: any) => a.is_primary).length === 1 && addrList.json.addresses.find((a: any) => a.is_primary)?.address_type === 'shipping', JSON.stringify(addrList.json.addresses));
  const addrDel = await inj('DELETE', `/api/customer-master/${cmNo}/addresses/${addr1.json.id}`, admin);
  ok('Customer address: delete the non-primary address', addrDel.status === 200 && addrDel.json.deleted === true, `${addrDel.status}`);
  const addrDelMissing = await inj('DELETE', `/api/customer-master/${cmNo}/addresses/999999`, admin);
  ok('Customer address: delete non-existent → 404 ADDRESS_NOT_FOUND', addrDelMissing.status === 404 && addrDelMissing.json.error?.code === 'ADDRESS_NOT_FOUND', `${addrDelMissing.status} ${addrDelMissing.json.error?.code}`);

  const contact1 = await inj('POST', `/api/customer-master/${cmNo}/contacts`, admin, { name: 'คุณสมหญิง', title: 'ผู้จัดการฝ่ายจัดซื้อ', phone: '081-000-0000', is_primary: true });
  ok('Customer contact: add primary contact', contact1.status === 201 || contact1.status === 200, `${contact1.status} ${JSON.stringify(contact1.json).slice(0, 150)}`);
  const contactList = await inj('GET', `/api/customer-master/${cmNo}/contacts`, admin);
  ok('Customer contact: list returns the added contact', contactList.json.contacts?.length === 1 && contactList.json.contacts[0].name === 'คุณสมหญิง', JSON.stringify(contactList.json.contacts));
  const contactDelMissing = await inj('DELETE', `/api/customer-master/${cmNo}/contacts/999999`, admin);
  ok('Customer contact: delete non-existent → 404 CONTACT_NOT_FOUND', contactDelMissing.status === 404 && contactDelMissing.json.error?.code === 'CONTACT_NOT_FOUND', `${contactDelMissing.status} ${contactDelMissing.json.error?.code}`);

  const parentSelf = await inj('PATCH', `/api/customer-master/${cmNo}/parent`, admin, { parent_customer_no: cmNo });
  ok('Customer parent: cannot be its own parent → 400 SELF_PARENT', parentSelf.status === 400 && parentSelf.json.error?.code === 'SELF_PARENT', `${parentSelf.status} ${parentSelf.json.error?.code}`);
  const parentSet = await inj('PATCH', `/api/customer-master/${cmNo}/parent`, admin, { parent_customer_no: cmParentNo });
  ok('Customer parent: link to parent company', parentSet.status === 200 && parentSet.json.parent_customer_no === cmParentNo, JSON.stringify(parentSet.json).slice(0, 150));
  const view360 = await inj('GET', `/api/customer-master/${cmNo}/360`, admin);
  ok('Customer 360: surfaces addresses/contacts/parent together', view360.json.addresses?.length === 1 && view360.json.contacts?.length === 1 && view360.json.parent?.customer_no === cmParentNo, JSON.stringify({ addr: view360.json.addresses?.length, contacts: view360.json.contacts?.length, parent: view360.json.parent }));

  // ── Match-merge / DQM (master-data audit Phase 5) — detect + merge duplicate customers. ──
  const survA = await inj('POST', '/api/customer-master', admin, { name: 'บริษัท สมาร์ทโซลูชั่น จำกัด', kind: 'company', phone: '02-555-1234' });
  const survANo = survA.json.customer_no as string;
  const dupB = await inj('POST', '/api/customer-master', admin, { name: 'สมาร์ทโซลูชั่น', kind: 'company', phone: '02-555-1234', email: 'contact@smart.co.th' });
  const dupBNo = dupB.json.customer_no as string;
  await inj('POST', `/api/customer-master/${dupBNo}/addresses`, admin, { address_type: 'billing', address_line1: '1 อาคารสมาร์ท', is_primary: true });
  await inj('POST', `/api/customer-master/${dupBNo}/contacts`, admin, { name: 'คุณเอ', phone: '081-111-2222', is_primary: true });

  const dupScan = await inj('GET', '/api/customer-master/duplicates', admin);
  const ids = (g: any) => [g.primary.customer_no, ...g.duplicates.map((d: any) => d.customer_no)];
  const grp = (dupScan.json.groups ?? []).find((g: any) => ids(g).includes(survANo) && ids(g).includes(dupBNo));
  ok('Customer dedup: detects the near-duplicate pair (shared phone + similar name)', !!grp && grp.duplicates.some((d: any) => d.reasons.includes('phone') && d.reasons.includes('name')), JSON.stringify(grp?.duplicates?.map((d: any) => ({ no: d.customer_no, reasons: d.reasons, score: d.score }))));

  const selfMerge = await inj('POST', `/api/customer-master/${survANo}/merge`, admin, { duplicate_customer_no: survANo });
  ok('Customer merge: cannot merge into itself → 400 SELF_MERGE', selfMerge.status === 400 && selfMerge.json.error?.code === 'SELF_MERGE', `${selfMerge.status} ${selfMerge.json.error?.code}`);
  const merge = await inj('POST', `/api/customer-master/${survANo}/merge`, admin, { duplicate_customer_no: dupBNo });
  ok('Customer merge: merges duplicate into survivor', (merge.status === 200 || merge.status === 201) && merge.json.merged === true, `${merge.status} ${JSON.stringify(merge.json).slice(0, 120)}`);
  const dupAfter = await inj('GET', `/api/customer-master/${dupBNo}`, admin);
  ok('Customer merge: duplicate soft-retired (status=merged, merged_into set, record preserved)', dupAfter.json.status === 'merged' && dupAfter.json.merged_into != null, JSON.stringify({ st: dupAfter.json.status, into: dupAfter.json.merged_into }));
  const survAddrs = await inj('GET', `/api/customer-master/${survANo}/addresses`, admin);
  const survContacts = await inj('GET', `/api/customer-master/${survANo}/contacts`, admin);
  ok('Customer merge: duplicate child rows repointed onto the survivor (address + contact)', (survAddrs.json.addresses?.length ?? 0) >= 1 && (survContacts.json.contacts?.length ?? 0) >= 1, JSON.stringify({ addr: survAddrs.json.addresses?.length, contacts: survContacts.json.contacts?.length }));
  const survAfter = await inj('GET', `/api/customer-master/${survANo}`, admin);
  ok('Customer merge: survivorship fills the survivor email from the duplicate', survAfter.json.email === 'contact@smart.co.th', `email=${survAfter.json.email}`);
  const reMerge = await inj('POST', `/api/customer-master/${survANo}/merge`, admin, { duplicate_customer_no: dupBNo });
  ok('Customer merge: re-merging an already-merged duplicate → 400 ALREADY_MERGED', reMerge.status === 400 && reMerge.json.error?.code === 'ALREADY_MERGED', `${reMerge.status} ${reMerge.json.error?.code}`);
  const dupScan2 = await inj('GET', '/api/customer-master/duplicates', admin);
  ok('Customer dedup: the merged duplicate no longer appears in the scan', !(dupScan2.json.groups ?? []).some((g: any) => ids(g).includes(dupBNo)), `groups=${dupScan2.json.count}`);

  await app.close();
  await pg.close();

  console.log('\n── Review W6 — customers-360 + analytics HTTP coverage ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} customers checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} customers checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
