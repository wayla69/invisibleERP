import { test, expect, type Page } from '@playwright/test';

/**
 * 0434 diner QR — recommended row + category filter chips (mobile viewport).
 * On-demand capture spec (excluded from CI via `*.capture.spec.ts`); run with the local scratchpad config.
 * Backend fully stubbed via route interception.
 */

const MENU = {
  categories: [
    { id: 1, code: 'main', name: 'อาหารจานหลัก', items: [
      { id: 10, sku: 'M1', name: 'ผัดกะเพราไก่', price: 80, is_available: true, is_recommended: true, description: 'เผ็ดกำลังดี', has_modifiers: false, modifier_groups: [] },
      { id: 11, sku: 'M2', name: 'ข้าวผัดหมู', price: 70, is_available: true, is_recommended: false, description: null, has_modifiers: false, modifier_groups: [] },
    ] },
    { id: 2, code: 'drink', name: 'เครื่องดื่ม', items: [
      { id: 20, sku: 'D1', name: 'ชาเย็น', price: 30, is_available: true, is_recommended: true, description: null, has_modifiers: false, modifier_groups: [] },
      { id: 21, sku: 'D2', name: 'น้ำเปล่า', price: 15, is_available: true, is_recommended: false, description: null, has_modifiers: false, modifier_groups: [] },
    ] },
  ],
  uncategorized: [],
  item_count: 4,
};
const statusOpen = { table_no: '7', session_status: 'open', order_mode: 'a_la_carte', buffet: null, order: null, bill: null };

async function stub(page: Page) {
  await page.route('**/api/qr/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/menu')) return json(MENU);
    if (url.includes('/buffet/tiers')) return json({ tiers: [] });
    return json(statusOpen);
  });
}

test('diner menu shows a recommended row + working category filter chips', async ({ page }) => {
  await stub(page);
  await page.goto('/qr/e2e-token');
  await expect(page.getByText('โต๊ะ 7')).toBeVisible();

  // open the menu tab → filter chip bar + recommended section render
  await page.getByRole('tab', { name: 'เมนู' }).click();
  await expect(page.getByRole('button', { name: 'ทั้งหมด' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'แนะนำ', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'อาหารจานหลัก' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'เครื่องดื่ม' })).toBeVisible();

  // the "เมนูแนะนำ" section lists both recommended items (starred), before the full categories
  await expect(page.getByText('เมนูแนะนำ')).toBeVisible();
  await page.screenshot({ path: (process.env.SHOT_DIR ?? 'test-results') + '/qr-menu-all.png', fullPage: true });

  // filter to a single category → recommended header disappears, only that category's items show
  await page.getByRole('button', { name: 'เครื่องดื่ม' }).click();
  await expect(page.getByText('เมนูแนะนำ')).toHaveCount(0);
  await expect(page.getByText('ชาเย็น')).toBeVisible();
  await expect(page.getByText('ผัดกะเพราไก่')).toHaveCount(0);
  await page.screenshot({ path: (process.env.SHOT_DIR ?? 'test-results') + '/qr-menu-drinks.png', fullPage: true });

  // filter to Recommended → only the two starred dishes across categories
  await page.getByRole('button', { name: 'แนะนำ', exact: true }).click();
  await expect(page.getByText('ผัดกะเพราไก่')).toBeVisible();
  await expect(page.getByText('ชาเย็น')).toBeVisible();
  await expect(page.getByText('น้ำเปล่า')).toHaveCount(0);

  // no horizontal overflow at the phone viewport
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(overflow).toBe(true);
});
