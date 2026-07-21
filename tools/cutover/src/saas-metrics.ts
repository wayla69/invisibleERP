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
import { DRIZZLE, tenantAwareProxy, runGlobalDb } from '../../../apps/api/dist/database/database.module';
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
  await app.get(BillingService).seedPlans(); // free/starter/business/pro/enterprise

  // Subscriptions: 2 Active Pro (9900) + 1 Active Starter (2900) → MRR 22700; 1 Canceled Pro (this month);
  // 1 Trialing Free. (Prices per 1.9: Standard 2,900 / Professional 9,900.)
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

  ok('MRR = active Pro×2 (9900) + Starter (2900) = 22,700', near(m.revenue?.mrr, 22700), `mrr=${m.revenue?.mrr}`);
  ok('ARR = MRR × 12 = 272,400', near(m.revenue?.arr, 272400), `arr=${m.revenue?.arr}`);
  ok('ARPU = MRR / active (22700/3 = 7,566.67)', near(m.revenue?.arpu, 7566.67), `arpu=${m.revenue?.arpu}`);
  ok('subscription counts: 3 active, 1 trialing, 1 canceled', m.subscriptions?.active === 3 && m.subscriptions?.trialing === 1 && m.subscriptions?.canceled === 1, JSON.stringify(m.subscriptions));
  ok('churn: 1 canceled in last 30 days + rate computed', m.churn?.canceled_30d === 1 && m.churn?.churn_rate_30d_pct > 0, JSON.stringify(m.churn));
  ok('by-plan mix: Pro has 2 active = 19,800 MRR', (m.by_plan ?? []).find((p: any) => p.plan === 'pro')?.mrr === 19800, JSON.stringify((m.by_plan ?? []).find((p: any) => p.plan === 'pro')));
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
  // These billing reads/writes are tenant-scoped in-tx methods (every prod route is @Permissions, never
  // @NoTx — they run inside the per-request tenant tx). The harness pokes them DIRECTLY (no HTTP request, so
  // no interceptor tx), which under STRICT_TENANT_PROXY=1 is an intentional base-pool access — declare it so
  // the fail-closed proxy permits it. Each call still passes t1 explicitly, so isolation is unaffected.
  const g = <T>(fn: () => Promise<T>): Promise<T> => runGlobalDb('saas-metrics:direct-billing', fn);
  const inv = await g(() => billing.aiOverageInvoice(t1, ovMonth));
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

  const hist = await g(() => billing.listOverageRuns(t1, ovMonth));
  ok('Overage history: listOverageRuns returns the (t1, 2026-05) charge', (hist.runs ?? []).length === 1 && near(hist.runs[0].amount, 120) && hist.runs[0].month === ovMonth, JSON.stringify(hist));

  // Env-rate override: AI_OVERAGE_RATE_THB_PER_1K re-prices overage with no plan/code change (ops knob).
  process.env.AI_OVERAGE_RATE_THB_PER_1K = '20';
  const invEnv = await g(() => billing.aiOverageInvoice(t1, ovMonth));
  delete process.env.AI_OVERAGE_RATE_THB_PER_1K;
  ok('Env rate override: AI_OVERAGE_RATE_THB_PER_1K=20 → 10,000 tokens = 200 THB', near(invEnv.amount, 200) && near(invEnv.overage_rate_thb_per_1k, 20), JSON.stringify(invEnv));

  // ── USAGE METERING → overage billing (1.5): generic meters (e-Tax docs, POS txns) mirror AI tokens —
  //    per-event rows in usage_events, monthly included quota + per-unit rate on the plan, idempotent
  //    monthly Stripe charge per (tenant, meter, month). t1 = Active Pro (etax 1000/mo @2 THB, pos 30000/mo @0.3). ──
  const uMonth = '2026-05';
  // e-Tax: 1005 documents in May → 5 over the Pro 1000 quota → 5 × 2 = 10 THB.
  await pg.query(`INSERT INTO usage_events (tenant_id, meter, event_key, period) SELECT ${t1}, 'etax_docs', 'TIV-'||g, '${uMonth}' FROM generate_series(1,1005) g`);
  // POS: only 5 transactions → well within the 30000 quota → 0 overage.
  await pg.query(`INSERT INTO usage_events (tenant_id, meter, event_key, period) SELECT ${t1}, 'pos_txns', 'SALE-'||g, '${uMonth}' FROM generate_series(1,5) g`);
  const eInv = await g(() => billing.usageOverageInvoice(t1, 'etax_docs', uMonth));
  ok('Usage/e-Tax invoice: used 1005, included 1000, overage 5 × 2 THB = 10 THB',
    eInv.used === 1005 && eInv.included === 1000 && eInv.overage_units === 5 && near(eInv.amount, 10), JSON.stringify(eInv));
  const pInv = await g(() => billing.usageOverageInvoice(t1, 'pos_txns', uMonth));
  ok('Usage/POS invoice: used 5 within the 30000 quota → overage 0, amount 0', pInv.used === 5 && pInv.overage_units === 0 && near(pInv.amount, 0), JSON.stringify(pInv));
  // Dedup: re-inserting an existing (tenant, meter, event_key) is a no-op (ON CONFLICT DO NOTHING) → count unchanged.
  await pg.query(`INSERT INTO usage_events (tenant_id, meter, event_key, period) VALUES (${t1}, 'etax_docs', 'TIV-1', '${uMonth}') ON CONFLICT (tenant_id, meter, event_key) DO NOTHING`);
  const eInv2 = await g(() => billing.usageOverageInvoice(t1, 'etax_docs', uMonth));
  ok('Usage meter dedup: re-recording the same doc_no does not double-count (still 1005)', eInv2.used === 1005, JSON.stringify(eInv2));
  const uSum = await g(() => billing.usageSummary(t1, uMonth));
  ok('Usage summary: both meters present for t1 (etax overage 5, pos 0)', (uSum.meters ?? []).length === 2 && uSum.meters.some((m: any) => m.meter === 'etax_docs' && m.overage_units === 5) && uSum.meters.some((m: any) => m.meter === 'pos_txns' && m.overage_units === 0), JSON.stringify(uSum).slice(0, 200));
  // Overage billing run: charges t1's e-Tax overage (10 THB) once; POS (0) is skipped. Mock path (no Stripe key).
  const uRun1 = await inj('POST', `/api/billing/usage-overage/run?month=${uMonth}`, token);
  const t1Etax = (uRun1.json.processed ?? []).find((p: any) => p.tenant_id === t1 && p.meter === 'etax_docs');
  ok('Usage overage run: t1 e-Tax charged 10 THB (recorded), POS not charged (within quota)',
    uRun1.status === 200 && !!t1Etax && near(t1Etax.amount, 10) && t1Etax.status === 'recorded' && !(uRun1.json.processed ?? []).some((p: any) => p.meter === 'pos_txns'), JSON.stringify(uRun1.json).slice(0, 240));
  // Idempotency: re-run the same month bills nothing (UNIQUE(tenant, meter, month) guard).
  const uRun2 = await inj('POST', `/api/billing/usage-overage/run?month=${uMonth}`, token);
  ok('Usage overage idempotent: re-run same month charges 0', uRun2.status === 200 && uRun2.json.processed_count === 0, JSON.stringify(uRun2.json));
  const uRows = (await pg.query(`SELECT meter, amount, status FROM usage_overage_billing_runs WHERE tenant_id=${t1} AND billing_month='${uMonth}'`)).rows as any[];
  ok('Usage overage ledger: exactly one e-Tax row for (t1, 2026-05), amount 10, recorded',
    uRows.length === 1 && uRows[0].meter === 'etax_docs' && near(uRows[0].amount, 10) && uRows[0].status === 'recorded', JSON.stringify(uRows));

  // ── ANNUAL BILLING + MULTI-CURRENCY (1.7): price_yearly/prices exposed, checkout resolves the right
  //    amount (fail-closed on un-offered interval/currency), the sub row records the billing intent, and
  //    changePlan prorates on the sub's interval basis (interval SWITCH → no misleading number). ──
  const errCode = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e: any) { return e?.response?.code ?? e?.code ?? String(e); } };
  const plansRes = await inj('GET', '/api/billing/plans', token);
  const starterPlan = (plansRes.json.plans ?? []).find((p: any) => p.code === 'starter');
  ok('1.7: plans expose price_yearly (Standard ฿29,000 = 2 months free) + USD price list',
    starterPlan?.price_yearly === 29000 && starterPlan?.prices?.USD?.monthly === 85 && starterPlan?.prices?.USD?.yearly === 850, JSON.stringify({ y: starterPlan?.price_yearly, usd: starterPlan?.prices?.USD }));
  const annCk = await g(() => billing.createCheckoutSession(t1, 'pro', 'annual'));
  const subRow: any = (await pg.query(`SELECT billing_interval, currency FROM subscriptions WHERE tenant_id=${t1} ORDER BY created_at DESC LIMIT 1`)).rows[0];
  ok('1.7: annual checkout (mock) charges ฿99,000/yr and stamps the billing intent on the sub',
    annCk.mock === true && annCk.interval === 'annual' && near(annCk.amount, 99000) && subRow.billing_interval === 'annual' && subRow.currency === 'THB', JSON.stringify({ ck: { i: annCk.interval, a: annCk.amount }, sub: subRow }));
  const usdCk = await g(() => billing.createCheckoutSession(t1, 'starter', 'monthly', 'USD'));
  ok('1.7: USD checkout resolves the per-currency price ($85/mo)', usdCk.currency === 'USD' && near(usdCk.amount, 85), JSON.stringify({ c: usdCk.currency, a: usdCk.amount }));
  ok('1.7: an un-offered currency fails closed (CURRENCY_NOT_OFFERED)', (await errCode(() => g(() => billing.createCheckoutSession(t1, 'starter', 'monthly', 'JPY')))) === 'CURRENCY_NOT_OFFERED', 'JPY');
  await pg.query(`UPDATE plans SET price_yearly = NULL WHERE code = 'starter'`); // simulate a plan with no annual offer
  ok('1.7: a plan without an annual price fails closed (ANNUAL_NOT_OFFERED)', (await errCode(() => g(() => billing.createCheckoutSession(t1, 'starter', 'annual')))) === 'ANNUAL_NOT_OFFERED', 'starter yearly=null');
  await pg.query(`UPDATE plans SET price_yearly = 29000 WHERE code = 'starter'`);
  // changePlan: re-stamp the sub to annual first (the USD checkout above set it monthly) — a same-interval
  // change prorates on the 365-day basis; an interval SWITCH returns proration null + note (no honest
  // single number across period bases).
  await g(() => billing.createCheckoutSession(t1, 'pro', 'annual'));
  const chSame = await g(() => billing.changePlan(t1, 'starter', 'annual'));
  ok('1.7: same-interval (annual) change → proration computed on the 365-day basis', chSame.billing_interval === 'annual' && chSame.proration !== null && (chSame.proration as any).period_days === 365, JSON.stringify({ i: chSame.billing_interval, p: (chSame.proration as any)?.period_days }));
  const chSwitch = await g(() => billing.changePlan(t1, 'pro', 'monthly'));
  ok('1.7: interval switch (annual→monthly) → proration null + interval_change note, interval updated',
    chSwitch.billing_interval === 'monthly' && chSwitch.proration === null && (chSwitch as any).proration_note === 'interval_change', JSON.stringify({ i: chSwitch.billing_interval, n: (chSwitch as any).proration_note }));

  // ── PRICE GRANDFATHERING (0454, docs/53 Q7): a subscription's snapshotted price survives a plan-row
  //    repricing — charge paths and MRR read COALESCE(snapshot, list); a plan CHANGE re-snapshots. ──
  // Simulate a legacy tenant: t3 subscribed to Standard back when it cost ฿1,900 (pre-1.9 list).
  await pg.query(`UPDATE subscriptions SET grandfathered_price = 1900 WHERE tenant_id = ${t3}`);
  const gfSub = await g(() => billing.getSubscription(t3));
  ok('0454: getSubscription returns the EFFECTIVE price (snapshot 1,900), list price beside it, flagged',
    near(gfSub.price_monthly, 1900) && near(gfSub.list_price_monthly, 2900) && gfSub.grandfathered === true, JSON.stringify({ p: gfSub.price_monthly, l: gfSub.list_price_monthly, g: gfSub.grandfathered }));
  const gfCk = await g(() => billing.createCheckoutSession(t3, 'starter', 'monthly'));
  ok('0454: checkout of the CURRENT plan charges the grandfathered ฿1,900, not list ฿2,900', near(gfCk.amount, 1900), `amount=${gfCk.amount}`);
  const otherCk = await g(() => billing.createCheckoutSession(t3, 'business', 'monthly'));
  ok('0454: checkout of a DIFFERENT plan prices at current list (฿4,900 — no snapshot carry-over)', near(otherCk.amount, 4900), `amount=${otherCk.amount}`);
  // MRR sums effective prices: t1 pro 9,900 (re-snapshotted by the changePlan above) + t2 pro 9,900
  // (NULL snapshot → list) + t3 starter 1,900 (grandfathered) = 21,700.
  const m2 = (await inj('GET', '/api/billing/saas-metrics', token)).json;
  ok('0454: MRR uses each sub\'s effective price (9,900 + 9,900 + 1,900 = 21,700)', near(m2.revenue?.mrr, 21700), `mrr=${m2.revenue?.mrr}`);
  const gfCh = await g(() => billing.changePlan(t3, 'business'));
  const gfRow: any = (await pg.query(`SELECT grandfathered_price FROM subscriptions WHERE tenant_id=${t3}`)).rows[0];
  ok('0454: a plan change RE-SNAPSHOTS at the new plan\'s current price (฿4,900) — old lock ends',
    gfCh.plan === 'business' && near(Number(gfRow.grandfathered_price), 4900), JSON.stringify(gfRow));

  // ── PRODUCT-LINE SKUs (0455, docs/53 C1): POS line prices PER BRANCH — checkout multiplies by the
  //    branch quantity, persists it, and a flat plan rejects an explicit quantity. ──
  const pbCk = await g(() => billing.createCheckoutSession(t2, 'pos_pro', 'monthly', 'THB', 3));
  const pbRow: any = (await pg.query(`SELECT branches FROM subscriptions WHERE tenant_id=${t2}`)).rows[0];
  ok('0455: POS Pro × 3 branches checkout charges 3 × ฿1,190 = ฿3,570 and persists branches=3',
    near(pbCk.amount, 3570) && pbCk.branches === 3 && Number(pbRow.branches) === 3, JSON.stringify({ a: pbCk.amount, b: pbRow.branches }));
  const pbAnnual = await g(() => billing.createCheckoutSession(t2, 'pos_lite', 'annual', 'THB', 2));
  ok('0455: POS Lite × 2 branches annual = 2 × ฿5,900 = ฿11,800 (per-branch × 10-month annual)',
    near(pbAnnual.amount, 11800), `amount=${pbAnnual.amount}`);
  ok('0455: a flat (per-company) plan rejects an explicit branch quantity → PLAN_NOT_PER_BRANCH',
    (await errCode(() => g(() => billing.createCheckoutSession(t2, 'starter', 'monthly', 'THB', 3)))) === 'PLAN_NOT_PER_BRANCH', 'starter ×3');

  await app.close();
  console.log('\n── Step 9 — SaaS metrics (MRR / churn / DAU-MAU) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} saas-metrics checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} saas-metrics checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
