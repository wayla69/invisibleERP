/**
 * Wave 1 · 1.8 — PlanGuard suite-gating behaviour (ToE for the 1.2 monetization gate).
 * Exercises the compiled PlanGuard's full decision tree against a scripted DB stub — deterministic, no
 * PGlite/HTTP needed. Proves: default-off = legacy (no suite gating), enforce = suite gating + the fixed
 * god-only bypass (per-tenant Admin no longer bypasses), shadow = observe-not-block, fail-open on infra
 * error, fail-closed on missing/unknown plan, and the trial/past-due status handling.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover plan-gating
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'plan-gating';
process.env.NODE_ENV = 'test';
process.env.PLATFORM_ADMIN_USERNAMES = 'god';

import { PlanGuard, evaluatePastDueGrace, billingGraceDays, entitlementEnforceTenantIds } from '../../../apps/api/dist/modules/billing/plan.guard';
import { PLAN_SUITES } from '@ierp/shared';
import { logger as apiPino } from '../../../apps/api/dist/observability/logger';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

// Metadata keys (mirror common/decorators + plan-feature.decorator + requires-suite.decorator).
const IS_PUBLIC_KEY = 'isPublic';
const PLAN_FEATURE_KEY = 'planFeature';
const PERMISSIONS_KEY = 'permissions';
const REQUIRES_SUITE_KEY = 'requiresSuite';

function stubReflector(meta: Record<string, unknown>) {
  return { getAllAndOverride: (key: string) => meta[key] } as any;
}
// Chainable drizzle-query stub whose terminal .limit() resolves to the scripted rows (or throws).
// B1: `.insert(...).values(v).onConflictDoNothing()` captures observation writes into `inserted`.
function stubDb(rows: any[], throwErr = false, inserted: any[] = []) {
  const builder: any = {};
  for (const m of ['select', 'from', 'leftJoin', 'where', 'orderBy']) builder[m] = () => builder;
  builder.limit = () => (throwErr ? Promise.reject(new Error('db blip')) : Promise.resolve(rows));
  return {
    select: () => builder,
    insert: () => ({ values: (v: any) => ({ onConflictDoNothing: () => { inserted.push(v); return Promise.resolve(); } }) }),
  } as any;
}
function ctx(user: any, meta: Record<string, unknown>, extraReq: Record<string, unknown> = {}) {
  const req = { user, ...extraReq };
  return {
    getType: () => 'http',
    getHandler: () => () => {},
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}
const planRow = (planCode: string, status = 'Active', extra: Record<string, unknown> = {}) => ({
  features: { suites: (PLAN_SUITES as any)[planCode], ...(extra as any) },
  status,
  trialEndsAt: null,
  planCode,
});

// Run the guard once; returns { allowed, code }.
async function run(
  mode: 'legacy' | 'shadow' | 'enforce',
  opts: { user: any; required?: string[]; feature?: string; suite?: string; rows?: any[]; dbError?: boolean; req?: Record<string, unknown>; cohort?: string; inserted?: any[] },
): Promise<{ allowed: boolean; code?: string }> {
  process.env.ENTITLEMENTS_ENFORCE = mode === 'enforce' ? 'true' : 'false';
  process.env.ENTITLEMENTS_SHADOW = mode === 'shadow' ? 'true' : 'false';
  process.env.ENTITLEMENTS_ENFORCE_TENANTS = opts.cohort ?? '';
  const meta: Record<string, unknown> = { [IS_PUBLIC_KEY]: false, [PERMISSIONS_KEY]: opts.required, [PLAN_FEATURE_KEY]: opts.feature, [REQUIRES_SUITE_KEY]: opts.suite };
  const guard = new PlanGuard(stubReflector(meta), stubDb(opts.rows ?? [], opts.dbError, opts.inserted));
  try {
    const allowed = await guard.canActivate(ctx(opts.user, meta, opts.req ?? {}));
    return { allowed };
  } catch (e: any) {
    return { allowed: false, code: e?.response?.code ?? e?.code };
  }
}

const tenantUser = (role = 'Sales', username = 'u1') => ({ username, role, tenantId: 7 });
const adminUser = { username: 'tenantadmin', role: 'Admin', tenantId: 7 };
const godUser = { username: 'god', role: 'Admin', tenantId: 7 };

async function main() {
  // ── LEGACY (default off): no suite gating; @RequiresPlanFeature still gates; Admin bypasses (unchanged) ──
  ok('legacy: ungated route allowed', (await run('legacy', { user: tenantUser(), required: ['procurement'], rows: [planRow('starter')] })).allowed === true);
  ok('legacy: ai_chat feature blocked when plan lacks it',
    (await run('legacy', { user: tenantUser(), feature: 'ai_chat', rows: [planRow('starter', 'Active', { ai_chat: false })] })).code === 'PLAN_FEATURE_REQUIRED');
  ok('legacy: ai_chat allowed when plan has it',
    (await run('legacy', { user: tenantUser(), feature: 'ai_chat', rows: [planRow('pro', 'Active', { ai_chat: true })] })).allowed === true);
  ok('legacy: tenant Admin bypasses (unchanged behaviour)',
    (await run('legacy', { user: adminUser, feature: 'ai_chat', rows: [planRow('starter', 'Active', { ai_chat: false })] })).allowed === true);

  // ── ENFORCE: suite gating + god-only bypass ──
  ok('enforce: docs/53 Q1 — Standard (starter) now INCLUDES base procurement (PR→PO→GRN allowed)',
    (await run('enforce', { user: tenantUser('Procurement'), required: ['procurement'], rows: [planRow('starter')] })).allowed === true);
  ok('enforce: pos_lite (POS line) blocks procurement route → SUITE_NOT_ENTITLED',
    (await run('enforce', { user: tenantUser('Procurement'), required: ['procurement'], rows: [planRow('pos_lite')] })).code === 'SUITE_NOT_ENTITLED');
  ok('enforce: pro (has procurement suite) allows procurement route',
    (await run('enforce', { user: tenantUser('Procurement'), required: ['procurement'], rows: [planRow('pro')] })).allowed === true);
  ok('enforce: core token (dashboard) always allowed even on starter',
    (await run('enforce', { user: tenantUser(), required: ['dashboard'], rows: [planRow('starter')] })).allowed === true);
  ok('enforce: sub-permission (gl_post) passes through (not suite-gated)',
    (await run('enforce', { user: tenantUser(), required: ['gl_post'], rows: [planRow('starter')] })).allowed === true);
  ok('enforce: FIX — per-tenant Admin no longer bypasses (blocked on unentitled module)',
    (await run('enforce', { user: adminUser, required: ['procurement'], rows: [planRow('pos_lite')] })).code === 'SUITE_NOT_ENTITLED');
  ok('enforce: platform god (username in PLATFORM_ADMIN_USERNAMES) bypasses',
    (await run('enforce', { user: godUser, required: ['procurement'], rows: [planRow('pos_lite')] })).allowed === true);
  ok('enforce: __platformBypass request flag bypasses',
    (await run('enforce', { user: tenantUser(), required: ['procurement'], rows: [planRow('pos_lite')], req: { __platformBypass: true } })).allowed === true);

  // ── ENFORCE: product-line SKUs (docs/53 C1) — POS-only and ERP-only entitlement boundaries ──
  ok('enforce: pos_lite allows the register (pos token via pos_frontoffice)',
    (await run('enforce', { user: tenantUser('pos'), required: ['pos'], rows: [planRow('pos_lite')] })).allowed === true);
  ok('enforce: pos_lite blocks finance (exec) → SUITE_NOT_ENTITLED',
    (await run('enforce', { user: tenantUser('Accounting'), required: ['exec'], rows: [planRow('pos_lite')] })).code === 'SUITE_NOT_ENTITLED');
  ok('enforce: erp_essentials allows order-to-cash (order_mgt via the split sales suite)',
    (await run('enforce', { user: tenantUser('Sales'), required: ['order_mgt'], rows: [planRow('erp_essentials')] })).allowed === true);
  ok('enforce: erp_essentials (register-less ERP line) blocks pos → SUITE_NOT_ENTITLED',
    (await run('enforce', { user: tenantUser('pos'), required: ['pos'], rows: [planRow('erp_essentials')] })).code === 'SUITE_NOT_ENTITLED');
  ok('enforce: erp_growth includes base procurement + planning',
    (await run('enforce', { user: tenantUser('Procurement'), required: ['procurement'], rows: [planRow('erp_growth')] })).allowed === true
    && (await run('enforce', { user: tenantUser('Planner'), required: ['planner'], rows: [planRow('erp_growth')] })).allowed === true);

  // ── ENFORCE: subscription status handling ──
  ok('enforce: Trialing (not expired) grants all suites',
    (await run('enforce', { user: tenantUser('Procurement'), required: ['procurement'], rows: [{ features: {}, status: 'Trialing', trialEndsAt: new Date(Date.now() + 86400000), planCode: 'free' }] })).allowed === true);
  ok('enforce: Trialing (expired) → TRIAL_EXPIRED',
    (await run('enforce', { user: tenantUser(), required: ['dashboard'], rows: [{ features: {}, status: 'Trialing', trialEndsAt: new Date(Date.now() - 86400000), planCode: 'free' }] })).code === 'TRIAL_EXPIRED');
  ok('enforce: PastDue → SUBSCRIPTION_INACTIVE',
    (await run('enforce', { user: tenantUser(), required: ['dashboard'], rows: [{ features: {}, status: 'PastDue', trialEndsAt: null, planCode: 'starter' }] })).code === 'SUBSCRIPTION_INACTIVE');

  // ── ENFORCE: fail-open / fail-closed ──
  ok('enforce: infra DB error → FAIL-OPEN (paying tenant never locked out)',
    (await run('enforce', { user: tenantUser('Procurement'), required: ['procurement'], dbError: true })).allowed === true);
  ok('enforce: no subscription row → FAIL-CLOSED to core (procurement blocked)',
    (await run('enforce', { user: tenantUser('Procurement'), required: ['procurement'], rows: [] })).code === 'SUITE_NOT_ENTITLED');
  ok('enforce: no subscription row → core still allowed',
    (await run('enforce', { user: tenantUser(), required: ['dashboard'], rows: [] })).allowed === true);
  ok('enforce: unknown plan code → fail-closed (procurement blocked)',
    (await run('enforce', { user: tenantUser('Procurement'), required: ['procurement'], rows: [{ features: {}, status: 'Active', trialEndsAt: null, planCode: 'mystery' }] })).code === 'SUITE_NOT_ENTITLED');

  // ── @RequiresSuite (1.1b): token-less premium suites (Manufacturing/Projects/HCM/Real-estate) ──
  ok('enforce: starter (no manufacturing suite) blocks @RequiresSuite(manufacturing) → SUITE_NOT_ENTITLED',
    (await run('enforce', { user: tenantUser(), required: ['exec'], suite: 'manufacturing', rows: [planRow('starter')] })).code === 'SUITE_NOT_ENTITLED');
  ok('enforce: enterprise (has manufacturing suite) allows @RequiresSuite(manufacturing)',
    (await run('enforce', { user: tenantUser(), required: ['exec'], suite: 'manufacturing', rows: [planRow('enterprise')] })).allowed === true);
  ok('enforce: pro (no projects suite) blocks @RequiresSuite(projects)',
    (await run('enforce', { user: tenantUser(), required: ['exec'], suite: 'projects', rows: [planRow('pro')] })).code === 'SUITE_NOT_ENTITLED');
  ok('enforce: god bypasses @RequiresSuite even on starter',
    (await run('enforce', { user: godUser, required: ['exec'], suite: 'manufacturing', rows: [planRow('starter')] })).allowed === true);
  ok('enforce: Trialing grants @RequiresSuite suites',
    (await run('enforce', { user: tenantUser(), required: ['exec'], suite: 'manufacturing', rows: [{ features: {}, status: 'Trialing', trialEndsAt: new Date(Date.now() + 86400000), planCode: 'free' }] })).allowed === true);
  ok('legacy: @RequiresSuite NOT enforced when kill-switch off',
    (await run('legacy', { user: tenantUser(), required: ['exec'], suite: 'manufacturing', rows: [planRow('starter')] })).allowed === true);

  // ── 0451 — à-la-carte ADD-ON suites (scm_advanced/integrations/cdp/sandbox): granted by the plan
  //    (grandfathered tiers) OR per-tenant via subscriptions.addons, unioned in by resolveEntitledSuites ──
  const addonRow = (planCode: string, addons: string[]) => ({ ...planRow(planCode), addons });
  ok('enforce: starter (no scm_advanced) blocks @RequiresSuite(scm_advanced) → SUITE_NOT_ENTITLED',
    (await run('enforce', { user: tenantUser('Procurement'), required: ['procurement'], suite: 'scm_advanced', rows: [planRow('business', 'Active')] })).allowed === true
    && (await run('enforce', { user: tenantUser('Procurement'), required: ['pr_raise'], suite: 'scm_advanced', rows: [planRow('starter')] })).code === 'SUITE_NOT_ENTITLED');
  ok('enforce: starter + purchased addons=[scm_advanced] allows the scm_advanced gate',
    (await run('enforce', { user: tenantUser('Procurement'), required: ['pr_raise'], suite: 'scm_advanced', rows: [addonRow('starter', ['scm_advanced'])] })).allowed === true);
  ok('enforce: business GRANDFATHERS scm_advanced (had the procurement token pre-add-on)',
    (await run('enforce', { user: tenantUser('Procurement'), required: ['procurement'], suite: 'scm_advanced', rows: [planRow('business')] })).allowed === true);
  ok('enforce: pro grandfathers cdp; starter needs the purchased addon',
    (await run('enforce', { user: tenantUser('Marketing'), required: ['exec'], suite: 'cdp', rows: [planRow('pro')] })).allowed === true
    && (await run('enforce', { user: tenantUser('Marketing'), required: ['exec'], suite: 'cdp', rows: [planRow('starter')] })).code === 'SUITE_NOT_ENTITLED'
    && (await run('enforce', { user: tenantUser('Marketing'), required: ['exec'], suite: 'cdp', rows: [addonRow('starter', ['cdp'])] })).allowed === true);
  ok('enforce: franchise plan includes sandbox + manufacturing (new seeded tier)',
    (await run('enforce', { user: tenantUser(), required: ['users'], suite: 'sandbox', rows: [planRow('franchise')] })).allowed === true
    && (await run('enforce', { user: tenantUser(), required: ['exec'], suite: 'manufacturing', rows: [planRow('franchise')] })).allowed === true);
  ok('enforce: unknown addon key on the subscription is IGNORED (still blocked)',
    (await run('enforce', { user: tenantUser(), required: ['users'], suite: 'sandbox', rows: [addonRow('starter', ['bogus', 'hcm'])] })).code === 'SUITE_NOT_ENTITLED');
  ok('legacy: addon @RequiresSuite gates NOT enforced when kill-switch off',
    (await run('legacy', { user: tenantUser(), required: ['users'], suite: 'sandbox', rows: [planRow('starter')] })).allowed === true);

  // ── Per-MODULE add-ons (2026-07-21): planning/marketing suite split + planning/marketing/crm_loyalty/ai
  //    sold à la carte — a purchased module add-on entitles its token(s); the ai add-on also confers the
  //    ai_chat feature band (applyAiAddonFeatures) so it works even where the plan says ai_chat:false. ──
  ok('module-addons: split — pro grandfathers BOTH planning (planner) and marketing tokens',
    (await run('enforce', { user: tenantUser('Sales'), required: ['planner'], rows: [planRow('pro')] })).allowed === true
    && (await run('enforce', { user: tenantUser('Sales'), required: ['marketing'], rows: [planRow('pro')] })).allowed === true);
  ok('module-addons: starter blocks planner/marketing/loyalty without the add-on',
    (await run('enforce', { user: tenantUser('Sales'), required: ['planner'], rows: [planRow('starter')] })).code === 'SUITE_NOT_ENTITLED'
    && (await run('enforce', { user: tenantUser('Sales'), required: ['marketing'], rows: [planRow('starter')] })).code === 'SUITE_NOT_ENTITLED'
    && (await run('enforce', { user: tenantUser('Sales'), required: ['loyalty'], rows: [planRow('starter')] })).code === 'SUITE_NOT_ENTITLED');
  ok('module-addons: purchased planning add-on entitles the planner token (marketing stays blocked)',
    (await run('enforce', { user: tenantUser('Sales'), required: ['planner'], rows: [addonRow('starter', ['planning'])] })).allowed === true
    && (await run('enforce', { user: tenantUser('Sales'), required: ['marketing'], rows: [addonRow('starter', ['planning'])] })).code === 'SUITE_NOT_ENTITLED');
  ok('module-addons: purchased marketing + crm_loyalty add-ons entitle their tokens',
    (await run('enforce', { user: tenantUser('Sales'), required: ['marketing'], rows: [addonRow('starter', ['marketing'])] })).allowed === true
    && (await run('enforce', { user: tenantUser('Sales'), required: ['loyalty'], rows: [addonRow('starter', ['crm_loyalty'])] })).allowed === true);
  ok('module-addons: ai add-on entitles the ai_chat token AND the ai_chat plan feature (band overlay)',
    (await run('enforce', { user: tenantUser('Sales'), required: ['ai_chat'], feature: 'ai_chat', rows: [addonRow('starter', ['ai'])] })).allowed === true
    && (await run('enforce', { user: tenantUser('Sales'), required: ['ai_chat'], feature: 'ai_chat', rows: [planRow('starter', 'Active', { ai_chat: false })] })).code === 'SUITE_NOT_ENTITLED');
  ok('module-addons: legacy mode — ai add-on unlocks the ai_chat feature gate TODAY (no flags needed)',
    (await run('legacy', { user: tenantUser('Sales'), feature: 'ai_chat', rows: [addonRow('starter', ['ai'])] })).allowed === true
    && (await run('legacy', { user: tenantUser('Sales'), feature: 'ai_chat', rows: [planRow('starter', 'Active', { ai_chat: false })] })).code === 'PLAN_FEATURE_REQUIRED');

  // ── 1.4 — PastDue grace window (pure decision) ──
  const DAY = 86400000;
  ok('grace: within window + GET → allow', evaluatePastDueGrace({ currentPeriodEnd: new Date(Date.now() - 2 * DAY), graceDays: 7, now: Date.now(), method: 'GET' }) === 'allow');
  ok('grace: within window + POST → readonly', evaluatePastDueGrace({ currentPeriodEnd: new Date(Date.now() - 2 * DAY), graceDays: 7, now: Date.now(), method: 'POST' }) === 'readonly');
  ok('grace: past window → block', evaluatePastDueGrace({ currentPeriodEnd: new Date(Date.now() - 10 * DAY), graceDays: 7, now: Date.now(), method: 'GET' }) === 'block');
  ok('grace: no period info → block (preserve prior)', evaluatePastDueGrace({ currentPeriodEnd: null, graceDays: 7, now: Date.now(), method: 'GET' }) === 'block');
  ok('grace: default BILLING_GRACE_DAYS = 7', billingGraceDays({} as any) === 7);

  // ── 1.4 — PastDue grace via the guard (enforce) ──
  const pastDue = (endDaysAgo: number) => [{ features: { suites: PLAN_SUITES.pro }, status: 'PastDue', trialEndsAt: null, currentPeriodEnd: new Date(Date.now() - endDaysAgo * DAY), planCode: 'pro' }];
  ok('enforce: PastDue within grace + GET (read) → allowed',
    (await run('enforce', { user: tenantUser(), required: ['dashboard'], rows: pastDue(2) })).allowed === true);
  ok('enforce: PastDue within grace + POST (write) → SUBSCRIPTION_PASTDUE_READONLY',
    (await run('enforce', { user: tenantUser(), required: ['dashboard'], rows: pastDue(2), req: { method: 'POST' } })).code === 'SUBSCRIPTION_PASTDUE_READONLY');
  ok('enforce: PastDue past grace → SUBSCRIPTION_INACTIVE',
    (await run('enforce', { user: tenantUser(), required: ['dashboard'], rows: pastDue(30) })).code === 'SUBSCRIPTION_INACTIVE');
  ok('enforce: Canceled → SUBSCRIPTION_INACTIVE (no grace)',
    (await run('enforce', { user: tenantUser(), required: ['dashboard'], rows: [{ features: {}, status: 'Canceled', trialEndsAt: null, currentPeriodEnd: new Date(), planCode: 'pro' }] })).code === 'SUBSCRIPTION_INACTIVE');

  // ── SHADOW: evaluate but never block ──
  // NB the fixture must be a genuinely-blocked pair (docs/53 Q1 gave starter procurement, which made the
  // old starter+procurement case vacuously allowed without ever reaching decide()): pos_lite lacks exec.
  // Capture stdout around the call to prove BOTH observability lines fire: the legacy console line and
  // the structured pino entitlement_shadow_block event (rollout triage, docs/ops runbook).
  {
    // Pino writes through its own sonic-boom fd stream (not process.stdout.write), so spy the SHARED
    // logger instance the guard imports (same CJS module cache) rather than stdout.
    const events: any[] = [];
    const realInfo = apiPino.info.bind(apiPino);
    (apiPino as any).info = (obj: any, msg?: string) => { events.push(obj); return realInfo(obj, msg); };
    const shadowRes = await run('shadow', { user: tenantUser('Accounting'), required: ['exec'], rows: [planRow('pos_lite')] });
    (apiPino as any).info = realInfo;
    const ev = events.find((e) => e && e.event === 'entitlement_shadow_block');
    ok('shadow: would-block scenario is ALLOWED (observe-not-block)', shadowRes.allowed === true);
    ok('shadow: structured pino telemetry emitted (entitlement_shadow_block + plan_code/tokens)',
      !!ev && ev.plan_code === 'pos_lite' && ev.code === 'SUITE_NOT_ENTITLED' && Array.isArray(ev.tokens) && ev.tokens.includes('exec'),
      JSON.stringify(ev ?? 'NO EVENT').slice(0, 160));
  }


  const shObs: any[] = [];
  ok('B1: shadow would-block RECORDS an observation (mode=shadow, day + dedup key)',
    (await run('shadow', { user: tenantUser('Procurement'), required: ['procurement'], rows: [planRow('pos_lite')], inserted: shObs })).allowed === true
    && shObs.length === 1 && shObs[0].mode === 'shadow' && shObs[0].code === 'SUITE_NOT_ENTITLED'
    && shObs[0].aboutTenantId === 7 && /^\d{4}-\d{2}-\d{2}$/.test(shObs[0].day)
    && String(shObs[0].dedupKey).includes(':7:SUITE_NOT_ENTITLED:shadow'), JSON.stringify(shObs[0] ?? null));
  const enObs: any[] = [];
  ok('B1: enforce block RECORDS an observation (mode=enforce)',
    (await run('enforce', { user: tenantUser('Procurement'), required: ['procurement'], rows: [planRow('pos_lite')], inserted: enObs })).code === 'SUITE_NOT_ENTITLED'
    && enObs.length === 1 && enObs[0].mode === 'enforce');
  const alObs: any[] = [];
  ok('B1: an ALLOWED request records nothing',
    (await run('enforce', { user: tenantUser('Procurement'), required: ['procurement'], rows: [planRow('pro')], inserted: alObs })).allowed === true && alObs.length === 0);
  {
    // Same denial twice through ONE guard instance → one insert (in-process first-seen gate; the DB
    // unique index covers cross-process dedup).
    process.env.ENTITLEMENTS_ENFORCE = 'false'; process.env.ENTITLEMENTS_SHADOW = 'true'; process.env.ENTITLEMENTS_ENFORCE_TENANTS = '';
    const meta: Record<string, unknown> = { [IS_PUBLIC_KEY]: false, [PERMISSIONS_KEY]: ['procurement'] };
    const dupObs: any[] = [];
    const guard = new PlanGuard(stubReflector(meta), stubDb([planRow('pos_lite')], false, dupObs));
    await guard.canActivate(ctx(tenantUser('Procurement'), meta));
    await guard.canActivate(ctx(tenantUser('Procurement'), meta));
    ok('B1: identical denial twice on one guard instance → ONE insert (first-seen dedup)', dupObs.length === 1, `inserted=${dupObs.length}`);
  }

  // ── Wave B · B3 — per-tenant enforcement cohort (ENTITLEMENTS_ENFORCE_TENANTS) ──
  ok('B3: cohort tenant is ENFORCED even in global legacy mode',
    (await run('legacy', { user: tenantUser('Procurement'), required: ['procurement'], rows: [planRow('pos_lite')], cohort: '7' })).code === 'SUITE_NOT_ENTITLED');
  ok('B3: non-cohort tenant keeps legacy behaviour (no suite gating)',
    (await run('legacy', { user: tenantUser('Procurement'), required: ['procurement'], rows: [planRow('pos_lite')], cohort: '99' })).allowed === true);
  ok('B3: cohort tenant is BLOCKED (not just logged) under global shadow',
    (await run('shadow', { user: tenantUser('Procurement'), required: ['procurement'], rows: [planRow('pos_lite')], cohort: '7,99' })).code === 'SUITE_NOT_ENTITLED');
  ok('B3: cohort tenant with an entitled plan is still allowed',
    (await run('legacy', { user: tenantUser('Procurement'), required: ['procurement'], rows: [planRow('pro')], cohort: '7' })).allowed === true);
  ok('B3: per-tenant Admin does NOT bypass inside the cohort (enforce semantics)',
    (await run('legacy', { user: adminUser, required: ['procurement'], rows: [planRow('pos_lite')], cohort: '7' })).code === 'SUITE_NOT_ENTITLED');
  ok('B3: god bypasses even inside the cohort',
    (await run('legacy', { user: godUser, required: ['procurement'], rows: [planRow('pos_lite')], cohort: '7' })).allowed === true);
  ok('B3: env parse — whitespace kept, bogus/zero dropped',
    [...entitlementEnforceTenantIds({ ENTITLEMENTS_ENFORCE_TENANTS: ' 1, 2,bogus,0,2 ' } as any)].sort().join(',') === '1,2');

  console.log('\n── Wave 1 · 1.8 — PlanGuard suite-gating (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} plan-gating checks failed` : `\n✅ All ${checks.length} plan-gating checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
