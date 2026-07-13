import { test, expect, type Page } from '@playwright/test';

// Verifies the two-step MFA login: the OTP field stays hidden until the server answers MFA_REQUIRED, then
// appears and the same button re-submits with the 6-digit code. Backend is fully stubbed.
async function boot(page: Page, onLogin: (body: { username: string; password: string; totp?: string }) => unknown) {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/config')) return json(200, { company_name: 'Test Co' });
    if (url.endsWith('/api/login')) {
      const body = route.request().postDataJSON() as { username: string; password: string; totp?: string };
      return json(200 as number, onLogin(body)) as unknown;
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('login reveals the OTP field on MFA_REQUIRED and signs in with the code', async ({ page }) => {
  let firstTry = true;
  await page.route('**/api/login', async (route) => {
    const body = route.request().postDataJSON() as { totp?: string };
    if (firstTry && !body.totp) {
      firstTry = false;
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'MFA_REQUIRED', message: 'TOTP code required', messageTh: 'ต้องใส่รหัสยืนยันสองชั้น (OTP)' } }),
      });
    }
    if (body.totp === '123456') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 't', role: 'Admin' }) });
    }
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'MFA_INVALID', messageTh: 'รหัส OTP ไม่ถูกต้อง' } }) });
  });
  await page.route('**/api/config', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ company_name: 'Test Co' }) }));

  await page.goto('/login');
  await page.fill('#username', 'ivsbcst');
  await page.fill('#password', 'secretpass');

  // OTP field not shown yet.
  await expect(page.locator('#totp')).toHaveCount(0);

  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();

  // Server said MFA_REQUIRED → the OTP field appears and the button relabels.
  await expect(page.locator('#totp')).toBeVisible();
  await expect(page.getByText('ต้องใส่รหัสยืนยันสองชั้น (OTP)')).toBeVisible();

  await page.fill('#totp', '123456');
  await page.getByRole('button', { name: 'ยืนยันรหัส OTP' }).click();

  // On success the app navigates away from /login (to /dashboard for Admin).
  await expect(page).toHaveURL(/\/dashboard/);
});
