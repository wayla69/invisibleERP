import { expect, test, type Page } from '@playwright/test';

/**
 * Slip pre-fill on the /billing pay-by-transfer card: uploading a slip image runs the client QR decode
 * (no QR in the fixture → falls through) then the doc-ai extraction, and the returned fields pre-fill
 * the claim form — the user still reviews and submits manually. Backend fully stubbed via route
 * interception (same recipe as platform-plans.spec.ts).
 */

// 1×1 PNG — carries no QR, so the flow exercises the AI-extraction fallback deterministically.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function bootBilling(page: Page, slipCalls: unknown[]) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json({ username: 'admin1', role: 'Admin', permissions: ['users', 'dashboard'], is_platform_owner: false });
    if (url.includes('/api/user-prefs')) return json({ favorites: [], navFold: {} });
    if (url.includes('/api/billing/subscription')) return json({ plan_code: 'business', status: 'Active', price_monthly: 4900, addons: [], features: { suites: [] } });
    if (url.includes('/api/billing/plans')) return json({ plans: [] });
    if (url.includes('/api/billing/payment-info')) {
      return json({ plan_code: 'business', plan_name: 'Business', interval: 'monthly', amount_due: 4900, addons: [], suggested_period: '2026-07', promptpay_id: null, qr_payload: null, qr_image: null, bank_details: 'KBank 123-4-56789-0' });
    }
    if (url.includes('/api/billing/payment-claims')) return json({ claims: [] });
    if (url.includes('/api/doc-ai/slip-extract')) {
      slipCalls.push(JSON.parse(route.request().postData() ?? '{}'));
      return json({ fields: { amount: 1234.5, transfer_ref: 'KB2026X99REF', date: '2026-06-30' }, source: 'ai' });
    }
    return json({});
  });
  await page.goto('/billing');
  await expect(page.getByText('ชำระด้วยการโอน / พร้อมเพย์')).toBeVisible();
}

test('uploading a slip pre-fills the claim form from the extraction (user still reviews)', async ({ page }) => {
  const slipCalls: any[] = [];
  await bootBilling(page, slipCalls);
  await page.setInputFiles('input[type="file"]', { name: 'slip.png', mimeType: 'image/png', buffer: PNG_1PX });
  await expect.poll(() => slipCalls.length).toBeGreaterThan(0);
  expect(String(slipCalls[0].data_url)).toMatch(/^data:image\/jpeg;base64,/); // bounded re-encode, not the raw file
  // Pre-filled from the stubbed extraction; period comes from the slip date's month.
  await expect(page.getByRole('textbox', { name: /เลขอ้างอิงจากสลิป/ })).toHaveValue('KB2026X99REF', { timeout: 7_000 });
  await expect(page.locator('input[type="number"]')).toHaveValue('1234.5');
  await expect(page.locator('input[type="month"]')).toHaveValue('2026-06');
  await expect(page.getByText('อ่านสลิปแล้ว — ตรวจสอบข้อมูลก่อนกดแจ้งโอน')).toBeVisible();
});
