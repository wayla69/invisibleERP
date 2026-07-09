import { test, expect, type Page } from '@playwright/test';

/**
 * Phone-viewport NO-OVERFLOW sweep for the frontline operational screens (claims, delivery, WMS,
 * inventory) — the screens warehouse/ops staff actually open on a phone. These pages have no
 * page-level `sm:hidden` layer of their own: their mobile behavior comes from the shared DataTable's
 * built-in card fallback plus the page chrome (header, search row, filter chips, action clusters).
 *
 * The regression class under test is the /shop bug (CLAUDE.md): ANY horizontal overflow on mobile
 * widens the layout viewport and shifts every `position:fixed` surface off-screen — so after each page
 * renders its seeded content we assert `scrollWidth <= clientWidth` (the recipe from
 * receiving.mobile.spec.ts). Rows are seeded with LONG Thai text on purpose to stress width.
 * Runs ONLY under the `mobile-iphone` project (iPhone 13 metrics); all /api/** stubbed.
 */

const ME = { username: 'amber', role: 'Admin', customer_name: 'AMBER', permissions: ['warehouse', 'delivery', 'wh_custody', 'dashboard'] };
const LONG_TH = 'กระดาษถ่ายเอกสารคุณภาพสูงพิเศษสำหรับงานพิมพ์เอกสารสำคัญของสำนักงานใหญ่ ขนาด A4 80 แกรม (แพ็ค 5 รีม)';

const CLAIMS = {
  claims: [{
    id: 1, order_no: 'SALE-AMBER-20260709120000', item_description: LONG_TH, claimed_qty: 2,
    reason: 'สินค้าชำรุดจากการขนส่ง กล่องบุบและมีรอยฉีกขาดบริเวณมุมด้านขวาล่างของบรรจุภัณฑ์', admin_status: 'Waiting',
  }],
};
const DELIVERIES = {
  deliveries: [{
    id: 1, do_no: 'DO-20260709-001', order_no: 'SO-20260709-001', driver: 'สมชาย ใจดีมากที่สุดในสามโลก',
    vehicle: 'ทะเบียน 1กข-1234 กรุงเทพมหานคร', status: 'Pending', customer_name: LONG_TH,
    created_at: '2026-07-09T02:00:00Z', delivered_at: null,
  }],
};
const BINS = {
  bins: [{
    bin_code: 'A-01-01-01', zone: 'A', aisle: '01', level: '01', position: '01',
    description: LONG_TH, item_count: 3, total_qty: 120, capacity: 200,
  }],
};
const STOCK = {
  snapshot_date: '2026-07-09', total: 1, low_stock_count: 0,
  items: [{ Item_ID: 'A4-PAPER-PREMIUM-EXTRA-LONG-SKU-0001', Item_Description: LONG_TH, UOM: 'REAM', AV_QTY: '42', Total_Stock: '42', Expiry_Date: null }],
};

async function boot(page: Page, payloads: Record<string, unknown>) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    for (const [needle, body] of Object.entries(payloads)) {
      if (url.includes(needle)) return json(body);
    }
    return json({}); // everything else: empty-object shape — pages render their empty states
  });
}

// The layout viewport must never exceed the visual viewport (receiving.mobile.spec.ts recipe).
async function expectNoOverflow(page: Page, stage: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontal overflow at: ${stage}`).toBeLessThanOrEqual(0);
}

test('claims — seeded Waiting row (approve/reject action cluster) fits the phone viewport', async ({ page }) => {
  await boot(page, { '/api/claims/sales': CLAIMS, '/api/claims/gr': { claims: [] } });
  await page.goto('/claims');
  await expect(page.getByText('SALE-AMBER-20260709120000').first()).toBeVisible();
  await expectNoOverflow(page, 'claims list with Waiting action cluster');
});

test('delivery — seeded delivery order with long driver/customer text fits the phone viewport', async ({ page }) => {
  await boot(page, { '/api/delivery': DELIVERIES });
  await page.goto('/delivery');
  await expect(page.getByText('DO-20260709-001').first()).toBeVisible();
  await expectNoOverflow(page, 'delivery register');
});

test('wms — seeded bin with long description fits the phone viewport', async ({ page }) => {
  await boot(page, { '/api/wms/bins': BINS, '/api/wms/layout': { zones: [] } });
  await page.goto('/wms');
  await expect(page.getByText('A-01-01-01').first()).toBeVisible();
  await expectNoOverflow(page, 'wms bins');
});

test('inventory — seeded stock row with an extra-long SKU fits the phone viewport', async ({ page }) => {
  await boot(page, { '/api/inventory/stock': STOCK });
  await page.goto('/inventory');
  await expect(page.getByText('A4-PAPER-PREMIUM-EXTRA-LONG-SKU-0001').first()).toBeVisible();
  await expectNoOverflow(page, 'inventory stock list');
});
