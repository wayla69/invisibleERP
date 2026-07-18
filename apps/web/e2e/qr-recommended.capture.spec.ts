import { test, expect, type Page } from '@playwright/test';

/**
 * 0434/0435 diner QR (mobile) — recommended row + category filter, list⇄grid toggle, image zoom lightbox,
 * and the "ออเดอร์ของฉัน" fire-lot grouping with the served swap. On-demand capture spec (excluded from CI
 * via `*.capture.spec.ts`); run with the local scratchpad config. Backend fully stubbed.
 */

// 1×1 transparent PNG so the image / zoom / grid paths render
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const MENU = {
  categories: [
    { id: 1, code: 'main', name: 'อาหารจานหลัก', items: [
      { id: 10, sku: 'M1', name: 'ผัดกะเพราไก่', price: 80, is_available: true, is_recommended: true, description: 'เผ็ดกำลังดี', image_url: IMG, has_modifiers: false, modifier_groups: [] },
      { id: 11, sku: 'M2', name: 'ข้าวผัดหมู', price: 70, is_available: true, is_recommended: false, description: null, image_url: IMG, has_modifiers: false, modifier_groups: [] },
    ] },
    { id: 2, code: 'drink', name: 'เครื่องดื่ม', items: [
      { id: 20, sku: 'D1', name: 'ชาเย็น', price: 30, is_available: true, is_recommended: true, description: null, image_url: IMG, has_modifiers: false, modifier_groups: [] },
    ] },
  ],
  uncategorized: [],
  item_count: 3,
};
const statusOpen = { table_no: '7', session_status: 'open', order_mode: 'a_la_carte', buffet: null, order: null, bill: null };

// a status with two fire lots — one fully served, one still cooking
const statusLots = {
  table_no: '7', session_status: 'open', order_mode: 'a_la_carte', buffet: null,
  order: { order_no: 'DIN-1', status: 'partially_ready', waited_min: 12, ready_in_min: 5, items: [
    { item_id: 1, name: 'ผัดกะเพราไก่', qty: 1, kds_status: 'served', status_th: 'เสิร์ฟแล้ว', amount: 80, is_buffet: false, charge: false, fired_at: '2026-07-18T11:30:00Z', served_at: '2026-07-18T11:38:00Z', wait_min: 8 },
    { item_id: 2, name: 'ชาเย็น', qty: 2, kds_status: 'preparing', status_th: 'กำลังปรุง', amount: 60, is_buffet: false, charge: false, fired_at: '2026-07-18T11:45:00Z', served_at: null, wait_min: 6 },
  ] },
  bill: { subtotal: 140, vat: 9.8, total: 149.8, settled: false },
};

async function stubMenu(page: Page) {
  await page.route('**/api/qr/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/menu')) return json(MENU);
    if (url.includes('/buffet/tiers')) return json({ tiers: [] });
    return json(statusOpen);
  });
}

test('diner menu: recommended row, category chips, list⇄grid toggle, image zoom', async ({ page }) => {
  await stubMenu(page);
  await page.goto('/qr/e2e-token');
  await expect(page.getByText('โต๊ะ 7')).toBeVisible();
  await page.getByRole('tab', { name: 'เมนู' }).click();

  // chips + recommended row
  await expect(page.getByRole('button', { name: 'ทั้งหมด' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'แนะนำ', exact: true })).toBeVisible();
  await expect(page.getByText('เมนูแนะนำ')).toBeVisible();
  await page.screenshot({ path: (process.env.SHOT_DIR ?? 'test-results') + '/qr-menu-list.png', fullPage: true });

  // grid toggle → tiles render (grid uses aspect-square image tiles)
  await page.getByRole('button', { name: 'สลับมุมมองรายการ/ตาราง' }).click();
  await expect(page.getByText('ผัดกะเพราไก่').first()).toBeVisible();
  await page.screenshot({ path: (process.env.SHOT_DIR ?? 'test-results') + '/qr-menu-grid.png', fullPage: true });

  // zoom: tap an image tile's ⛶ (the inner zoom control, exact name) → full-screen lightbox
  await page.getByRole('button', { name: 'ขยายรูป', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: (process.env.SHOT_DIR ?? 'test-results') + '/qr-menu-zoom.png', fullPage: true });
  await page.getByRole('button', { name: 'close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // no horizontal overflow at the phone viewport
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('diner service row: call-staff sheet + member link', async ({ page }) => {
  await stubMenu(page);
  await page.goto('/qr/e2e-token');
  await expect(page.getByText('โต๊ะ 7')).toBeVisible();
  // F1 + F3 controls render
  await expect(page.getByRole('button', { name: 'เรียกพนักงาน' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ผูกสมาชิก' })).toBeVisible();
  // open the call sheet → service options
  await page.getByRole('button', { name: 'เรียกพนักงาน' }).click();
  await expect(page.getByRole('button', { name: 'ขอน้ำ' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ขอเช็คบิล' })).toBeVisible();
  await page.screenshot({ path: (process.env.SHOT_DIR ?? 'test-results') + '/qr-call-staff.png', fullPage: true });
  await page.getByRole('button', { name: 'ขอน้ำ' }).click();   // fires POST /call, closes sheet
  await expect(page.getByText('แจ้งพนักงานแล้ว')).toBeVisible();
});

test('diner order tab: fire-lot grouping with send-time + served swap', async ({ page }) => {
  await page.route('**/api/qr/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/menu')) return json(MENU);
    if (url.includes('/buffet/tiers')) return json({ tiers: [] });
    return json(statusLots);
  });
  await page.goto('/qr/e2e-token');

  // order tab is the default; the two lots show their kitchen send-time (hh:mm, Asia/Bangkok = UTC+7)
  await expect(page.getByText('สั่งเมื่อ 18:30 น.')).toBeVisible();   // 11:30Z → 18:30 BKK
  await expect(page.getByText('สั่งเมื่อ 18:45 น.')).toBeVisible();   // 11:45Z → 18:45 BKK
  // the served dish swaps its wait for เสิร์ฟแล้ว; the cooking dish still shows a status
  await expect(page.getByText('เสิร์ฟครบแล้ว')).toBeVisible();
  await expect(page.getByText('เสิร์ฟแล้ว').first()).toBeVisible();
  await expect(page.getByText('กำลังปรุง')).toBeVisible();
  await page.screenshot({ path: (process.env.SHOT_DIR ?? 'test-results') + '/qr-order-lots.png', fullPage: true });
});
