/**
 * GRC-3 — Sensitive master-data single-record maker-checker (control MDM-01) over PGlite.
 * Editing a SENSITIVE vendor field (bank account / bank name / bank account name / credit limit / payment
 * terms) does NOT write the master directly — it stages a `pending` masterdata_change_requests row; the
 * master is applied ONLY when a DISTINCT user approves it (requester ≠ approver → 403 SOD_SELF_APPROVAL).
 * Reject discards it (master untouched). A non-sensitive field still edits directly. RLS isolates the queue.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover masterdata-change
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mdc-secret';
process.env.NODE_ENV = 'test';
// multi-company so per-tenant Admins are RLS-scoped to their own tenant (single-company grants a global
// Admin bypass) — lets the RLS-isolation checks below prove a T1 Admin can't see/act on HQ change requests.
process.env.TENANCY_MODE = 'multi-company';

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
  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'T1' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'maker', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },     // master-data maker (requester)
    { username: 'checker', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },    // DISTINCT approver (MDM-01)
    { username: 't1admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 },    // other tenant (RLS)
  ]).onConflictDoNothing();

  // Seed a supplier in HQ with existing sensitive fields.
  const [vendor] = await db.insert(s.vendors).values({
    tenantId: hq, vendorCode: 'V-ACME', name: 'Acme Parts', isSupplier: true,
    bankName: 'Kasikornbank', bankAccount: '111-2-33333-1', bankAccountName: 'Acme Parts Co', creditLimit: '50000.00', paymentTerms: 'Net 30', category: 'Supplier',
  }).returning();
  const vid = Number(vendor.id);
  const vfield = async (col: 'bankAccountName' | 'bankAccount' | 'bankName' | 'creditLimit' | 'paymentTerms' | 'category') =>
    (await db.select().from(s.vendors).where(eq(s.vendors.id, vid)))[0][col];

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /**/ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [maker, checker, t1admin] = [await login('maker', 'admin123'), await login('checker', 'admin123'), await login('t1admin', 'admin123')];

  // ── 1. Editing a sensitive bank field stages a pending request — master is NOT written ──
  const stage1 = await inj('POST', '/api/masterdata/change-requests', maker, { entity_type: 'vendor', entity_id: vid, field: 'bank_account_name', new_value: 'FRAUDSTER LTD', reason: 'Vendor updated payee name' });
  ok('Stage vendor bank_account_name → pending', stage1.status === 201 && stage1.json.status === 'pending' && !!stage1.json.req_no, JSON.stringify(stage1.json));
  ok('Master UNCHANGED while pending (bank_account_name still "Acme Parts Co")', (await vfield('bankAccountName')) === 'Acme Parts Co', String(await vfield('bankAccountName')));

  // ── 2. The requester cannot approve their own change (maker-checker) ──
  const selfApprove = await inj('POST', `/api/masterdata/change-requests/${stage1.json.req_no}/approve`, maker);
  ok('Self-approve → 403 SOD_SELF_APPROVAL', selfApprove.status === 403 && selfApprove.json.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify(selfApprove.json));
  ok('Master STILL unchanged after blocked self-approval', (await vfield('bankAccountName')) === 'Acme Parts Co', String(await vfield('bankAccountName')));

  // ── 3. A DISTINCT user approves → the master is applied ──
  const approve1 = await inj('POST', `/api/masterdata/change-requests/${stage1.json.req_no}/approve`, checker);
  ok('Distinct approver → approved', approve1.status === 201 && approve1.json.status === 'approved' && approve1.json.approved_by === 'checker', JSON.stringify(approve1.json));
  ok('Master UPDATED on approval (bank_account_name → "FRAUDSTER LTD")', (await vfield('bankAccountName')) === 'FRAUDSTER LTD', String(await vfield('bankAccountName')));

  // ── 4. Encrypted bank account no. round-trips through the maker-checker ──
  const stageAcct = await inj('POST', '/api/masterdata/change-requests', maker, { entity_type: 'vendor', entity_id: vid, field: 'bank_account', new_value: '999-9-99999-9' });
  await inj('POST', `/api/masterdata/change-requests/${stageAcct.json.req_no}/approve`, checker);
  ok('Encrypted bank_account applied + decrypts back to plaintext', (await vfield('bankAccount')) === '999-9-99999-9', String(await vfield('bankAccount')));

  // ── 5. Reject discards the change — master untouched ──
  const stage2 = await inj('POST', '/api/masterdata/change-requests', maker, { entity_type: 'vendor', entity_id: vid, field: 'credit_limit', new_value: '999999' });
  ok('Stage credit_limit → pending', stage2.status === 201 && stage2.json.status === 'pending', JSON.stringify(stage2.json));
  const reject = await inj('POST', `/api/masterdata/change-requests/${stage2.json.req_no}/reject`, checker, { reason: 'Not authorised' });
  ok('Distinct reviewer rejects → rejected', reject.status === 201 && reject.json.status === 'rejected', JSON.stringify(reject.json));
  ok('Master UNCHANGED after reject (credit_limit still 50000.00)', String(await vfield('creditLimit')) === '50000.00', String(await vfield('creditLimit')));

  // ── 6. payment_terms is now maker-checked (moved off the direct profile edit) ──
  const stageTerms = await inj('POST', '/api/masterdata/change-requests', maker, { entity_type: 'vendor', entity_id: vid, field: 'payment_terms', new_value: 'Net 90' });
  await inj('POST', `/api/masterdata/change-requests/${stageTerms.json.req_no}/approve`, checker);
  ok('payment_terms applied only via maker-checker → Net 90', (await vfield('paymentTerms')) === 'Net 90', String(await vfield('paymentTerms')));

  // ── 7. A NON-sensitive field still edits DIRECTLY (unchanged) ──
  const direct = await inj('PATCH', `/api/procurement/vendors/${vid}/profile`, maker, { category: 'Strategic' });
  ok('Non-sensitive field (category) edits directly → applied immediately', direct.status === 200 && (await vfield('category')) === 'Strategic', String(await vfield('category')));

  // ── 8. The generic endpoint refuses a non-sensitive field (points back to the direct path) ──
  const notSensitive = await inj('POST', '/api/masterdata/change-requests', maker, { entity_type: 'vendor', entity_id: vid, field: 'category', new_value: 'X' });
  ok('Non-sensitive field via change-requests → 400 FIELD_NOT_SENSITIVE', notSensitive.status === 400 && notSensitive.json.error?.code === 'FIELD_NOT_SENSITIVE', JSON.stringify(notSensitive.json));

  // ── 9. Staging the current value is a no-op guard ──
  const noChange = await inj('POST', '/api/masterdata/change-requests', maker, { entity_type: 'vendor', entity_id: vid, field: 'payment_terms', new_value: 'Net 90' });
  ok('No-op change → 400 NO_CHANGE', noChange.status === 400 && noChange.json.error?.code === 'NO_CHANGE', JSON.stringify(noChange.json));

  // ── 10. RLS isolation — T1 sees none of HQ's change requests and cannot approve one ──
  const stageRls = await inj('POST', '/api/masterdata/change-requests', maker, { entity_type: 'vendor', entity_id: vid, field: 'bank_name', new_value: 'Siam Commercial Bank' });
  const t1List = await inj('GET', '/api/masterdata/change-requests', t1admin);
  ok('RLS: T1 sees 0 of HQ change requests', t1List.status === 200 && t1List.json.count === 0, JSON.stringify({ count: t1List.json.count }));
  const t1Approve = await inj('POST', `/api/masterdata/change-requests/${stageRls.json.req_no}/approve`, t1admin);
  ok('RLS: T1 cannot approve an HQ request → 404 NOT_PENDING', t1Approve.status === 404 && t1Approve.json.error?.code === 'NOT_PENDING', JSON.stringify(t1Approve.json));
  ok('HQ reviewer still sees the pending request', (await inj('GET', '/api/masterdata/change-requests', checker)).json.count >= 1);

  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => {
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.filter((c) => !c.ok).length;
  console.log(`\n${'─'.repeat(60)}`);
  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(`${'─'.repeat(60)}\n${pass}/${checks.length} passed${fail ? ` (${fail} failed)` : ' 🎉'}`);
  if (fail) process.exit(1);
});
