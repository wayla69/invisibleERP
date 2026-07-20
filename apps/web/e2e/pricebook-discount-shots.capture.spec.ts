import { test, expect, type Page } from '@playwright/test';

/**
 * On-demand screenshot tool (not a CI test) for the two Phase 4 POS admin screens:
 *   • /pricing  → "เล่มราคา" (Books) tab — customer-tier / per-branch price books (Phase 4a)
 *   • /pos-control → "ส่วนลด" (Discount authority) tab — cashier caps + supervisor authorization (Phase 4b)
 * Backend fully stubbed via route interception (same recipe as sme-nav-folding.spec.ts). Run with a
 * throwaway config that clears testIgnore + points at the local Chromium (see the scratchpad config).
 */

interface Me {
  username: string;
  role: string;
  customer_name: string | null;
  permissions: string[];
}
const ADMIN: Me = { username: 'admin', role: 'Admin', customer_name: null, permissions: [] };

async function boot(page: Page) {
  await page.addInitScript(() => {
    document.cookie = 'ierp_csrf=e2e; path=/';
  });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ADMIN);
    if (url.includes('/api/user-prefs')) return json({ sme_wizard_done: true, favorites: [], navFold: {} });
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });

    // Phase 4a — price books
    if (url.includes('/api/pricing/books')) {
      return json({
        books: [
          { id: 1, name: 'ราคาสมาชิก VIP', tier: 'vip', branch_id: null, priority: 10, status: 'Active', active: true, valid_from: null, valid_to: null, created_by: 'somchai', approved_by: 'manager', approved_at: '2026-07-15T03:00:00Z' },
          { id: 2, name: 'โปรสงกรานต์', tier: 'wholesale', branch_id: null, priority: 20, status: 'Active', active: true, valid_from: '2026-08-01', valid_to: '2026-08-31', created_by: 'somchai', approved_by: 'manager', approved_at: '2026-07-16T03:00:00Z' },
          { id: 3, name: 'โปรสาขาเซ็นทรัลเวิลด์', tier: null, branch_id: 3, priority: 30, status: 'PendingApproval', active: false, valid_from: '2026-07-20', valid_to: null, created_by: 'nid', approved_by: null, approved_at: null },
          { id: 4, name: 'ราคาพนักงาน', tier: 'staff', branch_id: null, priority: 40, status: 'Inactive', active: false, valid_from: null, valid_to: null, created_by: 'somchai', approved_by: 'manager', approved_at: '2026-06-01T03:00:00Z' },
        ],
      });
    }
    if (url.includes('/api/pricing/rules')) return json({ rules: [] });
    if (url.includes('/api/branches')) {
      return json({ branches: [
        { id: 1, code: 'HQ', name: 'สำนักงานใหญ่' },
        { id: 3, code: 'CTW', name: 'เซ็นทรัลเวิลด์' },
        { id: 4, code: 'SLM', name: 'สีลม' },
      ], count: 3 });
    }
    if (url.includes('/api/procurement/catalog')) {
      return json({ items: [
        { item_id: 'SKU-1001', item_description: 'กาแฟอาราบิก้า 250g', uom: 'ถุง', unit_price: 185 },
        { item_id: 'SKU-1002', item_description: 'กาแฟโรบัสต้า 250g', uom: 'ถุง', unit_price: 145 },
      ] });
    }

    // Phase 4b — discount authority
    if (url.includes('/api/pos/discount-settings')) return json({ maxLinePct: 10, maxBillPct: 20 });
    if (url.includes('/api/pos/held')) return json({ held: [] });

    return json({});
  });
}

test('capture: price books (Phase 4a)', async ({ page }) => {
  await boot(page);
  // mount fires the default (Rules) tab's query — its arrival proves the page hydrated
  const mounted = page.waitForResponse((r) => r.url().includes('/api/pricing/rules'));
  await page.goto('/pricing');
  await mounted;
  const booksTab = page.getByRole('tab', { name: 'สมุดราคา', exact: true });
  await expect(booksTab).toBeVisible();
  const booksLoaded = page.waitForResponse((r) => r.url().includes('/api/pricing/books'));
  await booksTab.click();
  await booksLoaded;
  await expect(page.getByRole('cell', { name: 'ราคาสมาชิก VIP', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'โปรสาขาเซ็นทรัลเวิลด์', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/shot-price-books.png', fullPage: true });
});

test('capture: discount authority (Phase 4b)', async ({ page }) => {
  await boot(page);
  const mounted = page.waitForResponse((r) => r.url().includes('/api/pos/held'));
  await page.goto('/pos-control');
  await mounted;
  const discTab = page.getByRole('tab', { name: 'อำนาจส่วนลด', exact: true });
  await expect(discTab).toBeVisible();
  const capsLoaded = page.waitForResponse((r) => r.url().includes('/api/pos/discount-settings'));
  await discTab.click();
  await capsLoaded;
  // the caps inputs hydrate from /api/pos/discount-settings (10 / 20)
  await expect(page.locator('#dc-line')).toHaveValue('10');
  await expect(page.locator('#da-pct')).toBeVisible();
  await page.screenshot({ path: 'test-results/shot-discount-authority.png', fullPage: true });
});
