import { test, expect, type Page } from '@playwright/test';

/**
 * /requisitions — "สินค้าใกล้หมด" (low-stock) card + one-tap reorder PR.
 * Drives the REAL React card: it renders the low-stock rows, lets you edit the suggested qty and untick
 * an item, then raises ONE PR for the selection via POST /api/procurement/prs. Same two-layer guarantee
 * as the other requisitions/receiving E2Es — proves the web surface actually wires up (not just the API).
 */

const ME = { username: 'amber', role: 'Admin', customer_name: 'AMBER', permissions: [] };

const LOW = {
  count: 2,
  items: [
    { item_id: 'NAPKIN-L', item_description: 'กระดาษเช็ดปาก', uom: 'PACK', on_hand: 5, min_stock: 20, suggested_qty: 35, unit_price: 10 },
    { item_id: 'STRAW-L', item_description: 'หลอด', uom: 'BOX', on_hand: 2, min_stock: 10, suggested_qty: 18, unit_price: 8 },
  ],
};

async function boot(page: Page) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  let prBody: any = null;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {} });
    if (url.includes('/api/line/link-code')) return json({ code: 'ABC123', expires_at: '', linked: false });
    if (url.includes('/api/line/link')) return json({ linked: false });
    if (url.includes('/api/procurement/low-stock')) return json(LOW);
    if (url.includes('/api/procurement/prs') && req.method() === 'POST') { prBody = JSON.parse(String(req.postData() ?? '{}')); return json({ pr_no: 'PR-E2E-REORDER', status: 'Pending', lines: prBody.items?.length ?? 0 }); }
    if (url.includes('/api/procurement/prs')) return json({ prs: [], can_approve: true });
    return json({});
  });
  (page as any).__getPr = () => prBody;
}

test('requisitions: low-stock card renders + one-tap reorder raises a PR for the selection', async ({ page }) => {
  await boot(page);
  await page.goto('/requisitions');

  // ① the card renders both low-stock rows with their shortfall
  await expect(page.getByText('สินค้าใกล้หมด (2)')).toBeVisible();
  await expect(page.getByText('NAPKIN-L', { exact: false })).toBeVisible();
  await expect(page.getByText('STRAW-L', { exact: false })).toBeVisible();

  // ② edit NAPKIN-L's suggested qty 35 → 40 (first number input in the card)
  const qtyInputs = page.locator('#q-NAPKIN-L');
  await expect(qtyInputs).toHaveValue('35');
  await qtyInputs.fill('40');

  // ③ untick STRAW-L so only NAPKIN-L is ordered
  await page.getByLabel('เลือก STRAW-L').uncheck();

  // ④ raise the PR — button reflects the 1 remaining selection
  await page.getByRole('button', { name: /เปิด PR เติมของ \(1\)/ }).click();
  await expect.poll(() => (page as any).__getPr()).not.toBeNull();
  const body = (page as any).__getPr();
  expect(body.items).toHaveLength(1);
  expect(body.items[0].item_id).toBe('NAPKIN-L');
  expect(body.items[0].request_qty).toBe(40); // edited qty carried through
});
