import { test, expect } from '@playwright/test';

/**
 * Public QR deep-link resolver (`/q?d=<payload>`) — server-component smoke test.
 * A phone's native camera opens this page after scanning a deep-link tag. With no session the server-side
 * lookup (serverApi) returns null and the page falls back to the payload the tag itself carries, so this
 * runs against the production build with no backend/API stub (see playwright.config.ts). Automates the
 * page side of UAT-INV-069/070; the live camera decode itself can't run headless.
 */

test('resolves an item deep-link to its identity + workspace links', async ({ page }) => {
  await page.goto('/q?d=' + encodeURIComponent('ITEM_ID:A|DESC:Apple|UOM:EA'));

  // exact:true so the id/desc match the identity block, not the raw payload <code> at the bottom.
  await expect(page.getByText('A', { exact: true })).toBeVisible();
  await expect(page.getByText('Apple', { exact: true })).toBeVisible();
  await expect(page.getByText(/· Item/)).toBeVisible();
  // Item actions link into the inventory workspace.
  await expect(page.getByRole('link', { name: /Mobile scan/ })).toHaveAttribute('href', '/mobile-scan');
  await expect(page.getByRole('link', { name: /Stock/ })).toHaveAttribute('href', '/goods-issue');
});

test('resolves an asset deep-link to its identity + register link', async ({ page }) => {
  await page.goto('/q?d=' + encodeURIComponent('ASSET_ID:FA-1|DESC:Test Fridge|LOC:Kitchen'));

  await expect(page.getByText('FA-1', { exact: true })).toBeVisible();
  await expect(page.getByText('Test Fridge', { exact: true })).toBeVisible();
  await expect(page.getByText(/· Asset/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Open assets/ })).toHaveAttribute('href', '/assets');
});

test('shows an empty state when the link carries no payload', async ({ page }) => {
  await page.goto('/q');
  await expect(page.getByText(/No data in this QR link/)).toBeVisible();
});
