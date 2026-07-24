import { test, expect, type Page } from '@playwright/test';

/**
 * Regression: "เปลี่ยนเป็น EN แล้วเปลี่ยนหน้าเด้งกลับ TH". The LanguageProvider re-resolves the locale from
 * GET /api/i18n/me on every mount and used to let that value clobber the localStorage choice, while the
 * persisting PUT /api/i18n/me is fire-and-forget. Whenever the PUT can't succeed — a god in read-only
 * company view (every mutation → 403 READONLY_IMPERSONATION), or offline — each full page load snapped the
 * UI back to the server-resolved TH. The fix marks the choice as pending (ierp_lang_pending) when the
 * persist fails: the local choice then stays authoritative across reloads (with a persist retry on mount)
 * until a PUT succeeds, after which the server value is authoritative again (cross-device sync intact).
 * Backend fully stubbed via route interception (same recipe as sme-nav-folding.spec.ts).
 */

const ME = { username: 'admin', role: 'Admin', customer_name: null, permissions: [] };

// `server` is shared mutable state so a successful PUT is visible to the next GET, like the real API.
async function boot(page: Page, opts: { putOk: boolean; server: { locale: string } }) {
  await page.addInitScript(() => {
    document.cookie = 'ierp_csrf=e2e; path=/';
  });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/i18n/me')) {
      if (route.request().method() === 'PUT') {
        if (!opts.putOk) return json({ error: { code: 'READONLY_IMPERSONATION', message: 'Read-only company view — writing is disabled' } }, 403);
        opts.server.locale = String(JSON.parse(route.request().postData() ?? '{}').locale ?? opts.server.locale);
        return json({ locale: opts.server.locale });
      }
      return json({ locale: opts.server.locale, source: 'tenant' });
    }
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/user-prefs')) return json({ sme_wizard_done: true, favorites: [], navFold: {} });
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/dashboard/sales-trend')) return json({ days: 14, trend: [] });
    if (url.includes('/api/dashboard')) return json({ today: { sales: 0, orders: 0 }, month: { sales: 0, orders: 0 }, low_stock_count: 0, outstanding_ap: 0, top_items_today: [], recent_orders: [] });
    return json({});
  });
}

// The header locale picker is a native <select> whose accessible name is t('common.language') — it changes
// with the active locale, so address it by name in the language we expect to be active.
const picker = (page: Page, name: string) => page.getByRole('combobox', { name, exact: true });

// The SSR HTML paints the picker before React hydrates, and a change event dispatched pre-hydration is
// swallowed (hydration then resets the select to the React state). The LanguageProvider's mount effect
// only calls /api/i18n/me post-hydration (a GET normally, a PUT retry when a choice is pending), so
// running the navigation and awaiting that call makes the picker safe to interact with.
async function hydrated(page: Page, action: () => Promise<unknown>) {
  const resolved = page.waitForResponse((r) => r.url().includes('/api/i18n/me'));
  await action();
  await resolved;
}

test('read-only company view: EN choice survives a full page load even though the persist PUT is rejected', async ({ page }) => {
  await boot(page, { putOk: false, server: { locale: 'th' } });
  await hydrated(page, () => page.goto('/dashboard'));
  await expect(picker(page, 'ภาษา')).toHaveValue('th');

  await picker(page, 'ภาษา').selectOption('en');
  await expect(picker(page, 'Language')).toHaveValue('en');
  // The rejected PUT must leave the pending marker before we reload (the write happens in the catch).
  await page.waitForFunction(() => window.localStorage.getItem('ierp_lang_pending') === 'en');

  // Full page load = LanguageProvider remounts and re-resolves from the server (which still says th).
  await hydrated(page, () => page.reload());
  await expect(picker(page, 'Language')).toHaveValue('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('normal session: EN persists to the server, and once persisted the server value is authoritative again', async ({ page }) => {
  const server = { locale: 'th' };
  await boot(page, { putOk: true, server });
  await hydrated(page, () => page.goto('/dashboard'));
  await expect(picker(page, 'ภาษา')).toHaveValue('th');

  await picker(page, 'ภาษา').selectOption('en');
  await expect(picker(page, 'Language')).toHaveValue('en');
  // Successful PUT reaches the stub server and clears any pending marker.
  await page.waitForFunction(() => window.localStorage.getItem('ierp_lang_pending') === null);
  expect(server.locale).toBe('en');

  await hydrated(page, () => page.reload());
  await expect(picker(page, 'Language')).toHaveValue('en');

  // No pending choice → the server-resolved locale (e.g. changed from another device) wins on next load.
  server.locale = 'th';
  await hydrated(page, () => page.reload());
  await expect(picker(page, 'ภาษา')).toHaveValue('th');
});
