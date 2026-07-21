import { test, expect } from '@playwright/test';

/**
 * Public plans & pricing configurator (`/plans`) — desktop smoke. The page is public and its data is
 * static, so no session cookie or API stubs are needed (the LanguageProvider skips its server read when
 * no CSRF cookie is present). Automates UAT-SEC-060..062.
 *
 * Hydration gate: SSR paints the interactive buttons before React attaches handlers, so the FIRST
 * interaction can be swallowed pre-hydration and there is no mount API call to anchor waitForResponse
 * on — retry the language switch until its effect is visible instead (never a sleep).
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/plans');
  await expect(page.getByRole('heading', { name: 'เลือกแพ็กเกจของคุณ' })).toBeVisible();
  await expect(async () => {
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Build your plan' })).toBeVisible({ timeout: 1_000 });
  }).toPass();
});

test('five tiers render with seeded-plan prices and Growth preselected', async ({ page }) => {
  await expect(page.getByRole('radio')).toHaveCount(5);
  // Growth (audience "Multi-branch") is the default selection and the summary shows its monthly price.
  await expect(page.getByRole('radio', { name: /Multi-branch/ })).toHaveAttribute('aria-checked', 'true');
  const aside = page.locator('aside');
  await expect(aside).toContainText('Growth plan');
  await expect(aside).toContainText('฿4,900/mo');
  // Tier-card prices align with the seeded starter/business/pro plans.
  await expect(page.getByRole('radio', { name: /Single branch/ })).toContainText('฿2,900');
  await expect(page.getByRole('radio', { name: /Central kitchen/ })).toContainText('฿9,900');
});

test('annual toggle applies the 2-months-free discount to cards and total', async ({ page }) => {
  await page.getByRole('tab', { name: 'Annual' }).click();
  const aside = page.locator('aside');
  // Growth 4,900 × 10 ÷ 12 = 4,083/mo equivalent, billed 49,000/yr, saving 9,800/yr.
  await expect(aside).toContainText('฿4,083/mo');
  await expect(aside).toContainText('billed annually as ฿49,000/yr');
  await expect(aside).toContainText('฿9,800');
  await expect(page.getByRole('radio', { name: /Multi-branch/ })).toContainText('billed ฿49,000/yr');
});

test('add-on switches update the itemized total live', async ({ page }) => {
  await page.getByRole('switch', { name: /Advanced Supply Chain/ }).click();
  await page.getByRole('switch', { name: /Inbound Webhook/ }).click();
  const aside = page.locator('aside');
  // 4,900 + 1,500 + 990 = 7,390.
  await expect(aside).toContainText('฿7,390/mo');
  await expect(aside).toContainText('Advanced Supply Chain');
  // Toggling one back off removes its line and the total drops to 5,890.
  await page.getByRole('switch', { name: /Advanced Supply Chain/ }).click();
  await expect(aside).toContainText('฿5,890/mo');
  await expect(aside).not.toContainText('Advanced Supply Chain');
});

test('enterprise shows starting-at pricing and CTAs carry the selection into signup', async ({ page }) => {
  await page.getByRole('radio', { name: /Corporate/ }).click();
  const aside = page.locator('aside');
  await expect(aside).toContainText('(starting at)');
  await expect(aside.getByRole('link', { name: /Contact sales/ })).toHaveAttribute('href', '/signup?plan=enterprise&billing=monthly');
  // Non-enterprise tiers use the start-trial CTA; the href carries pack + billing + toggled add-ons.
  await page.getByRole('radio', { name: /Multi-branch/ }).click();
  await page.getByRole('tab', { name: 'Annual' }).click();
  await page.getByRole('switch', { name: /Inbound Webhook/ }).click();
  await expect(aside.getByRole('link', { name: /Start free trial/ })).toHaveAttribute(
    'href',
    '/signup?plan=growth&billing=annual&addons=integrations',
  );
  // The signup page reads the query back and shows the carried selection to the prospect.
  await aside.getByRole('link', { name: /Start free trial/ }).click();
  await expect(page.getByText(/Selected from the pricing page|แพ็กเกจที่เลือกจากหน้าราคา/)).toBeVisible();
  await expect(page.getByText('growth', { exact: true })).toBeVisible();
});

test('login page links to the public pricing page', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('link', { name: /ดูแพ็กเกจและราคา|View plans & pricing/ })).toHaveAttribute('href', '/plans');
});
