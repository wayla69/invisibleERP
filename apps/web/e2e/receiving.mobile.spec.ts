import { test, expect, type Page } from '@playwright/test';

/**
 * /receiving at PHONE viewport (iPhone 13, mobile-iphone project) — REAL-TAP regression for the
 * blind-count receiving flow. Every interaction uses ordinary Playwright clicks, so actionability is
 * enforced: a button covered by another element (the "ปุ่มซ้อนกันกดไม่ได้" bug class) fails the click
 * instead of silently passing. After every stage we also assert there is NO horizontal page overflow —
 * on mobile an overflow widens the layout viewport and shifts position:fixed surfaces (dialogs/sheets)
 * off-screen, which is the usual root cause of "the button is there but taps don't land" (see the
 * /shop PR #509 lesson in CLAUDE.md).
 */

const ME = { username: 'warehouse', role: 'Admin', customer_name: 'AMBER', permissions: [] };

const POS = {
  purchase_orders: [
    { PO_No: 'PO-M-APPR', PO_Date: '2026-07-03', Supplier_Name: 'ACME Foods', Total_Amount: 460, Status: 'Approved' },
  ],
};

const RECEIVE_LINES = {
  po_no: 'PO-M-APPR', status: 'Approved', vendor_name: 'ACME Foods', over_receipt_weight_pct: 5, claim_window_hours: 24,
  lines: [
    { item_id: 'RICE', item_description: 'ข้าวหอมมะลิถุงใหญ่พิเศษตราดอกบัวคู่', uom: 'EA', order_qty: 10, received_qty: 0, remaining_qty: 10, is_weight: false, closed: false },
    { item_id: 'BEEF', item_description: 'เนื้อวัววากิวนำเข้า', uom: 'kg', order_qty: 5, received_qty: 0, remaining_qty: 5, is_weight: true, closed: false },
    { item_id: 'OIL', item_description: 'น้ำมันพืช', uom: 'EA', order_qty: 3, received_qty: 3, remaining_qty: 0, is_weight: false, closed: false },
  ],
};

async function boot(page: Page) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  let grBody: any = null;
  let claimBody: any = null;
  let closedShortPo: string | null = null;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {} });
    if (url.includes('/receive-lines')) return json(RECEIVE_LINES);
    const mc = url.match(/\/api\/procurement\/pos\/([^/]+)\/close-short/);
    if (mc) { closedShortPo = decodeURIComponent(mc[1]); return json({ po_no: closedShortPo, po_status: 'Closed', short_lines: [{ item_id: 'RICE', short_qty: 4 }] }); }
    if (url.includes('/api/claims/gr') && req.method() === 'POST') {
      claimBody = req.postDataJSON();
      return json({ claim_no: 'GRC-M-001', status: 'Open', image_attachment_id: null });
    }
    if (url.includes('/api/procurement/grs') && req.method() === 'POST') {
      grBody = req.postDataJSON();
      return json({
        gr_no: 'GR-M-001', po_no: grBody.po_no, po_status: 'Received', lines: grBody.items.length,
        summary: {
          claim_window_hours: 24, claim_deadline: new Date(Date.now() + 24 * 3600_000).toISOString(),
          lines: [
            { item_id: 'RICE', item_description: 'ข้าวหอมมะลิถุงใหญ่พิเศษตราดอกบัวคู่', uom: 'EA', order_qty: 10, received_now: 6, received_total: 6, shortage_qty: 4, over_qty: 0, is_weight: false },
            { item_id: 'BEEF', item_description: 'เนื้อวัววากิวนำเข้า', uom: 'kg', order_qty: 5, received_now: 5.2, received_total: 5.2, shortage_qty: 0, over_qty: 0.2, is_weight: true },
            { item_id: 'OIL', item_description: 'น้ำมันพืช', uom: 'EA', order_qty: 3, received_now: 0, received_total: 3, shortage_qty: 0, over_qty: 0, is_weight: false },
          ],
        },
      });
    }
    if (url.includes('/api/procurement/grs')) return json({ grs: [], count: 0 });
    if (url.includes('/api/inventory/purchase-orders')) return json(POS);
    return json({});
  });
  (page as any).__getGrBody = () => grBody;
  (page as any).__getClaimBody = () => claimBody;
  (page as any).__getClosedShortPo = () => closedShortPo;
}

// The layout viewport must never exceed the visual viewport — a horizontal overflow anywhere on the page
// shifts fixed elements and makes buttons unclickable on phones.
async function assertNoHorizontalOverflow(page: Page, stage: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontal overflow at stage: ${stage}`).toBeLessThanOrEqual(0);
}

test('receiving (phone): blind-count flow is fully tappable — no overlap, no horizontal overflow', async ({ page }) => {
  await boot(page);
  await page.goto('/receiving');
  await expect(page.locator('#gr-po')).toBeVisible();
  await assertNoHorizontalOverflow(page, 'initial load');

  // ① pick the PO (real tap on the Radix select + its option)
  await page.locator('#gr-po').click();
  await page.getByRole('option', { name: /PO-M-APPR/ }).click();
  await expect(page.getByText('ข้าวหอมมะลิถุงใหญ่พิเศษตราดอกบัวคู่')).toBeVisible();
  await assertNoHorizontalOverflow(page, 'PO lines loaded (incl. a long Thai item name)');

  // ② blind count: inputs start EMPTY; the fully-received line shows ✓ instead of an input
  const riceInput = page.getByLabel(/จำนวนรับจริง RICE/);
  await expect(riceInput).toHaveValue('');
  await expect(page.getByLabel(/จำนวนรับจริง OIL/)).toHaveCount(0); // done line — badge, not input
  await riceInput.click(); // tap-to-focus must land (not covered)
  await riceInput.fill('6');
  const beefInput = page.getByLabel(/จำนวนรับจริง BEEF/);
  await beefInput.click();
  await beefInput.fill('5.2');
  await expect(page.getByText('นับแล้ว 2 จาก 3 รายการ')).toBeVisible();

  // ③ confirm — the primary button must be tappable at the bottom of the form
  await page.getByRole('button', { name: 'ยืนยันการรับของ' }).click();
  await expect.poll(() => (page as any).__getGrBody()).toMatchObject({ po_no: 'PO-M-APPR' });
  const body = await (page as any).__getGrBody();
  expect(body.items).toEqual([
    { item_id: 'RICE', received_qty: 6, uom: 'EA' },
    { item_id: 'BEEF', received_qty: 5.2, uom: 'kg' },
  ]);

  // ④ summary dialog renders inside the viewport (a page overflow would push the fixed dialog off-screen)
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('สรุปการรับของ — GR-M-001')).toBeVisible();
  await expect(dialog.getByText('ขาด 4')).toBeVisible();
  await expect(dialog.getByText('เกิน 0.2')).toBeVisible();
  await assertNoHorizontalOverflow(page, 'summary dialog open');
  const box = await dialog.boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box, 'dialog has a bounding box').not.toBeNull();
  expect(box!.x, 'dialog left edge on-screen').toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, 'dialog right edge on-screen').toBeLessThanOrEqual(vw + 1);

  // ⑤ claim from the shortage line — expand the inline form and file it (real taps throughout)
  await dialog.getByRole('button', { name: /แจ้งเคลม/ }).first().click();
  await dialog.getByLabel('จำนวนที่เคลม').fill('2');
  await dialog.getByLabel(/สาเหตุ/).fill('ของช้ำเสียหาย');
  await assertNoHorizontalOverflow(page, 'claim form expanded');
  await dialog.getByRole('button', { name: 'เปิดเรื่องเคลม' }).click();
  await expect.poll(() => (page as any).__getClaimBody()).toMatchObject({ gr_no: 'GR-M-001', item_id: 'RICE', claim_qty: 2 });
  await expect(dialog.getByText('เปิดเรื่องเคลม GRC-M-001 แล้ว')).toBeVisible();

  // ⑥ the shortage decision — close the PO short (destructive button must be tappable too)
  await expect(dialog.getByText('มีของขาดส่ง')).toBeVisible();
  await dialog.getByRole('button', { name: 'ปิด PO (ไม่รับส่วนที่ขาด)' }).click();
  await expect.poll(() => (page as any).__getClosedShortPo()).toBe('PO-M-APPR');

  // ⑦ done closes the dialog cleanly
  await dialog.getByRole('button', { name: 'เสร็จสิ้น' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await assertNoHorizontalOverflow(page, 'dialog closed');
});
