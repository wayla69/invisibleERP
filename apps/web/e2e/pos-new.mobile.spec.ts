import { test, expect, type Page } from '@playwright/test';

/**
 * Phone-viewport REAL-TAP regression for /pos/new — the quick manual-sale form (custom two-column grid
 * + quick-tender buttons, NOT a DataTable page). Follows the receiving.mobile.spec.ts recipe: drive the
 * whole flow with ordinary taps (Playwright actionability fails a click whose target is covered by
 * another element — the "ปุ่มซ้อนกัน/กดไม่ได้" class), assert NO horizontal overflow after every stage
 * (an overflow shifts fixed surfaces off-screen), and assert the captured POST body — so a layout
 * regression OR a payload regression both fail loudly. mobile-iphone project only; all /api/** stubbed.
 */

const ME = { username: 'cashier01', role: 'Admin', customer_name: 'AMBER', permissions: ['pos', 'pos_sell', 'order_mgt'] };

async function boot(page: Page) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  const posted: unknown[] = [];
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/pos/orders') && route.request().method() === 'POST') {
      posted.push(route.request().postDataJSON());
      return json({ order_no: 'S-1024', total: 340, points_earned: 3 });
    }
    return json({});
  });
  return posted;
}

async function assertNoHorizontalOverflow(page: Page, stage: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontal overflow at: ${stage}`).toBeLessThanOrEqual(0);
}

test('pos/new — two-line quick sale with real taps: add line, exact tender, confirm', async ({ page }) => {
  const posted = await boot(page);
  await page.goto('/pos/new');

  // Empty form: confirm is disabled until a line has an item + qty.
  const confirm = page.getByRole('button', { name: 'ยืนยันออเดอร์' });
  await expect(confirm).toBeDisabled();
  await assertNoHorizontalOverflow(page, 'empty form');

  // Line 1 — fill code / qty / unit price by their aria-labels.
  await page.getByLabel('รหัสสินค้า รายการที่ 1').fill('ITM-100');
  await page.getByLabel('จำนวน รายการที่ 1').fill('2');
  await page.getByLabel('ราคาต่อหน่วย รายการที่ 1').fill('120');

  // Line 2 via the add-line button (real tap), then fill it.
  await page.getByRole('button', { name: 'เพิ่มรายการ' }).click();
  await page.getByLabel('รหัสสินค้า รายการที่ 2').fill('ITM-200');
  await page.getByLabel('จำนวน รายการที่ 2').fill('1');
  await page.getByLabel('ราคาต่อหน่วย รายการที่ 2').fill('100');
  await assertNoHorizontalOverflow(page, 'two lines filled');

  // Quick tender: "พอดี" (exact) fills the cash-received input; must be tappable on the phone layout.
  await page.getByRole('button', { name: 'พอดี' }).click();

  await expect(confirm).toBeEnabled();
  await confirm.click();

  // The POST body is the payload contract: both lines, as typed.
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toMatchObject({
    items: [
      { item_id: 'ITM-100', order_qty: 2, unit_price: 120 },
      { item_id: 'ITM-200', order_qty: 1, unit_price: 100 },
    ],
  });

  // Success surface shows the created order number and the page still fits the viewport.
  await expect(page.getByText('S-1024').first()).toBeVisible();
  await assertNoHorizontalOverflow(page, 'order created');
});
