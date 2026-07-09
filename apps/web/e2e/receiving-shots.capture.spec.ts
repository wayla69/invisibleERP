import { test, type Page } from '@playwright/test';

const OUT = '/tmp/claude-0/-home-user-invisibleERP/7c113168-9110-554f-a417-fde17c1dfc5e/scratchpad';
const ME = { username: 'warehouse', role: 'Admin', customer_name: 'AMBER', permissions: [] };
const POS = { purchase_orders: [{ PO_No: 'PO-M-APPR', PO_Date: '2026-07-03', Supplier_Name: 'ACME Foods', Total_Amount: 460, Status: 'Approved' }] };
const RECEIVE_LINES = {
  po_no: 'PO-M-APPR', status: 'Approved', vendor_name: 'ACME Foods', over_receipt_weight_pct: 5, claim_window_hours: 24,
  lines: [
    { item_id: 'RICE', item_description: 'ข้าวหอมมะลิถุงใหญ่', uom: 'EA', order_qty: 10, received_qty: 0, remaining_qty: 10, is_weight: false, closed: false },
    { item_id: 'BEEF', item_description: 'เนื้อวัววากิวนำเข้า', uom: 'kg', order_qty: 5, received_qty: 0, remaining_qty: 5, is_weight: true, closed: false },
    { item_id: 'OIL', item_description: 'น้ำมันพืช', uom: 'EA', order_qty: 3, received_qty: 3, remaining_qty: 0, is_weight: false, closed: false },
  ],
};
async function boot(page: Page) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  await page.route('**/api/**', async (route) => {
    const req = route.request(); const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {} });
    if (url.includes('/receive-lines')) return json(RECEIVE_LINES);
    if (url.includes('/api/procurement/grs') && req.method() === 'POST') {
      return json({ gr_no: 'GR-M-001', po_no: 'PO-M-APPR', po_status: 'Received', lines: 2, summary: { claim_window_hours: 24, claim_deadline: new Date(Date.now() + 86400000).toISOString(), lines: [
        { item_id: 'RICE', item_description: 'ข้าวหอมมะลิถุงใหญ่', uom: 'EA', order_qty: 10, received_now: 6, received_total: 6, shortage_qty: 4, over_qty: 0, is_weight: false },
        { item_id: 'BEEF', item_description: 'เนื้อวัววากิวนำเข้า', uom: 'kg', order_qty: 5, received_now: 5.2, received_total: 5.2, shortage_qty: 0, over_qty: 0.2, is_weight: true },
        { item_id: 'OIL', item_description: 'น้ำมันพืช', uom: 'EA', order_qty: 3, received_now: 0, received_total: 3, shortage_qty: 0, over_qty: 0, is_weight: false },
      ] } });
    }
    if (url.includes('/api/procurement/grs')) return json({ grs: [], count: 0 });
    if (url.includes('/api/inventory/purchase-orders')) return json(POS);
    return json({});
  });
}
async function drive(page: Page, tag: string) {
  await page.goto('/receiving');
  const po = page.locator('#gr-po');
  await po.waitFor({ state: 'visible' });
  // hydration guard: retry the open until the option list actually mounts
  await test.step('open PO select', async () => {
    for (let i = 0; i < 5; i++) {
      await po.click();
      try { await page.getByRole('option').first().waitFor({ timeout: 2000 }); return; } catch { /* retry */ }
    }
    throw new Error('PO select never opened');
  });
  await page.getByRole('option').first().click();
  await page.getByText('ข้าวหอมมะลิถุงใหญ่').waitFor();
  await page.getByLabel(/จำนวนรับจริง RICE/).fill('6');
  await page.getByLabel(/จำนวนรับจริง BEEF/).fill('5.2');
  await page.screenshot({ path: `${OUT}/receiving-form-${tag}.png`, fullPage: false });
  await page.getByRole('button', { name: 'ยืนยันการรับของ' }).click();
  await page.getByText('สรุปการรับของ — GR-M-001').waitFor();
  await page.getByRole('button', { name: /แจ้งเคลม/ }).first().click();
  await page.screenshot({ path: `${OUT}/receiving-summary-${tag}.png`, fullPage: false });
}
test('capture phone + desktop', async ({ page }) => {
  await boot(page);
  await drive(page, page.viewportSize()!.width < 500 ? 'phone' : 'desktop');
});
