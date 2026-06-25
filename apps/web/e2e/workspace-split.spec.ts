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

  // Collapse the sub-section → its items hide; the header stays.
  await subHeader.click();
  await expect(subHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(navLink(page, '/master-data')).toBeHidden();

  // Re-expand → item returns.
  await subHeader.click();
  await expect(navLink(page, '/master-data')).toBeVisible();
});
