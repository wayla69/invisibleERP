import { test, expect, type Page } from '@playwright/test';

/**
 * docs/51 Track B — SME industry-aware nav folding (B1) + the "show hidden menus" escape hatch (B2).
 * Proves in a real browser what the unit test can only assert structurally: an SME tenant stamped with a
 * restaurant profile hides the industry-irrelevant domains, opens only the industry's daily-work groups,
 * folds every other subgroup, and lets the user reveal the hidden domains themselves. Backend fully
 * stubbed via route interception (same recipe as workspace-split.spec.ts).
 */

interface Me {
  username: string;
  role: string;
  customer_name: string | null;
  permissions: string[];
  control_profile?: 'enterprise' | 'sme';
  sme_hidden_nav_groups?: string[];
  sme_open_nav_groups?: string[];
}

// The restaurant profile exactly as provisioning stamps it (@ierp/shared nav-profiles.ts).
const SME_RESTO: Me = {
  username: 'sme_owner',
  role: 'Admin',
  customer_name: null,
  permissions: [],
  control_profile: 'sme',
  sme_hidden_nav_groups: ['nav.group.projects'],
  sme_open_nav_groups: ['nav.group.overview', 'nav.group.pos_sales', 'nav.sub.pos_frontline', 'nav.sub.pos_dining'],
};
const ENTERPRISE_ADMIN: Me = { username: 'admin', role: 'Admin', customer_name: null, permissions: [] };

async function bootAs(page: Page, me: Me) {
  await page.addInitScript(() => {
    document.cookie = 'ierp_csrf=e2e; path=/';
  });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(me);
    // Keep the SME first-run wizard (docs/49 v1.3) closed — it renders as a modal Dialog over the shell
    // and would block every sidebar interaction this spec asserts.
    if (url.includes('/api/user-prefs')) return json({ sme_wizard_done: true, favorites: [], navFold: {} });
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/dashboard/sales-trend')) return json({ days: 14, trend: [] });
    if (url.includes('/api/dashboard')) return json({ today: { sales: 0, orders: 0 }, month: { sales: 0, orders: 0 }, low_stock_count: 0, outstanding_ap: 0, top_items_today: [], recent_orders: [] });
    if (url.includes('/api/pos/summary')) return json({ total_orders: 0, total_sales: 0, total_tax: 0, total_discount: 0, avg_order_value: 0, top_items: [], by_payment: [] });
    return json({});
  });
}

const domainHeader = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const navLink = (page: Page, href: string) => page.locator(`a[data-sidebar="menu-button"][href="${href}"]`);

test('SME restaurant: industry-hidden domain is gone; other domains fold; subgroups default folded', async ({ page }) => {
  await bootAs(page, SME_RESTO);
  await page.goto('/dashboard');
  await expect(navLink(page, '/dashboard')).toBeVisible(); // shell rendered (overview open — active + listed)

  // B1: the hidden domain (โครงการ / nav.group.projects) is absent from the sidebar entirely.
  await expect(domainHeader(page, 'โครงการ')).toHaveCount(0);

  // A kept-but-unlisted domain starts collapsed…
  await expect(domainHeader(page, 'ซัพพลายเชน')).toHaveAttribute('aria-expanded', 'false');
  await domainHeader(page, 'ซัพพลายเชน').click();
  // …and under an SME profile its subgroups default FOLDED too (pre-B1 default was open).
  await expect(domainHeader(page, 'สินค้าคงคลัง')).toHaveAttribute('aria-expanded', 'false');
  await expect(navLink(page, '/inventory')).toBeHidden();
  await domainHeader(page, 'สินค้าคงคลัง').click(); // the user's own toggle still works
  await expect(navLink(page, '/inventory')).toBeVisible();
});

test('SME restaurant: POS workspace opens the industry groups with frontline items visible, rest folded', async ({ page }) => {
  await bootAs(page, SME_RESTO);
  await page.goto('/dashboard');
  // An Admin's default workspace is ERP — switch to POS via the workspace tab (like workspace-split.spec).
  await page.getByRole('tablist', { name: 'Workspace' }).getByRole('tab', { name: 'POS', exact: true }).click();
  await expect(page).toHaveURL(/\/pos-home$/);

  // nav.group.pos_sales is in the stamped open list → expanded without any clicks, and the listed
  // frontline + dining subgroups show their items immediately (the "~15 items on first login").
  await expect(domainHeader(page, 'ขายหน้าร้าน')).toHaveAttribute('aria-expanded', 'true');
  await expect(navLink(page, '/pos/register')).toBeVisible(); // ขาย & ออเดอร์ (listed sub)
  await expect(navLink(page, '/tables')).toBeVisible(); // โต๊ะ & ครัว (listed sub)
  await expect(navLink(page, '/pos/till')).toBeHidden(); // กะ & ควบคุม — unlisted sub stays folded

  // An unlisted POS domain starts collapsed.
  await expect(domainHeader(page, 'ร้าน & อุปกรณ์')).toHaveAttribute('aria-expanded', 'false');
});

test('B2: the "show hidden menus" toggle reveals the industry-hidden domain and folds it back', async ({ page }) => {
  await bootAs(page, SME_RESTO);
  await page.goto('/dashboard');
  await expect(navLink(page, '/dashboard')).toBeVisible();

  const toggle = page.getByRole('button', { name: 'แสดงเมนูที่ซ่อนไว้', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(domainHeader(page, 'โครงการ')).toBeVisible(); // hidden domain revealed, no god needed
  await toggle.click();
  await expect(domainHeader(page, 'โครงการ')).toHaveCount(0);
});

test('enterprise regression: no SME toggle, subgroups still default open', async ({ page }) => {
  await bootAs(page, ENTERPRISE_ADMIN);
  await page.goto('/dashboard');
  await expect(navLink(page, '/dashboard')).toBeVisible();

  await expect(page.getByRole('button', { name: 'แสดงเมนูที่ซ่อนไว้', exact: true })).toHaveCount(0);
  await expect(domainHeader(page, 'โครงการ')).toBeVisible(); // nothing hidden
  await domainHeader(page, 'ซัพพลายเชน').click();
  await expect(navLink(page, '/inventory')).toBeVisible(); // pre-B1 subgroup default (open) unchanged
});
