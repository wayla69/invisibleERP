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
  // Growth includes scm_advanced (badge, no switch) — use two genuinely purchasable extras here.
  await page.getByRole('switch', { name: /Dedicated Sandbox/ }).click();
  await page.getByRole('switch', { name: /Inbound Webhook/ }).click();
  const aside = page.locator('aside');
  // 4,900 + 2,900 + 990 = 8,790.
  await expect(aside).toContainText('฿8,790/mo');
  await expect(aside).toContainText('Dedicated Sandbox');
  // Toggling one back off removes its line and the total drops to 5,890.
  await page.getByRole('switch', { name: /Dedicated Sandbox/ }).click();
  await expect(aside).toContainText('฿5,890/mo');
  await expect(aside).not.toContainText('Dedicated Sandbox');
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

// Included-add-on honesty (2026-07-22): a tier that already includes a module shows "รวมในแพ็กเกจนี้แล้ว"
// with NO price/switch, the total never double-counts it, and the honesty nudge appears when tier +
// à-la-carte modules meet the Scale price.
test('included add-ons cannot be double-counted and the Scale nudge is honest', async ({ page }) => {
  // Scale (pro) includes planning/marketing/loyalty/AI + scm/cdp/webhook → those rows show the badge.
  await page.getByRole('radio', { name: /Central kitchen/ }).click();
  const planningRow = page.getByTestId('addon-planning');
  await expect(planningRow.getByText('Included in this pack')).toBeVisible();
  await expect(planningRow.getByRole('switch')).toHaveCount(0);
  // Growth (business) includes scm_advanced (grandfathered) → badge there too; planning is buyable.
  await page.getByRole('radio', { name: /Multi-branch/ }).click();
  await expect(page.getByTestId('addon-scm_advanced').getByText('Included in this pack')).toBeVisible();
  // Toggle 3 module add-ons on Growth: 4,900 + 1,900 + 1,290 + 1,490 = 9,580 < 9,900 → no nudge yet.
  for (const name of ['Planning & Forecasting (MRP)', 'Marketing & Campaigns', 'CRM & Loyalty']) {
    await page.getByRole('switch', { name }).click();
  }
  await expect(page.locator('aside')).toContainText('฿9,580/mo');
  await expect(page.getByTestId('upsell-scale')).toHaveCount(0);
  // + AI (1,990) → 11,570 ≥ 9,900 → the Scale nudge appears and the total stays the true sum.
  await page.getByRole('switch', { name: 'AI Copilot (100k tokens/day included)' }).click();
  await expect(page.locator('aside')).toContainText('฿11,570/mo');
  await expect(page.getByTestId('upsell-scale')).toBeVisible();
  // Switching to Scale absorbs the modules: the total drops to the pack price alone (nothing
  // double-counted) and the signup CTA carries NO addon params for included modules.
  await page.getByRole('radio', { name: /Central kitchen/ }).click();
  await expect(page.locator('aside')).toContainText('฿9,900/mo');
  const href = await page.locator('aside').getByRole('link', { name: 'Start free trial' }).getAttribute('href');
  expect(href).not.toContain('addons=');
});

test('login page links to the public pricing page', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('link', { name: /ดูแพ็กเกจและราคา|View plans & pricing/ })).toHaveAttribute('href', '/plans');
});
