import { test, expect, type Page } from '@playwright/test';

/**
 * Platform Console — Plans & Modules review + per-tenant add-on management (0451 follow-up).
 * Proves god can review WHAT each sellable plan contains (the per-plan module matrix rendered from the
 * DB plan catalogue), see a signup request's requested pack with its module preview, and manage a
 * company's purchased add-ons from the drawer (effective modules = plan ∪ add-ons, live-updating).
 * Backend fully stubbed via route interception (same recipe as sme-nav-folding.spec.ts). Thai default
 * locale. Automates UAT-SEC-064.
 */

const GOD = { username: 'god', role: 'Admin', customer_name: null, permissions: [], is_platform_owner: true };

// Slim but shape-faithful plan catalogue (features.suites is the boot-backfilled DB copy of PLAN_SUITES).
const PLANS = {
  plans: [
    { code: 'starter', name: 'Standard', price_monthly: '2900', price_yearly: '29000', currency: 'THB', features: { suites: ['core', 'finance', 'sales', 'inventory', 'masterdata'], users: 10, locations: 2 } },
    { code: 'business', name: 'Business', price_monthly: '4900', price_yearly: '49000', currency: 'THB', features: { suites: ['core', 'finance', 'sales', 'inventory', 'procurement', 'masterdata', 'crm_loyalty', 'multibranch', 'scm_advanced'], users: 25, locations: 5 } },
    { code: 'pro', name: 'Professional', price_monthly: '9900', price_yearly: '99000', currency: 'THB', features: { suites: ['core', 'finance', 'sales', 'inventory', 'procurement', 'masterdata', 'planning', 'crm_loyalty', 'multibranch', 'scm_advanced', 'integrations', 'cdp'], users: 50, locations: 10 } },
    { code: 'franchise', name: 'Franchise', price_monthly: '14900', price_yearly: '149000', currency: 'THB', features: { suites: ['core', 'finance', 'sales', 'inventory', 'procurement', 'masterdata', 'planning', 'crm_loyalty', 'multibranch', 'manufacturing', 'projects', 'scm_advanced', 'integrations', 'cdp', 'sandbox'], users: 100, locations: 25 } },
    { code: 'enterprise', name: 'Enterprise', price_monthly: '0', price_yearly: null, currency: 'THB', features: { custom: true, suites: ['core', 'finance', 'sales', 'inventory', 'procurement', 'masterdata', 'planning', 'crm_loyalty', 'multibranch', 'manufacturing', 'projects', 'hcm', 'scm_advanced', 'integrations', 'cdp', 'sandbox'], users: -1, locations: -1 } },
  ],
};

const COMPANY = {
  id: 1, code: 'TESTCAFE', name: 'Test Cafe', suspended: false, status: 'Trialing', plan_code: 'business',
  trial_ends_at: null, users: 3, created_at: '2026-07-01T00:00:00Z', tags: [], control_profile: 'enterprise', addons: ['cdp'],
};

const DETAIL = {
  id: 1, code: 'TESTCAFE', name: 'Test Cafe', legal_name: null, tax_id: null, created_at: '2026-07-01T00:00:00Z',
  suspended: false, deleted: false, purged: false, tags: [], control_profile: 'enterprise', sme_prefs: null,
  subscription: { plan_code: 'business', status: 'Trialing', trial_ends_at: null, addons: ['cdp'] },
  counts: { users: 3, branches: 1 },
  ai_usage: { input_tokens: 0, output_tokens: 0, overage_tokens: 0 },
  recent_activity: [],
};

const REQUEST = {
  id: 1, company_name: 'New Bistro', tenant_code: 'newbistro', admin_username: 'owner', email: null,
  status: 'Pending', requested_at: '2026-07-19T00:00:00Z',
  requested_plan: 'business', requested_interval: 'annual', requested_addons: ['cdp'],
};

async function bootAsGod(page: Page, addonPosts: unknown[], opts: { denyAiUsage?: boolean; skipPlansGate?: boolean; claimActions?: string[] } = {}) {
  const denyAiUsage = opts.denyAiUsage ?? false;
  const claimActions = opts.claimActions ?? [];
  await page.addInitScript(() => {
    document.cookie = 'ierp_csrf=e2e; path=/';
  });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(GOD);
    if (url.includes('/api/user-prefs')) return json({ favorites: [], navFold: {} });
    // The overview tab (default) renders StatCards straight off these nested fields — a bare {} passes
    // its truthy-data guard and crashes the page to the global error boundary, so mock the full shape.
    if (url.includes('/api/billing/saas-metrics')) {
      return json({
        revenue: { mrr: 0, arr: 0, arpu: 0 },
        subscriptions: { active: 0, trialing: 1, past_due: 0 },
        engagement: { mau: 0, dau: 0, stickiness_pct: 0 },
        churn: { churn_rate_30d_pct: 0, canceled_30d: 0 },
        by_plan: [],
      });
    }
    if (url.includes('/api/billing/plans')) return json(PLANS);
    if (url.includes('/api/admin/tenants/1/addons')) {
      const body = JSON.parse(route.request().postData() ?? '{}');
      addonPosts.push(body);
      return json({ tenant_id: 1, addons: body.addons ?? [] });
    }
    if (/\/api\/admin\/tenants\/1(\?|$)/.test(url)) return json(DETAIL);
    if (url.includes('/api/admin/tenants')) return json([COMPANY]);
    if (url.includes('/api/admin/signup-requests')) return json({ requests: [REQUEST] });
    if (url.includes('/api/admin/signup-invites')) return json({ invites: [] });
    if (url.includes('/api/admin/sme-defaults')) return json({ hidden_nav_groups: [], accountant_email: null, updated_by: null });
    if (url.includes('/api/admin/ai-usage')) {
      // Wave B2: optionally deny with a plan-level code so api() raises the app-wide upsell event.
      if (denyAiUsage) {
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SUITE_NOT_ENTITLED', message: 'Your current plan does not include this module.', messageTh: 'แพ็กเกจปัจจุบันของคุณไม่รวมโมดูลนี้ กรุณาอัปเกรดแพ็กเกจ' } }) });
      }
      return json([]);
    }
    // Wave C: the bank-transfer slip verify queue (approve POSTs are captured into addonPosts's sibling).
    if (url.includes('/api/admin/payment-claims')) {
      if (route.request().method() === 'POST') {
        claimActions.push(url.replace(/^.*\/api/, '/api'));
        return json({ id: 5, status: 'Approved', receipt_no: 'RCPT-S-000042' });
      }
      return json({
        claims: [{ id: 5, tenant_id: 3, tenant: 'Slow Payer Co', amount: 4900, period: '2026-08', slip_ref: 'TXN-778899', note: 'โอนจาก KBank', status: 'Pending', receipt_no: null, created_by: 'sp_admin', created_at: '2026-07-21T02:00:00Z' }],
      });
    }
    // Wave B1: enforcement-impact rollup consumed by the plans tab's observations panel.
    if (url.includes('/api/admin/entitlement-observations')) {
      return json({
        observations: [],
        summary: [{ tenant_id: 3, tenant: 'Blocked Co', total: 4, codes: ['SUITE_NOT_ENTITLED', 'TRIAL_EXPIRED'], modes: ['shadow'], last_at: '2026-07-21T00:00:00Z' }],
      });
    }
    return json({});
  });
  await page.goto('/platform');
  if (opts.skipPlansGate) return; // (B2 deny test: the upsell dialog overlays the tabs, so no gate click)
  // Hydration gate: retry the first tab click until its content mounts (no sleeps).
  await expect(async () => {
    await page.getByRole('tab', { name: 'แพ็กเกจ & โมดูล' }).click();
    await expect(page.getByTestId('plan-card-franchise')).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

test('plans tab renders the per-plan module matrix with amber add-on chips', async ({ page }) => {
  await bootAsGod(page, []);
  const franchise = page.getByTestId('plan-card-franchise');
  await expect(franchise).toContainText('Franchise');
  await expect(franchise).toContainText('฿14,900.00/เดือน');
  await expect(franchise).toContainText('฿149,000.00/ปี');
  await expect(franchise).toContainText('ผู้ใช้ 100 คน · 25 สาขา');
  await expect(franchise).toContainText('การผลิต / MRP'); // base module chip
  await expect(franchise).toContainText('สภาพแวดล้อมทดสอบเฉพาะราย'); // add-on suite chip (sandbox)
  // Enterprise: custom pricing + unlimited caps; Standard: no add-ons included.
  await expect(page.getByTestId('plan-card-enterprise')).toContainText('ราคาตามตกลง');
  await expect(page.getByTestId('plan-card-enterprise')).toContainText('ไม่จำกัด');
  await expect(page.getByTestId('plan-card-starter')).toContainText('ไม่มีในแพ็กเกจ — ซื้อเพิ่มเป็นรายโมดูลได้');
});

test('onboarding request shows the requested pack with its module preview', async ({ page }) => {
  await bootAsGod(page, []);
  await page.getByRole('tab', { name: 'Onboarding' }).click();
  const row = page.getByRole('row', { name: /New Bistro/ });
  await expect(row).toContainText('business · รายปี');
  await expect(row).toContainText('ส่งออกกลุ่มเป้าหมายโฆษณา (CDP)'); // requested add-on, labeled not raw
  await expect(row).toContainText('พื้นฐาน'); // first module chips of the pack render
  await expect(row).toContainText('+5'); // business = 9 suites, previewed as 4 chips + count
});

test('company drawer manages purchased add-ons and shows effective modules live', async ({ page }) => {
  const posts: any[] = [];
  await bootAsGod(page, posts);
  await page.getByRole('tab', { name: /บริษัท \(/ }).click();
  // Plan column shows the purchased-add-on count.
  await expect(page.getByRole('row', { name: /Test Cafe/ })).toContainText('+ โมดูลเสริม 1 รายการ');
  await page.getByRole('button', { name: /Test Cafe/ }).click();
  const drawer = page.locator('[role="dialog"]');
  await expect(drawer).toContainText('โมดูลเสริม (ซื้อเพิ่ม)');
  // cdp came pre-purchased; scm_advanced is included in the business plan (no price shown, "already in plan").
  const cdpBox = drawer.getByRole('checkbox', { name: /ส่งออกกลุ่มเป้าหมายโฆษณา/ });
  await expect(cdpBox).toBeChecked();
  await expect(drawer).toContainText('รวมในแพ็กเกจแล้ว');
  // Effective modules react to the selection before saving: tick sandbox → its chip appears.
  const effective = drawer.getByTestId('effective-modules');
  await drawer.getByRole('checkbox', { name: /สภาพแวดล้อมทดสอบเฉพาะราย/ }).check();
  await expect(effective).toContainText('สภาพแวดล้อมทดสอบเฉพาะราย');
  await drawer.getByRole('button', { name: 'บันทึกโมดูลเสริม' }).click();
  await expect.poll(() => posts.length).toBeGreaterThan(0);
  expect(posts[0].addons).toEqual(expect.arrayContaining(['cdp', 'sandbox']));
});

// Wave B1 — the plans tab's enforcement-impact panel (entitlement_observations rollup).
test('plans tab shows the entitlement-observation triage panel', async ({ page }) => {
  await bootAsGod(page, []);
  const panel = page.getByTestId('entitlement-observations');
  await expect(panel).toContainText('ผลกระทบการบังคับใช้แพ็กเกจ');
  await expect(panel).toContainText('Blocked Co');
  await expect(panel).toContainText('SUITE_NOT_ENTITLED');
  await expect(panel).toContainText('TRIAL_EXPIRED');
  await expect(panel).toContainText('shadow');
});

// Wave C — the payment-claim verify queue: pending slip renders with tenant/amount/ref; อนุมัติ posts approve.
test('payments tab lists pending slip claims and approve hits the API', async ({ page }) => {
  const claimActions: string[] = [];
  await bootAsGod(page, [], { claimActions });
  await page.getByRole('tab', { name: 'การชำระเงิน' }).click();
  const panel = page.getByTestId('payment-claims');
  await expect(panel).toContainText('Slow Payer Co');
  await expect(panel).toContainText('TXN-778899');
  await expect(panel).toContainText('฿4,900.00');
  await panel.getByRole('button', { name: 'อนุมัติ' }).click();
  await expect.poll(() => claimActions.length).toBeGreaterThan(0);
  expect(claimActions[0]).toBe('/api/admin/payment-claims/5/approve');
});

// Wave B2 — a plan-level 403 from any api() call raises the app-wide upsell dialog with the billing CTA.
test('plan-denied 403 opens the upsell dialog and its CTA goes to /billing', async ({ page }) => {
  await bootAsGod(page, [], { denyAiUsage: true, skipPlansGate: true }); // ai-usage (queried on the default overview tab) 403s SUITE_NOT_ENTITLED
  const dialog = page.getByRole('dialog').filter({ hasText: 'สิทธิ์การใช้งานตามแพ็กเกจ' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('แพ็กเกจปัจจุบันของคุณไม่รวมโมดูลนี้'); // server messageTh surfaced
  await dialog.getByRole('button', { name: 'ดูแพ็กเกจ & ชำระเงิน' }).click();
  await expect(page).toHaveURL(/\/billing/);
});
