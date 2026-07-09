import { test, expect, type Page } from '@playwright/test';

/**
 * /receiving — Goods Receipt surface + one-tap "รับครบ" (receive-all).
 * Drives the REAL React page: the PO list renders, an Approved PO shows the รับครบ button, a Closed PO
 * does NOT, and clicking รับครบ POSTs to /pos/:poNo/receive-all and refetches. Same two-layer guarantee
 * as the requisitions E2E — proves the web surface actually wires up (not just the API/harness).
 */

const ME = { username: 'warehouse', role: 'Admin', customer_name: 'AMBER', permissions: [] };

// two POs: one Approved (receivable → button shows), one Closed (fully received → no button)
const POS = {
  purchase_orders: [
    { PO_No: 'PO-E2E-APPR', PO_Date: '2026-07-03', Supplier_Name: 'ACME Foods', Total_Amount: 460, Status: 'Approved' },
    { PO_No: 'PO-E2E-DONE', PO_Date: '2026-07-01', Supplier_Name: 'ACME Foods', Total_Amount: 100, Status: 'Closed' },
  ],
};

// EXP-12 — the blind-count receive-lines payload for the approved PO: ordered/received/outstanding per
// line, the counted qty NEVER pre-filled by the UI (the receiver must key an actual count).
const RECEIVE_LINES = {
  po_no: 'PO-E2E-APPR', status: 'Approved', vendor_name: 'ACME Foods', over_receipt_weight_pct: 5, claim_window_hours: 24,
  lines: [
    { item_id: 'RICE', item_description: 'ข้าวหอมมะลิ', uom: 'EA', order_qty: 10, received_qty: 0, remaining_qty: 10, is_weight: false, closed: false },
    { item_id: 'BEEF', item_description: 'เนื้อวัว', uom: 'kg', order_qty: 5, received_qty: 0, remaining_qty: 5, is_weight: true, closed: false },
  ],
};

async function boot(page: Page) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  let receiveAllPo: string | null = null;
  let grBody: any = null;
  let closedShortPo: string | null = null;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {} });
    const m = url.match(/\/api\/procurement\/pos\/([^/]+)\/receive-all/);
    if (m) { receiveAllPo = decodeURIComponent(m[1]); return json({ gr_no: 'GR-E2E-001', po_no: receiveAllPo, po_status: 'Closed', lines: 2 }); }
    const mc = url.match(/\/api\/procurement\/pos\/([^/]+)\/close-short/);
    if (mc) { closedShortPo = decodeURIComponent(mc[1]); return json({ po_no: closedShortPo, po_status: 'Closed', short_lines: [{ item_id: 'RICE', short_qty: 4 }] }); }
    if (url.includes('/receive-lines')) return json(RECEIVE_LINES);
    if (url.includes('/api/procurement/grs') && req.method() === 'POST') {
      grBody = req.postDataJSON();
      // ordered-vs-received summary the server now returns with every GR (EXP-12)
      return json({
        gr_no: 'GR-E2E-002', po_no: grBody.po_no, po_status: 'Received', lines: grBody.items.length,
        summary: {
          claim_window_hours: 24, claim_deadline: new Date(Date.now() + 24 * 3600_000).toISOString(),
          lines: [
            { item_id: 'RICE', item_description: 'ข้าวหอมมะลิ', uom: 'EA', order_qty: 10, received_now: 6, received_total: 6, shortage_qty: 4, over_qty: 0, is_weight: false },
            { item_id: 'BEEF', item_description: 'เนื้อวัว', uom: 'kg', order_qty: 5, received_now: 0, received_total: 0, shortage_qty: 5, over_qty: 0, is_weight: true },
          ],
        },
      });
    }
    if (url.includes('/api/procurement/grs')) return json({ grs: [], count: 0 }); // recent-GR list surface
    if (url.includes('/api/inventory/purchase-orders')) return json(POS);
    return json({});
  });
  (page as any).__getReceiveAllPo = () => receiveAllPo;
  (page as any).__getGrBody = () => grBody;
  (page as any).__getClosedShortPo = () => closedShortPo;
}

test('receiving: PO list renders + one-tap รับครบ posts receive-all for an approved PO only', async ({ page }) => {
  await boot(page);
  await page.goto('/receiving');

  // ① both POs render in the list. Scoped to the desktop `table` (this suite runs at the Desktop Chrome
  // viewport): DataTable also renders a phone-width card list for the same rows (hidden via CSS below
  // `sm:`, but still in the DOM), so an unscoped text match would resolve to both and violate Playwright's
  // strict mode — same tradeoff already documented in requisitions-pr-to-po.spec.ts.
  await expect(page.locator('table').getByText('PO-E2E-APPR')).toBeVisible();
  await expect(page.locator('table').getByText('PO-E2E-DONE')).toBeVisible();

  // ② exactly one รับครบ button (the Closed PO must NOT offer it) — scoped to the desktop table for the
  // same reason as ①, since the same button also renders in the (hidden) mobile card copy of the row.
  const receiveBtns = page.locator('table').getByRole('button', { name: 'รับครบ' });
  await expect(receiveBtns).toHaveCount(1);

  // ③ clicking it POSTs receive-all for the approved PO
  await receiveBtns.click();
  await expect.poll(() => (page as any).__getReceiveAllPo()).toBe('PO-E2E-APPR');
});

test('receiving: GR form PO number is a dropdown of receivable POs, not free text', async ({ page }) => {
  await boot(page);
  await page.goto('/receiving');

  // The dropdown lists only receivable POs (Approved/Received) — the Closed PO must not appear,
  // same isReceivable gate as the รับครบ button above.
  const poSelect = page.locator('#gr-po');
  await expect(poSelect).toBeVisible();
  await poSelect.click();

  const options = page.getByRole('option');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText('PO-E2E-APPR');
  await expect(options.first()).toContainText('ACME Foods');

  await options.first().click();
  await expect(poSelect).toContainText('PO-E2E-APPR');
});

// EXP-12 — blind-count receiving: picking the PO loads its lines (ordered/outstanding, count inputs
// EMPTY), submitting the counted qty posts the GR, and the summary dialog shows the shortage with the
// keep-open / close-short decision. Drives the REAL page against route-mocked APIs.
test('receiving: PO lines load for a blind count → GR posts counted qty → summary shows shortage + close-short', async ({ page }) => {
  await boot(page);
  await page.goto('/receiving');

  // pick the approved PO → its lines load from receive-lines
  await page.locator('#gr-po').click();
  await page.getByRole('option').first().click();
  await expect(page.getByText('ข้าวหอมมะลิ')).toBeVisible();
  await expect(page.getByText('เนื้อวัว')).toBeVisible();

  // counted-qty inputs render EMPTY (blind count — never pre-filled)
  const riceInput = page.getByLabel(/จำนวนรับจริง RICE/);
  await expect(riceInput).toHaveValue('');

  // key an actual count (6 of 10) and confirm
  await riceInput.fill('6');
  await page.getByRole('button', { name: 'ยืนยันการรับของ' }).click();

  // the POST carried exactly the counted line
  await expect.poll(() => (page as any).__getGrBody()).toMatchObject({ po_no: 'PO-E2E-APPR' });
  const body = await (page as any).__getGrBody();
  expect(body.items).toEqual([{ item_id: 'RICE', received_qty: 6, uom: 'EA' }]);

  // summary dialog: ordered vs received with the shortage badge + the claim affordance + the decision
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('สรุปการรับของ — GR-E2E-002')).toBeVisible();
  await expect(dialog.getByText('ขาด 4')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /แจ้งเคลม/ }).first()).toBeVisible();
  await expect(dialog.getByText('มีของขาดส่ง')).toBeVisible();

  // choose "close short" → POSTs close-short for this PO
  await dialog.getByRole('button', { name: 'ปิด PO (ไม่รับส่วนที่ขาด)' }).click();
  await expect.poll(() => (page as any).__getClosedShortPo()).toBe('PO-E2E-APPR');
});
