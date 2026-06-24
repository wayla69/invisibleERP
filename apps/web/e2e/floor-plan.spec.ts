import { test, expect, type Page } from '@playwright/test';

/**
 * Floor-plan editor — interactive smoke test for the staff layout tools.
 * The backend is fully stubbed via route interception (no API/DB needed); we seed the auth token so the
 * app shell stays put, then assert the editor renders and that adding a table / a room posts to the API.
 * Runs against the production build (see playwright.config.ts).
 */

const TABLE = { id: 1, table_no: 'A1', status: 'available', seats: 4, zone_id: null, shape: 'rect', rotation: 0, rev: 0, pos_x: 40, pos_y: 40, width: 80, height: 80, session: null, order: null };

async function boot(page: Page): Promise<string[]> {
  const posts: string[] = [];
  await page.addInitScript(() => localStorage.setItem('ierp_token', 'e2e-token'));
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json({ username: 'mgr', role: 'Admin', customer_name: 'T1', permissions: ['pos'] });
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/restaurant/tables/status')) return json({ tables: [TABLE], generated_at: '' });
    if (url.includes('/api/restaurant/zones')) {
      if (method === 'POST') { posts.push('zone'); return json({ id: 9, name: 'VIP', sort_order: 0, color: '#caa53d', pos_x: 16, pos_y: 16, width: 320, height: 200 }, 201); }
      return json({ zones: [] });
    }
    if (url.includes('/api/restaurant/tables') && method === 'POST') { posts.push('table'); return json({ id: 2, table_no: 'A2' }, 201); }
    return json({});
  });
  return posts;
}

test('staff opens the floor-plan editor, adds a table and a room', async ({ page }) => {
  const posts = await boot(page);
  await page.goto('/tables');

  // switch to the floor-plan tab → the editor toolbar + the seeded table render
  await page.getByRole('tab', { name: 'ผังร้าน' }).click();
  await expect(page.getByRole('button', { name: 'แก้ไขผัง' })).toBeVisible();
  await expect(page.getByRole('button', { name: /โต๊ะ A1/ })).toBeVisible();

  // enter edit mode → the add-room toolbar appears
  await page.getByRole('button', { name: 'แก้ไขผัง' }).click();
  await expect(page.getByPlaceholder(/ชื่อห้อง/)).toBeVisible();

  // add a table → posts to the API
  await page.getByPlaceholder(/เลขโต๊ะ/).fill('A2');
  await page.getByRole('button', { name: 'เพิ่มโต๊ะ' }).click();
  await expect.poll(() => posts).toContain('table');

  // add a VIP room → posts to the API
  await page.getByPlaceholder(/ชื่อห้อง/).fill('VIP');
  await page.getByRole('button', { name: 'เพิ่มห้อง' }).click();
  await expect.poll(() => posts).toContain('zone');
});
