import { test, expect, type Page } from '@playwright/test';

/**
 * Verification (docs/49 v1.3, item 4) — the SME first-run setup wizard auto-opens for a control_profile='sme'
 * tenant with incomplete setup + un-dismissed wizard, walks step 0 → step 1, and does NOT open for enterprise.
 * Backend fully route-stubbed (no API/DB). Named *.capture.spec.ts so it's excluded from CI; run locally via a
 * throwaway config with the pre-installed Chromium.
 */
async function boot(page: Page, opts: { profile: 'sme' | 'enterprise'; wizardDone?: boolean; complete?: boolean }) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json({ username: 'owner', role: 'Admin', customer_name: 'SMECO', permissions: ['pos', 'dashboard', 'users'], control_profile: opts.profile, sme_hidden_nav_groups: [] });
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [], navDisabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favorites: [], navFold: {}, pos_fav: [], shop_favs: [], shop_templates: [], sme_wizard_done: !!opts.wizardDone, saved: true });
    if (url.includes('/api/tenant/onboarding-status')) {
      const complete = !!opts.complete;
      return json({ tenant_id: 1, steps: [{ key: 'profile', label_th: 'กรอกข้อมูลบริษัท/ภาษี', done: complete }, { key: 'branch', label_th: 'ตั้งสาขา', done: complete }, { key: 'staff', label_th: 'เพิ่มผู้ใช้', done: complete }, { key: 'catalog', label_th: 'เพิ่มสินค้า', done: complete }], done: complete ? 4 : 0, total: 4, percent: complete ? 100 : 0, complete, next: complete ? null : 'profile' });
    }
    if (url.includes('/api/tenant/profile')) return json({ code: 'SMECO', name: 'SMECO', legal_name: null, tax_id: null, address_line1: null, province: null, setup_complete: false });
    return json({});
  });
}

test('SME tenant: the setup wizard auto-opens and advances to the identity form', async ({ page }) => {
  await boot(page, { profile: 'sme', wizardDone: false, complete: false });
  await page.goto('/setup');

  // Step 0 — the wizard dialog auto-opens with the SME title + welcome copy.
  await expect(page.getByRole('dialog').getByText('ตั้งค่าธุรกิจของคุณ (โหมด SME)')).toBeVisible();
  await expect(page.getByText(/บัญชีนี้เป็นโหมด SME/)).toBeVisible();
  await expect(page.getByText(/ขั้นที่ 1 จาก 3/)).toBeVisible();
  await page.screenshot({ path: '/tmp/sme-wizard-step0.png' });

  // Advance → step 1 identity form shows the four setup_complete fields. Scope to the dialog: the /setup
  // page behind the modal renders the same field labels, so an un-scoped text match would be ambiguous.
  await page.getByRole('button', { name: 'เริ่มตั้งค่า' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/ขั้นที่ 2 จาก 3/)).toBeVisible();
  await expect(dialog.getByText('ชื่อนิติบุคคล (ตามทะเบียน)')).toBeVisible();
  await expect(dialog.getByText('เลขประจำตัวผู้เสียภาษี')).toBeVisible();
  await expect(dialog.getByText('จังหวัด')).toBeVisible();
  await page.screenshot({ path: '/tmp/sme-wizard-step1.png' });

  // Save is disabled until the required fields are filled (blank form).
  await expect(dialog.getByRole('button', { name: 'บันทึกและไปต่อ' })).toBeDisabled();
});

test('Enterprise tenant: the wizard does NOT open', async ({ page }) => {
  await boot(page, { profile: 'enterprise', wizardDone: false, complete: false });
  await page.goto('/setup');
  await page.waitForTimeout(1500);
  await expect(page.getByText('ตั้งค่าธุรกิจของคุณ (โหมด SME)')).toHaveCount(0);
});

test('SME tenant already dismissed: the wizard stays closed', async ({ page }) => {
  await boot(page, { profile: 'sme', wizardDone: true, complete: false });
  await page.goto('/setup');
  await page.waitForTimeout(1500);
  await expect(page.getByText('ตั้งค่าธุรกิจของคุณ (โหมด SME)')).toHaveCount(0);
});
