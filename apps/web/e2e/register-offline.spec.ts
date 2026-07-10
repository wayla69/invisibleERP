import { test, expect, type Page } from '@playwright/test';

/**
 * Touch-register offline selling — interactive smoke test.
 * Covers what build/unit checks can't: a quick cash sale rung while the network is down is queued
 * locally (IndexedDB) and shows the "บันทึกออฟไลน์" success state + a pending-sync badge; on reconnect
 * the register auto-replays it to POST /api/restaurant/offline-sync and the badge clears.
 * The backend is fully stubbed via route interception (no API/DB needed).
 */

const ME = { username: 'cashier1', role: 'Cashier', customer_name: 'T1', permissions: ['pos_sell'] };

const MENU = {
  categories: [
    { id: 1, code: 'main', name: 'จานหลัก', name_en: null, color: null, sort: 0, items: [
      { id: 1, sku: 'GP01', name: 'ผัดกะเพราไก่', name_en: null, type: 'food', price: 100, station_code: 'hot', is_available: true, available_now: true, has_modifiers: false },
    ] },
  ],
  uncategorized: [],
  item_count: 1,
};

async function boot(page: Page) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  let syncs = 0;
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.endsWith('/api/menu')) return json(MENU);
    if (url.includes('/api/pos/held')) return json({ held: [] });
    if (url.includes('/api/restaurant/tables')) return json({ tables: [] });
    if (url.includes('/api/pos/orders')) return json({ orders: [], count: 0 });
    if (url.includes('/api/restaurant/offline-sync')) {
      syncs++;
      // echo back each queued sale's client_uuid (the real server does this) so the client can match
      // the result to the local outbox row and remove it.
      const body = route.request().postDataJSON() as { sales: { client_uuid: string }[] };
      const results = (body?.sales ?? []).map((s, i) => ({ client_uuid: s.client_uuid, status: 'synced' as const, sale_no: `SALE-OFF-${i + 1}`, error: null }));
      return json({ results, summary: { synced: results.length, duplicate: 0, failed: 0 } });
    }
    return json({});
  });
  return { syncCount: () => syncs };
}

test('register queues a cash sale offline and auto-syncs it on reconnect', async ({ page, context }) => {
  const stub = await boot(page);
  await page.goto('/pos/register');

  // ring a menu item into the cart (online, so the menu loads)
  await expect(page.getByRole('button', { name: /ผัดกะเพราไก่/ })).toBeVisible();
  await page.getByRole('button', { name: /ผัดกะเพราไก่/ }).click();

  // go offline → the register flips to its offline state
  await context.setOffline(true);
  await expect(page.getByText('ออฟไลน์ — บันทึกในเครื่อง')).toBeVisible();

  // checkout a cash sale — it should be saved offline (not a server sale)
  await page.getByRole('button', { name: /ชำระเงิน/ }).click();
  await page.getByRole('button', { name: 'พอดี' }).click();
  await page.getByRole('button', { name: /ยืนยันชำระเงิน/ }).click();

  await expect(page.getByText('บันทึกออฟไลน์แล้ว')).toBeVisible();
  await page.getByRole('button', { name: 'ขายต่อไป' }).click();

  // a pending-sync badge appears
  await expect(page.getByRole('button', { name: /รอซิงค์ 1/ })).toBeVisible();

  // reconnect → the queued sale auto-replays to /api/restaurant/offline-sync and the badge clears
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: /รอซิงค์/ })).toHaveCount(0);
  expect(stub.syncCount()).toBeGreaterThan(0);
});

test('menu survives a reload while /api/menu is unreachable (localStorage snapshot)', async ({ page }) => {
  await boot(page);
  await page.goto('/pos/register');
  // first online load caches the menu snapshot to localStorage (fetchMenuOfflineFirst)
  await expect(page.getByRole('button', { name: /ผัดกะเพราไก่/ })).toBeVisible();

  // kill the menu API at the NETWORK level and reload — the register must render from the snapshot
  // (this is the "reboot the till mid-outage" case: the SW serves the shell but never caches /api/*)
  await page.route('**/api/menu', (route) => route.abort('failed'));
  await page.reload();
  await expect(page.getByRole('button', { name: /ผัดกะเพราไก่/ })).toBeVisible();

  // and the recovered menu is sellable — ring a line into the cart
  await page.getByRole('button', { name: /ผัดกะเพราไก่/ }).click();
  await expect(page.getByRole('button', { name: /ชำระเงิน/ })).toBeEnabled();
});

test('checkout falls back to the offline queue when the network dies but the browser still reports online', async ({ page }) => {
  const stub = await boot(page);
  await page.goto('/pos/register');
  await expect(page.getByRole('button', { name: /ผัดกะเพราไก่/ })).toBeVisible();
  await page.getByRole('button', { name: /ผัดกะเพราไก่/ }).click();

  // navigator.onLine stays TRUE (no context.setOffline) — but order creation dies at the network
  // level, the real-world "router up, internet down" failure the onLine flag cannot see
  await page.route('**/api/restaurant/orders', (route) => route.abort('failed'));

  await page.getByRole('button', { name: /ชำระเงิน/ }).click();
  await page.getByRole('button', { name: 'พอดี' }).click();
  await page.getByRole('button', { name: /ยืนยันชำระเงิน/ }).click();

  // the sale is queued locally instead of erroring at the cashier
  await expect(page.getByText('บันทึกออฟไลน์แล้ว')).toBeVisible();
  await page.getByRole('button', { name: 'ขายต่อไป' }).click();
  await expect(page.getByRole('button', { name: /รอซิงค์ 1/ })).toBeVisible();

  // network restored → tapping the pending badge replays the queue and it clears
  await page.unroute('**/api/restaurant/orders');
  await page.getByRole('button', { name: /รอซิงค์ 1/ }).click();
  await expect(page.getByRole('button', { name: /รอซิงค์/ })).toHaveCount(0);
  expect(stub.syncCount()).toBeGreaterThan(0);
});
