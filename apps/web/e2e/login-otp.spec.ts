import { test, expect } from '@playwright/test';

// Verifies the two-step MFA login: the OTP field stays hidden until the server answers MFA_REQUIRED, then
// appears and the same button re-submits WITH the 6-digit code. The backend is fully stubbed; the assertion
// is on the /api/login request payload (the behaviour under test) rather than on the post-login dashboard,
// which would require a real session cookie.
test('login reveals the OTP field on MFA_REQUIRED and re-submits with the code', async ({ page }) => {
  let loginCalls = 0;
  let lastTotp: string | undefined;

  await page.route('**/api/config', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ company_name: 'Test Co' }) }));

  await page.route('**/api/login', async (route) => {
    loginCalls += 1;
    const body = route.request().postDataJSON() as { username: string; password: string; totp?: string };
    lastTotp = body.totp;
    if (!body.totp) {
      // First attempt — password only → the server demands the second factor.
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'MFA_REQUIRED', message: 'TOTP code required', messageTh: 'ต้องใส่รหัสยืนยันสองชั้น (OTP)' } }),
      });
    }
    // Second attempt carries the code — accept it.
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 't', role: 'Admin' }) });
  });

  await page.goto('/login');
  await page.fill('#username', 'ivsbcst');
  await page.fill('#password', 'secretpass');

  // OTP field is hidden until the server asks for it.
  await expect(page.locator('#totp')).toHaveCount(0);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();

  // MFA_REQUIRED → the field appears, the message shows, and the first call carried NO code.
  await expect(page.locator('#totp')).toBeVisible();
  await expect(page.getByText('ต้องใส่รหัสยืนยันสองชั้น (OTP)')).toBeVisible();
  expect(lastTotp).toBeUndefined();

  await page.fill('#totp', '123456');
  await page.getByRole('button', { name: 'ยืนยันรหัส OTP' }).click();

  // The second submit re-sent username + password together with the 6-digit code.
  await expect.poll(() => lastTotp).toBe('123456');
  expect(loginCalls).toBe(2);
});
