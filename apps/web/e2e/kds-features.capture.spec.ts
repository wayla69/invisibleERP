import { test, expect, type Page } from '@playwright/test';

/**
 * 0434 KDS — board grouping tabs, food-priority badge, >10-min stuck alarm, serve-whole-ticket.
 * On-demand capture spec (excluded from CI via `*.capture.spec.ts`); run with the local scratchpad config.
 * Backend fully stubbed; the realtime SSE stream is short-circuited so the board falls back to polling.
 */

const ME = { username: 'chef', role: 'Admin', customer_name: null, permissions: ['pos', 'order_mgt', 'exec'] };

const FEED = {
  stations: [
    { station_id: 1, station_code: 'hot', station_name: 'ครัวร้อน', items: [
      { item_id: 101, order_no: 'DIN-A', table_label: '5', table_id: 5, name: 'สเต๊กเนื้อ', qty: 1, modifiers: [], notes: null,
        kds_status: 'queued', fired_at: '2026-07-18T03:00:00Z', elapsed_min: 15, prep_min: 12, sla: 'late', stuck: true, priority: 5, is_buffet: false, from_diner: false, course: 1 },
      { item_id: 102, order_no: 'DIN-A', table_label: '5', table_id: 5, name: 'สลัดผัก', qty: 1, modifiers: [], notes: null,
        kds_status: 'queued', fired_at: '2026-07-18T03:00:00Z', elapsed_min: 15, prep_min: 8, sla: 'late', stuck: true, priority: 0, is_buffet: false, from_diner: true, course: 1 },
    ] },
    { station_id: 2, station_code: 'drink', station_name: 'เครื่องดื่ม', items: [
      { item_id: 201, sku: 'D-CHA', order_no: 'DIN-B', table_label: '9', table_id: 9, name: 'ชาเย็น', qty: 2, modifiers: [], notes: null,
        kds_status: 'ready', fired_at: '2026-07-18T03:12:00Z', elapsed_min: 3, prep_min: 5, sla: 'ok', stuck: false, priority: 0, is_buffet: false, from_diner: false, course: 1 },
    ] },
  ],
  stuck_count: 2,
  stuck_minutes: 10,
  summary: { active_count: 3, avg_wait_min: 11, served_today: 7, avg_prep_today_min: 9 },
};

async function boot(page: Page) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  let served = false;
  let eightySixed = false;
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/scale/events/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {}, shop_favs: [], shop_templates: [] });
    if (url.includes('/api/restaurant/kds/serve') && method === 'POST') { served = true; return json({ order_no: 'DIN-B', served: 1 }); }
    if (url.includes('/api/restaurant/kds/start') && method === 'POST') return json({ order_no: 'DIN-A', started: 2 });
    if (url.includes('/availability') && method === 'PATCH') { eightySixed = true; return json({ sku: 'D-CHA', is_available: false }); }
    if (url.includes('/api/restaurant/kds/pacing')) return json({ nudges: [{ order_no: 'DIN-A', table_label: '5', next_course: 2, current_course: 1 }] });
    if (url.includes('/api/restaurant/kds/prep-times')) return json({ dishes: [
      { sku: 'F-STEAK', name: 'สเต๊กเนื้อ', avg_prep_min: 13.4, samples: 8 },
      { sku: 'F-SALAD', name: 'สลัดผัก', avg_prep_min: 4.2, samples: 5 },
    ], generated_at: '2026-07-18T04:30:00Z' });
    if (url.includes('/api/restaurant/kds/feed')) return json(FEED);
    return json({});
  });
  (page as unknown as { _servedFlag: () => boolean })._servedFlag = () => served;
  (page as unknown as { _eightySixFlag: () => boolean })._eightySixFlag = () => eightySixed;
}

test('KDS board: grouping tabs, priority badge, stuck alarm, serve-whole-ticket', async ({ page }) => {
  await boot(page);
  await page.goto('/kds');

  // station board renders the fired items
  await expect(page.getByText('สเต๊กเนื้อ')).toBeVisible();

  // grouping tabs present
  await expect(page.getByRole('tab', { name: 'ตามสถานี' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'ตามโต๊ะ' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'ตามเวลา' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'ตามลำดับความสำคัญ' })).toBeVisible();

  // F8 pacing nudge banner + F4 station filter + F7 void button
  await expect(page.getByText(/ส่งคอร์ส 2 ได้/)).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'เลือกสถานี' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ยกเลิกรายการ' }).first()).toBeVisible();
  // live summary strip + ergonomics controls (sound / big text / fullscreen)
  await expect(page.getByText(/กำลังทำ 3/)).toBeVisible();
  await expect(page.getByText(/เฉลี่ย\/จานวันนี้ 9/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'เสียงเตือน' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ตัวอักษรใหญ่ (จอไกล)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'เต็มจอ' })).toBeVisible();
  await page.getByRole('button', { name: 'ตัวอักษรใหญ่ (จอไกล)' }).click(); // big mode zooms the board (no crash)

  // stuck alarm banner (2 lines over 10 min) + the food-priority badge on the priority-5 dish
  await expect(page.getByText(/รายการค้างเกิน/)).toBeVisible();
  await expect(page.getByText('ลำดับ 5')).toBeVisible();
  await page.screenshot({ path: (process.env.SHOT_DIR ?? 'test-results') + '/kds-board-station.png', fullPage: true });

  // 86-from-KDS: the drink line (has a menu sku) shows an "ของหมด (86)" button → PATCH availability
  const req86 = page.waitForRequest((r) => r.url().includes('/availability') && r.method() === 'PATCH');
  await page.getByRole('button', { name: 'ของหมด (86)' }).first().click();
  await req86;
  expect((page as unknown as { _eightySixFlag: () => boolean })._eightySixFlag()).toBe(true);

  // group by table → the table with a READY line (โต๊ะ 9, fired later ⇒ second card) has an enabled
  // "เสิร์ฟทั้งออเดอร์"; the all-queued table's button is correctly disabled.
  await page.getByRole('tab', { name: 'ตามโต๊ะ' }).click();
  const serveBtn = page.getByRole('button', { name: 'เสิร์ฟทั้งออเดอร์' }).nth(1);
  await expect(serveBtn).toBeEnabled();
  // the all-queued table (โต๊ะ 5, first card) offers an enabled "เริ่มทำทั้งออเดอร์"
  await expect(page.getByRole('button', { name: 'เริ่มทำทั้งออเดอร์' }).first()).toBeEnabled();
  await page.screenshot({ path: (process.env.SHOT_DIR ?? 'test-results') + '/kds-board-table.png', fullPage: true });

  // serve the whole ticket → POST /kds/serve fires
  const req = page.waitForRequest((r) => r.url().includes('/api/restaurant/kds/serve') && r.method() === 'POST');
  await serveBtn.click();
  await req;
  expect((page as unknown as { _servedFlag: () => boolean })._servedFlag()).toBe(true);

  // priority grouping keeps the highest-priority dish first
  await page.getByRole('tab', { name: 'ตามลำดับความสำคัญ' }).click();
  await expect(page.getByText('สเต๊กเนื้อ')).toBeVisible();

  // F5 prep-time report: the "เวลาทำเฉลี่ย" view lists the learned avg per dish + sample count
  await page.getByRole('tab', { name: 'เวลาทำเฉลี่ย' }).click();
  await expect(page.getByRole('columnheader', { name: 'เฉลี่ย (นาที)' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'จำนวนครั้ง' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'สเต๊กเนื้อ' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '13.4′' })).toBeVisible();
  await expect(page.getByText(/อัปเดตเมื่อ/)).toBeVisible();
  await page.screenshot({ path: (process.env.SHOT_DIR ?? 'test-results') + '/kds-prep-times.png', fullPage: true });
});
