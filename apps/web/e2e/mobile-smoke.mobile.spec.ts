import { test, expect, type Page } from '@playwright/test';

/**
 * Phone-viewport regression for the screens that were hardened for mobile (Requisitions, Shop, POS
 * Register). These run ONLY under the `mobile-iphone` Playwright project (iPhone 13 metrics, isMobile) —
 * see playwright.config.ts — so they exercise the responsive layers that are display:none above the
 * `sm`/`lg` breakpoints and would never render at the Desktop Chrome viewport the other specs use.
 *
 * Each assertion targets a MOBILE-SPECIFIC element (a `sm:hidden` card list, an `xl:hidden` floating basket
 * button, the phone-width menu grid), so a regression that reflowed these back into a squeezed desktop table/row
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

// ── Expense-approvals queue (ESS pending employee claims) ────────────────────
const EXPENSES = {
  count: 1,
  pending: [{ id: 1, claim_date: '2026-07-01', category: 'ค่าเดินทาง', amount: 850, description: 'ค่าแท็กซี่ไปพบลูกค้า', status: 'Pending', emp_code: 'E001', employee_name: 'สมชาย ใจดี' }],
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
    // Expense approvals (ESS)
    if (url.includes('/api/ess/expenses/pending')) return json(EXPENSES);
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
  // Scope to the card container (first sm:hidden div) to avoid matching multiple elements
  const cardList = page.locator('div.sm\\:hidden').first();
  await expect(cardList.getByText('PR-MOB-001')).toBeVisible();
  await expect(cardList.getByText('กระดาษ A4 80 แกรม')).toBeVisible();
});

test('shop: phone shows the floating basket button after adding an item, opens the checkout sheet', async ({ page }) => {
  await boot(page);
  await page.goto('/shop');

  // Catalog card renders, then add it to the basket.
  await expect(page.getByText('กระดาษ A4 80 แกรม')).toBeVisible();
  const addButton = page.getByRole('button', { name: 'ใส่ตะกร้า' }).first();
  await addButton.click();

  // Once an item's in the basket, the grid card's add button turns into a −/qty/+ stepper (Shopee-style)
  // so a quantity bump doesn't require opening the basket. The "+" side reuses the same accessible name
  // as the original add button (same action), so re-clicking it should bump 1 → 2.
  await expect(page.getByRole('button', { name: 'ลดจำนวน' })).toBeVisible();
  await addButton.click();

  // The floating basket button is `xl:hidden` — present on phones and tablets alike, display:none only at
  // true desktop widths (which get the side-by-side basket sidebar instead). Its accessible name is the
  // "ดูตะกร้า" (view basket) aria-label; it shows the running subtotal, which confirms the stepper's second
  // tap actually bumped the quantity to 2 (120 × 2) rather than just re-showing the same line.
  const fab = page.getByRole('button', { name: 'ดูตะกร้า' });
  await expect(fab).toBeVisible();
  await expect(fab).toContainText('฿240.00');

  // Tapping it opens the basket in a bottom sheet (not a scroll-to-sidebar) so checkout is reachable
  // instantly regardless of catalog scroll position — the sheet must show the line + the submit button.
  await fab.click();
  const sheetCheckout = page.getByRole('button', { name: 'ส่งคำขอซื้อให้จัดซื้อ' });
  await expect(sheetCheckout).toBeVisible();
  await expect(page.getByText('กระดาษ A4 80 แกรม').last()).toBeVisible();
});

test('shop: phone shows a grid-shaped skeleton while the catalog is still loading', async ({ page }) => {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {}, shop_favs: [], shop_templates: [] });
    if (url.includes('/api/pmr/projects')) return json({ projects: [], count: 0 });
    if (url.includes('/api/procurement/low-stock')) return json({ items: [], count: 0 });
    if (url.includes('/api/procurement/prs')) return json({ can_approve: true, prs: [] });
    if (url.includes('/api/procurement/catalog')) {
      // Hold the catalog response open so the loading state is observable, instead of racing a real
      // network delay (which would make this test flaky under CI load).
      await new Promise((r) => setTimeout(r, 800));
      return json(CATALOG);
    }
    return json({});
  });
  await page.goto('/shop');

  // Skeleton tiles (data-slot="skeleton") stand in for the grid while `catalog.isLoading` is true.
  await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
  await expect(page.getByText('กระดาษ A4 80 แกรม')).not.toBeVisible();

  // Once the (deliberately delayed) response lands, the real grid replaces the skeleton.
  await expect(page.getByText('กระดาษ A4 80 แกรม')).toBeVisible();
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
});

test('shop: phone has no horizontal page overflow with a realistic multi-category catalog', async ({ page }) => {
  // Regression for a real-device bug: the catalog+basket layout grid had no explicit column template
  // below `xl` (only `xl:grid-cols-[1fr_360px]`), so it fell back to an implicit auto-sized track that
  // grows to fit content instead of clamping to the viewport. The 1-item/1-category CATALOG fixture used
  // by the other shop tests is too small to expose it — the category-chips row (many whitespace-nowrap
  // chips, one per category) only overflows the page once there are enough real categories, as on
  // production's 193-item / 8-category catalog.
  const WIDE_CATEGORIES = [
    ['kitchen_prep', 'ของเตรียมครัว (Kitchen Prep)', 32], ['prepared', 'ของแปรรูป (Prepared)', 38],
    ['fresh', 'ของสด (Fresh)', 12], ['rice', 'ข้าว (Rice)', 1], ['seasoning', 'เครื่องปรุง (Seasoning)', 18],
    ['frozen', 'แช่แข็ง/อื่นๆ (Frozen & Other)', 8], ['sauce', 'ซอส/เครื่องปรุง', 20], ['office', 'สำนักงาน', 10],
  ] as const;
  const WIDE_CATALOG = {
    items: Array.from({ length: 24 }, (_, i) => ({
      item_id: `ITM-${i + 1}`, item_description: `สินค้า ${i + 1}`, uom: 'EA', unit_price: 20 + i, image_key: null,
      category: WIDE_CATEGORIES[i % WIDE_CATEGORIES.length][1], category_key: WIDE_CATEGORIES[i % WIDE_CATEGORIES.length][0],
      on_hand: 10, last_price: 18,
    })),
    categories: WIDE_CATEGORIES.map(([key, label, count]) => ({ key, label, count })),
    total: 193, offset: 0, limit: 24, has_more: true, count: 24,
  };
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {}, shop_favs: [], shop_templates: [] });
    if (url.includes('/api/procurement/low-stock')) return json({ items: [], count: 0 });
    if (url.includes('/api/procurement/prs')) return json({ can_approve: true, prs: [] });
    if (url.includes('/api/pmr/projects')) return json({ projects: [], count: 0 });
    if (url.includes('/api/procurement/catalog')) return json(WIDE_CATALOG);
    return json({});
  });
  await page.goto('/shop');
  await expect(page.getByText('สินค้า 1', { exact: true })).toBeVisible();

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBe(clientWidth);
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
  // Scope to the card container (first sm:hidden div) to avoid matching multiple elements
  const card = page.locator('div.sm\\:hidden').first();
  await expect(card.getByText('S-240706-01')).toBeVisible();
  await expect(card.getByText('REV-13')).toBeVisible();
  await expect(card.getByRole('button', { name: 'อนุมัติ' })).toBeVisible();
});

test('expense-approvals: phone renders the claim cards with inline actions and no page overflow', async ({ page }) => {
  await boot(page);
  await page.goto('/expense-approvals');

  // The ESS pending-claim queue renders BOTH a `sm:hidden` card list (phones) and a `hidden sm:block`
  // DataTable (tablet+). At the phone viewport the desktop table must be display:none and the card must
  // show — with the batch checkbox + inline approve/reject thumb targets.
  await expect(page.locator('table', { hasText: 'สมชาย ใจดี' })).toBeHidden();
  const card = page.locator('div.sm\\:hidden').first();
  await expect(card.getByText('สมชาย ใจดี')).toBeVisible();
  await expect(card.getByText('ค่าแท็กซี่ไปพบลูกค้า')).toBeVisible();
  await expect(card.getByRole('button', { name: 'อนุมัติ' })).toBeVisible();

  // The critical mobile invariant: no element wider than the viewport (an overflow would shift any
  // fixed bottom-sheet/bar off-screen).
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBe(clientWidth);
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
