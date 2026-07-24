import { test, expect } from '@playwright/test';

/**
 * Public plans & pricing configurator (`/plans`) — phone-viewport regression (iPhone 13 metrics).
 * Exercises the fixed bottom summary bar that only renders below `lg`, in the default Thai locale.
 * Per the horizontal-overflow mantra: any page-level overflow shifts `position:fixed` elements
 * off-screen, so assert no overflow at every stage AND that the bar stays inside the viewport.
 * Automates UAT-SEC-061 (mobile leg).
 */

const noOverflow = async (page: import('@playwright/test').Page) => {
  const r = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(r.sw, `horizontal overflow: scrollWidth ${r.sw} > clientWidth ${r.cw}`).toBeLessThanOrEqual(r.cw);
};

test('bottom summary bar totals update and stay inside the viewport', async ({ page }) => {
  await page.goto('/plans');
  await expect(page.getByRole('heading', { name: 'เลือกแพ็กเกจของคุณ' })).toBeVisible();
  await noOverflow(page);

  const bar = page.locator('div.fixed.bottom-0');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('฿4,900');

  // Hydration gate (no mount API call to anchor on): retry the switch toggle until the bar's
  // total reflects it — a pre-hydration click changes nothing and must be re-dispatched, never slept on.
  // Target the planning module add-on by testid: on Growth the advanced supply-chain add-on is
  // INCLUDED (✓ badge, no switch), and the module-add-on group renders first.
  await expect(async () => {
    await page.getByTestId('addon-planning').getByRole('switch').click();
    await expect(bar).toContainText('฿6,800', { timeout: 1_000 }); // 4,900 + 1,900 planning module
  }).toPass();

  // Expand the itemized summary; the page and the bar must stay overflow-free with it open.
  await page.getByRole('button', { name: /ดูรายละเอียด/ }).click();
  await expect(bar).toContainText('ค่าบริการโดยประมาณ');
  await expect(bar).toContainText('แพ็กเกจ Growth');
  await noOverflow(page);
  const box = await bar.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  if (box && viewport) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
  }
});
