# Privilege-Escalation & API-Authorization Audit — Invisible ERP V2

**Date:** 2026-07-17
**Scope:** `apps/api` (NestJS 11 / Fastify 5 + Drizzle ORM 0.45 + PostgreSQL, multi-tenant RLS). Focused
white-box audit of **vertical** (role/permission escalation) and **horizontal** (BOLA / IDOR / cross-tenant)
authorization across all 211 controllers and their service layers.
**Baseline:** follow-up to the 2026-07-16 penetration test (`2026-07-16-penetration-test-report.md` /
`-pentest-handoff.md`, P1–P13 **closed** in #797/#798/#800/#802) and the 2026-07-08 third-party review.
**Method:** static white-box analysis. Every High/Medium finding was re-verified against the code on
`main` (tip `61d7973`). No application code was changed by this audit.

---

## 1. Executive summary

The authorization core remains **strong**. The global `JwtAuthGuard` (live DB role/tenant/orgId, revocation
denylist, must-change-password + privileged-MFA hard gates), the `PermissionsGuard`, the `PlatformAdminGuard`
(env-only god, machine-key barred), and the per-request RLS transaction (`TenantTxInterceptor`) are all
verified correct. A codebase-wide census confirmed **no mutating endpoint is reachable by an unprivileged
principal**: of 211 controllers, the only mutating handlers with no `@Permissions` are self-service by design
(auth-self change-password/MFA/PIN, ethics-acknowledge / whistleblower-hotline, owner-scoped `user-prefs`).
The loyalty **Member** and customer **portal** boundaries are also clean (members carry no id path-params;
portal customers are provisioned as their own tenant, so customer-vs-customer is cross-tenant and
RLS-backstopped).

The findings below cluster around **one theme the 2026-07-16 pentest identified but did not fully close**:

> **The `users` permission (access administration) is treated as authority to grant _any_ capability,
> unbounded by the granting principal's own privileges.** The pentest closed the paths that reach the
> **Admin/god** role (P1 reset-password, P2 SSO-JIT, P3 platform-key). But the same principle is still
> exploitable to grant _sub-Admin transactional capability_ through two paths it never examined — **API-key
> scopes** (which additionally skip the SoD engine entirely) and **single-duty permission overrides** to a
> controlled account. This defeats the whole point of the least-privilege `AccessAdmin` role (SoD R01: access
> administration must be segregated from every transactional duty).

Plus several independent new findings (self-approvable QC scrap write-off, a beneficiary-set match tolerance,
a within-tenant leave-balance IDOR, an MFA-downgrade side-door, and a class of `tenant_id`-from-body controllers).

| # | Finding | Class | Severity | Status vs 2026-07-16 |
|---|---------|-------|----------|----------------------|
| **PE-1** | `POST /api/platform/api-keys` writes `scopes` verbatim — no cap to the minter's perms → AccessAdmin mints a key with `gl_post`/`creditors`/… scopes | Vertical / SoD-bypass | **High** | ✅ **Fixed** (this branch — scopes bounded to minter, `403 KEY_SCOPE_EXCEEDS_GRANTOR`) |
| **PE-2** | `admin-users` grant bounds only the **Admin role** + SoD *pairs*; no `granted ⊆ caller` check → AccessAdmin grants a single transactional duty (e.g. `gl_post`) to a puppet account | Vertical | **High** | ✅ **Fixed** (this branch — escalating grants staged for a 2nd admin, `sod_rules:['ESCALATION']`) |
| **PE-3** | `GET /api/hcm/leave/balances` is `ess`-reachable but ignores the caller → any employee reads a colleague's (or **all**) leave balances | Horizontal / BOLA | **Medium** | New |
| **PE-4** | `POST /api/quality/inspect` (disposition=Scrap) posts an immediate GL write-off gated only by `warehouse`/`bom_master`, **no maker-checker** | Vertical / self-approval | **Medium** | New |
| **PE-5** | `PUT /api/procurement/match/tolerance` gated `creditors` only, no maker-checker → the AP beneficiary widens 3-way-match tolerances and defeats the EXP-01 hold | Vertical / SoD | **Medium** | New |
| **PE-6** | `POST /api/platform/mfa/setup` overwrites the TOTP secret + sets `mfaEnabled:false` with no already-enrolled guard / no step-up (the `auth` surface blocks exactly this) | Auth-control bypass | **Medium** | New |
| **PE-7** | Class of controllers pass body `tenant_id` straight to the service **without** the Admin gate that `ledger`/`leases` use (deferred-tax, fx-reval, tax-utp, treasury-pool/-debt/-hedge/-invest) | Horizontal (mitigated) | **Low** | New (same class as P7, different surfaces) |
| **PE-8** | Portal `deleteCustomer/Supplier/PurchaseOrder` issue the final `DELETE` without the `AND tenant_id` predicate (scoped SELECT + RLS still protect it) | Horizontal (defense-in-depth) | **Low** | New |
| **PE-9** | Portal sub-user allow-list includes `loyalty`; via OR-gating it satisfies the member points-transfer gate, sidestepping the `crm_points_adjust` SoD split | Vertical / SoD | **Low** | New |
| **PE-10** | `POST /api/inventory/waste` gated `warehouse`/`pos`/`order_mgt` → a sales role posts a non-perpetual stock write-off (perpetual items are hard-blocked to INV-07) | Vertical | **Low** | New |
| **PE-11** | `POST /api/costing/allocate` admits `cust_pos`/`order_cust` → a portal principal creates/releases stock reservations | Vertical | **Low** | New |

**Tenancy-mode caveat (blast-radius modifier).** Production runs **`TENANCY_MODE=multi-company`** (set
2026-07-03), so a per-tenant `Admin` is org/tenant-scoped and all of the above are **intra-tenant / intra-org**
escalations (a restricted role gains capability inside its own company). In the **default `single-company`**
mode an `Admin` holds a *global* RLS bypass, which turns the tenant-boundary items (PE-7, PE-8) cross-tenant.
Rate each on the prod (`multi-company`) impact; the single-company variant is called out where it changes severity.

---

## 2. Method & coverage

- **Vertical census.** Parsed all 211 controllers, attributing method- **and** class-level
  `@Permissions`/`@Public`/`@PlatformAdmin`/`@UseGuards`. Of every mutating handler
  (POST/PUT/PATCH/DELETE), exactly **8** carry no permission gate — all verified self-service by design
  (`auth` change-password/MFA/PIN, `governance` ethics-acknowledge / hotline-cases, `user-prefs` PUT).
  No mutating endpoint is reachable by a `Customer`/`Member` (`permissions:[]`).
- **Horizontal census.** Enumerated every `@NoTx()` (RLS-skipping) and `@Public()` route: all are
  token/HMAC/webhook-scoped (restaurant QR, signed receipts, SSO+SCIM guard, PSP/channel webhooks, health).
  Traced id/ref-addressed reads/writes for tenant + owner scoping; grepped every controller/service for a
  client-supplied `tenant_id`/`org_id` reaching a write.
- **Depth.** Five parallel domain audits (finance/GL/treasury; procurement/inventory/manufacturing;
  CRM/POS/loyalty/portal; platform/auth/admin; projects/HR/BI/docs) traced each candidate into its service
  to confirm the missing check and rule out an RLS/in-service mitigation.

---

## 3. Findings

### PE-1 · API-key scope escalation + SoD bypass **[High]** — *vertical*

- **Location.** `apps/api/src/modules/platform/api-key.service.ts` — `issue()` (lines 25–42); scopes are
  joined and stored verbatim (line 31 `const scopes = (dto.scopes ?? []).join(',')`, persisted line 39).
  Consumed in `apps/api/src/common/guards.ts:92–97`: a non-`*`/`admin` scope is mapped **literally** to a
  permission (`expanded = scopes.flatMap((s) => SCOPE_ALIASES[s] ?? [s])`; only `read`/`write` are aliases).
  Route: `platform.controller.ts` `@Permissions('users')`.
- **Root cause.** `issue()` performs **zero** validation of `dto.scopes` against the minter's own permission
  set and — unlike the user-grant path — runs **no** `detectSodConflicts`. The documented `*`/`admin` →
  `resolvePermissions('Sales')` cap (guards.ts:92) is illusory: it is bypassed simply by listing literal
  permission keys as scopes.
- **Exploit.** An **AccessAdmin** (role holds only `['users']`, `permissions.ts:152`) calls
  `POST /api/platform/api-keys` with `scopes: ['gl_post','creditors','approvals','procurement','md_vendor']`.
  The guard issues a machine principal (role `Sales`, RLS-scoped to its own tenant, correctly barred from
  `@PlatformAdmin`) whose `permissions` include all of those. The attacker then drives any `@Permissions`-gated
  endpoint in the tenant with `Authorization: Bearer ierp_…` — posting journals, disbursing AP, maintaining
  vendor master — none of which the `users` role can do itself, **and** a combination the SoD engine would
  block as a user grant (e.g. `md_vendor` + `creditors` = R02) sails through unchecked.
- **Why it survives H-2.** The 2026-07-08 H-2 / 2026-07-16 P3 fixes correctly bound the *identity* on a key
  (`created_by` = minting human) and bar a key from `@PlatformAdmin`. Neither bounds the key's **scope**.
- **Fix (fail-closed).** In `issue()`, intersect the requested scopes with the minter's own resolved
  permissions (reject or silently drop anything the minter doesn't hold), and run `detectSodConflicts` on the
  resulting permission set exactly as the user-grant path does — staging or rejecting a conflicting combination.
  Keep the `created_by`/`tenantId` binding.
- **Tests.** `onboarding`/`gaps`: an AccessAdmin minting a key with `gl_post` scope → the key cannot post a
  journal (403), and a key with an R02 pair → rejected/staged. Positive: a key scoped within the minter's perms works.
- **Doc-sync.** PN-27 (platform/admin-users) control matrix + revision row; if a control ID governs key
  issuance, reflect in `build_rcm.py` + regenerate the RCM xlsx (`check-rcm-census`); UAT-ADM negative case + traceability.

### PE-2 · Permission grant not bounded by the grantor's own privileges **[High]** — *vertical*

- **Location.** `apps/api/src/modules/admin-users/admin-users.service.ts` — `create()` (136–151) /
  `update()` (153–166). The only preventive gate is `assertCanGrantRole` (110–118), which bounds **only the
  `Admin` role** to the platform owner. The `permissions[]` override is passed only through
  `sodConflictOrThrow` (SoD *pairs*), then `applyCreate`/`applyUpdate`. A per-user override **replaces** role
  defaults (`resolvePermissions`, `permissions.ts:191`).
- **Root cause.** No `granted ⊆ caller.permissions` check anywhere on the grant path. The SoD layer catches
  conflicting *pairs*, not escalation of a *single* duty beyond the grantor's own level.
- **Exploit.** An **AccessAdmin** (`['users']`) creates a user with role `Sales` and
  `permissions: ['gl_post']` (a single duty → no SoD pair → applied immediately, not staged), sets its
  password, and now controls an account that posts journal entries — a capability AccessAdmin lacks. SoD R01
  blocks a *self*-grant that keeps `users` alongside a transactional duty, but nothing stops provisioning that
  duty on a *separate* account the AccessAdmin controls.
- **Fix (fail-closed).** On `create`/`update`, reject any requested permission not in the actor's own resolved
  set unless the actor is a platform owner (mirror the `assertCanGrantRole` shape and error family). This
  composes with — does not replace — the existing SoD-pair staging.
- **Tests.** `onboarding`/`gaps`: an AccessAdmin granting `gl_post` to any account → 403; a platform owner →
  allowed; granting within the actor's own perms → allowed.
- **Doc-sync.** PN-27 control matrix + revision row; UAT-ADM negative case + traceability; RCM only if a
  control ID changes.

> **PE-1 + PE-2 share one root cause.** `users` = "grant any capability, unbounded by what you hold." The
> 2026-07-16 pentest closed the *reach-Admin* expressions (P1/P2/P3); PE-1/PE-2 are the *reach-sub-Admin*
> expressions of the same flaw, on two paths (key scopes, single-duty override) it did not examine. PE-1 is
> the more severe: it also skips the SoD engine the user path enforces.

### PE-3 · Leave-balance BOLA — any employee reads colleagues' (or all) balances **[Medium]** — *horizontal / IDOR*

- **Location.** `apps/api/src/modules/hcm/hcm-leave.service.ts:80` `balances(empCode, _user)`; route
  `hcm-leave.controller.ts:40` `@Get('balances') @Permissions('hr','hr_admin','exec','ess')`.
- **Root cause.** The handler **ignores the caller** (`_user` is unused): with `?emp_code=<X>` it returns X's
  balances; with no `emp_code` it dumps up to 200 employees' balance rows for the tenant. There is no
  `isHr`/`callerEmpCode` own-scoping — unlike every sibling `ess`-reachable read in the module
  (`hcm-comp`/`hcm-perf`/`hcm-training` all do `isHr(user) ? empCode : (await callerEmpCode(user)) ?? '\x00none'`).
  RLS does not help (same tenant).
- **Exploit.** A bare **`ess`** employee calls `GET /api/hcm/leave/balances?emp_code=<colleague>` (PII: entitled
  / accrued / used / available per leave type) or omits `emp_code` to enumerate the whole tenant.
- **Fix.** Mirror the sibling pattern: for a non-HR (`ess`) caller, force `empCode` to
  `callerEmpCode(user)` and reject/own-scope the no-arg listing; HR/exec keep the full view.
- **Tests.** `hcm` harness: an `ess` user reading another `emp_code` → own row only (or 403); no-arg → own only;
  `hr_admin` → all. (Cross-Tenant Boundary + own-scope per the Multi-Tenant Test Protocol.)
- **Doc-sync.** PN-42 (HCM/ESS) control matrix + revision row; user-manual ESS leave section; UAT-HR own-scope case + traceability.

### PE-4 · Self-approvable QC scrap GL write-off **[Medium]** — *vertical / self-approval*

- **Location.** `apps/api/src/modules/mfg-depth/quality.service.ts:33–64` `inspect()`; route
  `mfg-depth.controller.ts:54` under `@Controller('api/quality') @Permissions('bom_master','warehouse','exec')`
  (class `PERMS`, line 13/50).
- **Root cause.** `inspect` with `disposition:'Scrap'` computes `scrapValue = qty_failed × unit_cost` (both
  client-supplied) and calls `this.ledger.postEntry({ source:'QA-SCRAP', … Dr scrap_loss / Cr 1250|1200|1210 })`
  — an **immediately posted** GL write-off with **no maker-checker**. The sibling NCR (QC-01,
  `mfg-depth.controller.ts:97`) and CoA (QC-03) disposition paths deliberately require a segregated
  `quality_approve` approver ≠ raiser via `assertMakerChecker`; this legacy `inspect` path skips it entirely.
- **Exploit.** A single holder of coarse `warehouse` (or `bom_master`) posts an inflated scrap loss / conceals
  inventory shrinkage as QC scrap, self-approved.
- **Fix.** Route a scrap-disposition write-off through the same maker-checker as NCR (`quality_approve` ≠
  raiser), or post it as `pendingApproval` for a segregated approver; do not loosen the NCR control to match.
  Add `quality`/`quality_approve` to the endpoint's duty set.
- **Tests.** `compliance`/manufacturing harness: a `warehouse`-only user's scrap inspection either does not post
  GL or posts as pending; a `quality_approve` ≠ raiser approves. Watch the `golden` master if the `inspect`
  return shape changes.
- **Doc-sync.** QMS/QC narrative (QC-01) control matrix + revision row; if the control set changes,
  `build_rcm.py` + census; UAT-QC self-approval-blocked case + traceability.

### PE-5 · 3-way-match tolerance set by the beneficiary, no maker-checker **[Medium]** — *vertical / SoD*

- **Location.** `apps/api/src/modules/match/match.controller.ts:24` `@Put('tolerance') @Permissions('creditors')`
  → `three-way-match.service.ts` `setTolerance()`.
- **Root cause.** The tolerance that governs **every** 3-way match is writable by `creditors` alone — the same
  role that runs the match and releases payment — with no exec/approver check and no maker-checker. The
  `override` action right beside it (`match.controller.ts:37`) *is* maker-checked (`creditors,approvals,gl_close`
  + `assertMakerChecker`), and the analogous EXP-12 `receiving-settings` deliberately excludes the operator
  (`procurement|exec`). Tolerance config is the odd one out.
- **Exploit.** An **ApClerk** (`creditors`) raises `qty_pct`/`price_pct`/`amount_pct` so all subsequent matches
  auto-pass, defeating the EXP-01 invoice-payment hold, then releases payment on unmatched invoices.
- **Fix.** Gate `setTolerance` to an approver duty (`exec`/`approvals`) and/or route it through maker-checker,
  mirroring `override` and `receiving-settings`. Exclude the `creditors` beneficiary from setting its own control.
- **Tests.** `basics`/procurement harness: a `creditors`-only user cannot widen tolerance (403); an approver can.
- **Doc-sync.** EXP-01 (3-way match) narrative control matrix + revision row; UAT-P2P tolerance-change case + traceability.

### PE-6 · MFA downgrade without step-up (parallel platform surface) **[Medium]** — *auth-control bypass*

- **Location.** `apps/api/src/modules/platform/mfa.service.ts:23–31` `setup()`; route
  `platform.controller.ts` `POST /api/platform/mfa/setup`.
- **Root cause.** `setup()` unconditionally overwrites `totpSecret` and sets `mfaEnabled:false` with **no
  already-enrolled guard and no step-up**. The primary surface `AuthService.mfaSetup()` explicitly blocks this
  (`MFA_ALREADY_ENABLED — disable it first`), and `mfaDisable()` requires password **+** current TOTP. This
  second, weaker surface lets a caller silently flip a user's `mfaEnabled` true→false (or rebind the secret),
  defeating the step-up control that governs MFA disablement.
- **Exploit.** A live or hijacked session (stolen cookie / XSS) calls the platform setup route to nuke MFA and
  re-enrol a secret the attacker controls — MFA persistence / downgrade to password-only. Self-scoped (operates
  on `user.username`), hence Medium.
- **Fix.** Make the platform MFA surface match `auth`: refuse `setup` when `mfaEnabled` is already true unless a
  step-up (password + current TOTP) is presented; or remove the duplicate surface and route the UI to the
  hardened `auth` endpoints.
- **Tests.** auth/onboarding harness: `setup` on an MFA-enabled account without step-up → 403; disable requires
  password + TOTP.
- **Doc-sync.** PN-27 / auth narrative (ITGC-AC-06 MFA) control matrix + revision row; UAT-ADM MFA-downgrade-blocked case.

### PE-7 · Client-supplied `tenant_id` reaches the service without the Admin gate **[Low, defense-in-depth]** — *horizontal (mitigated)*

- **Location.** `deferred-tax.controller.ts:35` / `deferred-tax.service.ts:55–58`; `fx-reval.controller.ts:34` /
  `fx-reval.service.ts:40–42`; `tax-utp.controller.ts:52,70` / `tax-utp.service.ts:39–40`;
  `treasury-pool/pool.controller.ts:81`, `treasury-debt/debt.controller.ts:85`,
  `treasury-hedge/hedge.controller.ts:85`, `treasury-invest/investment.controller.ts:82,90`. Each passes a body
  `tenant_id` straight into a `tenant()` helper that returns the explicit value (`if (explicit != null) return explicit`).
- **Root cause / why not exploitable today.** For an ordinary tenant session, RLS `WITH CHECK` rejects a
  foreign/NULL write (fails closed) and reads are RLS-scoped — so only an `Admin` (RLS bypass in single-company
  mode) can actually target a foreign `tenant_id`, which is the intended HQ behavior. But the control lives
  **only** at the DB layer; the correct app-layer pattern is next door — `ledger.controller.ts:14–17`
  `hqTenant(u, requested)` nulls a non-Admin's `tenant_id`, and `leases.controller.ts:32` does
  `u.role==='Admin' ? b.tenant_id : null`. Same class as the fixed P7 (marketing), on surfaces P7 didn't cover.
- **Fix.** Thread `@CurrentUser()` and apply the `hqTenant`/Admin-null pattern in these controllers; server-derive
  `tenant_id` for non-Admins. Drop `tenant_id` from the affected zod bodies (or ignore it server-side).
- **Tests.** Cross-Tenant Boundary test per surface: a non-Admin posting `{tenant_id: B}` → written as its own
  tenant (or 403), never B.
- **Doc-sync.** Note the app-layer tenant derivation in the affected narratives' revision rows; no RCM change unless a control ID governs it.

### PE-8 · Portal delete omits the `tenant_id` predicate **[Low, defense-in-depth]** — *horizontal*

- **Location.** `apps/api/src/modules/portal/portal.myerp.service.ts:50,79,128` —
  `deleteCustomer`/`deleteSupplier`/`deletePurchaseOrder` do a tenant-scoped `SELECT` ownership check, then
  `db.delete(...).where(eq(id))` **without** `AND tenant_id`.
- **Root cause / mitigation.** Not currently exploitable (the preceding scoped SELECT + per-request RLS both
  protect it), but it violates the repo's mandated combined `WHERE id = :id AND tenant_id = :active` rule
  (CLAUDE.md §9) — one refactor away from a cross-tenant delete if RLS context ever changes.
- **Fix.** Add the tenant predicate to the `DELETE` itself.
- **Doc-sync.** None (internal hardening).

### PE-9 · Portal sub-user `loyalty` grant sidesteps the points-adjust SoD split **[Low]** — *vertical / SoD*

- **Location.** `apps/api/src/modules/portal/portal.users.service.ts:39` (sub-user scope allow-list includes
  `'loyalty'`); consumed by `loyalty.controller.ts` `POST /api/loyalty/members/:id/transfer`
  `@Permissions('crm_points_adjust','loyalty','exec')` (OR-semantics).
- **Root cause.** A portal Customer (`cust_my_users`) can mint a sub-user carrying `loyalty`, which — because the
  points-transfer gate is OR — satisfies it **without** the `crm_points_adjust` SoD separation (R15/R16). Intra-tenant
  and owner-authorized (not an escalation past the tenant), but the coarse `loyalty` grant silently satisfies a
  points-adjust gate.
- **Fix.** Remove `loyalty` from the portal sub-user allow-list, or gate points-mutating loyalty routes on the
  granular `crm_points_adjust` (drop the coarse `loyalty` from those specific gates).
- **Doc-sync.** SoD narrative (R15/R16) note; UAT if the gate changes.

### PE-10 · Waste write-off reachable by a sales duty **[Low]** — *vertical*

- **Location.** `apps/api/src/modules/inventory/waste.controller.ts:40–52` (`POST /api/inventory/waste`,
  `/void-fire`), class-gated `warehouse|pos|order_mgt`.
- **Root cause / mitigation.** A `pos`/`order_mgt` user can reduce non-perpetual `customer_inventory` stock and
  post an immediate write-off (`Dr 5810 / Cr 1200`) with client-supplied `unit_cost`, with no `wh_adjust` duty and
  no maker-checker. Perpetual sub-ledger items are hard-blocked to the INV-07 write-off maker-checker
  (`USE_WRITEOFF` guard), so exposure is limited to non-perpetual kitchen stock — a shrinkage path that bypasses
  INV-04/INV-07 for those items.
- **Fix.** Require `wh_adjust` for the waste write-off; keep the INV-07 maker-checker for perpetual items.
- **Doc-sync.** INV-04/INV-07 narrative note; UAT if the duty changes.

### PE-11 · Costing allocation reachable by a customer-portal role **[Low]** — *vertical*

- **Location.** `apps/api/src/modules/costing/costing.controller.ts:42–48` (`POST /api/costing/allocate`,
  `/allocations/:refDoc/release|fulfill`), admits `cust_pos`/`order_cust`.
- **Root cause / mitigation.** A customer-portal principal can create/release stock reservations against an
  arbitrary `ref_doc`/`qty` (reservation-exhaustion / stock-hold abuse). Tenant-scoped via the token `tenantId`
  (no cross-tenant reach), so impact is low.
- **Fix.** Drop the portal perms from these routes; gate on an internal stock duty.
- **Doc-sync.** None material.

---

## 4. Verified clean (not exhaustive)

- **Vertical surface:** the only ungated mutating handlers are self-service by design (auth-self, ethics/hotline,
  owner-scoped `user-prefs`). No `Customer`/`Member`-reachable mutation.
- **Member / portal boundaries:** member routes carry no id path-param and scope every write to `u.memberId`;
  portal customers are their own tenant (customer-vs-customer is cross-tenant, RLS-backstopped); ESS payslips
  resolve the employee from the JWT, never a param.
- **`@NoTx`/`@Public`:** all token/HMAC/webhook-scoped (restaurant QR, signed receipts, SSO + SCIM guard,
  PSP/channel webhooks, health) — none reads/writes tenant data on an anonymous RLS-bypass path.
- **Finance/GL/treasury:** every mutation `@Permissions`-gated; maker-checker centralized and fail-closed
  (`assertMakerChecker`, `approveEntry` preparer≠approver); `intercompany`/`consolidation` are HQ/Admin-only
  in-service; FX shared-rate writes rejected by RLS `WITH CHECK` for non-Admins.
- **Platform/auth:** `@PlatformAdmin` covers every cross-tenant `admin/*` route and bars machine keys; god status
  is env-only (no DB column); JWT identity sourced live from DB; SSO/SCIM route through the Admin-grant guard and
  a JIT-forbidden-role allow-list; feature flags cannot widen the RLS bypass; the 2026-07-16 P1–P13 remediations
  are all present and hold.

---

## 5. Remediation priority

| PR | Contents | Rationale |
|----|----------|-----------|
| **PR-1** | PE-1 + PE-2 (bound key scopes to minter + SoD; bound perm grants to grantor) | Closes the residual reach-sub-Admin theme; one owning module each (`platform`, `admin-users`). |
| **PR-2** | PE-4 + PE-5 (scrap write-off maker-checker; match-tolerance approver gate) | Financial SoD; self-contained in `mfg-depth` / `match`. |
| **PR-3** | PE-3 (leave-balance own-scope) | Within-tenant PII; self-contained in `hcm-leave`. |
| **PR-4** | PE-6 (platform MFA step-up) | Auth-control parity; self-contained in `platform`. |
| **PR-5** | PE-7 + PE-8 (`hqTenant` pattern on the tenant_id-body controllers; portal DELETE predicate) | Tenant-boundary defense-in-depth. |
| **PR-6** | PE-9 + PE-10 + PE-11 (portal/loyalty scope; waste duty; costing duty) | Scope-breadth tightening. |

Each PR carries its own doc-sync (§3 blocks) and keeps the regression suite green
(`compliance`/`basics`/`onboarding`/`gaps`/`golden` + builds/typecheck + the `check-*` ratchets). Fix direction
is **fail-closed** — tighten the control; never add an opt-out that defaults open, and never loosen a harness
assertion to pass.

---

## Revision history

| Rev | Date | Author | Change |
|-----|------|--------|--------|
| 1.0 | 2026-07-17 | Security review workstream | Initial vertical + horizontal privilege-escalation audit. 11 findings (2 High / 4 Medium / 5 Low), each re-verified against `main`. PE-1/PE-2 identified as the still-open residual of the 2026-07-16 pentest theme (`users` = unbounded grant authority) on the API-key-scope and single-duty-override paths it did not examine. No application code changed by this audit. |
