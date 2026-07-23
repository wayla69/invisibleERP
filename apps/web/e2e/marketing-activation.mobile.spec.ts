import { test, expect, type Page } from '@playwright/test';

/**
 * docs/61 — /marketing-activation at PHONE viewport (iPhone 13, mobile-iphone project). Walks all six tabs
 * and asserts NO horizontal page overflow after each stage — on mobile an overflow widens the layout
 * viewport and shifts fixed elements off-screen (the /shop PR #509 lesson in CLAUDE.md). All /api/** calls
 * are stubbed; fixtures mirror the marketing-activation service response shapes.
 */

const ME = { username: 'napa', role: 'Sales', customer_name: 'T1', permissions: ['marketing'] };
const MI_SUMMARY = {
  mmm: { payload: { channels: [{ channel: 'facebook', spend: 50000, roi: 3.2 }] }, model_run_ref: 'MMM-1', pushed_at: '2026-07-23T00:00:00Z' },
  rfm: { payload: { segments: [{ segment: 'At Risk VIPs', customers: 12, monetary: 1000 }] }, pushed_at: '2026-07-23T00:00:00Z' },
  tows: null, updated_at: '2026-07-23T00:00:00Z', has_data: true,
};
const ROI = {
  budget: 100000, basis: 'MMM-1', has_mmm: true, segment_count: 1,
  cells: [{ segment: 'At Risk VIPs', channel: 'facebook', channel_roi: 3.2, lift_pct: null, lift_multiplier: 1, incremental_roi: 3.2, reach: 12, avg_clv: 8400.5, value_weight: 100806, score: 322579 }],
  channel_allocation: { facebook: 100000 }, recommendation_basis: 'mmm', note: '',
};
const SAVE_PREVIEW = {
  policy_no: 'SAVEPOL-1', policy: { churn_threshold: 0.5, min_clv: 100, offer_rate: 0.1, offer_cap: 500 },
  segment: null, swept: 842, eligible: 120, treatment_count: 96, control_count: 24,
  offer_cost: 48000, expected_saved_revenue: 201600, net_benefit: 153600, roi: 3.2,
  targets: [{ member_id: 1042, clv: 8400.5, churn_risk: 0.72, offer: 500, arm: 'treatment', expected_saved: 2117 }],
  note: '',
};

async function boot(page: Page) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {} });
    if (url.includes('/api/marketing-intel/summary')) return json(MI_SUMMARY);
    if (url.includes('/api/marketing-activation/segment-channel-roi')) return json(ROI);
    if (url.includes('/api/marketing-activation/nba/journeys')) return json({ journeys: [] });
    if (url.includes('/api/marketing-activation/studio/generations')) return json({ generations: [] });
    if (url.includes('/api/marketing-activation/save/preview')) return json(SAVE_PREVIEW);
    if (url.includes('/api/marketing-activation/save/policies')) return json({ policies: [] });
    if (url.includes('/api/marketing-activation/save/runs')) return json({ runs: [] });
    return json({});
  });
}

async function assertNoHorizontalOverflow(page: Page, stage: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontal overflow at stage: ${stage}`).toBeLessThanOrEqual(0);
}

test('marketing activation (phone): every tab renders without horizontal overflow', async ({ page }) => {
  await boot(page);
  await page.goto('/marketing-activation');

  await expect(page.getByRole('heading', { name: 'ศูนย์เปิดใช้การตลาด' })).toBeVisible();
  await assertNoHorizontalOverflow(page, 'overview');

  const tabs: { name: string; probe: RegExp }[] = [
    { name: 'สินค้าที่ควรเสนอ', probe: /รหัสลูกค้า|ควรเสนอ/ },
    { name: 'ROI กลุ่ม × ช่องทาง', probe: /เงินก้อนถัดไป/ },
    { name: 'ลำดับการกระทำ', probe: /ใครควรได้รับการดูแลก่อน/ },
    { name: 'สตูดิโอ AI', probe: /ร่างแคมเปญ/ },
    { name: 'รักษาลูกค้า', probe: /กติกาข้อเสนอ/ },
  ];
  for (const tabDef of tabs) {
    await page.getByRole('tab', { name: tabDef.name }).click();
    await expect(page.getByText(tabDef.probe).first()).toBeVisible();
    await assertNoHorizontalOverflow(page, tabDef.name);
  }
});
