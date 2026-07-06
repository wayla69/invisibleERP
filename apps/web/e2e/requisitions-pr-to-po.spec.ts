import { test, expect, type Page } from '@playwright/test';

/**
 * /requisitions — PR register + PR→PO conversion panel (supplier auto-group → one PO per vendor).
 * Drives the REAL React page (render + wiring), not just the API. Covers the reported asks:
 *   ① the register + dialog show the item NAME (not just the code),
 *   ② each line is auto-routed to its suggested supplier (GET items/suppliers),
 *   ③ lines fan out into one PO PER vendor and submit posts `pos: [{ vendor, lines }, …]` (1 PO = 1 supplier).
 * All APIs are stubbed (no backend/DB).
 */

const ME = { username: 'amber', role: 'Admin', customer_name: 'AMBER', permissions: [] };

const PRS = {
  can_approve: true,
  prs: [{
    pr_no: 'PR-E2E-001', pr_date: '2026-07-03', requested_by: 'amber', status: 'Approved', priority: 'Normal', approved_by: 'boss',
    lines: [
      { id: 11, item_id: 'A4-PAPER', item_description: 'กระดาษ A4 80 แกรม', request_qty: 3, uom: 'REAM', reason: null, po_no: null, line_status: 'Open' },
      { id: 12, item_id: 'INK-BLACK', item_description: 'หมึกดำ', request_qty: 2, uom: 'EA', reason: null, po_no: null, line_status: 'Open' },
    ],
  }],
};

// Each line resolves to a DIFFERENT preferred supplier, so the dialog auto-forms TWO PO groups.
const SUGGESTIONS = {
  suggestions: {
    'A4-PAPER': { suggested: { vendor_id: 7, vendor_name: 'ACME Foods', unit_price: 120, uom: 'REAM', currency: 'THB', preferred: true, source: 'pricelist' }, candidates: [] },
    'INK-BLACK': { suggested: { vendor_id: 9, vendor_name: 'Beta Supplies', unit_price: 300, uom: 'EA', currency: 'THB', preferred: false, source: 'last_po' }, candidates: [] },
  },
};

async function boot(page: Page) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  let toPoBody: any = null;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {} });
    if (url.includes('/api/line/link-code')) return json({ code: 'ABC123', expires_at: '', linked: false });
    if (url.includes('/api/line/link')) return json({ linked: true });
    if (url.includes('/api/procurement/prs') && url.includes('/to-po')) { toPoBody = JSON.parse(String(req.postData() ?? '{}')); return json({ pr_no: 'PR-E2E-001', pr_status: 'Converted', pos: [{ po_no: 'PO-E2E-001' }, { po_no: 'PO-E2E-002' }], created_items: [] }); }
    if (url.includes('/api/procurement/prs')) return json(PRS);
    if (url.includes('/api/procurement/items/suppliers')) return json(SUGGESTIONS);
    if (url.includes('/api/procurement/vendors/search')) return json({ vendors: [{ id: 7, name: 'ACME Foods', vendor_code: 'V-ACME' }] });
    if (url.includes('/api/procurement/items/search')) return json({ items: [] });
    return json({});
  });
  (page as any).__getToPo = () => toPoBody;
}

test('requisitions: register shows item names + PR→PO auto-groups by supplier → one PO per vendor', async ({ page }) => {
  await boot(page);
  await page.goto('/requisitions');

  // ① register renders the approved PR and shows the item NAME (not just the code) — the reported ask.
  // Scoped to the desktop `table` (this suite runs at the Desktop Chrome viewport): the register also
  // renders a phone-width card list for the same data (hidden via CSS below `sm:`, but still in the DOM),
  // so an unscoped text match would resolve to both and violate Playwright's strict mode.
  await expect(page.getByText('คำขอซื้อล่าสุด')).toBeVisible();
  await expect(page.locator('table').getByText('PR-E2E-001')).toBeVisible();
  await expect(page.locator('table').getByText('กระดาษ A4 80 แกรม')).toBeVisible();

  // ② open the conversion panel — suggestions auto-form two supplier groups
  await page.getByRole('button', { name: '➡️ สร้าง PO' }).click();
  await expect(page.getByText('สร้าง PO จาก PR-E2E-001')).toBeVisible();
  await expect(page.getByText('ใบสั่งซื้อ #1')).toBeVisible();
  await expect(page.getByText('ใบสั่งซื้อ #2')).toBeVisible();
  await expect(page.getByText('ACME Foods')).toBeVisible();
  await expect(page.getByText('Beta Supplies')).toBeVisible();

  // ③ submit → posts pos: [{vendor, lines}, …], one group per vendor, prices prefilled from suggestions
  await page.getByRole('button', { name: /สร้าง PO ทั้งหมด \(2\)/ }).click();
  await expect.poll(() => (page as any).__getToPo()).not.toBeNull();
  const body = (page as any).__getToPo();
  expect(Array.isArray(body.pos)).toBe(true);
  expect(body.pos).toHaveLength(2);
  const byVendor: Record<number, any> = Object.fromEntries(body.pos.map((p: any) => [p.vendor_id, p]));
  expect(byVendor[7].lines[0].item_id).toBe('A4-PAPER');
  expect(byVendor[7].lines[0].pr_line_id).toBe(11);
  expect(byVendor[7].lines[0].unit_price).toBe(120);   // preferred price-list prefill carried through
  expect(byVendor[9].lines[0].item_id).toBe('INK-BLACK');
  expect(byVendor[9].lines[0].pr_line_id).toBe(12);
  expect(byVendor[9].lines[0].unit_price).toBe(300);   // last-PO price prefill carried through
});
