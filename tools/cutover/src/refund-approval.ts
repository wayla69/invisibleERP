/**
 * Payments — Refund maker-checker (อนุมัติคืนเงิน) over PGlite (REV-16):
 * a standalone refund >= the threshold parks as a request (no money moves) until a DIFFERENT user
 * approves; small refunds run immediately; a goods-return refund is never gated.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover refund-approval
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'refund-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'cash1', passwordHash: await pw.hash('pw1'), role: 'PosSupervisor', tenantId: t1 },  // pos_refund
    { username: 'mgr1', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t1 },            // pos/order_mgt/exec
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
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const cash1 = await login('cash1', 'pw1');
  const mgr1 = await login('mgr1', 'pw2');
  const admin = await login('admin', 'admin123');
  const cnt = async (sql: string) => Number(((await pg.query(sql)).rows as any[])[0].n);
  // capture payments with mgr1 (Sales → has pos_sell); cash1 (PosSupervisor) requests refunds; mgr1 approves.
  const pay = async (amt: number) => (await inj('POST', '/api/payments', mgr1, { sale_no: `S-${amt}-${Math.random()}`, method: 'Cash', amount: amt })).json.payment_no as string;
  const small = await pay(500);
  const large = await pay(2000);

  // ── 1. small refund (< 1000) runs immediately ──
  const r1 = await inj('POST', '/api/payments/refunds', cash1, { payment_no: small, amount: 500, reason: 'ลูกค้าคืน' });
  ok('Small refund (<1000) runs immediately (Refunded)', r1.json.status === 'Refunded' && /^REF-/.test(r1.json.refund_no ?? ''), JSON.stringify(r1.json).slice(0, 80));

  // ── 2. large refund (>= 1000) parks as a request — no money moves ──
  const r2 = await inj('POST', '/api/payments/refunds', cash1, { payment_no: large, amount: 2000, reason: 'ยกเลิกบิล' });
  const reqId = r2.json.request_id;
  const refundsAfterReq = await cnt(`SELECT count(*)::int n FROM payment_refunds WHERE payment_no='${large}'`);
  ok('Large refund (>=1000) parks PendingApproval, no payment_refunds row yet', r2.json.status === 'PendingApproval' && typeof reqId === 'number' && refundsAfterReq === 0, JSON.stringify(r2.json).slice(0, 90));

  // ── 3. it surfaces in the GOV-01 pending-approvals monitor ──
  const mon = await inj('GET', '/api/finance/approvals/pending', admin);
  ok('Refund request appears in GOV-01 monitor (type refund, REV-16)', (mon.json.items ?? []).some((i: any) => i.type === 'refund' && i.control === 'REV-16' && near(i.amount, 2000)), `count=${mon.json.count}`);

  // ── 4. SoD: the requester cannot approve their own refund ──
  const selfAppr = await inj('POST', `/api/payments/refund-requests/${reqId}/approve`, cash1);
  ok('SoD: requester cannot approve own refund (403 SOD_VIOLATION)', selfAppr.status === 403 && selfAppr.json.error?.code === 'SOD_VIOLATION', `${selfAppr.status} ${selfAppr.json.error?.code}`);

  // ── 5. a DIFFERENT user approves → the real refund runs ──
  const appr = await inj('POST', `/api/payments/refund-requests/${reqId}/approve`, mgr1);
  const refundsAfterAppr = await cnt(`SELECT count(*)::int n FROM payment_refunds WHERE payment_no='${large}'`);
  ok('Manager approves → refund executed (REF- + 1 payment_refunds row)', appr.json.status === 'Approved' && /^REF-/.test(appr.json.refund_no ?? '') && refundsAfterAppr === 1, JSON.stringify(appr.json).slice(0, 90));

  // ── 6. re-approve rejected ──
  const reAppr = await inj('POST', `/api/payments/refund-requests/${reqId}/approve`, mgr1);
  ok('Re-approve rejected (NOT_PENDING)', reAppr.status === 400 && reAppr.json.error?.code === 'NOT_PENDING', `${reAppr.status} ${reAppr.json.error?.code}`);

  // ── 7. reject path: a new large refund, rejected by a different user, posts nothing ──
  const large2 = await pay(1500);
  const r7 = await inj('POST', '/api/payments/refunds', cash1, { payment_no: large2, amount: 1500 });
  const rej = await inj('POST', `/api/payments/refund-requests/${r7.json.request_id}/reject`, mgr1, { reason: 'ไม่อนุมัติ' });
  const refundsRejected = await cnt(`SELECT count(*)::int n FROM payment_refunds WHERE payment_no='${large2}'`);
  ok('Reject: refund voided, no money moved', rej.json.status === 'Rejected' && refundsRejected === 0, JSON.stringify(rej.json).slice(0, 70));

  // ── 8. list worklist ──
  const list = await inj('GET', '/api/payments/refund-requests', mgr1);
  ok('Refund-request worklist: 2 requests (1 Approved + 1 Rejected), 0 pending', list.json.count === 2 && list.json.pending === 0, JSON.stringify({ c: list.json.count, p: list.json.pending }));

  await app.close();
  await pg.close();
  console.log('\n── Payments Refund maker-checker (อนุมัติคืนเงิน) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} refund-approval checks failed` : `\n✅ All ${checks.length} refund-approval checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
