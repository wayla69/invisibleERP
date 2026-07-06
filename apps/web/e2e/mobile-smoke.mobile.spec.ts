import { test, expect, type Page } from '@playwright/test';

/**
 * Phone-viewport regression for the screens that were hardened for mobile (Requisitions, Shop, POS
 * Register). These run ONLY under the `mobile-iphone` Playwright project (iPhone 13 metrics, isMobile) —
 * see playwright.config.ts — so they exercise the responsive layers that are display:none above the
 * `sm`/`lg` breakpoints and would never render at the Desktop Chrome viewport the other specs use.
 *
 * Each assertion targets a MOBILE-SPECIFIC element (a `sm:hidden` card list, an `lg:hidden` bottom bar,
 * the phone-width menu grid), so a regression that reflowed these back into a squeezed desktop table/row
 * fails here even though the desktop specs stay green. All /api/** calls are stubbed (no backend/DB).
 */

const ME = { username: 'amber', role: 'Admin', customer_name: 'AMBER', permissions: ['pr_raise', 'pos_sell'] };

// ── Requisitions register ────────────────────────────────────────────────────
const PRS = {
  can_approve: true,
  prs: [{
    pr_no: 'PR-MOB-001', pr_date: '2026-07-06', requested_by: 'amber', status: 'Approved', priority: 'Normal', approved_by: 'boss',
    lines: [{ id: 1, item_id: 'A4-PAPER', item_description: 'กระดาษ A4 80 แกรม', request_qty: 3, uom: 'REAM', reason: null, po_no: null, line_status: 'Open' }],
  }],
};

// ── Shop catalog ─────────────────────────────────────────────────────────────
const CATALOG = {
  items: [{ item_id: 'A4-PAPER', item_description: 'กระดาษ A4 80 แกรม', uom: 'REAM', unit_price: 120, image_key: null, category: 'ทั่วไป', category_key: 'general', on_hand: 10, last_price: 118 }],
  categories: [{ key: 'general', label: 'ทั่วไป', count: 1 }],
  total: 1, offset: 0, limit: 24, has_more: false, count: 1,
};

// ── Approvals queue (GOV-01 pending maker-checker monitor) ───────────────────
const APPROVALS = {
  count: 1, by_type: { till_variance: 1 }, oldest_age_days: 5, overdue_days: 3, overdue: 1, total_amount: 850,
  items: [{ type: 'till_variance', control: 'REV-13', ref: 'S-240706-01', label: 'เงินสดขาด ฿850', amount: 850, requested_by: 'cashier1', requested_at: '2026-07-01T09:00:00Z', age_days: 5 }],
};

// ── POS register menu ────────────────────────────────────────────────────────
const MENU = {
  categories: [{ id: 1, code: 'main', name: 'จานหลัก', name_en: null, color: null, sort: 0, items: [
    { id: 1, sku: 'GP01', name: 'ผัดกะเพราไก่', name_en: null, type: 'food', price: 100, station_code: 'hot', is_available: true, available_now: true, has_modifiers: false },
  ] }],
  uncategorized: [], item_count: 1,
};

async function boot(page: Page) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {}, shop_favs: [], shop_templates: [] });
    // Requisitions
    if (url.includes('/api/procurement/low-stock')) return json({ items: [], count: 0 });
    if (url.includes('/api/procurement/prs')) return json(PRS);
    // Shop
    if (url.includes('/api/pmr/projects')) return json({ projects: [], count: 0 });
    if (url.includes('/api/procurement/catalog')) return json(CATALOG);
    // Approvals
    if (url.includes('/api/finance/approvals/pending')) return json(APPROVALS);
    if (url.includes('/api/payments/exceptions/voids-refunds')) return json({ voids: [], refunds: [], void_count: 0, refund_count: 0, void_total: 0, refund_total: 0 });
    if (url.includes('/api/tax-invoices/exceptions/voided')) return json({ voided: [], count: 0, total: 0 });
    // POS register
    if (url.endsWith('/api/menu')) return json(MENU);
    if (url.includes('/api/pos/held')) return json({ held: [] });
    if (url.includes('/api/restaurant/tables')) return json({ tables: [] });
    if (url.includes('/api/pos/orders')) return json({ orders: [], count: 0 });
    return json({});
  });
}

test('requisitions: phone renders the PR card list, not the desktop table', async ({ page }) => {
  await boot(page);
  await page.goto('/requisitions');

  // The register renders BOTH layers into the DOM: a `sm:hidden` card list (phones) and a `hidden sm:block`
  // <table> (tablet+). At the phone viewport the table must be display:none and the card list must show.
  await expect(page.getByText('คำขอซื้อล่าสุด')).toBeVisible();
  await expect(page.locator('table')).toBeHidden();
  await expect(page.locator('div.sm\\:hidden').getByText('PR-MOB-001')).toBeVisible();
  await expect(page.locator('div.sm\\:hidden').getByText('กระดาษ A4 80 แกรม')).toBeVisible();
});

test('shop: phone shows the pinned bottom checkout bar after adding an item', async ({ page }) => {
  await boot(page);
  await page.goto('/shop');

  // Catalog card renders, then add it to the basket.
  await expect(page.getByText('กระดาษ A4 80 แกรม')).toBeVisible();
  await page.getByRole('button', { name: 'ใส่ตะกร้า' }).first().click();

  // The Shopee/Grab-style bottom checkout bar is `lg:hidden` — present only below the `lg` breakpoint, so
  // it is visible at the phone viewport and would be display:none on desktop. Its accessible name is the
  // "ดูตะกร้า" (view basket) aria-label.
  const bar = page.getByRole('button', { name: 'ดูตะกร้า' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('1 รายการ');
});

test('approvals: phone renders the pending-approval cards with inline actions, not the table', async ({ page }) => {
  await boot(page);
  await page.goto('/approvals');

  // The GOV-01 queue renders BOTH a `sm:hidden` card list (phones) and a `hidden sm:block` DataTable
  // (tablet+). At the phone viewport the desktop table must be display:none and the card must show —
  // including the full-width approve/reject thumb targets for the till-variance item. (The page also has
  // two always-visible exception-report tables, so scope the hidden-table check to the one holding the
  // pending ref.)
  await expect(page.locator('table', { hasText: 'S-240706-01' })).toBeHidden();
  const card = page.locator('div.sm\\:hidden');
  await expect(card.getByText('S-240706-01')).toBeVisible();
  await expect(card.getByText('REV-13')).toBeVisible();
  await expect(card.getByRole('button', { name: 'อนุมัติ' })).toBeVisible();
});

test('pos register: menu grid is tappable at phone width and reaches checkout', async ({ page }) => {
  await boot(page);
  await page.goto('/pos/register');

  // The touch register menu grid (grid-cols-3 on a phone) renders and a tile rings into the cart — after
  // which the checkout button appears, proving the register is usable at 390px without a broken reflow.
  await expect(page.getByRole('button', { name: /ผัดกะเพราไก่/ })).toBeVisible();
  await page.getByRole('button', { name: /ผัดกะเพราไก่/ }).click();
  await expect(page.getByRole('button', { name: /ชำระเงิน/ })).toBeVisible();
});
