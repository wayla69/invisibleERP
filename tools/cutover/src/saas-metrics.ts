/**
 * Step 9 ToE — SaaS business metrics (MRR/ARR, plan mix, churn, DAU/MAU).
 * Boots the real Nest app over PGlite and asserts the platform metrics computed from subscriptions⋈plans
 * (recurring revenue, active/trial/canceled counts, 30-day churn) and from audit_log distinct actors
 * (DAU/MAU engagement). HQ/Admin runs with RLS bypass so the aggregates span all tenants.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover saas-metrics
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'saas-secret';
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
import { BillingService } from '../../../apps/api/dist/modules/billing/billing.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIG = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: number, b: number) => Math.abs(Number(a) - Number(b)) < 0.01;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await pg.exec(readFileSync(join(MIG, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'T1' }, { code: 'T2', name: 'T2' }, { code: 'T3', name: 'T3' }, { code: 'T4', name: 'T4' }, { code: 'T5', name: 'T5' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2, t3, t4, t5] = await Promise.all(['HQ', 'T1', 'T2', 'T3', 'T4', 'T5'].map(tid));
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(BillingService).seedPlans(); // free/starter/pro/enterprise

  // Subscriptions: 2 Active Pro (2900) + 1 Active Starter (990) → MRR 6790; 1 Canceled Pro (this month);
  // 1 Trialing Free.
  await db.insert(s.subscriptions).values([
    { tenantId: t1, planCode: 'pro', status: 'Active' },
    { tenantId: t2, planCode: 'pro', status: 'Active' },
    { tenantId: t3, planCode: 'starter', status: 'Active' },
    { tenantId: t4, planCode: 'pro', status: 'Canceled' },
    { tenantId: t5, planCode: 'free', status: 'Trialing' },
  ]);
  // Engagement: 3 distinct actors active in the last day, +1 active only ~10 days ago (MAU but not DAU).
  await db.insert(s.auditLog).values([
    { actor: 'u1', tenantId: t1, action: 'GET /x', status: 'success' },
    { actor: 'u2', tenantId: t2, action: 'GET /x', status: 'success' },
    { actor: 'u3', tenantId: t3, action: 'GET /x', status: 'success' },
    { actor: 'u4', tenantId: t4, action: 'GET /x', status: 'success', ts: new Date(Date.now() - 10 * 86400_000) },
  ]);

  const inj = async (method: string, url: string, token?: string) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const token = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'admin123' } })).json().token;

  const r = await inj('GET', '/api/billing/saas-metrics', token);
  const m = r.json;

  ok('MRR = active Pro×2 (2900) + Starter (990) = 6,790', near(m.revenue?.mrr, 6790), `mrr=${m.revenue?.mrr}`);
  ok('ARR = MRR × 12 = 81,480', near(m.revenue?.arr, 81480), `arr=${m.revenue?.arr}`);
  ok('ARPU = MRR / active (6790/3 = 2,263.33)', near(m.revenue?.arpu, 2263.33), `arpu=${m.revenue?.arpu}`);
  ok('subscription counts: 3 active, 1 trialing, 1 canceled', m.subscriptions?.active === 3 && m.subscriptions?.trialing === 1 && m.subscriptions?.canceled === 1, JSON.stringify(m.subscriptions));
  ok('churn: 1 canceled in last 30 days + rate computed', m.churn?.canceled_30d === 1 && m.churn?.churn_rate_30d_pct > 0, JSON.stringify(m.churn));
  ok('by-plan mix: Pro has 2 active = 5,800 MRR', (m.by_plan ?? []).find((p: any) => p.plan === 'pro')?.mrr === 5800, JSON.stringify((m.by_plan ?? []).find((p: any) => p.plan === 'pro')));
  ok('DAU ≥ 3 (u1/u2/u3 active today), MAU > DAU (u4 only in 30d)', m.engagement?.dau >= 3 && m.engagement?.mau >= 4 && m.engagement?.mau >= m.engagement?.dau, JSON.stringify(m.engagement));
  ok('stickiness DAU/MAU is a 0–100 %', m.engagement?.stickiness_pct >= 0 && m.engagement?.stickiness_pct <= 100, `stick=${m.engagement?.stickiness_pct}`);

  // ── AI token cost visibility: GET /api/billing/ai-usage reads ai_token_usage (the daily budget itself is
  //    enforced in AgentService via the autocommit client). HQ admin has no subscription → default 50k limit. ──
  const bizDate = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10); // Asia/Bangkok date
  await db.insert(s.aiTokenUsage).values({ tenantId: hq, usageDate: bizDate, inputTokens: 12000, outputTokens: 3000 });
  const au = await inj('GET', '/api/billing/ai-usage', token);
  ok('AI usage: today total 15,000 = input+output; default 50k limit; remaining 35k; not over budget',
    au.status === 200 && au.json.today?.total_tokens === 15000 && au.json.daily_limit === 50000 && au.json.today?.remaining === 35000 && au.json.today?.over_budget === false,
    JSON.stringify(au.json).slice(0, 170));

  // ── AI overage BILLING (Wave 1): the monthly job appends a Stripe invoice item per tenant for the month's
  //    metered overage, idempotent per (tenant, month). No STRIPE_SECRET_KEY in test → mock path (status
  //    'recorded', null invoice-item id). Connects the AI-COGS meter to actual collection. ──
  const ovMonth = '2026-05';
  // t1 (Active Pro — included 200k/day, overage rate 12 THB/1k) consumed 10,000 overage tokens in May.
  await db.insert(s.aiTokenUsage).values({ tenantId: t1, usageDate: `${ovMonth}-15`, inputTokens: 300000, outputTokens: 0, overageTokens: 10000 });
  const billing = app.get(BillingService);
  const inv = await billing.aiOverageInvoice(t1, ovMonth);
  ok('Overage invoice line: 10,000 tokens × 12 THB/1k = 120 THB (Pro rate)',
    near(inv.amount, 120) && inv.overage_tokens === 10000 && near(inv.overage_rate_thb_per_1k, 12), JSON.stringify(inv));

  const run1 = await inj('POST', `/api/billing/ai-overage/run?month=${ovMonth}`, token);
  ok('Overage billing run: charges t1 once, total 120 THB (mock invoice item — no Stripe key)',
    run1.status === 200 && run1.json.processed_count === 1 && near(run1.json.total_amount, 120) &&
    run1.json.processed?.[0]?.tenant_id === t1 && run1.json.processed?.[0]?.status === 'recorded' && run1.json.processed?.[0]?.stripe_invoice_item_id === null,
    JSON.stringify(run1.json).slice(0, 220));

  // Idempotency: a second run for the same month bills nothing (UNIQUE(tenant, month) guard → no double-bill).
  const run2 = await inj('POST', `/api/billing/ai-overage/run?month=${ovMonth}`, token);
  ok('Overage billing idempotent: re-run same month charges 0 tenant(s)', run2.status === 200 && run2.json.processed_count === 0, JSON.stringify(run2.json));

  const ovRows = (await pg.query(`SELECT amount, status, stripe_invoice_item_id FROM ai_overage_billing_runs WHERE tenant_id=${t1} AND billing_month='${ovMonth}'`)).rows as any[];
  ok('Overage ledger: exactly one row for (t1, 2026-05), amount 120, status recorded',
    ovRows.length === 1 && near(ovRows[0].amount, 120) && ovRows[0].status === 'recorded' && ovRows[0].stripe_invoice_item_id == null, JSON.stringify(ovRows));

  const hist = await billing.listOverageRuns(t1, ovMonth);
  ok('Overage history: listOverageRuns returns the (t1, 2026-05) charge', (hist.runs ?? []).length === 1 && near(hist.runs[0].amount, 120) && hist.runs[0].month === ovMonth, JSON.stringify(hist));

  // Env-rate override: AI_OVERAGE_RATE_THB_PER_1K re-prices overage with no plan/code change (ops knob).
  process.env.AI_OVERAGE_RATE_THB_PER_1K = '20';
  const invEnv = await billing.aiOverageInvoice(t1, ovMonth);
  delete process.env.AI_OVERAGE_RATE_THB_PER_1K;
  ok('Env rate override: AI_OVERAGE_RATE_THB_PER_1K=20 → 10,000 tokens = 200 THB', near(invEnv.amount, 200) && near(invEnv.overage_rate_thb_per_1k, 20), JSON.stringify(invEnv));

  await app.close();
  console.log('\n── Step 9 — SaaS metrics (MRR / churn / DAU-MAU) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} saas-metrics checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} saas-metrics checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
