# Ops — Multi-tenancy model & TENANCY_MODE (ITGC-AC-18)

> **Status:** v1.18 · **Date:** 2026-07-05 · **Owner:** Platform / Security
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
- **Admin** scope is what `TENANCY_MODE` selects (global in `single-company`; org-scoped in `multi-company`).
- **Platform owner = "god"** (a username in `PLATFORM_ADMIN_USERNAMES`) gets a **global `bypass_rls='on'` on
  every route**, regardless of `TENANCY_MODE` — the cross-org super-user. See §2bis.
- **Pre-auth** (login/signup) gets a temporary bypass to read `users` / create the tenant.

### 1bis. The base connection role MUST NOT bypass RLS (security review H-3)

RLS is enforced **only inside** the per-request `app_user` transaction. Handlers marked **`@NoTx`**, **`@Sse`**
streams, direct **`PG_CLIENT`** (raw) queries, and **background jobs** run on the **base connection** — the role
in `DATABASE_URL` — *without* that transaction. If the base role is a **superuser** or has **`BYPASSRLS`** (the
default on many managed Postgres providers), RLS is **not enforced** on those paths and they rely entirely on
hand-written `tenant_id` filters; a single omission is a cross-tenant leak.

**Fix — run the API as a dedicated non-superuser, non-`BYPASSRLS` owner role** so `FORCE` RLS fail-closes those
paths too (with `app.tenant_id` unset, `tenant_id = NULL` returns zero rows). Provision once:

```sql
-- A login role the API connects as; owns the schema objects but is NOT superuser and does NOT bypass RLS.
CREATE ROLE ierp_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO ierp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ierp_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ierp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ierp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ierp_app;
GRANT ierp_app TO app_user;   -- so `SET ROLE app_user` inside the request tx still works
```
Then point `DATABASE_URL` at `ierp_app`. Keep the intentionally-unscoped auth-global tables (`login_attempts`,
scheduler heartbeats, etc.) as reviewed exceptions.

**Boot check.** In production the API now **probes the base role and refuses to boot** if it is superuser / has
`BYPASSRLS` (`common/tenancy-boot-check.ts` → `assertRlsBackstop`). Set **`ALLOW_RLS_BYPASS_BASE_ROLE=1`** to boot
with a loud warning instead while you migrate the role (NOT recommended in prod). Best-effort: a probe failure
(DB not ready) never blocks boot; dev/test are a no-op.

## 2. `TENANCY_MODE`

| Mode | Admin sees | Use when |
|---|---|---|
| **`single-company`** (default) | **ALL tenants** (global `bypass_rls='on'`) | ONE company; other tenants are your own branches/outlets you want HQ to see. |
| **`multi-company`** | Only tenants sharing the Admin's **`org_id`**; `org_id=NULL` ⇒ **own tenant only** (fail-closed) | You onboard **multiple independent companies** (each provisioned by god — see below — must NOT see the others). |

> ⚠️ **Provisioning a company mints a tenant + an `Admin`.** `BillingService`
> (`modules/billing/billing.service.ts`) creates a **new tenant + an `Admin` user** for every provision.
> Under the **default** `single-company` mode that new Admin gets the **global bypass** and can read **every**
> other company's data — so any multi-tenant deployment MUST run `TENANCY_MODE=multi-company`. **Public
> self-service provisioning is off in production** (below), so in prod only a platform owner mints tenants.
>
> Hardenings built in (ITGC-AC-18):
> - **Public signup is disabled UNCONDITIONALLY in production** — `BillingService.isSignupAllowed()` returns
>   true only outside production, so `POST /api/auth/signup` provisions nothing in prod. The legacy
>   **`PUBLIC_SIGNUP_ENABLED`** env flag is now a **NO-OP** for provisioning (it no longer re-opens signup;
>   `env.validation.ts` warns it has no effect) — the only in-prod company-creation paths are the three
>   god-authorised flows below. Dev + harnesses (`NODE_ENV=test`) still allow self-serve signup for
>   convenience. The public web signup page was converted from an instant create-company+login flow into a
>   **request-access form** (`POST /api/auth/signup-requests`, see the approval-queue bullet) that files a
>   pending request and creates no tenant.
> - **Granting the `Admin` role is god-only too (ITGC-AC-02).** Because the `Admin` role is what carries the
>   RLS bypass / cross-tenant visibility (this whole doc), minting an Admin is a platform-level privileged
>   grant: `assertCanGrantRole` (`modules/admin-users/admin-users.service.ts`) permits the `Admin` role to be
>   granted **only by a platform owner** — a non-god who creates OR PATCHes a user to `Admin` gets
>   **`403 ADMIN_GRANT_DENIED`**; a company Admin still manages every non-Admin role, and the web role
>   dropdowns hide the Admin option for non-god. Keeping company creation god-only (above) keeps the *first*
>   Admin on the god path; this rule keeps every *subsequent* Admin there too. ToE `cutover/onboarding.ts`.
> - **Preferred onboarding = the platform-admin endpoint.** A configured platform owner
>   (`PLATFORM_ADMIN_USERNAMES`, comma list of usernames) provisions a new company from an authenticated
>   session via **`POST /api/admin/tenants`** (`@PlatformAdmin`) — same provisioning as signup (tenant + own
>   org + Admin + trial + fiscal year + industry CoA), audit-logged, **no env toggling and no public
>   exposure window**. Non-platform callers get `403 PLATFORM_ADMIN_REQUIRED`; empty config ⇒ nobody can (secure
>   default). `PlatformAdminGuard` grants the one-shot RLS bypass needed to write a brand-new tenant. **This (or an
>   invite / the request-access queue) is the ONLY way to open a company in production** — public signup is
>   off and `PUBLIC_SIGNUP_ENABLED` is a no-op.
> - **Invite-link onboarding (self-service, gated).** When you want the new company to fill in their own
>   details, a platform owner issues a **single-use, expiring invite** via **`POST /api/admin/signup-invites`**
>   (`@PlatformAdmin`; returns the raw token once + expiry — list/status at `GET /api/admin/signup-invites`).
>   The invitee signs up with it (`POST /api/auth/signup` including `invite_token`), which is accepted **even
>   when public signup is disabled**. Invalid/used/expired → `400 INVALID_INVITE`; consumed (single-use) on
>   success. Only the token **hash** is stored (`signup_invites`, migration 0233 — platform-level, no
>   tenant_id/RLS).
> - **Approval-queue onboarding.** A public "request access" form (**`POST /api/auth/signup-requests`**)
>   creates a **pending request** — it does **not** provision a tenant. A platform owner reviews the queue
>   (**`GET /api/admin/signup-requests`**) and **approves** (`…/:id/approve` → provisions the company with the
>   requester's chosen password, stored hashed) or **rejects** (`…/:id/reject`). Good for inbound leads
>   without auto-creating tenants. Duplicate pending → `409 REQUEST_PENDING`; already-handled → `409
>   REQUEST_NOT_PENDING`. Table `signup_requests` (migration 0234, platform-level; the resolved tenant is
>   `created_tenant_id`, not `tenant_id`, so it stays out of RLS).
> - **Company lifecycle — suspend / reactivate.** A platform owner can **suspend** a company
>   (**`POST /api/admin/tenants/:id/suspend`**, optional `reason`) — its users are then blocked at the auth
>   guard with **`403 TENANT_SUSPENDED`** — and **reactivate** it (**`…/:id/reactivate`**). Platform owners
>   are **exempt** from the block (so they can never lock themselves out and can always reactivate). Both
>   actions are audit-logged. Column `tenants.suspended_at` (migration 0235).
> - **Each new company gets its OWN org** — signup sets `org_id = the new tenant's id` on both the tenant
>   and its Admin, so under `multi-company` the new Admin is isolated to just that company by default (and
>   never needs the org_id backfill the boot warning mentions).

### Set it
Set `TENANCY_MODE=multi-company` on **every API service that connects to the same database** (e.g. both
`invisibleERP` and `invisiblePOSERP` on Railway) — a service left on the default keeps the isolation hole
open through that instance. Env-var change ⇒ redeploy. Reference config: `.env.example` (the tenancy/onboarding
block), `docker-compose.yml` (the local prod-like `api` service), and `docs/ops/railway-setup.md` §2.2.

Verify in the boot log (`EnvValidation`, prod only):
- `TENANCY_MODE=multi-company — Admin RLS bypass is org-scoped …` confirms the mode took.
- `PLATFORM_ADMIN_USERNAMES configures N platform owner(s) with a cross-tenant "god" bypass (…)` lists the
  break-glass accounts so they are a visible, conscious choice.
- `PUBLIC_SIGNUP_ENABLED … has no effect` — the flag is now a **no-op**; public signup is disabled in prod
  regardless, so seeing it set is harmless (remove it to avoid confusion). Company creation is god-only.

## 2bis. Platform owner = "god" (the cross-org super-user)

`multi-company` deliberately **removes the Admin's global bypass** — each per-tenant `Admin` is confined to its
own org (`org_id`). That is the point: a customer's Admin must not see other customers. So there is no longer a
role you can log in as that sees *everything*. When you still need one operator who can see and act across
**all** companies, that operator is the **platform owner**, not a role:

- A username listed in **`PLATFORM_ADMIN_USERNAMES`** (comma-separated, case-insensitive) is granted a
  **global `bypass_rls='on'` on every route** by `common/tenant-tx.interceptor.ts` — not just the
  `@PlatformAdmin` management endpoints. It therefore sees and operates on **every tenant's data** everywhere
  in the app, while ordinary `Admin`s stay org-scoped.
- Give the god user **role `Admin`** so it also holds every functional permission (the `Admin` role maps to
  all permissions); the env membership is what grants the cross-tenant *visibility*, the role is what grants
  the *permissions*.
- **Why an env list and not a DB role:** in `multi-company` a per-tenant Admin manages its own users. If
  "god" were an assignable role, that Admin could set someone's role to god and **escalate to cross-org
  visibility** (fail-open). Gating god on an **ops-controlled env var** the in-app user-management cannot
  touch closes that escalation path. It also means god membership is changed by a deploy/redeploy, and is
  the same knob (`PLATFORM_ADMIN_USERNAMES`) that authorises company provisioning/suspension.
- Every cross-tenant read/write a god makes still runs with `req.__rlsBypass=true`, which the audit
  interceptor records — so god actions are attributable in `audit_log`.

### 2ter. God company-switcher (act-as-one-company)
A god's whole point is the global bypass — so out of the box it sees **every company's rows combined**, with
no cue to which company a given row belongs to. To make that view usable, the web sidebar shows a **company
switcher** (only for a god — gated on `is_platform_owner` from `GET /api/auth/me`) that doubles as a
**current-company badge**:

- The switcher lists all companies (`GET /api/admin/tenants`, `@PlatformAdmin`) with a **search box** and a
  **"เพิ่งดู" (recently viewed)** shortlist (device-local). Picking one stores it client-side and sends
  **`X-Act-As-Tenant: <tenantId>`** on every request; **"ทุกบริษัท (รวม)"** clears it and restores the global
  view.
- `common/tenant-tx.interceptor.ts` honours that header **only for a god** (never a normal Admin/staff) and
  **only on non-provisioning routes** (a `@PlatformAdmin` route keeps its full bypass so the directory itself
  still lists every company). When set, it **drops the god's bypass** and pins `app.tenant_id` to the chosen
  tenant, so RLS returns exactly that one company's rows — the same visibility that company's own Admin has.
  It also repoints the request's `user.tenantId` so writes (and the incidental writes some GETs do) act as
  that company too.
- **It only ever REDUCES a god's visibility** (a god already sees everything), so trusting a client header
  here is not a privilege-escalation path — a non-god sending it is ignored (`pg-core` asserts this). God
  actions while acting-as are still attributable: the audit interceptor records `god_act_as_tenant` on the
  mutation's `audit_log` meta.
- **Read-only act-as (safe inspection).** Adding **`X-Act-As-Read-Only: 1`** alongside the act-as header makes
  the interceptor **reject any mutating request** (POST/PUT/PATCH/DELETE → `403 READONLY_IMPERSONATION`) while
  GETs still work — a god can enter a company to look/support with zero risk of writing. The web scope banner
  exposes a **อ่านอย่างเดียว ⇄ เปิดให้แก้ไข** toggle. ToE: `pg-core` asserts a read-only god GET returns the
  scoped rows while a POST is blocked 403.

### 2quater. Platform Console (`/platform`)
A god runs the whole fleet, so the platform-owner operations that were previously **API-only**
(`@PlatformAdmin`) now have a single web home — **`/platform`**, a nav entry surfaced **only** when
`is_platform_owner` is true (injected after the permission filter, so a per-tenant Admin never sees it).
It gathers:

- **Companies** — every tenant from `GET /api/admin/tenants` (enriched: subscription status, plan,
  user-count, trial end, created date, `setup_complete`, `tags`). Row actions: **เข้าดู** (sets the act-as
  scope via the switcher then jumps to `/dashboard`), **ระงับ/คืนสถานะ** (`POST /api/admin/tenants/:id/suspend|reactivate`),
  and header **เปิดบริษัทใหม่** (`POST /api/admin/tenants`). **Bulk actions** — select rows to suspend /
  reactivate / extend-trial / change-plan many companies at once (parallel per-company calls). **Tags/segments**
  — label companies (`POST /api/admin/tenants/:id/tags`; `tenants.tags` jsonb, migration 0246) and filter the
  table by a tag chip.
- **Onboarding** — the pending **request queue** (`GET /api/admin/signup-requests?status=pending` →
  approve/reject) and **invite links** (`POST/GET /api/admin/signup-invites`; the raw token shows once).
- **กิจกรรม (Activity)** — the **cross-company audit feed**: `GET /api/admin/audit` (a god's RLS bypass
  returns every tenant's rows) with a per-**company** filter (new `tenant_id` query param), result filter,
  free-text search, a **hash-chain verify** (`GET /api/admin/audit/verify`, ITGC-AC-16), and **CSV export**
  (`GET /api/admin/audit/export`; the query gained a `tenant_id` filter). Each row shows which company it
  belongs to (`tenant_id` → name), and a **"เฉพาะการข้ามบริษัท (god)"** lens filters to rows a god ran
  cross-tenant (`meta.god_act_as_tenant`/`rls_bypass`) — the impersonation/governance view — the fleet-wide
  *who-did-what*, for oversight and incident response.
- **แจ้งเตือน (Notifications)** — a **durable god event inbox** with per-god read state (`platform_notifications`
  + `platform_notification_reads`, migration 0247). Onboarding/lifecycle events **emit** into it —
  `signup_request` (a new access request), `company_provisioned`, `tenant_suspended`, `tenant_reactivated` —
  from `BillingService` (best-effort; never breaks the triggering action). God-only endpoints
  (`@PlatformAdmin`): `GET /api/admin/notifications` (inbox, unread-first), `…/unread-count`,
  `POST …/:id/read`, `POST …/mark-all-read`; the tab label shows the unread count. This complements the live
  *needs-attention* counts on Overview: notifications are the **point-in-time log** (a since-handled request
  still shows in history), needs-attention is the **current state**.
- **ภาพรวม (Overview)** — cross-company SaaS KPIs from `GET /api/billing/saas-metrics` (MRR/ARR/ARPU,
  paying/trialing counts, DAU/MAU + stickiness, 30-day churn, plan mix) plus a **needs-attention** panel
  derived from the company list + request queue (pending requests, trials ending within 7 days, past-due,
  suspended, **setup-incomplete** — `GET /api/admin/tenants` now returns `setup_complete`) — the
  *what-needs-me-now* summary for the fleet. Plus a **system-health** strip (DB pool / queue backlog /
  dead-letters / cache from `GET /api/ops/metrics` + `GET /api/jobs/ops-metrics`) and a **cross-company AI
  spend** table (top token spenders + overage from `GET /api/admin/ai-usage`).
- **Company detail drawer** — clicking a company name opens a slide-over with its full picture
  (`GET /api/admin/tenants/:id`: profile, subscription, user/branch counts, cumulative AI usage, recent
  audit activity) plus **platform subscription controls that need no impersonation** —
  **`POST /api/admin/tenants/:id/plan`** (change plan) and **`POST /api/admin/tenants/:id/extend-trial`**
  (push the trial out N days, back to Trialing) — and **act-as jump** shortcuts: **เข้าดูบริษัทนี้** (into its
  dashboard) and **จัดการผู้ใช้** (into its `/admin/users` — reset password / revoke sessions / deactivate,
  reusing the standard user-admin screen scoped to that company; no separate cross-tenant user API needed).

The console **auto-refreshes** (companies 60s, request queue 45s) so new signup requests and status changes
surface without a manual reload, and a **toast fires when a new pending request arrives** — near-real-time
alerting appropriate for platform events (a true SSE push channel is a possible future enhancement).

The page is a server shell (`page.tsx`, prefetches via `serverApi`) + a client island; access is enforced by
the API (`@PlatformAdmin`/`exec` → 403 for non-owners), the nav gate is only chrome. ToE: `cutover/onboarding.ts`
(`GET /api/admin/tenants` lists all companies enriched; blocked for a non-owner).

**Scope banner (safety).** Because the combined god view silently sums every company, a persistent banner
under the header (god only) states the current scope: in the combined view it warns figures span **all**
companies; while acting-as it names the company and offers one-click return to the combined view — so a
dashboard number is never misread as one company's.

**Provision one (two steps — account, then bypass):**
1. Create the account: `GOD_PASSWORD='<temp>' pnpm --filter @ierp/api db:create-god` (`GOD_USERNAME` defaults
   to `godmimi`; in production add `ALLOW_PROD_GOD=1`). It inserts a role=`Admin` user with
   `must_change_password=true` in the HQ tenant — the temp password is rotated on first login and is never the
   standing credential. Idempotent: an existing username is left untouched unless `GOD_RESET_PASSWORD=1`.
2. Grant the bypass: add that username to `PLATFORM_ADMIN_USERNAMES` on every API service, then redeploy.

The account alone is just an ordinary Admin; **step 2 is what makes it god.** (You can also skip step 1 and
point `PLATFORM_ADMIN_USERNAMES` at an existing user — e.g. the seeded `admin` — no new account needed.)

> **Operational note:** treat god credentials like a break-glass account — few named humans, strong auth
> (MFA on that `Admin`), and remove the username from `PLATFORM_ADMIN_USERNAMES` when the person no longer
> needs cross-org access. ToE: `cutover/pg-core.ts` asserts a god (`PLATFORM_ADMIN_USERNAMES` member) sees
> ALL companies across every org while a same-org non-god Admin sees only its org.

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
| 1.20 | 2026-07-08 | Security review | **Fail-closed data-isolation boot checks (H-3 / H-4).** (H-4) The tenancy-mode check now **refuses to boot by default** in prod on the dangerous state (single-company + >1 company), instead of warn-only; opt out with `ALLOW_SINGLE_COMPANY_MULTI_TENANT=1`. The old `STRICT_TENANCY_BOOT` flag is removed (its fail-closed behaviour is now the default). (H-3) New `assertRlsBackstop` (§1bis): in prod the API **probes the base DB role and refuses to boot** if it is superuser / has `BYPASSRLS`, since RLS is not enforced on the base connection (`@NoTx`/SSE/raw/job paths); opt out with `ALLOW_RLS_BYPASS_BASE_ROLE=1`, fix by connecting as a non-superuser owner role (§1bis provisioning SQL). Both are prod-only, best-effort (a read/probe failure never blocks boot). Unit tests: `apps/api/test/tenancy-boot-check.test.ts` (14 checks). |
| 1.19 | 2026-07-07 | Platform / Security | **Data-isolation boot check (4.2).** New `common/tenancy-boot-check.ts` runs at bootstrap (prod-only, best-effort): counts tenants and, when `TENANCY_MODE=single-company` but **>1 company** exists on the DB (where every tenant Admin has a global RLS bypass), logs a **loud error** by default and **refuses to boot** when `STRICT_TENANCY_BOOT=1`. A DB-read failure never blocks boot. env.validation already warns on config; this catches the actually-dangerous *state*. ToE: `cutover/tenancy-boot.ts` (12 checks — decision matrix + prod/dev/strict/best-effort). |
| 1.0 | 2026-07-03 | Platform / Security | Initial tenancy-model doc: TENANCY_MODE modes, signup exposure, org_id grouping, rollout guidance, ToE (pg-smoke + new pg-core HTTP-stack checks), and the PGlite per-table-org-clause fidelity note. |
| 1.1 | 2026-07-03 | Platform / Security | Signup hardening (ITGC-AC-18): public `POST /api/auth/signup` is now **fail-closed in production** (`PUBLIC_SIGNUP_ENABLED`, `403 SIGNUP_DISABLED` when off; dev/harnesses unaffected), and each signup gives the new company its **own org** (`org_id = tenant id` on the tenant + Admin) so it is isolated by default under multi-company. ToE: `apps/api/test/signup-gate.test.ts` (gate matrix) + `cutover/onboarding.ts` (org_id assertion). |
| 1.2 | 2026-07-03 | Platform / Security | Controlled onboarding (ITGC-AC-18, onboarding-flow #1): new **`POST /api/admin/tenants`** (`@PlatformAdmin`) lets a configured platform owner (`PLATFORM_ADMIN_USERNAMES`) provision a company from an authenticated session — the alternative to toggling public signup. `PlatformAdminGuard` authorises + grants a server-set one-shot RLS bypass (honoured by the tenant-tx interceptor); non-owners get `403 PLATFORM_ADMIN_REQUIRED`; empty list ⇒ nobody (secure default); audit-logged. ToE: `apps/api/test/platform-admin.test.ts` + `cutover/onboarding.ts` (403 gate + 201 provision + org-isolation). |
| 1.3 | 2026-07-03 | Platform / Security | **Cross-account org SHARING fixed** (closes the §6 tracked limitation). Root cause: `0218_tenant_indexes_backfill`'s generic RLS re-loop recreated `tenant_isolation` with the plain body, silently dropping 0196's org clause on data tables. Fix: `0232_reapply_org_rls` re-applies the org-clause policy to every `tenant_id` table. `pg-core` now hard-asserts `org1===2` (org sharing active + isolated) on both backends. Corrected the mistaken "PGlite doesn't run the DO-loop" note — it does. |
| 1.4 | 2026-07-03 | Platform / Security | **Invite-link onboarding** (ITGC-AC-18, onboarding-flow #2): platform owners issue single-use, expiring invites (`POST`/`GET /api/admin/signup-invites`, `@PlatformAdmin`); the invitee signs up with `invite_token` even when public signup is disabled (`400 INVALID_INVITE` if invalid/used/expired; single-use). Platform-level `signup_invites` table (migration 0233, hash-only, no tenant_id/RLS). ToE: `cutover/onboarding.ts` (issue-auth 403, bogus/valid/reuse, used-list). |
| 1.5 | 2026-07-03 | Platform / Security | **Approval-queue onboarding** (ITGC-AC-18, onboarding-flow #3): public `POST /api/auth/signup-requests` creates a PENDING request (no tenant); a platform owner reviews (`GET /api/admin/signup-requests`) and approves (`…/:id/approve` → provisions with the requester's hashed password) or rejects (`…/:id/reject`). Dup pending → 409 REQUEST_PENDING; handled → 409 REQUEST_NOT_PENDING. Table `signup_requests` (migration 0234, platform-level; `created_tenant_id` not `tenant_id`). ToE: `cutover/onboarding.ts` (request→pending→approve→login, dup, reject, non-owner 403, re-approve 409). |
| 1.7 | 2026-07-04 | Platform / Security | **Platform owner = "god" (cross-org super-user).** `common/tenant-tx.interceptor.ts` now grants a **global RLS bypass on EVERY route** to any `PLATFORM_ADMIN_USERNAMES` member (previously only on `@PlatformAdmin` management endpoints), so an ops-designated owner sees/operates across ALL tenants while a per-tenant Admin stays org-scoped under `multi-company`. Gated by env (not an assignable DB role) to prevent in-app privilege escalation; god actions still flagged to the audit interceptor. New §1 bullet + §2bis. ToE: `cutover/pg-core.ts` (god sees all 4 companies; same-org non-god Admin sees only its org — `god===4`, `org1===2`). Deploy config: documented the tenancy/onboarding vars (`TENANCY_MODE`/`PLATFORM_ADMIN_USERNAMES`/`PUBLIC_SIGNUP_ENABLED`) in `.env.example`, `docker-compose.yml`, and `railway-setup.md` §2.2; `env.validation.ts` now emits boot warnings listing configured god accounts and flagging the `PUBLIC_SIGNUP_ENABLED`-on-without-`multi-company` footgun. Added a `db:create-god` bootstrap script (`apps/api/src/database/create-god-user.ts`) to provision a god candidate account (default username `godmimi`, role Admin, must-change-password; prod-gated by `ALLOW_PROD_GOD=1`) — §2bis "Provision one". |
| 1.18 | 2026-07-05 | Platform / Security | **Company creation god-only in prod + Admin-grant god-only (ITGC-AC-18 / ITGC-AC-02).** Public self-service signup is now **disabled unconditionally in production** — `BillingService.isSignupAllowed()` is prod-false and the legacy **`PUBLIC_SIGNUP_ENABLED`** flag is a **NO-OP** for provisioning (the boot warning now says it has no effect); the public web signup page became a **request-access form** (`POST /api/auth/signup-requests`, no tenant created). Only a `PLATFORM_ADMIN_USERNAMES` (god) provisions — direct `POST /api/admin/tenants`, invite, or approve-queue. Separately, **granting the `Admin` role is now god-only** (`assertCanGrantRole` → `isPlatformAdmin`): a non-god who creates/PATCHes a user to `Admin` gets **`403 ADMIN_GRANT_DENIED`** (company Admins manage non-Admin roles; the web hides the Admin option for non-god) — because the Admin role carries the RLS bypass, minting one is a platform-level privileged grant. Updated §2 (table, callout, the two AC-18 bullets, boot-log footgun line). No new RCM control (strengthens AC-18/AC-02). ToE: `apps/api/test/signup-gate.test.ts` + `cutover/onboarding.ts` (non-god denied / god 201). |
| 1.17 | 2026-07-05 | Platform / Security | **Platform notification inbox (god event feed).** New `platform_notifications` + `platform_notification_reads` (migration 0247, platform-level, no RLS); `BillingService` emits `signup_request`/`company_provisioned`/`tenant_suspended`/`tenant_reactivated` (best-effort). God-only `@PlatformAdmin` endpoints `GET /api/admin/notifications` (+`/unread-count`, `POST /:id/read`, `/mark-all-read`) back a **แจ้งเตือน** console tab with per-god read state + unread badge — the durable event log alongside the live needs-attention counts. §2quater extended. ToE: `cutover/onboarding.ts` (signup_request surfaces unread; mark-all clears). |
| 1.16 | 2026-07-04 | Platform / Security | **Read-only act-as (safe inspection).** `X-Act-As-Read-Only: 1` alongside the act-as header makes the interceptor reject mutating requests (403 READONLY_IMPERSONATION) while GETs still work; the web scope banner adds an อ่านอย่างเดียว⇄เปิดให้แก้ไข toggle. §2ter extended. ToE: `pg-core` (read-only GET works, POST blocked 403). |
| 1.15 | 2026-07-04 | Platform / Security | **Platform Console — bulk actions + tags/segments.** Companies table gains **bulk** suspend/reactivate/extend-trial/change-plan over selected rows (parallel per-company calls) and **tags/segments**: `tenants.tags` jsonb (migration 0246), `POST /api/admin/tenants/:id/tags` (`@PlatformAdmin`, deduped/trimmed/capped), tags surfaced on `GET /api/admin/tenants` + the drawer, with a tag-chip filter on the table. §2quater extended. ToE: `cutover/onboarding.ts` (tags set/dedup/reflect). |
| 1.14 | 2026-07-04 | Platform / Security | **Platform Console wave-2 quick wins.** Switcher **search + recently-viewed**; Overview gains a **system-health** strip (`GET /api/ops/metrics` + `GET /api/jobs/ops-metrics`), a **cross-company AI-spend** table (new `GET /api/admin/ai-usage`, `@PlatformAdmin`), and a **setup-incomplete** needs-attention card (`GET /api/admin/tenants` now returns `setup_complete`); the Activity tab gains a **god-only (impersonation) lens** (filters `meta.god_act_as_tenant`/`rls_bypass`). §2ter/§2quater extended. ToE: `cutover/onboarding.ts` (setup_complete field; ai-usage aggregate). |
| 1.13 | 2026-07-04 | Platform / Security | **Platform Console — user-support shortcut + auto-refresh alerts.** The company drawer now has a **จัดการผู้ใช้** act-as shortcut into that company's `/admin/users` (reset password / revoke sessions / deactivate — reuses the standard screen scoped to the company; no new cross-tenant user API). The console auto-refreshes (companies 60s, requests 45s) and toasts when a new pending signup request arrives — near-real-time alerting (SSE push is a possible future step). Web-only. §2quater extended. |
| 1.12 | 2026-07-04 | Platform / Security | **Platform Console — cross-company Activity tab.** Added a fleet-wide audit feed to the console: `GET /api/admin/audit` (a god's RLS bypass returns every tenant's rows) gained a `tenant_id` filter param so a god can scope the combined feed to one company; the tab also does result/text filtering, hash-chain verify (ITGC-AC-16), and CSV export, and labels each row with its company. §2quater extended. ToE: `cutover/onboarding.ts` (tenant_id filter narrows the fleet feed to one company). |
| 1.11 | 2026-07-04 | Platform / Security | **Platform Console — company detail drawer + subscription control.** Click a company → a slide-over with `GET /api/admin/tenants/:id` (profile, subscription, user/branch counts, cumulative AI usage, recent audit activity) and platform-level subscription actions that need no impersonation: `POST /api/admin/tenants/:id/plan` (change plan) + `POST /api/admin/tenants/:id/extend-trial`. §2quater extended. ToE: `cutover/onboarding.ts` (detail shape; extend-trial; change-plan; non-owner 403). |
| 1.10 | 2026-07-04 | Platform / Security | **Platform Console — Overview + scope banner.** Added an **ภาพรวม** tab (cross-company SaaS KPIs from `GET /api/billing/saas-metrics` — MRR/ARR/ARPU, paying/trialing, DAU/MAU, churn, plan mix) with a **needs-attention** panel (pending requests, trials ending ≤7d, past-due, suspended) derived from the company list + queue. Added a god-only **scope banner** under the header: warns the combined view sums all companies, and while acting-as names the company + one-click return. §2quater extended. Web-only (no new API/control). |
| 1.9 | 2026-07-04 | Platform / Security | **Platform Console (`/platform`).** Gave the platform owner a single web home for the previously API-only `@PlatformAdmin` operations — a god-only nav entry (gated on `is_platform_owner`) with a **Companies** table (`GET /api/admin/tenants`, now enriched with subscription status/plan/user-count/trial/created) offering act-as jump + suspend/reactivate + provision, and an **Onboarding** panel (signup-request approve/reject + issue/list invites). Server shell + client island; access enforced by `@PlatformAdmin`. New §2quater. ToE: `cutover/onboarding.ts` (enriched directory lists all companies; non-owner 403). |
| 1.8 | 2026-07-04 | Platform / Security | **God company-switcher (act-as-one-company).** A god otherwise sees every company's rows combined with no cue to which company each belongs to. Added a web sidebar **company switcher + current-company badge** (gated on `is_platform_owner`, new field on `GET /api/auth/me`) backed by a new **`GET /api/admin/tenants`** (`@PlatformAdmin`) directory. Selecting a company sends **`X-Act-As-Tenant`**; `common/tenant-tx.interceptor.ts` honours it **only for a god, only on non-provisioning routes**, dropping the bypass and pinning `app.tenant_id` (+ `user.tenantId`) to that tenant so RLS returns just that company's rows. Only ever narrows a god (a non-god's header is ignored); audit records `god_act_as_tenant`. New §2ter. ToE: `cutover/pg-core.ts` (act-as narrows to 1, re-scopes per selection, non-god ignored). |
| 1.6 | 2026-07-03 | Platform / Security | **Setup checklist + starter (onboarding #4, setup UX):** `GET /api/tenant/onboarding-status` (steps + percent + next) and `POST /api/tenant/starter-pack` (idempotent HQ branch). **Company lifecycle (onboarding #5, ITGC-AC-18):** platform owner `POST /api/admin/tenants/:id/suspend`/`reactivate` — a suspended company's users are blocked at the guard (`403 TENANT_SUSPENDED`); platform owners are exempt; audit-logged. Column `tenants.suspended_at` (migration 0235). ToE: `cutover/onboarding.ts` (checklist advance + idempotent starter; suspend→blocked→reactivate→restored, non-owner 403). |
