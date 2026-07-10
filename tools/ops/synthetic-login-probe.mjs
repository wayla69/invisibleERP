#!/usr/bin/env node
// Synthetic browser login probe (incident 2026-07-10 follow-up — see
// docs/ops/incident-2026-07-10-login-bounce-cross-site-cookie.md).
//
// The July-10 outage was invisible to every curl-based check: the login POST returned 200 (so any
// status-code probe passed) while the BROWSER dropped the SameSite=Lax cookies on the next cross-site
// /api/* call and bounced the user to /login. Only a real browser applies cookie policy, so this
// probe drives headless Chromium through the actual login flow and asserts the session SURVIVES the
// next authenticated round-trip — exactly the step that failed in prod.
//
// Usage (GitHub Actions runner — prod URLs are unreachable from dev sandboxes):
//   WEB_URL=https://… PROBE_USERNAME=… PROBE_PASSWORD=… node tools/ops/synthetic-login-probe.mjs
// The probe account should be a LOW-PRIVILEGE user (e.g. `pos`) created for monitoring only.
import { chromium } from 'playwright';

const WEB_URL = (process.env.WEB_URL ?? '').replace(/\/+$/, '');
const USER = process.env.PROBE_USERNAME ?? '';
const PASS = process.env.PROBE_PASSWORD ?? '';
if (!WEB_URL || !USER || !PASS) {
  console.error('missing WEB_URL / PROBE_USERNAME / PROBE_PASSWORD');
  process.exit(2);
}

const fail = (msg) => { console.error(`❌ ${msg}`); process.exitCode = 1; };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  console.log(`1) open ${WEB_URL}/login`);
  const resp = await page.goto(`${WEB_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (!resp?.ok()) throw new Error(`login page returned ${resp?.status()}`);

  console.log('2) submit credentials');
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await page.press('#password', 'Enter');

  // Success = client-side router.push to /dashboard (or /portal/dashboard for Customer accounts).
  await page.waitForURL(/\/(dashboard|portal\/dashboard)/, { timeout: 20_000 }).catch(() => {
    throw new Error(`login did not navigate to a dashboard (still at ${page.url()}) — wrong probe credentials or login broken`);
  });
  console.log(`   → ${page.url()}`);

  // The cookies the server just set must have survived the browser's cookie policy. ierp_csrf is the
  // client's "session exists" flag; ierp_token is the httpOnly JWT. A SameSite/Domain misconfiguration
  // (the July-10 class) shows up as these cookies existing but not being SENT — caught next step.
  const cookies = await ctx.cookies(WEB_URL);
  for (const name of ['ierp_csrf', 'ierp_token']) {
    const c = cookies.find((x) => x.name === name);
    if (!c) fail(`cookie ${name} not stored after login`);
    // Attributes are diagnostic gold when the round-trip fails (never log values).
    else console.log(`   cookie ${name}: domain=${c.domain} path=${c.path} secure=${c.secure} sameSite=${c.sameSite}`);
  }

  // Real in-page fetch — the EXACT call the app's api() helper makes (same-origin, credentials
  // included, subject to CSP/cookie policy). On failure, surface the server's error code so the log
  // distinguishes "cookie not attached" (Missing token) from "token rejected" (Invalid or expired).
  console.log('3) authenticated round-trip: GET /api/auth/me (in-page fetch, browser cookie jar)');
  const me = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      let code = '';
      try { const j = await r.json(); code = j?.error?.message ?? j?.error?.code ?? ''; } catch { /* non-JSON */ }
      return { status: r.status, code };
    } catch (e) {
      return { status: 0, code: String(e).slice(0, 120) };
    }
  });
  if (me.status !== 200) fail(`/api/auth/me returned ${me.status} (${me.code}) — session does not survive the authenticated hop`);

  // The incident's exact symptom: login "succeeds", then the FIRST authenticated page load bounces to
  // /login?next=…. Reload the dashboard and assert we stay signed in.
  console.log('4) reload dashboard — session must survive');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000); // give the client-side auth gate time to bounce if it is going to
  if (/\/login/.test(page.url())) fail(`bounced back to ${page.url()} after reload — the July-10 login-bounce symptom`);
  else console.log(`   → stayed at ${page.url()}`);

  if (process.exitCode) throw new Error('synthetic login probe FAILED');
  console.log('✅ synthetic login probe passed (login → cookies stored → attached → session survives reload)');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await browser.close();
}
