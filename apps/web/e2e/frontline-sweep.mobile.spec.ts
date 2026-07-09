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
 *
 * Round 2 extends the sweep to the rest of the frontline set — POS back-office (till, close-of-day,
 * refunds, pos-home) and warehouse ops (inventory POs, stock-adjustment, replenishment, lots, waste) —
 * including a tab-switch on the tabbed pages (each tab renders its own DataTable, so the second tab is
 * its own overflow surface). /pos/new gets a dedicated real-tap spec (pos-new.mobile.spec.ts).
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

// ── Round 2: POS back-office + warehouse ops ────────────────────────────────────────────────────────

const XZ_REPORT = {
  id: 42, till_session_id: 7, report_type: 'X', status: 'Open', generated_by: 'cashier01',
  generated_at: '2026-07-09T08:30:00Z', gross_sales: 15230.5, total_cash: 9200, total_card: 6030.5,
  total_refund: 0, cash_expected: 9200, cash_counted: 9180, variance: -20, content_hash: 'abc123', hash_valid: true,
};

test('pos/till — seeded X-report row fits the phone viewport', async ({ page }) => {
  await boot(page, { '/api/payments/xz-reports': { reports: [XZ_REPORT], count: 1 } });
  await page.goto('/pos/till');
  await expect(page.getByText('S-7').first()).toBeVisible();
  await expect(page.getByText('cashier01').first()).toBeVisible();
  await expectNoOverflow(page, 'till session register');
});

test('pos/close-of-day — Z-report row + closed-session sign form fit the phone viewport', async ({ page }) => {
  await boot(page, {
    '/api/payments/till/sessions': { sessions: [{ session_no: 'TILL-20260709-001', opened_by: 'cashier01', variance_status: 'NotRequired' }] },
    '/api/payments/xz-reports': { reports: [{ ...XZ_REPORT, report_type: 'Z', status: 'Closed', generated_by: 'manager01' }], count: 1 },
  });
  await page.goto('/pos/close-of-day');
  await expect(page.getByText('Z-42').first()).toBeVisible();
  await expect(page.getByText('manager01').first()).toBeVisible();
  await expectNoOverflow(page, 'close-of-day');
});

test('pos/refunds — pending refund with a long Thai reason fits the phone viewport', async ({ page }) => {
  await boot(page, {
    '/api/payments/refund-requests': {
      requests: [{
        id: 1, request_no: 'RR-0001', payment_no: 'PAY-0009', sale_no: 'S-1023', amount: 250,
        reason: LONG_TH, status: 'Pending', requested_by: 'cashier01',
        requested_at: '2026-07-09T10:15:00Z', approved_by: null, approved_at: null, reject_reason: null,
      }], count: 1,
    },
  });
  await page.goto('/pos/refunds');
  await expect(page.getByText('RR-0001').first()).toBeVisible();
  await expect(page.getByText('PAY-0009').first()).toBeVisible();
  await expectNoOverflow(page, 'refund approval queue');
});

test('pos-home — summary stats + open tills + recent bills fit the phone viewport', async ({ page }) => {
  await boot(page, {
    '/api/pos/summary': {
      total_orders: 42, total_sales: 15230.5, total_tax: 996.3, total_discount: 120, avg_order_value: 362.6,
      top_items: [{ Item_Description: LONG_TH, total_qty: 30, total_revenue: 1800 }],
      by_payment: [{ Payment_Method: 'Cash', order_count: 25, amount: 9200 }],
    },
    '/api/pos/sessions': { sessions: [{ Cashier: 'cashier01', Sale_Date: '2026-07-09', session_total: 9200, order_count: 25 }] },
    '/api/pos/orders': { orders: [{ Sale_No: 'S-1023', Sale_Date: '2026-07-09', Total: 362.6, Status: 'Paid', Payment_Method: 'Cash', Cashier: 'cashier01' }] },
  });
  await page.goto('/pos-home');
  await expect(page.getByText('S-1023').first()).toBeVisible();
  await expect(page.getByText('cashier01').first()).toBeVisible();
  await expectNoOverflow(page, 'pos home dashboard');
});

test('inventory/purchase-orders — PO row with a long Thai supplier name fits the phone viewport', async ({ page }) => {
  await boot(page, {
    '/api/inventory/purchase-orders': {
      purchase_orders: [{ PO_No: 'PO-2026-001', PO_Date: '2026-07-05', Supplier_Name: LONG_TH, Total_Amount: 45000, Status: 'Open' }],
    },
  });
  await page.goto('/inventory/purchase-orders');
  await expect(page.getByText('PO-2026-001').first()).toBeVisible();
  await expectNoOverflow(page, 'inventory purchase orders');
});

test('stock-adjustment — counts tab AND write-offs tab both fit the phone viewport', async ({ page }) => {
  await boot(page, {
    '/api/stocktake': { stocktakes: [{ st_no: 'ST-2026-001', st_date: '2026-07-08', counted_by: 'counter01', lines: 40, variance_lines: 3, status: 'Counted' }] },
    '/api/inventory/writeoffs': {
      writeoffs: [{ id: 1, writeoff_no: 'WO-2026-001', item_id: 'ITM-100', item_description: LONG_TH, qty: 5, uom: 'ขวด', reason: 'หมดอายุและบรรจุภัณฑ์เสียหายจากความชื้นในคลังสินค้า', status: 'Pending', requested_by: 'wh01', requested_at: '2026-07-09T09:00:00Z' }],
    },
  });
  await page.goto('/stock-adjustment');
  await expect(page.getByText('ST-2026-001').first()).toBeVisible();
  await expectNoOverflow(page, 'stock-adjustment counts tab');
  await page.getByRole('tab', { name: /ตัดสต๊อกรออนุมัติ/ }).click();
  await expect(page.getByText('WO-2026-001').first()).toBeVisible();
  await expectNoOverflow(page, 'stock-adjustment write-offs tab');
});

test('replenishment — transfer + buy suggestions + par recommendations fit the phone viewport', async ({ page }) => {
  await boot(page, {
    '/api/replenishment/suggestions': {
      suggestions: [
        { suggestion_no: 'RS-001', route: 'transfer', status: 'Suggested', urgency: 'critical', branch_name: LONG_TH, branch_id: 2, from_branch_name: 'คลังกลาง', from_branch_id: 1, item_id: 'ITM-100', transfer_qty: 24, suggested_qty: 24 },
        { suggestion_no: 'RS-002', route: 'buy', status: 'Suggested', urgency: 'warning', branch_name: 'สาขาสีลม', branch_id: 2, item_id: 'ITM-200', on_hand: 3, buy_qty: 50, suggested_qty: 50, vendor: 'บริษัท บี', pr_no: null },
      ],
    },
    '/api/replenishment/par-recommendations': {
      recommendations: [{ branch_id: 2, item_id: 'ITM-300', avg_daily_usage: 12, lead_time_days: 3, current_reorder_point: 20, recommended_reorder_point: 48, under_buffered: true }],
    },
  });
  await page.goto('/replenishment');
  await expect(page.getByText('RS-001').first()).toBeVisible();
  await expect(page.getByText('RS-002').first()).toBeVisible();
  await expectNoOverflow(page, 'replenishment suggestions');
});

test('lots — lot register tab AND expiry tab both fit the phone viewport', async ({ page }) => {
  await boot(page, {
    '/api/lots/expiry': {
      summary: { expired: 1, d0_7: 2, d8_30: 5, d31_plus: 10 },
      buckets: { expired: [{ lot_no: 'LOT-X', item_id: 'ITM-100', location_id: 'WH1-A01', balance: 3, expiry_date: '2026-07-01', status: 'Expired', days_to_expiry: -8 }], d0_7: [], d8_30: [] },
    },
    '/api/lots': { lots: [{ lot_no: 'LOT-A1', item_id: 'ITM-100', location_id: 'WH1-A01', balance: 120, expiry_date: '2026-08-01', status: 'Active' }] },
  });
  await page.goto('/lots');
  await expect(page.getByText('LOT-A1').first()).toBeVisible();
  await expectNoOverflow(page, 'lots ledger tab');
  await page.getByRole('tab', { name: 'ใกล้หมดอายุ' }).click();
  await expect(page.getByText('LOT-X').first()).toBeVisible();
  await expectNoOverflow(page, 'lots expiry tab');
});

test('waste — waste log row with a long Thai description fits the phone viewport', async ({ page }) => {
  await boot(page, {
    '/api/inventory/waste': {
      waste: [{ waste_no: 'WST-2026-001', item_id: 'ITM-100', item_description: LONG_TH, qty: 5, uom: 'ขวด', reason_code: 'spoilage', unit_cost: 20, total_cost: 100, journal_no: 'JV-5001', logged_by: 'wh01', created_at: '2026-07-09T07:00:00Z' }],
      count: 1, total_qty: 5, total_cost: 100,
      by_reason: [{ reason: 'spoilage', qty: 5, cost: 100, count: 1 }],
    },
  });
  await page.goto('/waste');
  await expect(page.getByText('WST-2026-001').first()).toBeVisible();
  await expectNoOverflow(page, 'waste log');
});
