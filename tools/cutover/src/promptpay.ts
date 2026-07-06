/**
 * C2 — PromptPay end-to-end. Set tenant merchant id → real scannable EMVCo QR via the QR endpoint
 * and the payment tender. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover promptpay
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pp-secret';
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
import { crc16ccitt } from '../../../apps/api/dist/modules/payments/promptpay-qr';
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
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    // G15: a distinct approver for the PromptPay/Tax-ID maker-checker (payment-target integrity).
    { username: 'approver', passwordHash: await pw.hash('appr123'), role: 'Admin', tenantId: hq },
  ]).onConflictDoNothing();

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
  const admin = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;
  const approver = (await inj('POST', '/api/login', undefined, { username: 'approver', password: 'appr123' })).json.token;
  // G15: set the PromptPay id under maker-checker — admin stages, a DISTINCT approver releases it.
  const setPromptPay = async (id: string) => {
    const r = await inj('PATCH', '/api/tenant/profile', admin, { promptpay_id: id });
    if (r.json?.pending_change?.req_no) await inj('POST', `/api/tenant/profile-approvals/${r.json.pending_change.req_no}/approve`, approver);
    return r;
  };

  // ── 1. before configuring: QR endpoint refuses ──
  const noPp = await inj('GET', '/api/payments/promptpay-qr?amount=100', admin);
  ok('QR refused before PromptPay id set (400 NO_PROMPTPAY)', noPp.status === 400 && noPp.json.error?.code === 'NO_PROMPTPAY', JSON.stringify({ s: noPp.status, c: noPp.json.error?.code }));

  // ── 2. invalid id rejected ──
  const bad = await inj('PATCH', '/api/tenant/profile', admin, { promptpay_id: 'not-a-number' });
  ok('Invalid PromptPay id rejected (400)', bad.status === 400, `status=${bad.status}`);

  // ── 3. set a valid mobile id (G15 maker-checker: staged, then a distinct approver releases it) ──
  // 3a. admin stages the change — it is NOT applied and the QR still refuses until a checker approves.
  const staged = await inj('PATCH', '/api/tenant/profile', admin, { promptpay_id: '0812345678' });
  ok('G15: PromptPay change staged PendingApproval (not applied yet)', staged.status < 300 && staged.json.promptpay_id == null && staged.json.pending_change?.fields?.includes('promptpay_id'), JSON.stringify({ pp: staged.json.promptpay_id, pc: staged.json.pending_change }));
  const stillNo = await inj('GET', '/api/payments/promptpay-qr?amount=100', admin);
  ok('G15: QR still refused while the change is pending', stillNo.status === 400 && stillNo.json.error?.code === 'NO_PROMPTPAY', `${stillNo.status} ${stillNo.json.error?.code}`);
  // 3b. requester cannot self-approve → 403 SOD_VIOLATION.
  const selfAppr = await inj('POST', `/api/tenant/profile-approvals/${staged.json.pending_change.req_no}/approve`, admin);
  ok('G15: requester cannot self-approve their own PromptPay change → 403 SOD_VIOLATION', selfAppr.status === 403 && selfAppr.json.error?.code === 'SOD_VIOLATION', `${selfAppr.status} ${selfAppr.json.error?.code}`);
  // 3c. a DISTINCT approver releases it → applied.
  const appr = await inj('POST', `/api/tenant/profile-approvals/${staged.json.pending_change.req_no}/approve`, approver);
  const set = await inj('GET', '/api/tenant/profile', admin);
  ok('G15: distinct approver applies PromptPay id → set on tenant profile', appr.status === 200 && appr.json.approved_by === 'approver' && set.json.promptpay_id === '0812345678', JSON.stringify({ s: appr.status, pp: set.json.promptpay_id }));

  // ── 4. QR endpoint returns a real, well-formed, CRC-valid EMVCo payload ──
  const qr = await inj('GET', '/api/payments/promptpay-qr?amount=125.5', admin);
  const p = qr.json.qr_payload ?? '';
  ok('QR payload: EMVCo header + mobile-formatted id + amount 125.50 + valid CRC',
    p.startsWith('000201') && p.includes('0066812345678') && p.includes('5406125.50') && p.slice(-4) === crc16ccitt(p.slice(0, -4)),
    JSON.stringify({ head: p.slice(0, 6), crcOk: p.slice(-4) === crc16ccitt(p.slice(0, -4)) }));

  // ── 5. tender via PromptPay gateway returns the real QR + Pending (async settlement) ──
  const pay = await inj('POST', '/api/payments', admin, { sale_no: 'SALE-PP-1', method: 'PromptPay', gateway: 'promptpay', amount: 200, tenant_id: hq });
  ok('Tender returns qr_payload (real QR) + Pending status',
    pay.status < 300 && pay.json.status === 'Pending' && (pay.json.qr_payload ?? '').includes('5406200.00') && !(pay.json.qr_payload ?? '').startsWith('promptpay_'),
    JSON.stringify({ s: pay.json.status, hasQr: !!pay.json.qr_payload }));

  // ── 6. national-id (13-digit) target also formats (staged → distinct approver releases) ──
  await setPromptPay('1234567890123');
  const qr2 = await inj('GET', '/api/payments/promptpay-qr?amount=10', admin);
  const p2 = qr2.json.qr_payload ?? '';
  ok('13-digit national-id target → QR contains it + valid CRC',
    p2.includes('02131234567890123') && p2.slice(-4) === crc16ccitt(p2.slice(0, -4)), JSON.stringify({ ok: p2.includes('02131234567890123') }));

  console.log('\n── C2 — PromptPay end-to-end (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} promptpay checks failed` : `\n✅ All ${checks.length} promptpay checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
