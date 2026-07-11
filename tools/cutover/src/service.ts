/**
 * Phase 20 Batch 2C — Service Contracts + Subscriptions over PGlite.
 * SLA event tracking with breach detection, subscription billing cycle.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover service
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'service-secret';
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
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: hq },
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
  const [admin, sales1] = [await login('admin', 'admin123'), await login('sales1', 'pw1')];

  // ── SERVICE CONTRACTS + SLA ──

  // 1. Create Gold SLA contract (response=2h, resolution=8h)
  const contract = await inj('POST', '/api/service/contracts', admin, {
    customer_name: 'Acme Corp', sla_tier: 'Gold',
    start_date: '2026-01-01', end_date: '2026-12-31', monthly_value: 50000,
  });
  ok('Create Gold SLA contract → SVC-00001, response_hours=2', contract.status === 201 && contract.json.contract_no === 'SVC-00001' && contract.json.response_hours === 2, JSON.stringify(contract.json));
  const contractId = contract.json.id;

  // 2. Log P1 event (opened at T=0)
  const openedAt = '2026-01-10T09:00:00.000Z';
  const ev1 = await inj('POST', `/api/service/contracts/${contractId}/events`, sales1, { title: 'System Down', priority: 'P1', opened_at: openedAt });
  ok('Log P1 event → response_due_at = opened + 2h', ev1.status === 201 && ev1.json.event_no === 'INC-00001' && !!ev1.json.response_due_at, JSON.stringify(ev1.json));
  const ev1Id = ev1.json.id;

  // Verify response_due is exactly 2h after opened
  const dueMs = new Date(ev1.json.response_due_at).getTime() - new Date(openedAt).getTime();
  ok('P1 Gold response_due = 2h (7200000ms)', dueMs === 2 * 3600000, `diff=${dueMs}ms`);

  // 3. Resolve within SLA (1h after opening → no breach)
  const resolvedWithin = await inj('POST', `/api/service/events/${ev1Id}/resolve`, sales1, {
    responded_at: '2026-01-10T09:30:00.000Z', // 30min after → within 2h SLA
    resolved_at: '2026-01-10T16:00:00.000Z',  // 7h after → within 8h resolution
  });
  ok('Resolve within SLA → no breach', resolvedWithin.status === 200 && resolvedWithin.json.response_breached === false && resolvedWithin.json.resolution_breached === false, JSON.stringify(resolvedWithin.json));

  // 4. Log P2 event and resolve LATE (breach)
  const ev2 = await inj('POST', `/api/service/contracts/${contractId}/events`, sales1, { title: 'Slow performance', priority: 'P2', opened_at: '2026-01-11T10:00:00.000Z' });
  const ev2Id = ev2.json.id;
  const resolvedLate = await inj('POST', `/api/service/events/${ev2Id}/resolve`, sales1, {
    responded_at: '2026-01-11T15:00:00.000Z', // 5h after → breaches 2h Gold SLA
    resolved_at:  '2026-01-12T10:00:00.000Z', // 24h after → breaches 8h Gold SLA
  });
  ok('Resolve late → response_breached=true, resolution_breached=true', resolvedLate.status === 200 && resolvedLate.json.response_breached === true && resolvedLate.json.resolution_breached === true, JSON.stringify(resolvedLate.json));

  // 5. List events for contract → 2 events
  const events = await inj('GET', `/api/service/contracts/${contractId}/events`, sales1);
  ok('List contract events → 2', events.json.events?.length === 2, `count=${events.json.events?.length}`);

  // 6. List contracts → 1
  const contracts = await inj('GET', '/api/service/contracts', admin);
  ok('List contracts → 1', contracts.json.contracts?.length === 1, `count=${contracts.json.contracts?.length}`);

  // ── SUBSCRIPTIONS ──

  // 7. Create monthly subscription (1000/month)
  const sub = await inj('POST', '/api/service/subscriptions', admin, {
    customer_name: 'Beta Ltd', product_code: 'ERP-BASIC', description: 'ERP Basic SaaS',
    billing_cycle: 'monthly', unit_price: 10000, qty: 1, start_date: '2026-01-01',
  });
  ok('Create monthly subscription → SUB-00001', sub.status === 201 && sub.json.sub_no === 'SUB-00001' && sub.json.status === 'Active', JSON.stringify(sub.json));
  const subId = sub.json.id;

  // 8. Run billing → 1 invoice created (next_billing_date <= today = 2026-01-01)
  const billing = await inj('POST', '/api/service/billing/run', admin, { as_of_date: '2026-01-01' });
  ok('Billing run → 1 invoice created', billing.status === 200 && billing.json.invoices_created === 1, JSON.stringify(billing.json));

  // 9. Invoice is Draft, amount = 10000
  const invoices = await inj('GET', `/api/service/subscriptions/${subId}/invoices`, admin);
  ok('Invoice created: amount=10000, status=Draft', invoices.json.invoices?.length === 1 && near(invoices.json.invoices[0].amount, 10000) && invoices.json.invoices[0].status === 'Draft', JSON.stringify(invoices.json));
  const invId = invoices.json.invoices[0].id;

  // 10. next_billing_date advanced to 2026-02-01
  const subs = await inj('GET', '/api/service/subscriptions', admin);
  ok('Next billing date advanced to 2026-02-01', subs.json.subscriptions[0].next_billing_date === '2026-02-01', `next=${subs.json.subscriptions[0].next_billing_date}`);

  // 11. Pay invoice → Paid
  const paid = await inj('POST', `/api/service/invoices/${invId}/pay`, admin);
  ok('Pay invoice → status=Paid', paid.status === 200 && paid.json.status === 'Paid', JSON.stringify(paid.json));

  // 12. Pause subscription → Paused; billing run skips it
  const paused = await inj('POST', `/api/service/subscriptions/${subId}/pause`, admin);
  ok('Pause subscription → status=Paused', paused.status === 200 && paused.json.status === 'Paused', JSON.stringify(paused.json));
  const billing2 = await inj('POST', '/api/service/billing/run', admin, { as_of_date: '2026-02-01' });
  ok('Billing run on paused sub → 0 invoices', billing2.json.invoices_created === 0, JSON.stringify(billing2.json));

  // 13. Resume subscription → Active; billing run picks it up again
  const resumed = await inj('POST', `/api/service/subscriptions/${subId}/resume`, admin);
  ok('Resume subscription → status=Active', resumed.status === 200 && resumed.json.status === 'Active', JSON.stringify(resumed.json));
  const billing3 = await inj('POST', '/api/service/billing/run', admin, { as_of_date: '2026-02-01' });
  ok('Billing run on resumed sub → 1 invoice', billing3.json.invoices_created === 1, JSON.stringify(billing3.json));

  // 14. Cancel is terminal → resume rejected
  const cancelled = await inj('POST', `/api/service/subscriptions/${subId}/cancel`, admin);
  ok('Cancel subscription → status=Cancelled', cancelled.status === 200 && cancelled.json.status === 'Cancelled', JSON.stringify(cancelled.json));
  const resumeCancelled = await inj('POST', `/api/service/subscriptions/${subId}/resume`, admin);
  ok('Resume cancelled sub → 400 SUB_CANCELLED', resumeCancelled.status === 400 && resumeCancelled.json.error?.code === 'SUB_CANCELLED', JSON.stringify(resumeCancelled.json));

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
