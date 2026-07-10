# Incident 2026-07-10 — prod login bounce (cross-site auth cookie dropped)

**Status:** RESOLVED (mitigated same night; durable fix rolling out) · **Severity:** P1 (all interactive
users unable to stay signed in) · **ITGC-OP-03/05 evidence record.**

## Timeline (UTC)

| Time (Jul 9–10) | Event |
|---|---|
| 09 (before 11:30) | **Trigger:** an "orphan" Postgres service is deleted on a dashboard suggestion, **without first verifying what referenced it** — kicking off the env firefight below. Post-hoc verification (the deleted instance had only ever produced `28P01` auth failures, and the H-3 workflow's sanity gate confirmed the surviving DB carries the live 100+ migration history) showed the deletion itself lost no data — but that was luck, not process. See `docs/ops/pre-deletion-checklist.md`. |
| 09 11:30–11:44 | 3 production deploys FAIL: first on the H-3 tenancy boot check (`Refusing to boot: RLS BACKSTOP MISSING` — `DATABASE_URL` pointed at a superuser role), then on `drizzle-kit migrate` → `42501 permission denied for database railway` after a partial role swap. Sentry captured the boot refusal. |
| 09 12:31–12:50 | `Ops — Railway failed-deploy diagnostics` runs during the firefight; **service env variables were rebuilt by hand** during this window. |
| 09 13:28 | `Ops — provision non-superuser DB role (H-3)` provisions `ierp_app` correctly, repoints `DATABASE_URL`, redeploys → SUCCESS. |
| 09 18:33 | Scheduled deploy of merge `b2b98b2` (PR #586) → SUCCESS, healthy. |
| 10 ~03:00 | User report: login succeeds, then immediately bounced to `/login?next=%2Fdashboard`. |
| 10 03:26 | Diagnostics dispatched: active deployment healthy; **API service env list shows `AUTH_COOKIE_SAMESITE` (and `AUTH_COOKIE_DOMAIN`) MISSING** while `CORS_ORIGINS` is present. |
| 10 ~03:50 | Mitigation applied by operator: `AUTH_COOKIE_SAMESITE=None` restored on the API service → login stable again. |

## Root cause

Production runs the web (`invisiblePOSERP`) and the API (`invisibleERP`) on **separate `*.up.railway.app`
domains** (cross-site — `up.railway.app` is on the Public Suffix List). The auth cookies therefore require
`AUTH_COOKIE_SAMESITE=None` on the API (see `common/cookies.ts`). That variable was **lost during the
morning's hand-rebuild of the service env** (11:30–13:40 firefight). Cookies fell back to the default
`SameSite=Lax`, so the browser stored the login cookies but **never attached them to cross-site `/api/*`
requests** → every authenticated call returned `401 UNAUTHORIZED (Missing token)` → the web client's
401 handler bounced to `/login?next=…`. Login itself kept "succeeding" (the POST returns 200), which made
the symptom look like a session bug rather than a missing env var.

Not related to the day's application deploys: the merged code touched no auth/cookie/guard surface, and
the active deployment was healthy throughout the report window.

## Resolution

1. **Mitigation (done):** restore `AUTH_COOKIE_SAMESITE=None` on the API service.
2. **Durable fix (this change):** move the browser to **same-origin** — the web service proxies `/api/*`
   to the API (`next.config.mjs` rewrites via `API_PROXY_TARGET`, `NEXT_PUBLIC_API_URL=''`), making the
   auth cookie first-party everywhere (no dependence on third-party-cookie browser policy). To let that
   proxy ride Railway's **private network** (IPv6-only `*.railway.internal`) instead of hairpinning
   through the public edge, the API now binds **dual-stack `'::'`** with an automatic IPv4 fallback on
   hosts without an IPv6 stack (`EAFNOSUPPORT`/`EADDRNOTAVAIL` → `0.0.0.0`, warn) and a `BIND_HOST`
   override (`apps/api/src/main.ts`). Fallback path exercised in CI-like conditions (IPv6-less sandbox:
   warned, bound IPv4, served). After deploy, set on `invisiblePOSERP`:
   `API_PROXY_TARGET=http://invisibleerp.railway.internal:<PORT of the API service>` +
   `NEXT_PUBLIC_API_URL=''` and **rebuild** (both are build-time values). Then remove
   `AUTH_COOKIE_SAMESITE=None` from the API (same-origin ⇒ default `Lax` is the safer posture).
3. **Long-term (recommended):** custom domains under one registrable domain (`app.…` + `api.…` with
   `AUTH_COOKIE_DOMAIN`), per the design notes in `common/cookies.ts`.

## Addendum — a SECOND, distinct login bounce (same day, different root cause)

After the same-origin cutover (above) removed the cross-site cookie dependency, login bounced **again**.
This was a different bug, surfaced only once the real-browser Playwright probe was armed:

1. **Web build regression (fixed by env):** the running web bundle had been built with
   `NEXT_PUBLIC_API_URL` **unset** (Railway does not inject an *empty-valued* variable into the build
   environment), so the client fell back to its hard-coded `http://localhost:8000` default and the
   browser's CSP (`connect-src 'self'`) blocked the login `fetch` → "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้". Fixed by
   setting `NEXT_PUBLIC_API_URL=https://<web-domain>` (a non-empty, same-origin value) and rebuilding.
2. **API RLS regression (the real bounce):** with the bundle fixed, login POST returned 200 but the very
   next authenticated call (`GET /api/auth/me`) returned **401 `USER_NOT_FOUND` ("Account no longer
   exists")** — identical through the web proxy AND direct to the API, proving it was the API guard, not
   cookies. **Root cause:** the `JwtAuthGuard` authenticates by reading the `users` row *before* the
   per-request tenant transaction exists (guards run before interceptors), so it reads as the base
   `ierp_app` connection role with **no `app.*` GUCs**. `users` carries a `tenant_id` column, so the
   generic RLS loop in recent migrations had it under **`FORCE ROW LEVEL SECURITY`**; once H-3 made
   `ierp_app` the non-superuser table **owner**, `FORCE` applied to it too, and the policy returned **zero
   rows** for the identity lookup → every valid session looked like a deleted account. Confirmed on a
   local Postgres reproduction of the H-3 role/ownership world (owner read: 0 rows; owner read with
   `app.bypass_rls=on`: 1 row; `app_user` tenant-scoped reads still correctly isolated).
   **Fix:** the guard's auth-infra reads (`users`, `revoked_tokens`, `pos_members`) now run in a short
   `app.bypass_rls=on` transaction (`common/guards.ts` `authRead`). Identity resolution legitimately
   predates tenant context; normal per-request queries are unchanged (they still `SET ROLE app_user` and
   enforce tenant RLS). The synthetic browser probe and the provision workflow's cookie round-trip matrix
   now guard against regression.

## Lessons / follow-ups

- **The trigger was an unverified deletion.** The whole chain started with deleting a Postgres service
  because a dashboard suggestion said it was unused — verification happened only after the fact.
  **(DONE 2026-07-10)** checked-in runbook `docs/ops/pre-deletion-checklist.md`: reference-check +
  live-datastore proof + snapshot + ops-log entry before ANY destructive infra change.
- **Env is config-of-record:** hand-rebuilding service variables under incident pressure silently dropped
  a security-relevant flag. **(DONE 2026-07-10)** `docs/ops/railway-env-manifest.json` is the checked-in
  **variable-NAME manifest per service**; the scheduled `ops-synthetic-probe.yml` `env-manifest` job diffs
  live names against it every 30 min (values never printed) — a lost variable now fails a probe within
  half an hour instead of a multi-hour hunt.
- The diagnostics workflow only dumps FAILED deployments; the healthy-deployment 401s were invisible from
  CI. **(DONE 2026-07-10)** `ops-synthetic-probe.yml` adds scheduled HTTP probes (login page, proxied
  `/api/config`, wrong-password 401 shape, `/proxy-health`) plus a **real-browser Playwright login probe**
  (`tools/ops/synthetic-login-probe.mjs`: login → cookies stored → attached on `/api/auth/me` → session
  survives reload — the exact step July-10 broke; curl can't see cookie policy). The browser probe reads its
  credentials from the `PROBE_USERNAME`/`PROBE_PASSWORD` repo secrets, or (fallback) the Railway
  variables of the same names — provisioned and rotated fully automatically by
  `ops-provision-probe-user.yml` (upserts the low-privilege `synthetic-probe` user, role
  ExecutiveViewer, and verifies a live login through the web proxy).
- **The cutover itself is now automated and self-verifying. (DONE 2026-07-10)** `ops-proxy-cutover.yml`
  (manual dispatch): `verify` (read-only go/no-go matrix) → `cutover` (pre-checks the private target via
  `/proxy-health`, flips `API_PROXY_TARGET`, polls green, **auto-rolls back** to the public URL on
  failure) → `remove-samesite` (deletes `AUTH_COOKIE_SAMESITE` from the API only after the same-origin
  proxy is verified live, restoring the safer `SameSite=Lax` default).
- The web's 401 bounce masks the response body. Follow-up (UX): surface the API error `code` on the login
  page after a bounce (`?reason=`) to cut diagnosis time.
- **(DONE 2026-07-10)** Cutting over to the private-network proxy stalled on blind rebuild-and-retry
  (wrong port guessed, no console access to test from inside the container). Shipped
  **`GET /proxy-health`** on the web app (`apps/web/src/app/proxy-health/route.ts`): tests the runtime
  `API_PROXY_TARGET` (and any `?target=http://<name>.railway.internal[:port]` override — restricted to
  private Railway hostnames, status/error codes only, never the upstream body) from inside the web
  container, so proxy-target changes are verified in one browser call instead of a rebuild per guess.
