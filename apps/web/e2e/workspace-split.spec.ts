import { test, expect, type Page } from '@playwright/test';

/**
 * ERP/POS workspace switcher — interactive smoke test.
 * Covers the behaviours that build/unit checks can't: the toggle, role-based first-landing redirect,
 * localStorage persistence, and per-workspace menu filtering. The backend is fully stubbed via route
 * interception (no API/DB needed); we seed the auth token so the app shell doesn't bounce to /login.
 */

interface Me {
  username: string;
  role: string;
  customer_name: string | null;
  permissions: string[];
  must_change_password?: boolean;
}

const CASHIER: Me = { username: 'cashier1', role: 'Cashier', customer_name: 'T1', permissions: ['pos_sell'] };
const ADMIN: Me = { username: 'admin', role: 'Admin', customer_name: null, permissions: [] };

async function bootAs(page: Page, me: Me) {
  // Seed the readable CSRF cookie before any app script runs so hasSession() is true and the shell
  // stays put (auth now rides an httpOnly cookie; the JS-readable ierp_csrf cookie is the session signal).
  await page.addInitScript(() => {
    document.cookie = 'ierp_csrf=e2e; path=/';
  });
  // Stub every API call — `me`, module flags, and the dashboards' data sources.
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(me);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/pos/summary')) return json({ total_orders: 3, total_sales: 1500, total_tax: 98, total_discount: 0, avg_order_value: 500, top_items: [], by_payment: [] });
    if (url.includes('/api/pos/sessions')) return json({ sessions: [] });
    if (url.includes('/api/pos/orders')) return json({ orders: [], count: 0 });
    if (url.includes('/api/dashboard/sales-trend')) return json({ days: 14, trend: [] });
    if (url.includes('/api/dashboard')) return json({ today: { sales: 1000, orders: 5 }, month: { sales: 30000, orders: 120 }, low_stock_count: 0, outstanding_ap: 0, top_items_today: [], recent_orders: [] });
    return json({});
  });
}

const tabs = (page: Page) => page.getByRole('tablist', { name: 'Workspace' });
const tab = (page: Page, name: 'ERP' | 'POS') => tabs(page).getByRole('tab', { name, exact: true });
// Scope to SIDEBAR menu links only — the POS home also renders quick-action <a href> buttons
// (e.g. /pos, /branches), so an unscoped `a[href=...]` would match 2 elements (strict-mode violation).
const navLink = (page: Page, href: string) => page.locator(`a[data-sidebar="menu-button"][href="${href}"]`);

test('POS-only operator is redirected from the ERP home to the POS home on first landing', async ({ page }) => {
  await bootAs(page, CASHIER); // no saved workspace → role-based default = POS
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/pos-home$/);
  await expect(tab(page, 'POS')).toHaveAttribute('aria-selected', 'true');
});

test('switcher filters the menu and navigates between the two workspace homes', async ({ page }) => {
  await bootAs(page, ADMIN); // Admin → default ERP
  await page.goto('/dashboard');

  // ERP view: an ERP-only item is visible, a POS-only item is not.
  await expect(tab(page, 'ERP')).toHaveAttribute('aria-selected', 'true');
  await expect(navLink(page, '/procurement')).toBeVisible();
  await expect(navLink(page, '/pos')).toHaveCount(0);

  // Switch to POS → navigates to /pos-home and the menu flips.
  await tab(page, 'POS').click();
  await expect(page).toHaveURL(/\/pos-home$/);
  await expect(tab(page, 'POS')).toHaveAttribute('aria-selected', 'true');
  await expect(navLink(page, '/pos')).toBeVisible();
  await expect(navLink(page, '/procurement')).toHaveCount(0);

  // Switch back to ERP → back to /dashboard.
  await tab(page, 'ERP').click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(navLink(page, '/procurement')).toBeVisible();
});

test('workspace choice persists across a reload (localStorage)', async ({ page }) => {
  await bootAs(page, ADMIN);
  await page.goto('/dashboard');
  await tab(page, 'POS').click();
  await expect(page).toHaveURL(/\/pos-home$/);
  expect(await page.evaluate(() => localStorage.getItem('ie-workspace'))).toBe('pos');

  await page.reload();
  await expect(tab(page, 'POS')).toHaveAttribute('aria-selected', 'true');
  await expect(navLink(page, '/pos')).toBeVisible();
});

test('dual-use item (Branches) is cross-listed in both workspaces', async ({ page }) => {
  await bootAs(page, ADMIN);
  await page.goto('/dashboard');
  await expect(navLink(page, '/branches')).toBeVisible(); // ERP
  await tab(page, 'POS').click();
  await expect(page).toHaveURL(/\/pos-home$/);
  await expect(navLink(page, '/branches')).toBeVisible(); // POS too
});

test('System settings sub-sections are collapsible and reachable', async ({ page }) => {
  await bootAs(page, ADMIN);
  await page.goto('/dashboard');

  // A "ตั้งค่าระบบ" item lives inside the "ข้อมูลหลัก" sub-section and is visible (sub-sections open by default).
  await expect(navLink(page, '/master-data')).toBeVisible();
  const subHeader = page.getByRole('button', { name: 'ข้อมูลหลัก', exact: true });
  await expect(subHeader).toHaveAttribute('aria-expanded', 'true');

  // Advanced sub-sections (defaultOpen: false) start collapsed — their items hidden until expanded.
  const advHeader = page.getByRole('button', { name: 'ปรับแต่ง', exact: true });
  await expect(advHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(navLink(page, '/automation')).toBeHidden();
  await advHeader.click();
  await expect(navLink(page, '/automation')).toBeVisible();

  // Collapse the sub-section → its items hide; the header stays.
  await subHeader.click();
  await expect(subHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(navLink(page, '/master-data')).toBeHidden();

  // Re-expand → item returns.
  await subHeader.click();
  await expect(navLink(page, '/master-data')).toBeVisible();
});

test('Finance group is split into PEAK-style cycle sub-sections', async ({ page }) => {
  await bootAs(page, ADMIN);
  await page.goto('/dashboard');

  // The daily book sub-section is open by default and exposes /finance.
  const arap = page.getByRole('button', { name: 'รายรับ–รายจ่าย (AR/AP)', exact: true });
  await expect(arap).toHaveAttribute('aria-expanded', 'true');
  await expect(navLink(page, '/finance')).toBeVisible();

  // Advanced multi-entity/FX sub-section (defaultOpen: false) starts collapsed; /fx hidden until expanded.
  const fxHeader = page.getByRole('button', { name: 'ระหว่างบริษัท & สกุลเงิน', exact: true });
  await expect(fxHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(navLink(page, '/fx')).toBeHidden();
  await fxHeader.click();
  await expect(navLink(page, '/fx')).toBeVisible();
});

test('Finance ?tab= deep-link opens the matching PEAK-style cycle tab', async ({ page }) => {
  await bootAs(page, ADMIN);
  // Stub the finance endpoints with their real shapes so the page renders (DataTable needs real arrays).
  // Registered after bootAs → takes precedence; ordered specific-before-generic.
  await page.route('**/api/finance/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/finance/kpi')) return json({ mtd_revenue: 0, ytd_revenue: 0, ar_outstanding: 0, ap_outstanding: 0 });
    if (url.includes('/ar/aging')) return json({ total: 0, buckets: {} });
    if (url.includes('/ap/aging')) return json({ total: 0, buckets: {} });
    if (url.includes('/ar/collections')) return json({ rows: [] });
    if (url.includes('/ar/write-offs')) return json({ write_offs: [] });
    if (url.includes('/ap/payments/pending')) return json({ payments: [] });
    if (url.includes('/finance/ap')) return json({ transactions: [] });
    if (url.includes('/finance/ar')) return json({ invoices: [] });
    return json({});
  });

  // Deep-link straight to the payables cycle (as the dashboard action center does).
  // `exact: true` — the AP/AR section <h2> shares a substring with the aging sub-header
  // (e.g. "เจ้าหนี้ (AP)" vs "อายุเจ้าหนี้ (AP) · …"), and getByRole name is a substring match by default.
  await page.goto('/finance?tab=payables');
  await expect(page.getByRole('tab', { name: 'รายจ่าย (AP)' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'เจ้าหนี้ (AP)', exact: true })).toBeVisible();

  // Switching tabs writes the param back so the view stays shareable.
  await page.getByRole('tab', { name: 'รายรับ (AR)' }).click();
  await expect(page.getByRole('heading', { name: 'ลูกหนี้ (AR)', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/[?&]tab=receivables/);
});

test('starring a menu item pins it to the Favourites group and persists across reload', async ({ page }) => {
  await bootAs(page, ADMIN);
  await page.goto('/dashboard');

  // Star /procurement via its hover menu-action button.
  const procItem = page.locator('li[data-sidebar="menu-item"]', { has: page.locator('a[href="/procurement"]') });
  await procItem.locator('button[data-sidebar="menu-action"]').click();

  // It now appears under the "รายการโปรด" (Favourites) group, pinned at the top.
  const favGroup = page.locator('div[data-sidebar="group"]', { has: page.getByText('รายการโปรด', { exact: true }) });
  await expect(favGroup.locator('a[href="/procurement"]')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ie-nav-favorites'))).toContain('/procurement');

  // Survives a reload.
  await page.reload();
  await expect(favGroup.locator('a[href="/procurement"]')).toBeVisible();

  // Un-star from the favourites entry (its unpin control) → the group disappears.
  await favGroup
    .locator('li[data-sidebar="menu-item"]')
    .first()
    .getByRole('button', { name: /ออกจากรายการโปรด/ })
    .click();
  await expect(page.getByText('รายการโปรด', { exact: true })).toHaveCount(0);
});

test('server-saved favourites hydrate the sidebar and toggles are persisted to /api/user-prefs', async ({ page }) => {
  await bootAs(page, ADMIN);
  // Override the generic stub for the prefs endpoint (registered after bootAs → takes precedence).
  const puts: Array<{ favorites?: string[]; navFold?: Record<string, boolean> }> = [];
  await page.route('**/api/user-prefs', async (route) => {
    const req = route.request();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'GET') return json({ favorites: ['/procurement'], navFold: { 'nav.sub.customise': true }, saved: true });
    if (req.method() === 'PUT') {
      puts.push(JSON.parse(req.postData() || '{}'));
      return json({ favorites: [], navFold: {}, saved: true });
    }
    return json({});
  });
  await page.goto('/dashboard');

  // The server-saved favourite hydrates into the Favourites group even though localStorage started empty.
  const favGroup = page.locator('div[data-sidebar="group"]', { has: page.getByText('รายการโปรด', { exact: true }) });
  await expect(favGroup.locator('a[href="/procurement"]')).toBeVisible();
  // The server-saved fold-state is applied: ปรับแต่ง (collapsed by default) is now expanded.
  await expect(page.getByRole('button', { name: 'ปรับแต่ง', exact: true })).toHaveAttribute('aria-expanded', 'true');

  // Starring another item issues a PUT carrying the updated favourites.
  const invItem = page.locator('li[data-sidebar="menu-item"]', { has: page.locator('a[href="/inventory"]') });
  await invItem.locator('button[data-sidebar="menu-action"]').click();
  await expect.poll(() => puts.some((p) => p.favorites?.includes('/inventory'))).toBeTruthy();
});

test('favourites and recents surface at the top of the command palette', async ({ page }) => {
  await bootAs(page, ADMIN);
  await page.goto('/dashboard');

  // Pin an item, then open the ⌘K palette.
  await page
    .locator('li[data-sidebar="menu-item"]', { has: page.locator('a[href="/inventory"]') })
    .locator('button[data-sidebar="menu-action"]')
    .click();
  await page.keyboard.press('Control+k');

  // The Favourites group is rendered at the top of the palette.
  await expect(page.getByText('★ รายการโปรด', { exact: true })).toBeVisible();
});

test('favourites can be reordered with the move up/down controls', async ({ page }) => {
  await bootAs(page, ADMIN);
  await page.goto('/dashboard');
  const star = (href: string) =>
    page
      .locator('li[data-sidebar="menu-item"]', { has: page.locator(`a[href="${href}"]`) })
      .locator('button[data-sidebar="menu-action"]')
      .first();
  await star('/inventory').click();
  await star('/finance').click(); // newest-first → favourites = [/finance, /inventory]

  const favGroup = page.locator('div[data-sidebar="group"]', { has: page.getByText('รายการโปรด', { exact: true }) });
  const firstFav = () => favGroup.locator('a[data-sidebar="menu-button"]').first();
  await expect(firstFav()).toHaveAttribute('href', '/finance');

  // Move the first favourite down → order flips.
  await favGroup.locator('li[data-sidebar="menu-item"]').first().getByRole('button', { name: /ย้าย .* ลง/ }).click();
  await expect(firstFav()).toHaveAttribute('href', '/inventory');
});
