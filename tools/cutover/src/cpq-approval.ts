/**
 * SVC-1 — CPQ-01 discount-approval & margin-floor control. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover cpq-approval
 *
 * A quote whose effective discount% breaches max_discount_pct OR whose margin% falls below min_margin_pct
 * (per-tenant floor, cpq_settings) parks in PendingApproval on send and CANNOT be accepted until a DIFFERENT
 * authorised user approves it (author cannot self-approve → SOD_SELF_APPROVAL). Reject sends it back to Draft.
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cpq-approval-secret';
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
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
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

  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'T1' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },   // approver (cpq_approve via Admin)
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: hq },        // author (cpq)
    { username: 't1user', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: t1 },        // other-tenant, for RLS
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /**/ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [admin, sales1, t1user] = [await login('admin', 'admin123'), await login('sales1', 'pw1'), await login('t1user', 'pw1')];

  // Floor: default 20% margin / 15% discount. Read it, then tighten the discount ceiling to 5% for the test.
  const set0 = await inj('GET', '/api/cpq/settings', sales1);
  ok('Default floor = 20% margin / 15% discount', near(set0.json.min_margin_pct, 20) && near(set0.json.max_discount_pct, 15), JSON.stringify(set0.json));
  const setPut = await inj('PUT', '/api/cpq/settings', admin, { min_margin_pct: 20, max_discount_pct: 5 });
  ok('Update floor → max_discount 5%', setPut.status === 200 && near(setPut.json.max_discount_pct, 5), JSON.stringify(setPut.json));

  // ── 1. WITHIN floor: price 50000, cost 30000 → margin 40% ≥ 20, discount 0 ≤ 5 → sends normally ──
  const qOk = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'In-floor Buyer', lines: [{ description: 'Widget', qty: 1, unit_price: 50000, unit_cost: 30000 }] });
  ok('Create in-floor quote → margin 40%', qOk.status === 201 && near(qOk.json.margin_pct, 40), JSON.stringify({ m: qOk.json.margin_pct, d: qOk.json.discount_pct }));
  const sentOk = await inj('POST', `/api/cpq/quotes/${qOk.json.id}/send`, sales1);
  ok('In-floor quote sends normally → Sent (no approval)', sentOk.status === 200 && sentOk.json.status === 'Sent' && sentOk.json.requires_approval === false, JSON.stringify({ st: sentOk.json.status, ra: sentOk.json.requires_approval }));

  // ── 2. MARGIN breach: price 50000, cost 45000 → margin 10% < 20 → PendingApproval, accept blocked ──
  const qLow = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Thin-margin Buyer', lines: [{ description: 'Widget', qty: 1, unit_price: 50000, unit_cost: 45000 }] });
  ok('Create thin-margin quote → margin 10%', qLow.status === 201 && near(qLow.json.margin_pct, 10), JSON.stringify({ m: qLow.json.margin_pct }));
  const sentLow = await inj('POST', `/api/cpq/quotes/${qLow.json.id}/send`, sales1);
  ok('Margin-floor breach on send → PendingApproval + requires_approval', sentLow.status === 200 && sentLow.json.status === 'PendingApproval' && sentLow.json.requires_approval === true, JSON.stringify({ st: sentLow.json.status, ra: sentLow.json.requires_approval }));
  const acceptBlocked = await inj('POST', `/api/cpq/quotes/${qLow.json.id}/accept`, admin);
  ok('Un-approved quote cannot be accepted → 400 INVALID_TRANSITION', acceptBlocked.status === 400 && acceptBlocked.json.error?.code === 'INVALID_TRANSITION', JSON.stringify({ s: acceptBlocked.status, c: acceptBlocked.json.error?.code }));

  // ── 3. Self-approve blocked (author = sales1) ──
  const selfApprove = await inj('POST', `/api/cpq/quotes/${qLow.json.id}/approve`, sales1);
  ok('Author self-approve → 403 SOD_SELF_APPROVAL', selfApprove.status === 403 && selfApprove.json.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify({ s: selfApprove.status, c: selfApprove.json.error?.code }));

  // ── 4. Distinct approver approves → Sent → acceptable (revenue posts) ──
  const approve = await inj('POST', `/api/cpq/quotes/${qLow.json.id}/approve`, admin);
  ok('Distinct approver approves → Sent + approved_by', approve.status === 200 && approve.json.status === 'Sent' && approve.json.approved_by === 'admin', JSON.stringify({ st: approve.json.status, by: approve.json.approved_by }));
  const accepted = await inj('POST', `/api/cpq/quotes/${qLow.json.id}/accept`, admin);
  ok('Approved quote accepts → Accepted + AR posted 50000', accepted.status === 200 && accepted.json.status === 'Accepted' && near(accepted.json.ar_posted, 50000), JSON.stringify({ st: accepted.json.status, ar: accepted.json.ar_posted }));
  const apprList = await inj('GET', '/api/cpq/approvals?status=approved', admin);
  ok('Approval audit row recorded (approved)', apprList.json.approvals?.length === 1 && apprList.json.approvals[0].approved_by === 'admin', JSON.stringify({ n: apprList.json.approvals?.length }));

  // ── 5. DISCOUNT breach + REJECT → back to Draft ──
  const cfg = await inj('POST', '/api/cpq/configs', admin, { code: 'LAPTOP', name: 'Laptop', base_price: 50000 });
  await inj('POST', `/api/cpq/configs/${cfg.json.id}/rules`, admin, { name: 'Vol 2+', rule_type: 'volume', discount_pct: 10, min_qty: 2 });
  const qDisc = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Over-discount Buyer', config_id: cfg.json.id, qty: 2, unit_cost: 10000 });
  ok('Create 10%-discount quote → discount_pct 10 (> 5 ceiling)', qDisc.status === 201 && near(qDisc.json.discount_pct, 10), JSON.stringify({ d: qDisc.json.discount_pct }));
  const sentDisc = await inj('POST', `/api/cpq/quotes/${qDisc.json.id}/send`, sales1);
  ok('Discount-ceiling breach on send → PendingApproval', sentDisc.status === 200 && sentDisc.json.status === 'PendingApproval', JSON.stringify({ st: sentDisc.json.status }));
  const rejSelf = await inj('POST', `/api/cpq/quotes/${qDisc.json.id}/reject`, sales1);
  ok('Author self-reject of a breach → 403 SOD_SELF_APPROVAL', rejSelf.status === 403 && rejSelf.json.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify({ s: rejSelf.status, c: rejSelf.json.error?.code }));
  const rejected = await inj('POST', `/api/cpq/quotes/${qDisc.json.id}/reject`, admin);
  ok('Distinct approver rejects breach → back to Draft', rejected.status === 200 && rejected.json.status === 'Draft', JSON.stringify({ st: rejected.json.status }));

  // ── 6. RLS: another tenant sees neither the HQ quotes nor the HQ approvals ──
  const t1Quotes = await inj('GET', '/api/cpq/quotes', t1user);
  ok('RLS: T1 sees 0 HQ quotes', t1Quotes.json.quotes?.length === 0, `count=${t1Quotes.json.quotes?.length}`);
  const t1Appr = await inj('GET', '/api/cpq/approvals', t1user);
  ok('RLS: T1 sees 0 HQ approvals', t1Appr.json.approvals?.length === 0, `count=${t1Appr.json.approvals?.length}`);

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
