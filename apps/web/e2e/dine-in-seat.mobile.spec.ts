import { test, expect, type Page } from '@playwright/test';

/**
 * POS-9 (seat-level ordering) phone-viewport regression. Runs ONLY under the `mobile-iphone` project
 * (iPhone 13 metrics) — see playwright.config.ts. The dine-in order dialog gained a course+seat row and a
 * per-line seat badge; on a phone that row must WRAP (not push the modal wider than the viewport), and the
 * dialog must stay inside the viewport — a horizontal overflow anywhere shifts fixed/dialog layers off-screen
 * (see CLAUDE.md). All /api/** calls are stubbed (no backend/DB).
 */

const ME = { username: 'amber', role: 'Admin', customer_name: 'AMBER', permissions: ['pos'] };
const BOARD = { tables: [{ id: 1, table_no: 'A1', seats: 4, status: 'occupied', order: null, zone_id: null }] };
const MENU = {
  categories: [{ name: 'จานหลัก', items: [{ sku: 'GP01', name: 'ผัดกะเพราไก่', price: 100 }] }],
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
    if (url.includes('/api/restaurant/tables/status')) return json(BOARD);
    if (url.includes('/api/restaurant/zones')) return json({ zones: [] });
    if (url.endsWith('/api/menu')) return json(MENU);
    return json({});
  });
}

test('dine-in dialog: seat control renders and the modal fits the phone viewport (no overflow)', async ({ page }) => {
  await boot(page);
  await page.goto('/tables');

  // The floor grid renders one table card with an "สั่งอาหาร" (order food) action → opens the dine-in dialog.
  await page.getByRole('button', { name: 'สั่งอาหาร' }).first().click();

  // The seat row (POS-9) is part of the dialog and always visible — its label proves the control mounted.
  const seatLabel = page.getByText('ที่นั่งสำหรับรายการที่เพิ่ม');
  await expect(seatLabel).toBeVisible();
  await expect(page.getByText('คอร์สสำหรับรายการที่เพิ่ม')).toBeVisible();

  // No horizontal page overflow at 390px — an overflow would push the modal/fixed layers off-screen.
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBe(clientWidth);

  // The dialog itself stays within the viewport width.
  const dialog = page.getByRole('dialog');
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(clientWidth + 1);
});
