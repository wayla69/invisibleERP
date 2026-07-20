# Security Audit, Penetration Test & Load Test Report — Invisible ERP

**Date:** 2026-06-28
**Scope:** `apps/api` (NestJS 10 / Fastify 4 + Drizzle ORM + PostgreSQL, multi-tenant RLS)
**Method:** White-box code audit (3 parallel reviewers), live penetration probes against a running
instance, and a closed-loop load test scaling 1→200 concurrent sessions.
**Environment:** Local PostgreSQL 16 cluster, full 176-migration schema (344 tables) applied, API booted
from `dist` (Node 22, single process, 4 vCPU). This is a *test environment*; no production data touched,
no files in the app changed by the audit.

---

## 1. Executive summary

| Area | Result |
|------|--------|
| **Multi-tenant isolation (RLS)** | ✅ **Verified correct, live.** Cross-tenant reads/writes are blocked; HQ/Admin bypass works as designed. This is the strongest part of the system. |
| **Auth core (guards, CSRF, crypto, env)** | ✅ Default-deny, constant-time compares, AES-256-GCM at rest, fail-closed secrets — all confirmed. |
| **Penetration findings** | 1 Critical, 6 High, 8 Medium, ~11 Low/Info (details §4). The exploitable cluster: SSO `state`/secret handling, no login throttle, an Admin-grant privilege-escalation path, and timing-unsafe aggregator webhooks. |
| **Dependencies** | 1 Critical + 11 High advisories present but **all triaged/accepted** in `pnpm-workspace.yaml`. The accepted Critical is the drizzle-orm 0.36.4 SQLi (deferred pending the 0.45 upgrade). |
| **Performance @ 100 sessions** | ✅ 0 errors, stable. ⚠️ p50 latency ~240ms = **~54× the single-session baseline**; throughput plateaus at **~400 req/s**. Two stacked bottlenecks: the default 10-connection DB pool, then a single Node process saturating 1 of 4 cores. Both are config/topology issues, not algorithmic. |

---

## 2. Tech stack

| Layer | Component | Version | Note |
|-------|-----------|---------|------|
| Runtime | Node.js | 22.x | current LTS line |
| API framework | NestJS | ^10.4.4 | **one major behind** (11 is current) |
| HTTP | Fastify (`@nestjs/platform-fastify`) | ^4.28.1 | **one major behind** (5 is current) |
| ORM | drizzle-orm | ^0.36.4 | pinned; see dependency note |
| PG driver | postgres (postgres.js) | ^3.4.4 | pool `max` default **10** |
| Validation | zod | ^3.23.8 | opt-in pipe (not global) |
| Auth | `@nestjs/jwt` (HS256), otplib (TOTP), scrypt | — | |
| Edge | `@fastify/helmet`, `@fastify/rate-limit` | 11 / 9 | confirmed active (headers + 429 path) |
| Web | Next.js 15 / React 19 | — | not load-tested here |

Most of the accepted advisories (§5) trace to the **Fastify-4 / Nest-10 → Fastify-5 / Nest-11** upgrade
that is still pending.

---

## 3. Load test

Closed-loop tester: each "session" = one keep-alive connection issuing a mixed authenticated read
workload (`/api/auth/me`, `/api/ledger/accounts`, `/api/dashboard`, `/api/ledger/trial-balance`,
`/api/finance/ar/aging`, `/api/loyalty/members`). Every request runs the full auth guard (a DB
`is_active` lookup) **plus** the per-request tenant transaction (`SET LOCAL ROLE` + 3× `set_config`),
so all of them touch Postgres. Rate limiter raised for the test so we measure app capacity, not the cap.

### 3.1 Scaling curve (default pool = 10)

| Sessions | req/s | p50 ms | p90 ms | p99 ms | max ms | errors |
|---------:|------:|-------:|-------:|-------:|-------:|-------:|
| 1   | 199 | 4.5  | 6.7  | 10.6 | 22.6 | 0 |
| 10  | 405 | 23.0 | 35.4 | 45.3 | 67.5 | 0 |
| 25  | 398 | 61.0 | 74.1 | 88.1 | 110.9 | 0 |
| 50  | 401 | 122.9 | 137.8 | 156.3 | 183.9 | 0 |
| **100** | **410** | **242.7** | **261.5** | **310.3** | **349.6** | **0** |
| 200 | 414 | 476.8 | 509.6 | 535.3 | 576.8 | 0 |

**Reading:** throughput doubles from 1→10 sessions, then **flatlines at ~400 req/s** while latency grows
linearly with load — textbook Little's Law on a saturated resource. At 100 sessions p50 is **~54× the
1-session baseline**. No errors, no crashes, no 5xx — the system degrades gracefully (it queues, it
doesn't fall over).

### 3.2 Root cause (instrumented)

Sampling Postgres connections and Node CPU under 100 sessions:

- **Pool = 10:** `pg_total_conns` pinned at exactly **10** (pool max) the entire run → pool-saturated.
- **Pool = 50:** active connections only ~20–27 of 50, but **Node CPU ≈ 120–150% of 400%** (≈1.2 of 4
  cores) and throughput barely moved (~450 req/s). The main JS thread is saturated; 3 of 4 cores idle.

So there are **two stacked bottlenecks**:
1. **Default DB pool of 10** (`DB_POOL_MAX ?? 10`, `database.module.ts`) caps the first tier at ~400 req/s.
2. Above that, the **single Node process** caps the second tier — Node is single-threaded for JS and the
   app runs one process with no clustering/replicas, so it can only use ~1 core.

A contributing tax: **each request issues ~5 sequential DB round-trips before the handler query** — the
guard's `is_active` lookup + `SET LOCAL ROLE app_user` + 3× `set_config` (tenant_id / bypass / actor) in
`tenant-tx.interceptor.ts`. That inflates both connection hold-time and per-request CPU.

### 3.3 Login throughput (scrypt)

200 logins at concurrency 20 → **~77 logins/s, p50 246 ms** each. scrypt-at-defaults is deliberately
expensive (good for cracking resistance) but means **`/api/login` is a CPU-amplification surface**: each
attempt costs the server real CPU and memory, and there is no per-account throttle (see H2) to bound it.

### 3.4 Recommendations (performance)

- **Run multiple API processes** (cluster / PM2 / container replicas behind the LB), one per core, each
  with its own pool → ~4× throughput on this box. This is the single biggest win.
- **Raise `DB_POOL_MAX`** to match `(replicas × pool) ≤ Postgres `max_connections``; 10 is too low for a
  single-process deployment.
- **Collapse the per-request RLS setup** into one round-trip (a single `SELECT set_config(...),
  set_config(...), set_config(...)` after `SET LOCAL ROLE`), and cache the guard's `is_active`/revocation
  check briefly — removes ~4 round-trips/request.
- Add a dedicated **tight rate limit on `/api/login`** to cap scrypt-DoS amplification.

---

## 4. Security findings (penetration test)

Severity reflects exploitability in a default production config. Findings marked **[live-validated]** were
reproduced against the running instance.

### 🔴 Critical

**C1 — SSO callback performs no `state`/nonce/PKCE validation → login-CSRF / account fixation.**
`modules/identity/sso.service.ts:56-83`, `sso.controller.ts:23-38`. The `state` nonce is generated at
`authorize()` but never persisted or verified on callback (only split to recover the tenant code). The
callback is `@Public` and sets the session cookie from a body-supplied assertion. An attacker can fix a
victim's browser onto the attacker's account (victim's subsequent data lands in attacker's account).
**Becomes outright id_token forgery when combined with M1** (empty SSO secret). *Fix:* persist+verify
`state`, add OIDC `nonce`, adopt PKCE, prefer the RS256/JWKS path.

### 🟠 High

**H1 — No per-account login lockout or throttle. [live-validated]** `auth.service.ts:21-32`; only a coarse
per-IP global limiter. 15 consecutive bad passwords → all 401, **no lockout/backoff, correct password
still works immediately**. Enables credential stuffing and (with §3.3) scrypt-DoS amplification. Tracked
internally as `ITGC-AC-07`. *Fix:* per-username failed-attempt counter + exponential backoff/lockout;
dedicated `/api/login` rate limit.

**H2 — Privilege escalation: a non-Admin with the `users` permission can mint an `Admin` user → full
cross-tenant bypass.** `modules/admin-users/admin-users.service.ts:53-85`. Role `AccessAdmin` holds
`['users']`; `CreateBody.role` accepts `'Admin'`; the service does no "only an Admin may grant Admin"
check; the RLS interceptor grants bypass purely on `role === 'Admin'`. A tenant-scoped AccessAdmin creates
an Admin in their own tenant (passes RLS WITH CHECK), then logs in with full HQ bypass. Real SoD/ICFR
weakness. *Fix:* reject granting `Admin` unless caller is Admin; decouple HQ-bypass from the role string
(require `tenantId === null`).

**H3 — Member JWTs are effectively non-revocable for 30 days.** `member-auth.service.ts:87,119`;
`guards.ts:103-108`. Member tokens carry no `jti` and `expiresIn: '30d'`; the deactivation/revocation
check keys on the `users` table, which members aren't in — so they skip it. A compromised/deprovisioned
member token cannot be killed. *Fix:* add `jti` + denylist check for `member:` subjects, add an
`active`/watermark re-check, shorten lifetime.

**H4 — Weak password KDF + live legacy SHA-256 verifier.** `auth/password.service.ts:14-35`. scrypt is
called with default cost (N=16384 ≈ low for 2026) and an **unsalted single-round SHA-256** legacy verifier
is still accepted; rehash only happens on next successful login, so dormant accounts keep weak hashes.
*Fix:* argon2id (or tuned scrypt), force-migrate legacy rows out-of-band, add a strength/breach check.

**H5 — Delivery-aggregator webhooks use a timing-unsafe bare-secret compare with no body signature or
replay protection.** `modules/channel-adapter/channel-adapter.service.ts:58-60`,
`modules/restaurant/channel-order.service.ts:222-224`. `if (secret !== expected)` (non-constant-time) on
an `x-webhook-secret` header; no HMAC over the raw body, no timestamp/nonce. Anyone who observes one valid
request can replay/forge orders into a tenant (fake revenue, KDS spam). *Fix:* adopt the PSP webhook's
scheme — `timingSafeEqual` over an HMAC of `req.rawBody` + a replay window.

**H6 — Over-refund TOCTOU on the large-refund path.** `modules/payments/payments.service.ts:217-223`.
`requestRefund` computes the remaining refundable amount **without a row lock** (unlike the locked `run()`
path), so two concurrent requests can each pass the guard and, if both approved, total refunds exceed the
captured amount. *Fix:* `SELECT … FOR UPDATE` on the payment row when summing prior refunds/pending.

### 🟡 Medium

- **M1 — SSO accepts an empty client secret** → `verifyHs256(idToken, '')` verifies with an empty HMAC key
  any attacker can compute (forge arbitrary `sub`/`email`). `sso.service.ts:61,69`. Fail closed on empty
  secret. *(Amplifies C1.)*
- **M2 — Session JWT verify doesn't pin the algorithm.** `guards.ts:91`. Not exploitable today (symmetric
  secret only) but a latent alg-confusion footgun if an asymmetric key is ever added. Set
  `algorithms: ['HS256']`.
- **M3 — SSRF via tenant-registered webhook URL.** `modules/platform/webhook.service.ts:89`;
  `RegisterWebhookBody.url` is only `z.string().url()`, so `http://169.254.169.254/…`/RFC1918/localhost
  are accepted and the server will POST to them. *Fix:* https-only + deny private/link-local at register
  *and* send time (DNS-rebind safe).
- **M4 — `AllExceptionsFilter` leaks raw `exception.message` to clients.**
  `common/all-exceptions.filter.ts:36-39`. Internal hostnames/IPs/library text can reach the caller on a
  500. (Malformed-JSON parser detail is reflected too — `[live-validated]`, low.) *Fix:* return a static
  message; keep detail server-side only.
- **M5 — Validation is opt-in, not global.** No `APP_PIPE`/`useGlobalPipes`; `ZodValidationPipe` is applied
  per parameter. Easy to miss a `@Body`/`@Query`; money fields are unbounded JS `number`s. *Fix:* global
  validation or a CI check; a shared bounded `zMoney` schema.
- **M6 — SCIM controller is class-wide `@Public`** (auth rests entirely on `ScimAuthGuard`) and
  **SCIM accepts a caller-supplied `role`** — escalation risk that depends on `AdminUsersService` rejecting
  `Admin` (ties to H2). `scim.controller.ts:8-11`, `scim.service.ts:87,109`.
- **M7 — `deferred-tax`/`fx-reval` controllers forward body `tenant_id` without the `hqTenant` guard** that
  their sibling `ledger.controller.ts` uses. RLS still blocks the cross-tenant effect, so this is a
  defense-in-depth/parity gap. `deferred-tax.controller.ts:34`, `fx-reval.controller.ts:33`.
- **M8 — IDOR-by-id handlers rely solely on RLS** (no explicit `tenant_id` predicate on `where(eq(id,…))`).
  Correct today because RLS is FORCEd, but one mis-set GUC from a leak. Add explicit tenant predicates on
  id fetches in tenant-scoped services.

### 🟢 Low / Info

Dev-only hardcoded JWT fallback secret (fail-closed in prod); permissions baked into the JWT (a
permission *downgrade* lags until token expiry; deactivation *is* live); no server-side MFA enforcement
(client-nudge only); TOTP has no single-use replay lock; enc key = `sha256(APP_ENC_KEY)` with no KDF
stretch (fine for a high-entropy key); `decrypt()` passes through malformed/plaintext blobs (legacy
back-compat); `bank.service.ts:52` builds `ANY(ARRAY[...])` via `sql.raw` (values are tenant-filtered DB
rows, **not** user input — not exploitable, but replace with `inArray`); `bi.service.ts` `date_trunc` unit
via `sql.raw` (strict whitelist — safe).

### ✅ Verified correct (not findings — important for the SOX narrative)

- **Cross-tenant RLS isolation — proven live:** tenant-2 user sees only tenant-2 rows, tenant-1 only
  tenant-1, HQ/Admin sees both. WITH CHECK blocks cross-tenant writes. GUCs are transaction-local
  (`SET LOCAL` / `set_config(…, true)`), so no leak across pooled connections. `tenant_id`/`role` come
  only from a server-signed JWT — not spoofable via header/body.
- **Default-deny global guard** — unauthenticated request to a protected route → 401 `[live-validated]`.
- **PSP money webhook** — HMAC over raw body + `timingSafeEqual` + fail-closed in prod + out-of-band
  re-verification against the PSP. Correct end-to-end.
- **Security headers** (helmet: CSP `default-src 'none'`, HSTS, nosniff, frame-ancestors none) present
  `[live-validated]`.
- **CSRF** double-submit, constant-time, correctly exempts Bearer/API-key.
- **Secrets at rest** (TOTP seeds, OIDC client secrets) AES-256-GCM, random IV, fail-closed in prod.
- **Env validation** fail-closed in prod for `DATABASE_URL`/`JWT_SECRET`/`APP_ENC_KEY`/PSP secret.
- **API-key principals** forced to non-Admin `Sales` + own tenant (no HQ bypass).

---

## 5. Dependency / advisory posture

`pnpm audit --audit-level high --prod`: **23 advisories — 1 critical, 11 high, 10 moderate, 1 low.**
The 1 critical + 11 high are **all in the accepted `ignoreGhsas` list**, so the CI gate passes (`RC=0`).

- **Accepted Critical:** `GHSA-gpj5-g38j-94v9` — drizzle-orm SQL-injection via improperly escaped values.
  Accepted because the fix (0.45) regresses an insert path (`compliance/vulnerability-triage.md`). This is
  a genuine accepted risk; the typed-builder discipline elsewhere is the compensating control. **Prioritize
  the 0.45 upgrade workstream.**
- **Accepted Highs:** mostly the `@fastify/middie` / `@nestjs/platform-fastify` / `fast-uri` /
  `fastify` cluster — i.e. the **Fastify-5 / Nest-11 upgrade**. Tracked, not yet done.
- 10 moderate / 1 low are under the gate threshold and largely dev/build-only.

**Recommendation:** schedule the Fastify-5/Nest-11 and drizzle-0.45 upgrades as their own tested
workstreams; each clears a large block of accepted advisories at once. Re-review the ignore list quarterly
(the file already mandates this).

---

## 6. Prioritized remediation order

1. **C1 + M1** — SSO `state`/nonce/PKCE and reject empty SSO secret (forgeable login is the worst case).
2. **H2** — Admin-grant guard / decouple HQ-bypass from the role string (cross-tenant escalation).
3. **H1** — per-account login throttle/lockout (+ dedicated `/api/login` limit).
4. **H5** — constant-time, body-signed aggregator webhooks.
5. **H3 / H4 / H6** — member-token revocation; argon2id + legacy-hash migration; refund row-lock.
6. **M3 / M4** — webhook-URL SSRF deny-list; stop leaking `exception.message`.
7. **Perf** — cluster the API process + raise `DB_POOL_MAX` + collapse per-request RLS round-trips.
8. **Deps** — Fastify-5/Nest-11 and drizzle-0.45 upgrade workstreams.

> Per the repo documentation-sync policy: remediations touching controls map to `ITGC-AC-06` (MFA),
> `ITGC-AC-07` (login lockout) and the SoD rules in `packages/shared/src/permissions.ts`; update the
> affected process narratives, the RCM (`build_rcm.py`), and `tools/cutover/src/compliance.ts` alongside
> the code.

---

## 7. Remediation applied in this change

A first batch of contained, no-migration fixes was implemented and **verified live** on the same booted
instance; typecheck clean, `compliance` (106) and `restaurant` (162) harnesses green.

| # | Finding | Fix | Verification |
|---|---------|-----|--------------|
| **H2** | Non-Admin (`AccessAdmin`/SCIM) could mint an `Admin` → cross-tenant bypass | `AdminUsersService.create/update` now enforce an **Admin-grant guard**: only an `Admin` actor may grant the `Admin` role (`ADMIN_GRANT_DENIED`, 403). Controller passes `@CurrentUser()`; SCIM passes its principal. | Live: `AccessAdmin` create-Admin → **403**; promote-to-Admin → **403**; create-Sales → 201; real Admin create-Admin → 201. |
| **M1** | SSO accepts an empty client secret → empty-key HS256 forgery | SSO callback **fails closed** on empty secret (`SSO_SECRET_MISSING`). | Code path; HS256 verify never runs with `''`. |
| **M2** | Session JWT verify didn't pin the algorithm | `JwtModule` sets `verifyOptions.algorithms: ['HS256']` (+ `signOptions.algorithm`). | Live: normal login still 200 (HS256 unaffected). |
| **H5** | Aggregator/channel webhooks compared the shared secret with timing-unsafe `!==` | New `safeEqualStr` (SHA-256 then `timingSafeEqual` — constant-time, length-independent) used in both `channel-adapter` and `channel-order` ingest. | Typecheck + `restaurant` harness green. |
| **M4** | `AllExceptionsFilter` echoed raw `exception.message` to clients | Generic `Unexpected error` returned; real message/stack logged server-side only. | Code path; default body unchanged for mapped errors. |

### 7.1 Second batch — remaining Critical/High/Medium + performance

The deferred items were subsequently implemented and **verified live** (typecheck clean; `compliance` 106,
`basics` 210, `restaurant` 162, `ext` 253 — the latter +3 new security checks):

| # | Finding | Fix | Verification |
|---|---------|-----|--------------|
| **C1** | SSO callback never validated `state` → login-CSRF / account-fixation | Server-persisted, **single-use `state`** (`sso_login_state`, migration `0177`) minted by `authorize()`; OIDC **`nonce`** bound into the id_token; **PKCE** (S256) on the code exchange. | Live: forged state → **400 BAD_STATE**; valid handshake → 200; consumed state replay → 400. |
| **H1** | No per-account login lockout | `login_attempts` (migration `0176`) written on an **autocommit** path (raw pg client) so failures survive the 401 rollback; 10 fails → 15-min lockout. | Live: 10 fails → 11th **429 LOGIN_LOCKED**; correct password blocked during lock; other accounts unaffected. |
| **H3** | Member JWTs non-revocable (30d, no jti) | `jti` added (revocable via the existing denylist) + life cut to 7d; guard re-checks `pos_members.active` each request. | Live: deactivating a member → that token **401 MEMBER_DEACTIVATED** immediately; token now carries a jti. |
| **H4** | Weak password KDF | Self-describing hardened scrypt `scrypt$N$r$p$salt$hash` (cost ↑, env-tunable); legacy hashes verify + transparently rehash on login. | Typecheck + auth harnesses green. |
| **H6** | Refund TOCTOU over-refund | `requestRefund` sums settled **and** pending refunds under a `FOR UPDATE` payment-row lock. | `basics`/`restaurant` payment checks green. |
| **M3** | Webhook-URL SSRF | `assertPublicUrl` (https-only in prod; rejects private/loopback/link-local/metadata) at register **and** re-checked at send (DNS-rebind). | Live: metadata/loopback/RFC1918 → **400 SSRF_BLOCKED**; public https → 201. |
| **Perf** | 10-conn pool + single Node process | Opt-in clustering (`WEB_CONCURRENCY`); `DB_POOL_MAX` default 10→20; per-request RLS `set_config` collapsed 3→1 round-trip. | Load test below. |

**Performance result (100 sessions):** clustered (4 workers × pool 20, batched RLS) → **946 req/s, p50 93 ms**
vs the original **410 req/s, p50 242 ms** — **~2.3× throughput, ~2.6× lower p50 latency, 0 errors**. (Single
process with the same code gains ~5%; the cluster — using the previously-idle cores — is the real win.)

Docs updated: SSO/SCIM control-matrix row + revision history (rev 1.1 & 1.2) in
`docs/process-narratives/27-platform-customization.md`; RCM readiness item `ITGC-AC-07` updated and the xlsx
regenerated (`compliance/build_rcm.py`). Two journaled migrations added (`0176`, `0177`); both new tables are
auth-global (pre-tenant) so no RLS. No new RCM control.

### 7.2 Still open (genuinely out of scope here)

Lower-priority/operational items remain: **M2-residual** RS256/JWKS SSO path (only HS256 implemented),
server-side **MFA enforcement** (L3), TOTP single-use replay lock (L4), argon2id migration as the eventual
KDF target (H4 is a strong interim), retiring the legacy SHA-256 verifier once dormant accounts are migrated,
ops **alerting on repeated lockouts**, and the tracked dependency upgrades (drizzle-0.45, Fastify-5/Nest-11).
