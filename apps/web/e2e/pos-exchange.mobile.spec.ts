import { test, expect, type Page } from '@playwright/test';

/**
 * docs/52 Phase 4e — the POS exchange flow at PHONE viewport (iPhone 13, mobile-iphone project). A REAL-TAP
 * smoke of the /pos/register แลกเปลี่ยน button + dialog: pick the original bill, set the return qty, catalog-add
 * a replacement, read the live net preview, key a reason and confirm — driven with ordinary clicks so a covered
 * control (the "ปุ่มซ้อนกันกดไม่ได้" bug class) fails the tap. After each stage we assert NO horizontal page
 * overflow — on mobile an overflow widens the layout viewport and shifts the fixed dialog off-screen (the /shop
 * PR #509 lesson in CLAUDE.md). All /api/** calls are stubbed (no backend/DB); the POST body is captured and
 * asserted so the dialog wires the return + replacement lines + reason through faithfully.
 */

// A refund-duty operator (returns/pos_refund/exec) — the exchange button is perm-gated to this set and is
// hidden from a plain pos_sell cashier (mirrors the API's SoD R08 gate).
const ME = { username: 'clerk', role: 'Sales', customer_name: 'T1', permissions: ['pos', 'pos_sell', 'returns', 'pos_refund', 'exec'] };
const PROFILE = { business_type: 'retail', tables: false, kds: false, sale_path: 'generic' };
const MENU = {
  categories: [{ id: 1, code: 'main', name: 'สินค้า', name_en: null, color: null, sort: 0, items: [
    { id: 1, sku: 'WIDGET', name: 'วิดเจ็ต', name_en: null, type: 'retail', price: 100, station_code: null, is_available: true, available_now: true, has_modifiers: false },
  ] }],
  uncategorized: [], item_count: 1,
};
const ORDERS = { orders: [{ Sale_No: 'SALE-M-001', Status: 'Completed', Total: '107.00' }], count: 1 };
const ORDER_DETAIL = { order: { saleNo: 'SALE-M-001' }, items: [
  { id: 501, itemId: 'WIDGET', itemDescription: 'วิดเจ็ต', qty: '1', unitPrice: '100', amount: '100', uom: 'ชิ้น' },
] };
const CATALOG = { items: [{ item_id: 'GADGET', item_description: 'แกดเจ็ต', uom: 'ชิ้น', unit_price: 150 }] };

async function boot(page: Page) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  let exchangeBody: any = null;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {}, pos_fav: [] });
    if (url.includes('/api/pos/profile')) return json(PROFILE);
    if (url.endsWith('/api/menu')) return json(MENU);
    if (url.includes('/api/pos/held')) return json({ held: [] });
    if (url.includes('/api/pricing/books')) return json({ books: [] });
    if (url.includes('/api/pos/summary')) return json({});
    // the exchange POST — capture the body, return an UP-SWAP result (customer pays the difference)
    if (url.includes('/api/pos/exchange') && req.method() === 'POST') {
      exchangeBody = req.postDataJSON();
      return json({ exchange_no: 'EXC-M-001', return_no: 'RTN-M-001', new_sale_no: 'SALE-M-002', credit_note_no: null,
        returned_value: 107, new_value: 160.5, store_credit_card_no: 'GC-M-001', store_credit_applied: 107,
        net_difference: 53.5, cash_collected: 53.5, residual_store_credit: 0, even: false });
    }
    // order DETAIL (has a trailing segment) must be matched before the list
    if (/\/api\/pos\/orders\/[^/?]+/.test(url)) return json(ORDER_DETAIL);
    if (url.includes('/api/pos/orders')) return json(ORDERS);
    if (url.includes('/api/procurement/catalog')) return json(CATALOG);
    return json({});
  });
  (page as any).__getExchangeBody = () => exchangeBody;
}

async function assertNoHorizontalOverflow(page: Page, stage: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontal overflow at stage: ${stage}`).toBeLessThanOrEqual(0);
}

test('pos exchange (phone): the แลกเปลี่ยน flow is fully tappable and nets to the cash difference', async ({ page }) => {
  await boot(page);
  await page.goto('/pos/register');

  // The register renders; the exchange button is present for a refund-duty operator.
  const exchangeBtn = page.getByRole('button', { name: /แลกเปลี่ยน/ });
  await expect(exchangeBtn).toBeVisible();
  await assertNoHorizontalOverflow(page, 'register loaded');

  // ① open the dialog (real tap) → title + bill picker render, still no page overflow.
  await exchangeBtn.click();
  await expect(page.getByRole('heading', { name: 'แลกเปลี่ยนสินค้า' })).toBeVisible();
  await expect(page.getByText('บิลเดิม')).toBeVisible();
  await assertNoHorizontalOverflow(page, 'exchange dialog open');

  // ② pick the original bill (Radix select trigger → its option).
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: /SALE-M-001/ }).click();

  // ③ the returnable line loads with a qty stepper; bump it to 1.
  await expect(page.getByText('สินค้าที่คืน')).toBeVisible();
  const retQty = page.locator('input[type="number"]').first();
  await expect(retQty).toHaveValue('0');
  await retQty.fill('1');
  await assertNoHorizontalOverflow(page, 'return line picked');

  // ④ catalog-add a replacement item (typeahead → result → line added with its price).
  await page.getByPlaceholder(/ค้นหาสินค้า/).fill('GAD');
  await page.getByRole('button', { name: /แกดเจ็ต/ }).first().click();

  // ⑤ the live net preview shows the customer pays the difference (150 − 100 = ฿50, pre-VAT approx).
  await expect(page.getByText('มูลค่าที่คืน')).toBeVisible();
  await expect(page.getByText(/ลูกค้าจ่ายเพิ่ม/)).toBeVisible();
  await assertNoHorizontalOverflow(page, 'replacement added + net preview');

  // ⑥ reason is required; key it and confirm.
  await page.getByPlaceholder(/เปลี่ยนไซซ์/).fill('เปลี่ยนไซซ์');
  await page.getByRole('button', { name: 'ยืนยันการแลกเปลี่ยน' }).click();

  // ⑦ success screen: exchange no. + the cash-collected outcome (up-swap).
  await expect(page.getByText('แลกเปลี่ยนสำเร็จ')).toBeVisible();
  await expect(page.getByText('EXC-M-001')).toBeVisible();
  await expect(page.getByText(/เก็บเงินเพิ่ม/)).toBeVisible();
  await assertNoHorizontalOverflow(page, 'exchange success');

  // ⑧ the POST body faithfully carried the return line, the replacement line and the reason.
  const body = (page as any).__getExchangeBody();
  expect(body.sale_no).toBe('SALE-M-001');
  expect(body.return_items).toEqual([{ sale_item_id: 501, qty: 1 }]);
  expect(body.new_items).toHaveLength(1);
  expect(body.new_items[0]).toMatchObject({ item_id: 'GADGET', qty: 1, unit_price: 150 });
  expect(body.reason).toBe('เปลี่ยนไซซ์');
});

test('pos exchange (phone): a plain cashier (pos_sell only) does NOT see the exchange button', async ({ page }) => {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json({ username: 'cashier', role: 'Cashier', customer_name: 'T1', permissions: ['pos_sell'] });
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {}, pos_fav: [] });
    if (url.includes('/api/pos/profile')) return json(PROFILE);
    if (url.endsWith('/api/menu')) return json(MENU);
    if (url.includes('/api/pos/held')) return json({ held: [] });
    if (url.includes('/api/pricing/books')) return json({ books: [] });
    if (url.includes('/api/pos/orders')) return json(ORDERS);
    return json({});
  });
  await page.goto('/pos/register');
  // the register itself renders (menu grid), but the refund-gated exchange button is absent (SoD R08).
  await expect(page.getByRole('button', { name: /วิดเจ็ต/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /แลกเปลี่ยน/ })).toHaveCount(0);
});
