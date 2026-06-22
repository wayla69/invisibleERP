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
