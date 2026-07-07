import { defineConfig, devices } from '@playwright/test';

// Smoke tests for UI interactions that can't be covered by build/unit checks (e.g. the ERP/POS workspace
// switcher). The app is served as a production build; all /api/** calls are stubbed in the specs, so no
// backend/database is required. Run: `pnpm --filter @ierp/web test:e2e` (needs `playwright install chromium`).
const PORT = Number(process.env.E2E_PORT ?? 3210);

export default defineConfig({
  testDir: './e2e',
  // *.capture.spec.ts are on-demand screenshot tools, not CI tests — run them with a config that clears
  // testIgnore (see e2e/sidebar.capture.spec.ts).
  testIgnore: ['**/*.capture.spec.ts'],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    // Desktop specs (everything except *.mobile.spec.ts) run at the Desktop Chrome viewport.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: ['**/*.mobile.spec.ts'] },
    // Phone-viewport regression: only *.mobile.spec.ts run here, at an iPhone 13 viewport (390×844,
    // isMobile/hasTouch) so the card-vs-table + bottom-bar layouts that only appear below the `sm`/`lg`
    // breakpoints are actually exercised. iPhone 13's default engine is WebKit, but CI installs only
    // Chromium (`playwright install chromium`), so we keep the phone metrics and force the chromium engine
    // (isMobile is a Chromium-supported emulation flag).
    {
      name: 'mobile-iphone',
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
      testMatch: ['**/*.mobile.spec.ts'],
    },
  ],
  webServer: {
    command: `pnpm exec next build && pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    // Bake an empty API base so fetches resolve same-origin (localhost:${PORT}). Cookie auth now sends
    // `credentials: 'include'`; a cross-origin stub (the default :8000 base) lacks the ACAC header and the
    // browser would block it. Same-origin also keeps CSP `connect-src 'self'` sufficient. Page-route stubs
    // intercept `**/api/**` regardless of origin, so the relative URLs still match.
    env: { NEXT_PUBLIC_API_URL: '' },
  },
});
