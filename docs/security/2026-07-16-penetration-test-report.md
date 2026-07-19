# Penetration Test Report — Invisible ERP V2

**Date:** 2026-07-16
**Scope:** `apps/api` (NestJS 11 / Fastify 5 + Drizzle ORM 0.45 + PostgreSQL, multi-tenant RLS) and `apps/web`
(Next.js 15). White-box code audit across six parallel domains, with independent re-verification of every
High/Medium finding against current `main`.
**Baseline:** follow-up to `docs/security/2026-06-28-security-and-load-test-report.md` and the 2026-07-08
third-party review (22 findings, all merged). Codebase has grown from 176 → **405 migrations** and ~100 → **160+
modules** since the last pentest (new: platform console, projects/PMO, store hub, blind-count receiving,
MMM/marketing-intelligence, public API).
**Method:** static white-box analysis only. No live instance, no load test this round. No application code was
changed by this audit.

---

## 1. Executive summary

The security core is in **excellent** shape and every prior remediation held up under regression testing (§5).
The multi-tenant RLS machinery, auth crypto, webhook signing, SSRF guard, error handling, and dependency posture
are all verified correct. drizzle-orm is now `0.45.2` (the accepted Critical SQLi advisory is **remediated**) and
the Fastify-5 / Nest-11 upgrade cleared the old High-advisory cluster.

The findings that remain cluster around **one theme**: the 2026-06-28 privilege-escalation fix (H2 — "only the
platform owner may grant the `Admin` role", enforced by `assertCanGrantRole`) was applied to `create`/`update` in
`AdminUsersService` but **three other code paths reach `Admin`/god authority without going through that guard.**
Individually each is a High; together they mean the headline control from the last pentest is only partially
enforced.

| # | Finding | Severity |
|---|---------|----------|
| **P1** | `reset-password` performs **no** actor/target-role check → a `users`-permission holder (AccessAdmin) hijacks their tenant's `Admin` account | **High** |
| **P2** | SSO JIT provisioning inserts the configured `default_role` with no `assertCanGrantRole` → AccessAdmin self-provisions an `Admin` | **High** |
| **P3** | `PlatformAdminGuard` authorizes on `username` only → a platform-owner-minted API key is an MFA-free "god" credential | **High** |
| **P4** | Journal-entry approval path (`approveEntry`) is missing the hard-close (`Locked`) period gate → a Draft can post into an irreversibly closed period | **High** |
| **P5** | Blind-count goods-receipt over-receipt gate is a TOCTOU race (check outside the tx, no row lock) | **Medium** |
| **P6** | Refund maker-checker (REV-16) is a **per-call** threshold → split into sub-threshold refunds to skip approval | **Medium** |
| **P7** | Marketing `price-list` / `survey-response` writes take `tenant_id` from the request body (mass-assignment) | **Medium** |
| **P8** | Billing/metering tables carry a real `tenant_id` column but have **no RLS policy** (app-filter only, no DB backstop) | **Medium** |
| **P9** | `DELETE /api/admin/users/:username` can delete a higher-privileged (`Admin`) account — no target-role check | **Low** |
| **P10** | Staff login lacks a dummy-hash on the unknown-user branch → username enumeration timing oracle | **Low** |
| **P11** | SSO-minted staff sessions carry no `jti` → not revocable by logout / denylist | **Low** |
| **P12** | Public tenant-minting endpoints (`/api/auth/signup`, `signup-requests`) are on the loose 300/min global bucket | **Low** |
| **P13** | `CSP_REPORT_ONLY` is not overridden in prod → a stray flag silently disables the strict nonce CSP | **Low** |
| — | Minor/info: `webhook-auth` length-leak, password-min inconsistency (6 vs 8), SSRF DNS-rebind residual, unbounded loyalty money field, no RLS-coverage CI gate, manual HTML-escaping | Info |

**Tenancy-mode caveat (governs blast radius of P1/P2/P3/P7).** In the **default `single-company`** mode an
`Admin` holds a *global* cross-tenant RLS bypass, so these escalations are cross-tenant (approaching Critical).
Production runs **`TENANCY_MODE=multi-company`** (set 2026-07-03), where `Admin` is org/tenant-scoped — so in prod
these are *intra-tenant/org* privilege escalations (a restricted access-admin becomes full company Admin), not
cross-tenant leaks. They are rated on the intra-tenant impact; the default-mode variant is called out per finding.

### 1a. Remediation status

**P1, P2, P3 are fixed in the same change as this report** (the "Admin-grant side-doors" workstream) and
verified live:

| # | Fix | Verification |
|---|-----|--------------|
| **P1** | `AdminUsersService.resetPassword` now receives the actor and authorizes on the **target's current role** (`assertCanGrantRole` + a platform-owner-target guard) — a non-platform Admin/AccessAdmin can no longer reset a peer Admin (`ADMIN_GRANT_DENIED`). | `onboarding`: non-platform reset-Admin → 403; reset-non-Admin → 2xx; god reset-Admin → 2xx. |
| **P2** | `Admin`/`AccessAdmin` removed from the SSO/SCIM assignable `default_role` allow-list (`BAD_ROLE`), and `SsoService.provisionAndMint` **fails closed** on a stale privileged config (`SSO_ROLE_NOT_ALLOWED`). | `onboarding`: default_role=Admin/AccessAdmin → 400; =Sales → 200. `platform-admin` unit: `isJitForbiddenRole`. |
| **P3** | `PlatformAdminGuard` **rejects machine principals** (`user.apiKeyPrefix`), so a god-minted API key can no longer pass god routes. | `onboarding`: god-minted key → `GET /api/admin/tenants` → 403 `PLATFORM_ADMIN_REQUIRED`. |

ToE: `onboarding` +6 → 130, `platform-admin` unit +4; regression: `ext` 306 / `compliance` 179 / `pg-core` 15
green. Docs synced (PN-27 rev 1.3, manual §2 + FAQ, UAT-ADM-156..158 + traceability). **P4–P13 remain open**
(P4 is the intended next PR).

---

## 2. What regressed vs. what is new

- **No prior fix regressed.** All 2026-06-28 and 2026-07-08 remediations are present and correct (§5).
- **P1, P2, P3 are gaps left *beside* the H2 fix**, not regressions of it — the guard itself is intact on
  `create`/`update`; these are sibling paths that were never wired to it.
- **P4, P5, P6, P7** are in code that is **new or materially changed** since the last pentest (hard-close
  approval flow, blind-count receiving EXP-12, marketing module), i.e. genuinely new attack surface.
- **P8** tables (`ai_token_usage`, `ai_overage_billing_runs`, `usage_events`, `usage_overage_billing_runs`) are
  new metering surface added after the last audit.

---

## 3. Findings (detail)

### 🟠 P1 — `reset-password` has no authorization check → Admin-account takeover  **[High]**

`apps/api/src/modules/admin-users/admin-users.controller.ts:54` ·
`apps/api/src/modules/admin-users/admin-users.service.ts:219-228`

`reset()` is the **only** user-mutating route in the controller that does not receive `@CurrentUser()`:

```ts
@Post(':username/reset-password') reset(@Param('username') u, @Body(...) b) { return this.svc.resetPassword(u, b.password); }   // no actor
```

Compare `create` (`:52`) and `update` (`:53`), which pass `actor` and run `assertCanGrantRole` (the H2 fix).
`resetPassword(username, newPassword)` looks the target up **under the request's RLS tx** and overwrites its
`passwordHash` + sets `mustChangePassword=true`, with no check on the *target's* role. The class gate is only
`@Permissions('users')`.

**Exploit.** An attacker holding role `AccessAdmin` (default perms `['users']`, non-Admin) resets the password of
their tenant's own `Admin` (same tenant ⇒ visible under RLS), logs in as that Admin (completing the forced
password change they set), and now holds role `Admin`. `assertCanGrantRole` blocks *granting* Admin but does
nothing to stop *hijacking* an existing one. In `single-company` mode this yields the global RLS bypass
(cross-tenant); in prod's `multi-company` mode it is a full escalation to org Admin. Under `single-company` an
existing tenant Admin can even reset the **platform owner's** row (reachable via the global bypass) and become god.

**Fix.** Thread `@CurrentUser()` into `reset`, and in `resetPassword` refuse when the *target's current role* is
`Admin` (or `isPlatformAdmin(target)`) unless the actor is a platform owner — mirror `assertCanGrantRole`, keyed on
the target rather than the requested role. Optionally bump `tokensValidFrom` on reset to kill live sessions.

---

### 🟠 P2 — SSO JIT provisioning bypasses the Admin-grant control  **[High]**

`apps/api/src/modules/identity/sso.service.ts:121-148` (`provisionAndMint`) ·
`apps/api/src/modules/identity/identity-config.service.ts:56,101` (`ROLES` allow-list **includes `'Admin'`**) ·
`identity.controller.ts` `PUT /api/platform/identity` gated only `@Permissions('users')`.

The SCIM path routes provisioning through `AdminUsersService`, so it inherits `assertCanGrantRole`. **The SSO JIT
path does not** — it inserts the configured `defaultRole` straight into `users`:

```ts
await tx.insert(users).values({ username: uname, ..., role: defaultRole as ..., tenantId, ssoSubject: subject, isActive: true });   // sso.service.ts:142
```

`default_role` is set via `PUT /api/platform/identity` (held by a tenant `AccessAdmin`), and its validator only
checks `ROLES.includes(default_role)` — where `ROLES` **permits `'Admin'`** (`identity-config.service.ts:101`).

**Exploit (no real IdP needed).** As AccessAdmin: (1) `PUT /api/platform/identity` with `sso_enabled:true`, an
https `oidc_issuer`, an `oidc_client_id`, an **attacker-chosen** `oidc_client_secret`, and `default_role:'Admin'`.
(2) `GET /api/auth/sso/authorize?tenant=CODE` — the returned `authorization_url` embeds the server `state`/`nonce`.
(3) Self-sign an HS256 `id_token` with the chosen secret (matching nonce/iss/aud) and `POST /api/auth/sso/callback`
with `{state, id_token}`. `verifyHs256` passes (secret is attacker-set — the M1 empty-secret fix doesn't apply).
(4) `provisionAndMint` creates a **role=Admin** user and returns an Admin session. In `single-company` mode that is
a global cross-tenant bypass.

**Fix.** Remove `'Admin'` (and `'AccessAdmin'`) from the SSO/SCIM assignable `ROLES`, **and** call an
`assertCanGrantRole`-equivalent inside `provisionAndMint` so JIT can never mint a privileged role regardless of
config. Hard-cap SSO JIT to non-privileged roles.

---

### 🟠 P3 — Platform-owner API key is an MFA-free "god" credential  **[High]**

`apps/api/src/common/guards.ts:102` (API-key principal) · `guards.ts:233-237` (`PlatformAdminGuard`)

The H-2 hardening made an API key adopt its **minting human** as the maker-checker principal:
`req.user.username = row.createdBy` (`guards.ts:102`). `PlatformAdminGuard` authorizes `@PlatformAdmin` routes
**solely on the username** and then grants a full cross-tenant RLS bypass:

```ts
if (!isPlatformAdmin(user?.username)) throw new ForbiddenException(...);   // guards.ts:233
req.__platformBypass = true;                                              // guards.ts:236
```

So a key minted by a platform owner has `username` = the god username and passes **every** god route
(provision/suspend/**factory-reset**/**purge** tenants, `act-as` any company, cross-tenant AI-usage) — with no
password and no MFA, and (unless a TTL was set) no expiry. This directly contradicts the invariant stated one
function above (`guards.ts:88`: *"A key is a machine principal — NEVER 'Admin' (no HQ bypass via key)"*): the H-2
change reintroduced god authority through the key's `created_by`. API keys are routinely embedded in scripts/CI,
so a leaked god key is a full fleet compromise that also bypasses the documented "MFA those god logins" control.

**Precondition:** a platform owner has actually minted an API key. It is a latent privilege-scoping flaw that
becomes live the moment a god key exists.

**Fix.** In `PlatformAdminGuard`, reject machine principals — the request already carries `apiKeyPrefix`:
`if (user?.apiKeyPrefix) throw Forbidden`. Keep `created_by` for maker-checker/SoD, but never let it satisfy the
platform-admin decision.

---

### 🟠 P4 — Journal approval skips the hard-close (`Locked`) period gate  **[High]**

`apps/api/src/modules/ledger/ledger-posting.service.ts:118-123` (`postEntry`) vs `:283-286` (`approveEntry`)

`postEntry` blocks a `Locked` period (irreversible hard close, `:118`) **and** a `Closed` period (`:121`). The
maker-checker approval path — where a Draft transitions Draft→Posted, bypassing `postEntry` — re-checks **only
`Closed`**:

```ts
if (pp && pp.status === 'Closed') throw PERIOD_CLOSED;   // approveEntry :286 — no 'Locked' branch
```

The code's own comment (`:116-117`) states `Locked` is "strictly stronger than the soft 'Closed' gate", yet the
stronger gate is absent on approval. `bumpPeriodBalances` then mutates the locked period's `gl_period_balances`.
The GL-immutability trigger blocks edits to *Posted* rows, not a Draft→Posted transition, so there is no DB
backstop.

**Exploit.** (1) In an open period, user A creates a Draft JE (any amount/accounts). (2) The period is hard-closed
→ `Locked` (year-end). (3) A different user B (ordinary GL-05 approver) approves the Draft → it posts **into the
locked period** and rewrites its balances after the irreversible close, altering audited P&L/BS figures in a
period auditors treat as frozen. Needs two accounts (maker≠checker is enforced) but is a serious ICFR-integrity gap.

**Fix.** In `approveEntry`, reject `pp.status === 'Locked'` (keep the `Closed` check), ideally by routing the
approval's posting through the same period gate `postEntry` uses rather than a duplicated weaker check.

---

### 🟡 P5 — Over-receipt gate is a TOCTOU race (EXP-12)  **[Medium]**

`apps/api/src/modules/procurement/procurement-grn.service.ts:155-176` (check) vs `:183-207` (mutation)

The `OVER_RECEIPT` cap is evaluated with a **non-transactional, unlocked** read of `poItems.receivedQty`
(`db.select` at `:159`) **before** the `db.transaction` opens at `:183`. Inside the tx the code re-selects the PO
line (`:192`) but does **not** re-validate the cap — it blindly increments
`receivedQty = receivedQty + recv` (`:207`). This is the exact TOCTOU shape fixed for refunds (H6) with
`FOR UPDATE`, but here the lock is missing.

**Exploit.** Two concurrent `POST /api/procurement/receiving` (or a double-clicked "รับครบ") for the same PO line
(ordered 100, received 0): both read 0, both pass `0 + 100 ≤ 100`, both commit `+100` → **200 received vs 100
ordered**, booking inventory/AP for goods never ordered and defeating the 3-way match. The weight-UoM tolerance
widens the window.

**Fix.** Move the over-receipt check *inside* the transaction and lock the PO-line rows with `.for('update')`
before summing `receivedQty + reqQty` against `cap`, so concurrent receipts serialize.

---

### 🟡 P6 — Refund maker-checker evaded by splitting into sub-threshold refunds  **[Medium]**

`apps/api/src/modules/payments/payments.service.ts:24,267`

The REV-16 approval gate is **per-call** on `dto.amount`:

```ts
if (!outerTx && !opts?.force && n(dto.amount) >= REFUND_APPROVAL_THRESHOLD) return this.requestRefund(dto, user);   // threshold = 1000
```

There is no cumulative check across a payment. A holder of `pos_refund` fully refunds a ฿9,000 payment as 10 ×
฿900, all executed immediately with **no independent approval**. The over-refund guard (`:288`, correctly locked)
still caps total ≤ captured — so no money is *created* — but the second-person control is entirely skipped.

**Fix.** Base the threshold on **cumulative** refunds against the payment (already-refunded + this amount ≥
threshold ⇒ require approval), using the `prior` sum already computed under the lock at `:284`.

---

### 🟡 P7 — Marketing writes accept `tenant_id` from the request body  **[Medium]**

`apps/api/src/modules/marketing/marketing.service.ts:269,304` ·
`marketing.controller.ts:91,101` (no `@CurrentUser()` override)

`createPriceList` and `createSurveyResponse` write `tenantId: dto.tenant_id ?? null` straight from the body, and
the two controller routes pass the body through with no server-side override — unlike the sibling
`portal/surveys/:id/responses` route (`:108-109`), which correctly does `b.tenant_id ?? u.tenantId`.

**Exploit.** A `marketing`-permission user in tenant A sends `{"tenant_id": <B>}` to attribute a price list /
survey response to tenant B, or `{"tenant_id": null}` to create a **global** ("All Customers") price list. The RLS
`WITH CHECK` blocks a normal tenant session from writing a foreign/NULL `tenant_id`, so for ordinary users this is
defense-in-depth — **but** an `Admin` under `single-company` (global bypass) makes it a genuine cross-tenant/global
write. Violates the CLAUDE.md rule "never allow the tenant context to be overridden by client input."

**Fix.** Drop `tenant_id` from `PriceListBody`/`SurveyResponseBody` (or ignore it) and derive `tenantId` from
`user.tenantId` in the service; pass `@CurrentUser()` into both routes.

---

### 🟡 P8 — Billing/metering tables have `tenant_id` but no RLS policy  **[Medium, defense-in-depth]**

`apps/api/drizzle/0178_ai_token_usage.sql` (`ai_token_usage`) ·
`0201_ai_overage_billing_runs.sql` (`ai_overage_billing_runs`) ·
`0281_usage_meters.sql` (`usage_events`, `usage_overage_billing_runs`)

All four declare `tenant_id BIGINT NOT NULL REFERENCES tenants(id)` but never `ENABLE ROW LEVEL SECURITY` and never
create `tenant_isolation` (intentional: "operator/job-written"). Because RLS is not enabled, the prod H-3 backstop
(non-superuser base role) does **not** protect them — the only thing preventing a cross-tenant read is the
hand-written `eq(tenantId, …)` predicate at each call site. Verified: every *current* read filters correctly
(`billing-metering.service.ts:36,48,94,157-159,191-192,246-249`; `usage-meter.service.ts:12-18`), so there is **no
active leak** — but no DB safety net either. A future "usage summary" endpoint that forgets the tenant predicate
would return every company's transaction volumes and THB overage amounts.

**Fix.** Enable RLS + apply the canonical `tenant_isolation` (0232 org-clause form) — reads already filter, so
behavior is unchanged and you gain the backstop; the existing `UNIQUE(tenant_id, …)` satisfies the `tenant-idx`
gate. Alternatively rename the column to `billed_tenant_id`/`about_tenant_id` per the platform-table convention so
the name stops implying an isolation guarantee it doesn't provide. **Also add a CI gate** (mirror `tenant-idx`)
that fails when a `tenant_id`-column table lacks `rowsecurity=true` + a `tenant_isolation` policy, with a
documented allow-list — this class of gap has no gate today.

---

### 🟢 Low / Info

- **P9 — Deleting a higher-privileged account.** `admin-users.service.ts:378-387` `remove` blocks only
  `SELF_DELETE`; an AccessAdmin can delete their tenant's `Admin` (denial-of-administration). Same fix as P1: don't
  allow deleting an `Admin`/platform owner unless the actor is a platform owner.
- **P10 — Username enumeration timing oracle.** `auth.service.ts:40,83` return immediately on unknown user/PIN
  (no scrypt), while a known user incurs a full scrypt verify — a reliable timing distinguisher. The member-OTP
  path was *explicitly* hardened against this (`member-auth.service.ts:64-66`); staff login was not. Fix: dummy
  `verify` against a constant fake hash on the no-user branch.
- **P11 — SSO sessions not revocable.** `sso.service.ts:147` signs the JWT with **no `jti`**, unlike password
  (`auth.service.ts:126`) and member (`member-auth.service.ts:93`) login. The guard only denylist-checks when
  `jti` is present (`guards.ts:122`), and `revokeToken` returns `{revoked:false}` with no `jti` — so **logout
  cannot kill an SSO session**. Capped by the short access-token life. Fix: add `jti: randomUUID()`.
- **P12 — Public tenant-minting not throttled tightly.** `billing.controller.ts:58,86` (`@Public` signup /
  signup-requests) are not in `edge.ts`'s strict buckets, so they fall to the 300/min global bucket — ~300 spam
  tenants/min/IP where public signup is enabled. Fix: add both to a strict `signup`/`lead` bucket.
- **P13 — CSP kill-switch unguarded.** `apps/web/src/middleware.ts:61` emits report-only when `CSP_REPORT_ONLY==='1'`;
  a stray prod value silently disables the strict nonce CSP with no signal. Fix: ignore it when
  `NODE_ENV==='production'` (fail-closed, like the tenancy boot checks).
- **Info:** `webhook-auth.ts:15-19` re-implements a length-leaking `safeEqualStr` instead of reusing the
  SHA-256-first helper in `crypto.ts:119`; password minimum is 6 in admin create/reset vs 8 in change-password, no
  breach/complexity check; `net-guard` has a residual sub-ms DNS-rebind TOCTOU (validated IP not pinned to the
  connect); public-API loyalty `EarnBody.net_spend` has no upper cap; manual per-field HTML escaping (no
  auto-escaping engine) is a latent-XSS risk if a future field is interpolated without `esc()` — recommend a CI
  grep asserting `esc()` coverage in `*-pdf`/`*Html` builders (email-attachment HTML renders outside any CSP).

---

## 4. Prioritized remediation order

1. **P1 + P2 + P3** — close the three Admin-grant side doors in one workstream: actor/target-role check on
   `reset-password`; drop `Admin` from SSO/SCIM assignable roles + guard `provisionAndMint`; reject machine
   principals in `PlatformAdminGuard`. (This is the headline — the H2 control is currently only partially enforced.)
2. **P4** — add the `Locked`-period gate to `approveEntry` (ICFR: post-hard-close manipulation).
3. **P5** — move the over-receipt check into the tx under `FOR UPDATE`.
4. **P6** — cumulative refund threshold.
5. **P7** — server-derive `tenant_id` on the two marketing writes.
6. **P8** — enable RLS (or rename) on the metering tables + add the RLS-coverage CI gate.
7. **P9–P13 + info** — target-role check on delete; login dummy-hash; SSO `jti`; signup rate bucket; prod CSP
   guard; the info-level hardening.

> Per the repo documentation-sync policy, remediations touch: `assertCanGrantRole`/SoD in
> `packages/shared/src/permissions.ts` and PN-27 (platform/SSO); GL-05/GL-15/GL-19 narrative + close docs and the
> RCM (`build_rcm.py`) for P4; EXP-12 PN-02 §7 + `tools/cutover/src/compliance.ts` for P5; add negative UAT cases
> (reset-Admin→403, SSO default_role=Admin→rejected, approve-into-locked→PERIOD_LOCKED, concurrent GR→OVER_RECEIPT,
> split-refund→approval-required). Extend the `basics` and `compliance` harnesses accordingly.

---

## 5. Verified correct (regression checks — all passed)

**Every prior remediation is intact.** These are important for the SOX narrative and are *not* findings.

**Multi-tenant isolation (RLS) — the strongest part of the system.**
- Per-request GUCs are transaction-local (`SET LOCAL ROLE app_user` + `set_config(…, true)` inside
  `db.transaction`), not client-overridable (`tenant-tx.interceptor.ts`).
- `role`/`orgId`/`tenantId` are re-read **live from the DB** each request (`guards.ts:135-161`) — only `username`
  comes from the token; a forged role/tenant/org claim cannot widen scope (L-3, AC-02/03/18).
- The org-sharing clause is **canonical on every post-0232 `tenant_isolation` policy** (enumerated migrations
  0236→0405; the historical 0218 clause-drop is superseded by 0232). `WITH CHECK` rejects NULL/foreign `tenant_id`
  writes. Recent retrofits (0316, 0387) use the canonical form.
- god `act-as` (`X-Act-As-Tenant`/`X-Act-As-Read-Only`) is honored **only for a platform owner**, only *narrows*
  scope, and rejects mutations under read-only; `__platformBypass` is set server-side only. Boot checks are
  fail-closed (H-3/H-4). Platform tables correctly avoid the `tenant_id` name (`about_/created_/used_tenant_id`).

**Auth / session / crypto.**
- C1 SSO `state`/`nonce`/PKCE (single-use `sso_login_state`, replay-rejected); M1 empty-secret fail-closed; M2
  algorithm pinning (`algorithms:['HS256']`, id_token rejects `alg≠HS256`); H1 per-account lockout (10→15min on an
  autocommit path); H3 member `jti` + 7d + live `pos_members.active` recheck; H4 hardened self-describing scrypt,
  legacy unsalted-SHA-256 verifier removed; H-2 API keys carry `created_by`; refresh-token rotation with
  reuse→revoke-all; TOTP seeds AES-256-GCM at rest; CSRF constant-time double-submit (Bearer/API-key exempt);
  env-secret validation fail-closed in prod. (P3 is the one place the API-key principal over-reaches.)

**Injection / SSRF / upload / validation.**
- **No real SQL-injection sink** — every `sql.raw`/`sql\`\`` site interpolates compile-time constants, whitelisted
  tokens, or tenant-filtered DB rows; all user input reaching queries is Drizzle-parameter-bound.
- `net-guard.assertPublicUrl` blocks RFC1918 / loopback / link-local `169.254.169.254` / CGNAT / ULA /
  IPv4-mapped-IPv6 (dotted **and** hex, H-1) / NAT64, at register **and** send; every tenant/user-supplied
  outbound URL routes through it.
- `object-storage.isSafeObjectKey` rejects traversal/scheme/control chars and re-validates on every operation
  (L-9); the only XML parse is on server-generated fragments (no XXE).

**Web / errors / webhooks / rate limiting / deps.**
- CSP is a **per-request nonce** in `apps/web/src/middleware.ts` (M-1) — `strict-dynamic`, no static-header
  regression; no `dangerouslySetInnerHTML`; CWE-598 avoided (SSO/reputation callbacks forward `location.search`
  opaquely, parsed server-side from the POST body); client auth gate is UX-only, server enforces via the global
  guard chain.
- `AllExceptionsFilter` returns generic `INTERNAL_ERROR` and logs detail server-side only (M4); Sentry capture
  strips the query string.
- **All inbound webhooks** verify HMAC-over-`rawBody` with `timingSafeEqual`, a replay window, and fail-closed in
  prod (H5/L-1/L-2): channel-adapter, restaurant channel-order, email-capture, crm-inbound, service-cases, LINE,
  Stripe. `main.ts` sets `rawBody:true`. No `==`/bare-secret compares remain.
- Rate limiting shares counters via Redis across replicas (L-8/L-12) with per-IP buckets; the dedicated
  login/OTP/lead buckets are in place (H1).
- **Dependencies:** `drizzle-orm ^0.45.2` (**Critical SQLi GHSA-gpj5-g38j-94v9 remediated** — off the ignore
  list), `@nestjs/platform-fastify ^11`, `fastify ^5` (the old High-advisory cluster cleared). Remaining
  `ignoreGhsas` entries are dev/build-only and justified in `compliance/vulnerability-triage.md`. `pnpm audit
  --audit-level high` is a hard CI gate; no open Critical/High in the production runtime.

**Business-logic integrity.**
- H6 refund over-refund is fixed and present (`FOR UPDATE` on the payment row, prior refunds summed under the
  lock, pending counted); refund self-approval blocked; payment tender idempotency (`ux_payments_idem` +
  `onConflictDoNothing`); `postEntry` balanced-by-construction with `ux_je_idem` dedupe and both period gates;
  GL immutability + contra-reversal; gift-card / loyalty redeem lock the row `FOR UPDATE` and re-check balance;
  recurring/prepaid jobs idempotent via deterministic `source_ref`. (P4/P5/P6 are the specific gaps above.)

---

## 6. Appendix — method & coverage

Six parallel white-box auditors: (A) auth/session/SSO/SCIM/API-keys/crypto; (B) authz/privesc/IDOR/SoD/act-as;
(C) multi-tenant RLS across all 405 migrations; (D) injection/SSRF/upload/validation/public-API; (E)
business-logic/financial integrity; (F) web/CSP/errors/webhooks/rate-limiting/deps. Every High/Medium finding in
this report was independently re-verified against current `main` (file:line confirmed by direct read). No live
instance was exercised; the load-test dimension of the 2026-06-28 report was not repeated this round (recommend
re-running it after the clustering/pool changes land). No application code was modified by this audit.
