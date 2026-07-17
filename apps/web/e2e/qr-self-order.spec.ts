import { test, expect, type Page } from '@playwright/test';

/**
 * QR diner self-ordering — interactive smoke test for the public ordering UI.
 * The backend is fully stubbed via route interception (no API/DB needed): we mock the public QR
 * endpoints and assert the diner can browse the menu, add to cart, and submit an order that then
 * shows up on the order-status tab. Runs against the production build (see playwright.config.ts).
 */

const MENU = {
  categories: [
    { id: 1, code: 'main', name: 'อาหารจานหลัก', items: [
      { id: 1, sku: 'A1', name: 'ผัดไทยกุ้งสด', price: 80, is_available: true, description: null, has_modifiers: false, modifier_groups: [] },
    ] },
  ],
  uncategorized: [],
  item_count: 1,
};

const statusOpen = { table_no: '5', session_status: 'open', order_mode: 'a_la_carte', buffet: null, order: null, bill: null };
const statusOrdered = {
  table_no: '5', session_status: 'open', order_mode: 'a_la_carte', buffet: null,
  order: { order_no: 'DIN-20260623-009', status: 'sent_to_kitchen', waited_min: 0, ready_in_min: 8,
    items: [{ item_id: 1, name: 'ผัดไทยกุ้งสด', qty: 1, kds_status: 'queued', status_th: 'รอคิว', amount: 80, is_buffet: false, charge: false }] },
  bill: { subtotal: 80, vat: 5.6, total: 85.6, settled: false },
};

async function stub(page: Page) {
  let ordered = false;
  await page.route('**/api/qr/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/menu')) return json(MENU);
    if (url.includes('/buffet/tiers')) return json({ tiers: [] });
    if (url.endsWith('/order') && method === 'POST') { ordered = true; return json(statusOrdered); }
    // base status poll
    return json(ordered ? statusOrdered : statusOpen);
  });
}

test('diner browses the menu, adds an item, and submits an order', async ({ page }) => {
  await stub(page);
  await page.goto('/qr/e2e-token');

  // lands on the order tab for an empty session
  await expect(page.getByText('โต๊ะ 5')).toBeVisible();

  // switch to the menu and add the (modifier-less) item straight to the cart
  await page.getByRole('tab', { name: 'เมนู' }).click();
  await expect(page.getByText('ผัดไทยกุ้งสด')).toBeVisible();
  await page.getByRole('button', { name: /ผัดไทยกุ้งสด/ }).click();

  // cart bar appears → open it and send the order to the kitchen
  const cartBar = page.getByRole('button', { name: /ตะกร้า \(1\)/ });
  await expect(cartBar).toBeVisible();
  await cartBar.click();
  await page.getByRole('button', { name: 'ส่งออเดอร์เข้าครัว' }).click();

  // the order now shows on the status tab with its kitchen state. The dish name also exists in the
  // (now-hidden or overlaid) menu list and cart, so an unscoped getByText intermittently trips a
  // strict-mode violation (bit PR #777) — assert on the VISIBLE occurrence only.
  await expect(page.getByText('ผัดไทยกุ้งสด').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('รอคิว')).toBeVisible();
});
