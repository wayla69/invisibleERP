import { expect, test, type Page } from '@playwright/test';

/**
 * On-demand screenshot tool (not a CI test — *.capture.spec.ts are testIgnore'd): captures mockup
 * imagery of the per-module add-on surfaces shipped in #922 — the /plans configurator (desktop +
 * phone) and the /billing add-on card. Output goes to the scratchpad, nothing is committed.
 * Run with a local config that clears testIgnore (see CLAUDE.md local-e2e recipe).
 */

// Playwright resolves screenshot paths from cwd (apps/web when run via pnpm --filter @ierp/web).
const OUT = process.env.MOCKUP_OUT ?? '../../docs/user-manual/img';

async function bootBilling(page: Page, addons: string[]) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json({ username: 'admin1', role: 'Admin', permissions: ['users', 'dashboard'], is_platform_owner: false });
    if (url.includes('/api/user-prefs')) return json({ favorites: [], navFold: {} });
    if (url.includes('/api/billing/subscription')) return json({ plan_code: 'business', plan_name: 'Business', status: 'Active', price_monthly: 4900, addons, features: { suites: [] } });
    if (url.includes('/api/billing/plans')) return json({ plans: [] });
    if (url.includes('/api/billing/payment-info')) {
      return json({ plan_code: 'business', plan_name: 'Business', interval: 'monthly', amount_due: 4900, addons, suggested_period: '2026-07', promptpay_id: null, qr_payload: null, qr_image: null, bank_details: 'KBank 123-4-56789-0' });
    }
    if (url.includes('/api/billing/payment-claims')) return json({ claims: [] });
    if (url.includes('/api/billing/ai-usage')) return json({ used_today: 41230, daily_limit: 100000, daily_max: 200000, overage_rate_thb_per_1k: 12 });
    return json({});
  });
  await page.goto('/billing');
  await expect(page.getByText('ชำระด้วยการโอน / พร้อมเพย์')).toBeVisible();
}

test('plans configurator — desktop, Growth + module add-ons toggled', async ({ page }) => {
  await page.goto('/plans');
  await expect(page.getByRole('heading', { name: 'เลือกแพ็กเกจของคุณ' })).toBeVisible();
  // Hydration gate: retry the first toggle until the total reflects it.
  await expect(async () => {
    await page.getByTestId('addon-planning').getByRole('switch').click();
    await expect(page.locator('aside')).toContainText('฿6,800', { timeout: 1_000 });
  }).toPass();
  await page.getByTestId('addon-ai').getByRole('switch').click();
  await expect(page.locator('aside')).toContainText('฿8,790');
  // Close-up: the add-on groups (module SKUs first, advanced second) + the sticky summary.
  await page.getByText('ขายยกโมดูล').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/plans-module-addons.png` });
});

test('plans configurator — desktop, Scale shows included badges (display honesty)', async ({ page }) => {
  await page.goto('/plans');
  await expect(page.getByRole('heading', { name: 'เลือกแพ็กเกจของคุณ' })).toBeVisible();
  await expect(async () => {
    await page.getByRole('radio', { name: /ครัวกลาง|Central kitchen/ }).click();
    await expect(page.getByTestId('addon-planning').getByText('รวมในแพ็กเกจนี้แล้ว')).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await page.getByText('ขายยกโมดูล').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/plans-included-badges.png` });
});

test('plans configurator — phone, bottom bar with expanded breakdown', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/plans');
  await expect(page.getByRole('heading', { name: 'เลือกแพ็กเกจของคุณ' })).toBeVisible();
  await expect(async () => {
    await page.getByTestId('addon-planning').getByRole('switch').click();
    await expect(page.locator('div.fixed.bottom-0')).toContainText('฿6,800', { timeout: 1_000 });
  }).toPass();
  await page.getByRole('button', { name: /ดูรายละเอียด/ }).click();
  await expect(page.locator('div.fixed.bottom-0')).toContainText('ค่าบริการโดยประมาณ');
  await page.screenshot({ path: `${OUT}/plans-mobile-summary.png` });
});

test('billing — add-on card with the ai module active', async ({ page }) => {
  await bootBilling(page, ['ai']);
  const modulesHeader = page.getByText('ขายยกโมดูล').first();
  await modulesHeader.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/billing-addons-card.png` });
});
