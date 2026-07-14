import { test, type Page } from '@playwright/test';

/**
 * Screenshot CAPTURE tool (not a CI test) — regenerates the user-manual sidebar imagery.
 * Excluded from the normal suite via `testIgnore` in playwright.config.ts; run on demand with a config
 * that clears testIgnore (see docs/15-ui-ux-menu-restructure-plan.md / the capture command in the PR).
 * Backend is fully stubbed (no API/DB); we seed the session cookie so the shell stays put.
 */

const ADMIN = { username: 'admin', role: 'Admin', customer_name: null, permissions: [] as string[] };
// Playwright resolves screenshot paths from cwd (apps/web when run via pnpm --filter @ierp/web).
const OUT = '../../docs/user-manual/img';

async function boot(page: Page) {
  await page.addInitScript(() => {
    // The app gates on a readable CSRF cookie as the "has session" signal.
    document.cookie = 'ierp_csrf=e2e-capture; path=/';
  });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/api/auth/me')) return json(ADMIN);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favorites: [], navFold: {}, saved: false });
    if (url.includes('/api/dashboard'))
      return json({ today: { sales: 1000, orders: 5 }, month: { sales: 30000, orders: 120 }, low_stock_count: 0, outstanding_ap: 0, top_items_today: [], recent_orders: [] });
    return json({});
  });
}

const sidebar = (page: Page) => page.locator('[data-slot="sidebar-inner"]').first();
const header = (page: Page) => page.locator('[data-sidebar="header"]').first();

// Top-level domains are collapsible and default to only-active-open (docs/15 rev 2/3), so an item in a
// non-active domain is hidden until its header is expanded. Advanced areas need the "show advanced" toggle.
async function openDomain(page: Page, name: string) {
  const btn = page.getByRole('button', { name, exact: true });
  if ((await btn.getAttribute('aria-expanded')) === 'false') await btn.click();
}
async function enableAdvanced(page: Page) {
  const t = page.getByRole('button', { name: 'แสดงเมนูขั้นสูง', exact: true });
  if ((await t.getAttribute('aria-pressed')) !== 'true') await t.click();
}
const scrollSidebar = (page: Page, to: 'top' | 'bottom') =>
  page.locator('[data-slot="sidebar-content"]').first().evaluate((el, t) => {
    el.scrollTo({ top: t === 'top' ? 0 : el.scrollHeight });
  }, to);

test.use({ viewport: { width: 1280, height: 1400 } });

test('capture sidebar imagery for the user manual', async ({ page }) => {
  await boot(page);
  await page.goto('/dashboard');
  await sidebar(page).waitFor();

  // 1) Workspace switcher (sidebar header close-up).
  await header(page).screenshot({ path: `${OUT}/workspace-switcher.png` });

  // 2) Full sidebar with the restructured, grouped navigation (ERP workspace).
  await sidebar(page).screenshot({ path: `${OUT}/sidebar-overview.png` });

  // 3) Favourites: star two items so the รายการโปรด group appears, then scroll back to the top so it shows.
  //    Open each item's domain first (they default collapsed): /inventory → ซัพพลายเชน, /finance → การเงิน & บัญชี.
  await openDomain(page, 'ซัพพลายเชน');
  await openDomain(page, 'การเงิน & บัญชี');
  for (const href of ['/inventory', '/finance']) {
    await page
      .locator('li[data-sidebar="menu-item"]', { has: page.locator(`a[href="${href}"]`) })
      .locator('button[data-sidebar="menu-action"]')
      .click();
  }
  await page.getByText('รายการโปรด', { exact: true }).waitFor();
  await scrollSidebar(page, 'top');
  await sidebar(page).screenshot({ path: `${OUT}/sidebar-favourites.png` });

  // 4) Collapsible Settings: reveal advanced areas, expand the ตั้งค่าระบบ domain, then expand one advanced
  //    sub-section (ปรับแต่ง) and leave another collapsed (เชื่อมต่อ & ขยาย); scroll to the group at the bottom.
  await enableAdvanced(page);
  await openDomain(page, 'ตั้งค่าระบบ');
  await page.getByRole('button', { name: 'ปรับแต่ง', exact: true }).click();
  await scrollSidebar(page, 'bottom');
  await sidebar(page).screenshot({ path: `${OUT}/sidebar-settings.png` });
});
