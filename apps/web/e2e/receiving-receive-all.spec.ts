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

async function boot(page: Page) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  let receiveAllPo: string | null = null;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {} });
    const m = url.match(/\/api\/procurement\/pos\/([^/]+)\/receive-all/);
    if (m) { receiveAllPo = decodeURIComponent(m[1]); return json({ gr_no: 'GR-E2E-001', po_no: receiveAllPo, po_status: 'Closed', lines: 2 }); }
    if (url.includes('/api/inventory/purchase-orders')) return json(POS);
    return json({});
  });
  (page as any).__getReceiveAllPo = () => receiveAllPo;
}

test('receiving: PO list renders + one-tap รับครบ posts receive-all for an approved PO only', async ({ page }) => {
  await boot(page);
  await page.goto('/receiving');

  // ① both POs render in the list
  await expect(page.getByText('PO-E2E-APPR')).toBeVisible();
  await expect(page.getByText('PO-E2E-DONE')).toBeVisible();

  // ② exactly one รับครบ button (the Closed PO must NOT offer it)
  const receiveBtns = page.getByRole('button', { name: 'รับครบ' });
  await expect(receiveBtns).toHaveCount(1);

  // ③ clicking it POSTs receive-all for the approved PO
  await receiveBtns.click();
  await expect.poll(() => (page as any).__getReceiveAllPo()).toBe('PO-E2E-APPR');
});
