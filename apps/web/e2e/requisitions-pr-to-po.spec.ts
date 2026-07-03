import { test, expect, type Page } from '@playwright/test';

/**
 * /requisitions — PR register + PR→PO conversion panel (vendor picker + last-price + new-code).
 * Drives the REAL React page (render + wiring), not just the API — this is the check that would have
 * caught "the PR doesn't show on the web": the table, the ➡️ สร้าง PO panel, vendor/item search, the
 * not-found hint, and submit are all exercised against stubbed APIs (no backend/DB).
 */

const ME = { username: 'amber', role: 'Admin', customer_name: 'AMBER', permissions: [] };

const PRS = {
  can_approve: true,
  prs: [{
    pr_no: 'PR-E2E-001', pr_date: '2026-07-03', requested_by: 'amber', status: 'Approved', priority: 'Normal', approved_by: 'boss',
    lines: [
      { item_id: 'A4-PAPER', request_qty: 3, uom: 'REAM', reason: null },   // exists in master
      { item_id: 'Iberico ham', request_qty: 2, uom: null, reason: null },   // free-text, not in master
    ],
  }],
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
    if (url.includes('/api/procurement/prs') && url.includes('/to-po')) { toPoBody = JSON.parse(String(req.postData() ?? '{}')); return json({ pr_no: 'PR-E2E-001', po_no: 'PO-E2E-001', po_status: 'Pending', total_amount: 460, created_items: ['IBERICO-HAM'] }); }
    if (url.includes('/api/procurement/prs')) return json(PRS);
    if (url.includes('/api/procurement/vendors/search')) return json({ vendors: [{ id: 7, name: 'ACME Foods', vendor_code: 'V-ACME' }] });
    if (url.includes('/api/procurement/items/search')) {
      const q = new URL(url).searchParams.get('q') ?? '';
      if (q.includes('A4')) return json({ items: [{ item_id: 'A4-PAPER', item_description: 'กระดาษ A4 80 แกรม', uom: 'REAM', unit_price: 95, last_price: 120 }] });
      return json({ items: [] }); // "Iberico ham" → no match
    }
    return json({});
  });
  // expose the captured to-po body for assertions
  (page as any).__getToPo = () => toPoBody;
}

test('requisitions: PR register renders + PR→PO panel (vendor pick, last-price, new-code, submit)', async ({ page }) => {
  await boot(page);
  await page.goto('/requisitions');

  // ① the register table renders the approved PR (this is the surface that was missing before)
  await expect(page.getByText('คำขอซื้อล่าสุด')).toBeVisible();
  await expect(page.getByText('PR-E2E-001')).toBeVisible();
  await expect(page.getByText('อนุมัติแล้ว')).toBeVisible();

  // ② open the conversion panel
  await page.getByRole('button', { name: '➡️ สร้าง PO' }).click();
  await expect(page.getByText('สร้าง PO จาก PR-E2E-001')).toBeVisible();

  // ③ vendor picker: search → pick from the master
  await page.getByPlaceholder('ชื่อผู้ขาย / ซัพพลายเออร์').fill('ACME');
  await page.getByRole('button', { name: 'ค้นหาผู้ขาย' }).click();
  await page.getByRole('button', { name: /ACME Foods/ }).click();
  await expect(page.getByPlaceholder('ชื่อผู้ขาย / ซัพพลายเออร์')).toHaveValue('ACME Foods');

  // ④ line 1 (A4-PAPER): search → match chip shows last price → pick → price prefilled to 120
  const searchButtons = page.getByRole('button', { name: 'ค้นหา/เทียบ' });
  await searchButtons.first().click();
  await expect(page.getByRole('button', { name: /A4-PAPER.*ล่าสุด ฿120/ })).toBeVisible();
  await page.getByRole('button', { name: /A4-PAPER.*ล่าสุด ฿120/ }).click();
  // the first line's price input now holds 120
  await expect(page.locator('input[type="number"]').nth(2)).toHaveValue('120'); // [qty,qty pattern] price is 3rd number input on line 1

  // ⑤ line 2 (Iberico ham): search → NOT FOUND hint appears (the fix that was silent before)
  await searchButtons.nth(1).click();
  await expect(page.getByText(/ไม่พบ .* ในทะเบียนสินค้า/)).toBeVisible();

  // submit works (stubbed) — button enabled, click resolves
  await page.getByRole('button', { name: 'สร้างใบสั่งซื้อ (PO)' }).click();
  await expect.poll(() => (page as any).__getToPo()).not.toBeNull();
  const body = (page as any).__getToPo();
  expect(body.vendor_id).toBe(7);              // picked from master (not free text)
  expect(body.lines[0].unit_price).toBe(120);  // last-price prefill carried through
});
