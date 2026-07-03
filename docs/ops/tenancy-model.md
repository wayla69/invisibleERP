# Ops — Multi-tenancy model & TENANCY_MODE (ITGC-AC-18)

> **Status:** v1.0 · **Date:** 2026-07-03 · **Owner:** Platform / Security
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

> ⚠️ **Self-service signup is public.** `POST /api/auth/signup` creates a **new tenant + an `Admin` user**
> (`org_id=NULL`) for every signup (`modules/billing/billing.service.ts`). Under the **default**
> `single-company` mode that new Admin gets the **global bypass** and can read **every** other company's
> data. **Any deployment that lets outsiders sign up MUST run `TENANCY_MODE=multi-company`.**

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
  companies**, and the single-company contrast (same Admin sees ALL). It also logs whether cross-account
  org **sharing** is active — see §7 (currently fail-closed).

## 6. Known limitation — cross-account org SHARING is fail-closed (not a security risk)
`org_id` **isolation** (an Admin never sees a *different* org/company) holds on both backends. But `org_id`
**sharing** — an org-scoped Admin seeing a **sibling tenant's DATA** (rows in tenant-scoped tables like
`background_jobs`, `journal_entries`, …) when several separate accounts share one `org_id` — is **currently
NOT effective on data tables**, on real Postgres **and** PGlite (verified: `pg-core` sees an org-scoped Admin
reading only its **own** tenant's rows, `org1=1`). The mode therefore **fails CLOSED**: an org Admin
over-isolates to its own tenant rather than leaking. This is **safe** (no cross-account data exposure), and
most deployments are **one-tenant-per-company** (branches are intra-tenant, §3) so they never need sharing.

Mechanism: `0196` installs the per-table `org_id` clause via a `DO $$ … EXECUTE format() … $$` loop over
every `tenant_id` table; its **direct** DDL (e.g. the `tenants` self-policy) takes effect — so org isolation
at the `tenants` level works and `pg-smoke` is green — but the per-**data-table** org clause does not resolve
as intended (PGlite additionally does not apply the dynamic loop at all). **Tracked AC-18 follow-up** to
root-cause + enable cross-account sharing; until then, model each company as its own org (isolation), not a
shared org.

## 7. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-07-03 | Platform / Security | Initial tenancy-model doc: TENANCY_MODE modes, signup exposure, org_id grouping, rollout guidance, ToE (pg-smoke + new pg-core HTTP-stack checks), and the PGlite per-table-org-clause fidelity note. |
