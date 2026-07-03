# Ops — Multi-tenancy model & TENANCY_MODE (ITGC-AC-18)

> **Status:** v1.3 · **Date:** 2026-07-03 · **Owner:** Platform / Security
> How tenant data is isolated, what `TENANCY_MODE` does, and how to choose it for your deployment.

## 1. The two isolation layers

Every tenant-scoped table has a Postgres **row-level-security (RLS)** policy keyed on `tenant_id`, forced
on with `FORCE ROW LEVEL SECURITY` (so even the table owner is subject to it). Each request runs under
`SET ROLE app_user` with three transaction-local GUCs set by `common/tenant-tx.interceptor.ts`:
`app.tenant_id`, `app.org_id`, `app.bypass_rls`. The policy is:

```
bypass_rls='on'  OR  tenant_id = app.tenant_id  OR  (app.org_id set AND tenant_id IN <tenants sharing app.org_id>)
```

- **Non-Admin staff** (Sales/Warehouse/Customer/…) are always scoped to their own `tenant_id`. Unchanged by
  `TENANCY_MODE`.
- **Admin** scope is what `TENANCY_MODE` selects.
- **Pre-auth** (login/signup) gets a temporary bypass to read `users` / create the tenant.

## 2. `TENANCY_MODE`

| Mode | Admin sees | Use when |
|---|---|---|
| **`single-company`** (default) | **ALL tenants** (global `bypass_rls='on'`) | ONE company; other tenants are your own branches/outlets you want HQ to see. |
| **`multi-company`** | Only tenants sharing the Admin's **`org_id`**; `org_id=NULL` ⇒ **own tenant only** (fail-closed) | Outsiders can **self-signup** (each signup = an independent company that must NOT see others). |

> ⚠️ **Self-service signup mints a tenant + an `Admin`.** `POST /api/auth/signup`
> (`modules/billing/billing.service.ts`) creates a **new tenant + an `Admin` user** for every signup. Under
> the **default** `single-company` mode that new Admin gets the **global bypass** and can read **every**
> other company's data — so any deployment reachable by outsiders MUST run `TENANCY_MODE=multi-company`.
>
> Two hardenings are now built in (ITGC-AC-18):
> - **Signup is fail-closed in production** — `POST /api/auth/signup` returns `403 SIGNUP_DISABLED` unless
>   the operator sets **`PUBLIC_SIGNUP_ENABLED`** truthy. Dev + harnesses (`NODE_ENV=test`) are unaffected.
> - **Preferred onboarding = the platform-admin endpoint.** A configured platform owner
>   (`PLATFORM_ADMIN_USERNAMES`, comma list of usernames) provisions a new company from an authenticated
>   session via **`POST /api/admin/tenants`** (`@PlatformAdmin`) — same provisioning as signup (tenant + own
>   org + Admin + trial + fiscal year + industry CoA), audit-logged, **no env toggling and no public
>   exposure window**. Non-platform callers get `403 PLATFORM_ADMIN_REQUIRED`; empty config ⇒ nobody can (secure
>   default). `PlatformAdminGuard` grants the one-shot RLS bypass needed to write a brand-new tenant. Use
>   `PUBLIC_SIGNUP_ENABLED` only if you actually want open self-service signup.
> - **Invite-link onboarding (self-service, gated).** When you want the new company to fill in their own
>   details, a platform owner issues a **single-use, expiring invite** via **`POST /api/admin/signup-invites`**
>   (`@PlatformAdmin`; returns the raw token once + expiry — list/status at `GET /api/admin/signup-invites`).
>   The invitee signs up with it (`POST /api/auth/signup` including `invite_token`), which is accepted **even
>   when public signup is disabled**. Invalid/used/expired → `400 INVALID_INVITE`; consumed (single-use) on
>   success. Only the token **hash** is stored (`signup_invites`, migration 0233 — platform-level, no
>   tenant_id/RLS).
> - **Each new company gets its OWN org** — signup sets `org_id = the new tenant's id` on both the tenant
>   and its Admin, so under `multi-company` the new Admin is isolated to just that company by default (and
>   never needs the org_id backfill the boot warning mentions).

### Set it
Set `TENANCY_MODE=multi-company` on **every API service that connects to the same database** (e.g. both
`invisibleERP` and `invisiblePOSERP` on Railway) — a service left on the default keeps the isolation hole
open through that instance. Env-var change ⇒ redeploy. Verify in the boot log: `EnvValidation` warns
`TENANCY_MODE=multi-company — Admin RLS bypass is org-scoped …`.

## 3. `org_id` — grouping tenants (only needed for cross-account SHARING)

`org_id` is a plain grouping number on `tenants` and `users` (no separate `orgs` table). It matters **only**
when one company legitimately owns **multiple separate tenant-accounts** that should see each other:

- **Branches inside one company are intra-tenant** (`branches.tenant_id`) — they already share via a single
  `tenant_id`. **No `org_id` needed**; the company is one tenant and multi-company mode isolates it from
  others automatically.
- To let several **separate** tenant-accounts share, backfill the **same `org_id`** on those `tenants` rows
  **and** their Admin `users` rows. A signup does not set `org_id` (stays NULL ⇒ self-only), so no existing
  single-account tenant loses visibility when you switch modes.

## 4. Choosing & rolling out

1. **SaaS / outsiders can sign up** → `TENANCY_MODE=multi-company`. No backfill if each company is one
   account (the common case). Done.
2. **Only your own company (many branches)** → either mode is safe (branches are intra-tenant); prefer
   **not exposing public signup**, or `multi-company` for defence-in-depth.
3. **Mixed** (a main account with several sibling accounts that must share, isolated from customers) →
   `multi-company` **and** backfill a shared `org_id` on the sibling `tenants` + their Admin `users`.

## 5. Test of effectiveness (ToE)
- **`cutover/pg-smoke.ts`** (real Postgres, CI): raw-RLS org-scoping — an org-A Admin sees only org-A
  tenants; FORCE-RLS under `app_user`.
- **`cutover/pg-core.ts`** (both backends): **full HTTP stack** — login → guard reads live `org_id` →
  interceptor → RLS → `GET /api/jobs`. Asserts a fresh-signup Admin (`org_id=NULL`) sees only its own
  tenant, a single-tenant company Admin sees only itself, an org-scoped Admin is **isolated from other
  companies**, and the single-company contrast (same Admin sees ALL). It also **hard-asserts cross-account
  org sharing** — an org-scoped Admin sees BOTH of its org's tenants' data rows (`org1===2`; see §6).

## 6. Cross-account org SHARING — works (resolved AC-18 follow-up)
`org_id` **isolation** (an Admin never sees a *different* org/company) **and** `org_id` **sharing** — an
org-scoped Admin seeing a **sibling tenant's DATA** (rows in tenant-scoped tables like `background_jobs`,
`journal_entries`, …) when several separate accounts share one `org_id` — both hold, on real Postgres **and**
PGlite. `pg-core` asserts an org-scoped Admin sees exactly its own org's tenants (`org1===2`) and none of the
other companies (no leak).

History (the AC-18 follow-up, now closed): `0196` installed the per-table `org_id` clause on every
`tenant_id` table via a `DO $$ … EXECUTE format() … $$` loop, but `0218_tenant_indexes_backfill` later
re-ran the generic RLS loop and recreated `tenant_isolation` with the **PLAIN** body — silently dropping the
org clause on every DATA table (sharing broke; isolation held — fail-closed, no leak). The `tenants`
self-policy survived (0196 set it via **direct** DDL; `tenants` has no `tenant_id` column so neither loop
touches it), which is why tenants-level org isolation stayed green (`pg-smoke`) while data-table sharing
broke. `0232_reapply_org_rls` re-applies the org-clause policy to every `tenant_id` table (runs after 0218 →
wins). **NB:** PGlite *does* execute the dynamic `DO`-loop (verified on 0.2.17) — the earlier "PGlite doesn't
apply the loop" note was mistaken; the sole cause was 0218's clobber. **Forward rule:** any new tenant
table's RLS loop, or any migration that re-creates `tenant_isolation`, must copy **0232**'s org-clause form.

## 7. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-07-03 | Platform / Security | Initial tenancy-model doc: TENANCY_MODE modes, signup exposure, org_id grouping, rollout guidance, ToE (pg-smoke + new pg-core HTTP-stack checks), and the PGlite per-table-org-clause fidelity note. |
| 1.1 | 2026-07-03 | Platform / Security | Signup hardening (ITGC-AC-18): public `POST /api/auth/signup` is now **fail-closed in production** (`PUBLIC_SIGNUP_ENABLED`, `403 SIGNUP_DISABLED` when off; dev/harnesses unaffected), and each signup gives the new company its **own org** (`org_id = tenant id` on the tenant + Admin) so it is isolated by default under multi-company. ToE: `apps/api/test/signup-gate.test.ts` (gate matrix) + `cutover/onboarding.ts` (org_id assertion). |
| 1.2 | 2026-07-03 | Platform / Security | Controlled onboarding (ITGC-AC-18, onboarding-flow #1): new **`POST /api/admin/tenants`** (`@PlatformAdmin`) lets a configured platform owner (`PLATFORM_ADMIN_USERNAMES`) provision a company from an authenticated session — the alternative to toggling public signup. `PlatformAdminGuard` authorises + grants a server-set one-shot RLS bypass (honoured by the tenant-tx interceptor); non-owners get `403 PLATFORM_ADMIN_REQUIRED`; empty list ⇒ nobody (secure default); audit-logged. ToE: `apps/api/test/platform-admin.test.ts` + `cutover/onboarding.ts` (403 gate + 201 provision + org-isolation). |
| 1.3 | 2026-07-03 | Platform / Security | **Cross-account org SHARING fixed** (closes the §6 tracked limitation). Root cause: `0218_tenant_indexes_backfill`'s generic RLS re-loop recreated `tenant_isolation` with the plain body, silently dropping 0196's org clause on data tables. Fix: `0232_reapply_org_rls` re-applies the org-clause policy to every `tenant_id` table. `pg-core` now hard-asserts `org1===2` (org sharing active + isolated) on both backends. Corrected the mistaken "PGlite doesn't run the DO-loop" note — it does. |
| 1.4 | 2026-07-03 | Platform / Security | **Invite-link onboarding** (ITGC-AC-18, onboarding-flow #2): platform owners issue single-use, expiring invites (`POST`/`GET /api/admin/signup-invites`, `@PlatformAdmin`); the invitee signs up with `invite_token` even when public signup is disabled (`400 INVALID_INVITE` if invalid/used/expired; single-use). Platform-level `signup_invites` table (migration 0233, hash-only, no tenant_id/RLS). ToE: `cutover/onboarding.ts` (issue-auth 403, bogus/valid/reuse, used-list). |
