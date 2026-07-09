# Web E2E (Playwright) smoke tests

Interactive UI smoke tests that build/unit checks can't cover — currently the **ERP/POS workspace
switcher** (`workspace-split.spec.ts`): the toggle, role-based first-landing redirect, `localStorage`
persistence, and per-workspace menu filtering.

The backend is **fully stubbed** via route interception (no API/DB needed); the auth token is seeded so the
app shell doesn't bounce to `/login`. The Playwright config serves a production build on port `3210`.

## Run

```bash
# one-time: download the browser (needs network access to cdn.playwright.dev)
pnpm --filter @ierp/web exec playwright install chromium

# run the smoke tests (builds + starts the web app automatically)
pnpm --filter @ierp/web test:e2e
```

> **Note:** In restricted/sandboxed environments the browser download (`cdn.playwright.dev`) may be blocked
> by the network egress allowlist. The specs still parse and list (`playwright test --list`); run them in
> CI or locally where the browser can be installed, or allowlist `cdn.playwright.dev`. If a system Chrome is
> available, you can instead run against it by adding `channel: 'chrome'` to the chromium project `use`.

- `frontline-sweep.mobile.spec.ts` — phone-viewport NO-OVERFLOW sweep over the frontline ops screens, rows seeded with long Thai text; asserts the /shop overflow regression class (`scrollWidth <= clientWidth`) plus a content element per page. Round 1: claims / delivery / wms / inventory. Round 2 extends to POS back-office (pos/till, pos/close-of-day, pos/refunds, pos-home) + warehouse ops (inventory/purchase-orders, stock-adjustment, replenishment, lots, waste), including a tab-switch on the tabbed pages (each tab is its own overflow surface). The replenishment case caught a real bug on first run: `PageHeader`'s `shrink-0` action wrapper kept a 3-button cluster at intrinsic width (396px > 390px viewport) — fixed in `components/page-header.tsx` (actions now `max-w-full flex-wrap`). Mobile-iphone project only.
- `pos-new.mobile.spec.ts` — REAL-TAP phone regression for the `/pos/new` quick-sale form (receiving.mobile.spec.ts recipe): add-line/quick-tender/confirm driven by ordinary taps, no-overflow asserted after every stage, and the captured `POST /api/pos/orders` body asserted as the payload contract.
