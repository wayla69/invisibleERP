# Incident 2026-07-10 — prod login bounce (cross-site auth cookie dropped)

**Status:** RESOLVED (mitigated same night; durable fix rolling out) · **Severity:** P1 (all interactive
users unable to stay signed in) · **ITGC-OP-03/05 evidence record.**

## Timeline (UTC)

| Time (Jul 9–10) | Event |
|---|---|
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

## Lessons / follow-ups

- **Env is config-of-record:** hand-rebuilding service variables under incident pressure silently dropped
  a security-relevant flag. Follow-up: keep a checked-in **variable-NAME manifest per service** and extend
  the diagnostics workflow to diff live names against it (values never printed), so a missing var is a
  one-click detection instead of a multi-hour hunt.
- The diagnostics workflow only dumps FAILED deployments; the healthy-deployment 401s were invisible from
  CI. Follow-up: add an authenticated **synthetic login probe** (login → `/api/auth/me`) to the scheduled
  ops checks so a cookie/session regression pages before a user does.
- The web's 401 bounce masks the response body. Follow-up (UX): surface the API error `code` on the login
  page after a bounce (`?reason=`) to cut diagnosis time.
- **(DONE 2026-07-10)** Cutting over to the private-network proxy stalled on blind rebuild-and-retry
  (wrong port guessed, no console access to test from inside the container). Shipped
  **`GET /proxy-health`** on the web app (`apps/web/src/app/proxy-health/route.ts`): tests the runtime
  `API_PROXY_TARGET` (and any `?target=http://<name>.railway.internal[:port]` override — restricted to
  private Railway hostnames, status/error codes only, never the upstream body) from inside the web
  container, so proxy-target changes are verified in one browser call instead of a rebuild per guess.
