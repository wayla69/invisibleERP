import { test, expect, type Page } from '@playwright/test';

/**
 * docs/61 — the /marketing-activation Marketing Studio workspace (desktop). Boots with a marketing-duty
 * user, stubs every /api/** call with fixtures shaped exactly like the marketing-activation services'
 * responses, and walks the five tools: overview KPIs, the ③ propensity lookup (ranked offers with the
 * driver/lift facts), the ⑤ segment×channel ranking + staged budget plan (POST body captured), the ② NBA
 * preview via the segment combobox (EV targets + recorded suppression), and the ④ churn-save preview
 * (capped offer chip + retention P&L). Also asserts the marketing-family style rule: NO ฿ sign anywhere —
 * amounts render as "… THB".
 */

const ME = { username: 'napa', role: 'Sales', customer_name: 'T1', permissions: ['marketing'] };
const MI_SUMMARY = {
  mmm: { payload: { channels: [{ channel: 'facebook', spend: 50000, roi: 3.2 }, { channel: 'tiktok', spend: 20000, roi: 1.4 }] }, model_run_ref: 'MMM-1', pushed_at: '2026-07-23T00:00:00Z' },
  rfm: { payload: { segments: [{ segment: 'At Risk VIPs', customers: 12, monetary: 1000 }] }, pushed_at: '2026-07-23T00:00:00Z' },
  tows: null, updated_at: '2026-07-23T00:00:00Z', has_data: true,
};
const OFFERS = {
  customer_no: 'M-1042', marketing_opt_in: true, clv: 8400.5, window: { from: '2026-04-24', to: '2026-07-23' }, owned_count: 1,
  offers: [
    { item_id: 'CROISSANT', name: 'ครัวซองต์เนยสด', confidence_pct: 100, lift: 2.4, unit_margin: 40, margin_pct: 50, driver_item_id: 'LATTE', driver_name: 'กาแฟลาเต้', score: 3.6 },
    { item_id: 'CAKE', name: 'เค้กช็อกโกแลต', confidence_pct: 62, lift: 1.9, unit_margin: 60, margin_pct: 60, driver_item_id: 'LATTE', driver_name: 'กาแฟลาเต้', score: 1.9 },
  ],
  note: 'Advisory scoring only (MKT-23).',
};
const ROI = {
  budget: 100000, basis: 'MMM-1', has_mmm: true, segment_count: 1,
  cells: [
    { segment: 'At Risk VIPs', channel: 'facebook', channel_roi: 3.2, lift_pct: 900, lift_multiplier: 10, incremental_roi: 32, reach: 12, avg_clv: 8400.5, value_weight: 100806, score: 3225792 },
    { segment: 'At Risk VIPs', channel: 'tiktok', channel_roi: 1.4, lift_pct: null, lift_multiplier: 1, incremental_roi: 1.4, reach: 12, avg_clv: 8400.5, value_weight: 100806, score: 141128 },
  ],
  channel_allocation: { facebook: 95000, tiktok: 5000 }, recommendation_basis: 'measured+mmm', note: 'Advisory ranking only (MKT-25).',
};
const NBA_PREVIEW = {
  segment: 'At Risk VIPs', scored: 5, treatment_count: 2, control_count: 1, suppressed_count: 1,
  targets: [
    { member_id: 1042, action: 'WINBACK', expected_value: 1512, arm: 'treatment', preferred_channel: 'facebook' },
    { member_id: 2087, action: 'UPSELL', expected_value: 520, arm: 'treatment', preferred_channel: 'line' },
    { member_id: 3311, action: 'WINBACK', expected_value: 480, arm: 'control', preferred_channel: null },
  ],
  suppressed: [{ member_id: 4102, reason: 'RECENT_PURCHASE', action: 'CROSS_SELL' }],
  note: 'Advisory preview (MKT-22).',
};
const SAVE_PREVIEW = {
  policy_no: 'SAVEPOL-1', policy: { churn_threshold: 0.5, min_clv: 100, offer_rate: 0.1, offer_cap: 500 },
  segment: null, swept: 842, eligible: 120, treatment_count: 96, control_count: 24,
  offer_cost: 48000, expected_saved_revenue: 201600, net_benefit: 153600, roi: 3.2,
  targets: [
    { member_id: 1042, clv: 8400.5, churn_risk: 0.72, offer: 500, arm: 'treatment', expected_saved: 2117 },
    { member_id: 3311, clv: 6900, churn_risk: 0.58, offer: 500, arm: 'control', expected_saved: 1400 },
  ],
  note: 'Advisory retention P&L (MKT-24).',
};
const JOURNEYS = { journeys: [
  { journey_no: 'NBA-1', status: 'Pending', segment: 'At Risk VIPs', channel: 'sms', target_count: 2, control_count: 1, suppressed_count: 1, requested_by: 'napa', approved_by: null, campaign_id: null, created_at: '2026-07-23T00:00:00Z', activated_at: null },
  // A measured journey — the realized-lift chip (MKT-19 discipline extended to ② journeys).
  { journey_no: 'NBA-0', status: 'Active', segment: 'At Risk VIPs', channel: 'sms', target_count: 1, control_count: 1, suppressed_count: 0, requested_by: 'napa', approved_by: 'somchai', campaign_id: 7, created_at: '2026-07-01T00:00:00Z', activated_at: '2026-07-01T01:00:00Z', measured_at: '2026-07-15T00:00:00Z', measured_by: 'napa', realized_lift_pct: 900, incremental_revenue: 900, treatment_per_head: 1000, control_per_head: 100 },
] };
const POLICIES = { policies: [{ policy_no: 'SAVEPOL-1', status: 'Active', churn_threshold: 0.5, min_clv: 100, offer_rate: 0.1, offer_cap: 500, requested_by: 'napa', approved_by: 'somchai', created_at: '2026-07-23T00:00:00Z' }] };
const RUNS = { runs: [
  { run_no: 'SAVE-1', policy_no: 'SAVEPOL-1', segment: null, treatment_count: 96, control_count: 24, offer_cost: 48000, expected_saved_revenue: 201600, net_benefit: 153600, campaign_id: 9, created_at: '2026-07-23T00:00:00Z' },
  // A measured run — expected becomes PROVEN (realized retention P&L).
  { run_no: 'SAVE-0', policy_no: 'SAVEPOL-1', segment: null, treatment_count: 90, control_count: 20, offer_cost: 40000, expected_saved_revenue: 180000, net_benefit: 140000, campaign_id: 5, created_at: '2026-07-01T00:00:00Z', measured_at: '2026-07-15T00:00:00Z', measured_by: 'napa', realized_lift_pct: 42.5, realized_saved_revenue: 160000, realized_net_benefit: 120000 },
] };

const CENTER = { items: [
  { kind: 'journey_measure_due', severity: 'high', control: 'MKT-22', ref: 'NBA-9', title_th: 'ครบกำหนดวัดผลแผน NBA NBA-9', title_en: 'NBA journey NBA-9 is due for measurement' },
  { kind: 'save_policy_pending', severity: 'medium', control: 'MKT-24', ref: 'SAVEPOL-9', title_th: 'นโยบายรักษาลูกค้า SAVEPOL-9 รออนุมัติ', title_en: 'Save-offer policy SAVEPOL-9 awaits approval' },
], count: 2 };

async function boot(page: Page) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  let stagedRoiBody: any = null;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/marketing-activation/action-center')) return json(CENTER);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {} });
    if (url.includes('/api/marketing-intel/summary')) return json(MI_SUMMARY);
    if (url.includes('/api/marketing-activation/propensity/customer/')) return json(OFFERS);
    if (url.includes('/api/marketing-activation/propensity/item/')) return json({ item_id: 'X', item_name: 'X', unit_margin: null, window: {}, driver_item_ids: [], candidate_members: 0, audiences: [], note: '' });
    // stage POST (has a trailing segment) must be matched before the ranking GET
    if (url.includes('/api/marketing-activation/segment-channel-roi/stage') && req.method() === 'POST') {
      stagedRoiBody = req.postDataJSON();
      return json({ plan_no: 'BP-1', status: 'Pending', channel_allocation: ROI.channel_allocation, recommendation_basis: 'measured+mmm', top_cell: ROI.cells[0] });
    }
    if (url.includes('/api/marketing-activation/segment-channel-roi')) return json(ROI);
    if (url.includes('/api/marketing-activation/nba/preview')) return json(NBA_PREVIEW);
    if (url.includes('/api/marketing-activation/nba/journeys')) return json(JOURNEYS);
    if (url.includes('/api/marketing-activation/studio/generations')) return json({ generations: [] });
    if (url.includes('/api/marketing-activation/save/preview')) return json(SAVE_PREVIEW);
    if (url.includes('/api/marketing-activation/save/policies')) return json(POLICIES);
    if (url.includes('/api/marketing-activation/save/runs')) return json(RUNS);
    return json({});
  });
  (page as any).__getStagedRoiBody = () => stagedRoiBody;
}

test('marketing activation (desktop): the five tools render their facts, staging is captured, and no ฿ appears', async ({ page }) => {
  await boot(page);
  await page.goto('/marketing-activation');

  // Hero + the six tabs (assert by NAME — the AppShell workspace switcher also exposes role=tab, so a
  // global count would see extra chrome tabs).
  await expect(page.getByRole('heading', { name: 'ศูนย์เปิดใช้การตลาด' })).toBeVisible();
  for (const name of ['ภาพรวม', 'สินค้าที่ควรเสนอ', 'ROI กลุ่ม × ช่องทาง', 'ลำดับการกระทำ', 'สตูดิโอ AI', 'รักษาลูกค้า']) {
    await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
  }

  // Overview: real-read KPIs (1 journey, latest save-run net as THB) + the trust card.
  await expect(page.getByText('Journey ทั้งหมด')).toBeVisible();
  await expect(page.getByText('154K THB').first()).toBeVisible(); // compactThb(153600)
  await expect(page.getByText('ทำงานอย่างปลอดภัย')).toBeVisible();
  // docs/62 action center: the "what needs me now" card lists severity-dotted items with their controls.
  await expect(page.getByText('สิ่งที่รอคุณตอนนี้')).toBeVisible();
  await expect(page.getByText('ครบกำหนดวัดผลแผน NBA NBA-9')).toBeVisible();

  // ③ Propensity: look a customer up → ranked offers with the driver/lift facts.
  await page.getByRole('tab', { name: 'สินค้าที่ควรเสนอ' }).click();
  await page.getByPlaceholder(/รหัสลูกค้า/).fill('M-1042');
  // Submit via Enter — a global ค้นหา button also exists in the AppShell chrome, so a name-based click is ambiguous.
  await page.getByPlaceholder(/รหัสลูกค้า/).press('Enter');
  await expect(page.getByText('ครัวซองต์เนยสด')).toBeVisible();
  await expect(page.getByText('lift 2.4')).toBeVisible();
  await expect(page.getByText(/เพราะซื้อ “กาแฟลาเต้”/).first()).toBeVisible();

  // ⑤ Segment × Channel: the ranking renders (measured lift chip) and staging captures the budget.
  await page.getByRole('tab', { name: 'ROI กลุ่ม × ช่องทาง' }).click();
  await expect(page.getByText('At Risk VIPs').first()).toBeVisible();
  await expect(page.getByText(/lift จริง/).first()).toBeVisible();
  await page.getByRole('button', { name: /จัดเป็นแผนงบ/ }).click();
  await expect.poll(() => (page as any).__getStagedRoiBody()).toEqual({ total_budget: 100000 });

  // ② NBA: pick the segment → EV-ranked targets + the recorded suppression reason.
  await page.getByRole('tab', { name: 'ลำดับการกระทำ' }).click();
  // Scope to the tabpanel — the AppShell language <select> is also role=combobox.
  await page.getByRole('tabpanel', { name: 'ลำดับการกระทำ' }).getByRole('combobox').click();
  await page.getByRole('option', { name: 'At Risk VIPs' }).click();
  await expect(page.getByText('WINBACK').first()).toBeVisible();
  await expect(page.getByText('RECENT_PURCHASE')).toBeVisible();
  // The measured journey shows its realized-lift chip (MKT-19 discipline); the unmeasured Active one would
  // show วัดผล — here NBA-0 is measured, so the proven lift renders instead of a button.
  await expect(page.getByText(/lift จริง \+900/)).toBeVisible();

  // ④ Churn-save: the retention P&L + a capped offer chip (the MKT-24 control made visible).
  await page.getByRole('tab', { name: 'รักษาลูกค้า' }).click();
  await expect(page.getByText('เข้าเกณฑ์ + ยินยอม')).toBeVisible();
  await expect(page.getByText('202K THB').first()).toBeVisible(); // compactThb(201600) expected saved
  await expect(page.getByText('ชนเพดาน').first()).toBeVisible();
  // Run history: the unmeasured run offers วัดผล; the measured run shows the PROVEN realized net benefit.
  await expect(page.getByRole('button', { name: 'วัดผล' })).toBeVisible();
  await expect(page.getByText(/พิสูจน์แล้ว 120K THB/)).toBeVisible(); // compactThb(120000) realized net

  // The marketing-family style rule: no ฿ sign anywhere on the workspace.
  await expect(page.getByText('฿')).toHaveCount(0);
});
