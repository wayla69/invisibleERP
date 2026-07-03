# 32 — Dedicated single-tenant deployment (silo) — Design & Roadmap

> **Date:** 2026-07-03 · **Status:** v1.0 — DESIGN (not yet built) · **Owner:** Platform / Security
> **Scope:** Stand up a **fully-dedicated deployment ("silo")** of the ERP for a new **government
> customer** — its own web app + API + Postgres database + domain, running the **same codebase** off
> `main` — so its data can **never** mix with the existing customer's, because there is no shared data
> surface at all. This is **Model B** in `docs/ops/multi-tenant-subdomain-runbook.md` §1, which today
> exists only as a one-row comparison; this plan turns it into an operational runbook.
> **Decision recorded:** Isolation tier = **fully-dedicated deployment**; driver = **standard commercial
> onboarding** (no contractual/residency mandate stated). Same codebase, one Postgres DB per silo,
> tenancy left `single-company` with **public signup off** (a single-customer silo has no second tenant
> to isolate from). The heavier-than-necessary ops cost is accepted for the clean isolation optic on a
> government logo.

---

## 0. Read this first — what already exists (do **not** rebuild)

The app is **multi-tenant with Postgres RLS from the ground up**. The building blocks for isolating a new
customer already exist and are DB-enforced — the silo mostly *reuses* them on fresh infrastructure.

| Capability | Where | Status |
|---|---|---|
| Per-`tenant_id` row-level security, `FORCE ROW LEVEL SECURITY` under least-priv `app_user` role | `apps/api/drizzle/0002_rls.sql`; canonical org-clause body `apps/api/drizzle/0232_reapply_org_rls.sql:30` | ✅ |
| Per-request tenant context (tx-local GUCs `app.tenant_id`/`app.org_id`/`app.bypass_rls`), Drizzle proxy that routes every query through the RLS tx | `common/tenant-tx.interceptor.ts`; `common/tenant-context.ts`; `database/database.module.ts:15` | ✅ |
| `TENANCY_MODE` (`single-company` default / `multi-company` org-scoped Admin) | `common/tenant-tx.interceptor.ts:51`; `common/env.validation.ts:57` | ✅ |
| Tenant provisioning core (tenant + own org + Admin + trial + fiscal year + industry CoA), audit-logged | `modules/billing/billing.service.ts` `provisionTenant()` (257) | ✅ |
| Platform-admin provisioning (`POST /api/admin/tenants`, `@PlatformAdmin`), invite-link, approval-queue, suspend/reactivate | `modules/billing/billing.controller.ts`; `docs/ops/tenancy-model.md` §7 | ✅ |
| Per-tenant branding / theme / locale / messaging creds (encrypted) | `tenants` cols + `tenant_*` config tables; `PUT /api/messaging/providers/:channel` | ✅ |
| Fail-closed boot env validation | `common/env.validation.ts` (`DATABASE_URL`, `JWT_SECRET`, `APP_ENC_KEY`, PSP webhook secret) | ✅ |
| Isolation Tests of Effectiveness | `tools/cutover/src/pg-smoke.ts`, `pg-core.ts`, `onboarding.ts` | ✅ |
| Two-service Railway deploy (`invisibleERP` + `invisiblePOSERP`) — **one shared DB** | `.github/workflows/deploy.yml:68`; `apps/{api,web}/railway.json` | ✅ |

**The honest tradeoff (surface to the business before spending on infra).** For *standard commercial
onboarding of one new company*, **Model A** (add a `tenant` row on the existing deployment) would onboard
this customer in minutes with the same DB-enforced isolation — that is literally what the platform was
built for. **Model B (this plan) buys physical separation as insurance/optics, not because RLS is
insufficient.** We proceed with B per the recorded decision, but §4 lists the confirm-before-you-build
questions so nobody spends on a silo the contract didn't require.

**What Model B changes vs A:** isolation moves from *policy-enforced* (RLS) to *physical* (separate
database + separate app processes). RLS stays on as belt-and-suspenders. Because the silo holds exactly
one real customer, `TENANCY_MODE=single-company` is safe and public signup stays **off**.

---

## 1. Target architecture — the silo

```
  ┌─────────────── EXISTING (unchanged) ───────────────┐   ┌──────────── GOV SILO (new) ────────────┐
  │  web (invisibleERP) ─┐                              │   │  web-gov ─┐                            │
  │  web (invisiblePOSERP)├─► api ×2 ─► Postgres (DB-1) │   │           ├─► api-gov ─► Postgres (DB-2)│
  │                       ┘   TENANCY_MODE per policy   │   │  gov domain    single-company, no signup│
  └────────────────────────────────────────────────────┘   └────────────────────────────────────────┘
        original customer's data lives ONLY in DB-1              gov customer's data lives ONLY in DB-2
                         │                                                    │
                         └──────────────── same git `main`, same image ──────┘  (only the code is shared)
```

- **Separate Railway project (recommended) or a dedicated `gov` environment** in the current project — own
  service Variables, own Postgres plugin, own domain. A separate *project* gives the cleanest blast-radius
  and billing boundary; a separate *environment* is lighter but shares the project's access list.
- **Same codebase**: the silo deploys the same `apps/api` + `apps/web` from `main`. No fork. Upgrades flow
  to both by redeploying the same commit.
- **Nothing shared but code**: distinct `DATABASE_URL`, `JWT_SECRET`, `APP_ENC_KEY`, domain, cookies, object
  storage, and provider credentials (see §3). A session or ciphertext from one silo is meaningless in the
  other.

---

## 2. Phased plan (each phase independently completable)

### Phase S1 — Provision infrastructure
- Create the Railway **project/environment** for the gov silo; add a **Postgres** plugin (its own instance
  → its own `DATABASE_URL`).
- Create `api-gov` and `web-gov` services from this repo, mirroring `apps/api/railway.json` /
  `apps/web/railway.json` (builder `RAILPACK`, **not** NIXPACKS — see `docs/ops/deployment.md` §2A). The API
  `preDeployCommand` (`db:migrate && db:sync-catalog`) will run the full migration chain against **DB-2** on
  first deploy — this is how the schema (incl. `0002_rls.sql` RLS bootstrap) lands.
- Run the one-time least-privilege role setup on DB-2 (`tools/ops/sql/prod-db-roles.sql`, run by a DBA — not
  in the migration chain) so `api-gov` connects as `ierp_app`, not a superuser.
- **Domain + TLS:** register the gov domain/subdomain (e.g. `<agency>.erp.example.go.th` or a dedicated
  domain), point web-gov at it, issue TLS (Railway-managed or Let's Encrypt). A single host, not a wildcard —
  this silo has one customer.

### Phase S2 — Config & secrets (the per-silo env matrix)
- Populate the silo's env from §3. **Generate fresh** `JWT_SECRET` and `APP_ENC_KEY` (never reuse DB-1's).
- Set `NEXT_PUBLIC_API_URL` to the **api-gov** origin **before the web build** — it is baked into the bundle
  at build time (`apps/web/Dockerfile:18`; `railway-setup.md` §3). Changing it later requires a web rebuild.
- Set `CORS_ORIGINS` to the web-gov origin and `AUTH_COOKIE_DOMAIN` to the silo's parent domain so login
  sticks across the web/api origins.
- Tenancy posture: `TENANCY_MODE=single-company`, **omit** `PUBLIC_SIGNUP_ENABLED` (prod default = disabled),
  set `PLATFORM_ADMIN_USERNAMES` to the operator who will bootstrap the tenant.
- Decide optional integrations per government policy (§4): Stripe/PSP, `ANTHROPIC_API_KEY` (AI assistant),
  messaging (LINE/SMS/SMTP), object storage. A PSP webhook secret is **boot-blocking** — if no PSP is used,
  set a throwaway `PSP_WEBHOOK_SECRET` to satisfy validation, or gate it (see §4).

### Phase S3 — Deploy pipeline
- Extend delivery so the gov silo ships the **same commit** as production. Two options:
  1. **Add a gated job to `.github/workflows/deploy.yml`** that runs `railway up` against the gov services
     (mirroring the existing `invisibleERP`/`invisiblePOSERP` steps at :68), guarded by a separate
     `RAILWAY_TOKEN_GOV` and the `production` Environment reviewer gate (ITGC-CM-03: deployer ≠ author).
  2. **A parallel `deploy-gov.yml`** if the gov release cadence must differ (e.g. change-freeze windows).
     Recommended if the agency wants to approve each release.
- Post-deploy smoke against the gov hosts (`/healthz`, `/readyz`, `/api/login`) as `deploy.yml` already does.
- **This is the only code change in the whole plan.** If added, journal nothing (no migration) but keep the
  workflow lint/`ops-scripts-check` green.

### Phase S4 — Bootstrap the single government tenant
- With `PLATFORM_ADMIN_USERNAMES` set, an operator provisions the one tenant via `POST /api/admin/tenants`
  (`@PlatformAdmin`) — same core as signup: tenant + Admin + fiscal year + industry CoA. No public signup
  window opens.
- Set the tenant profile/tax identity (`PATCH /api/tenant/profile`), branding/theme (`/theme`), locale, and
  functional currency (THB default).
- Create the HQ branch (`POST /api/tenant/starter-pack`, idempotent) and any additional intra-tenant branches
  (`branches.tenant_id`). Force the Admin password change on first login.
- Verify with `GET /api/tenant/onboarding-status` (steps/percent/next).

### Phase S5 — Verify isolation & readiness
- **Physical isolation proof:** confirm `api-gov`'s `DATABASE_URL` resolves to DB-2 only; there is no
  connection string, replica, or object-store bucket pointing back at DB-1. (Isolation here is structural, so
  the RLS ToE harnesses are a bonus, not the guarantee.)
- Boot fail-closed check: confirm the silo refuses to start if any boot-blocking secret is missing
  (`env.validation.ts`); confirm the boot log shows the chosen `TENANCY_MODE`.
- Run the login + a representative business smoke on the gov host.
- **Backups/PITR on DB-2** from day one (`tools/ops/BACKUP-RUNBOOK.md`) — a silo has its own backup lifecycle.

### Phase S6 — Ops & lifecycle
- Per-silo **backups/PITR, monitoring** (Sentry DSN / OTLP endpoint distinct from DB-1), and an **upgrade
  cadence** (same commit as prod, or a lagged/approved cadence for the agency).
- **Offboarding / exit:** because data is one database, exit = a DB-2 dump handed over + teardown, or a PDPA
  erasure. Document the export format and retention. (Far simpler than extracting one tenant's rows from a
  shared DB — a real advantage of the silo.)
- **Break-glass / cross-silo admin:** no shared platform-admin spans both silos (separate `JWT_SECRET` +
  user tables), which is the desired property. Record who holds `PLATFORM_ADMIN_USERNAMES` on the gov silo.

---

## 3. Secrets/config that MUST be distinct per silo

Full matrix in `docs/ops/secrets.md` §3. The per-silo **must-differ** subset:

| Variable | Why it must be fresh for the silo |
|---|---|
| `DATABASE_URL` | The whole point — DB-2, separate Postgres, own credentials/backups. |
| `JWT_SECRET` | Isolates sessions; a DB-1 token must never validate on the gov silo. Boot-blocking. |
| `APP_ENC_KEY` | AES-256-GCM at-rest key (TOTP/MFA seeds, encrypted messaging creds). Generate fresh; rotating invalidates ciphertext. Boot-blocking. `TABLE_TOKEN_SECRET` inherits it unless set. |
| `PSP_WEBHOOK_SECRET` (or `_<PROVIDER>`) | Boot-blocking. HMAC-verifies PSP callbacks; per-silo even if PSP unused (set a throwaway or gate — §4). |
| `NEXT_PUBLIC_API_URL` | Baked into the web bundle at build time → points web-gov at api-gov. |
| `CORS_ORIGINS` / `AUTH_COOKIE_DOMAIN` (+ `AUTH_COOKIE_SAMESITE`) | New domain pair; cookies scoped to the silo's parent so login sticks. |
| `PLATFORM_ADMIN_USERNAMES` | Who may bootstrap/administer the gov tenant. Empty ⇒ nobody (secure default). |
| `TENANCY_MODE` / `PUBLIC_SIGNUP_ENABLED` | `single-company`; signup off. |
| `OBJECT_STORE_*`, `WEBHOOK_SECRET_*`, LINE/SMS/SMTP, Stripe/OPN, `SEED_ADMIN_PASSWORD` | Per-silo provider creds & buckets; never shared. |
| `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_ENDPOINT` | Separate observability streams so gov telemetry isn't co-mingled. |

---

## 4. Decisions to confirm with the client / business (before S1)

1. **Is a silo actually required, or is Model A enough?** "Standard commercial onboarding" usually doesn't
   mandate dedicated infra. Confirm the agency's isolation clause — Model A is dramatically cheaper if the
   contract permits it. (Proceeding with B per the recorded decision; this is the last off-ramp.)
2. **Data residency / hosting region.** Does the contract require Thailand-region hosting (or a specific gov
   cloud)? That changes the infra provider choice in S1.
3. **Domain.** Gov-owned domain (`*.go.th`) vs a subdomain of your platform domain — affects DNS/TLS/cookies.
4. **PSP / billing.** Does the gov tenant transact payments? If not, we still satisfy the boot-blocking
   `PSP_WEBHOOK_SECRET` (throwaway value) or add a small `NO_PSP=1` escape hatch to `env.validation.ts`
   (a tiny, testable code change if we want it clean).
5. **AI features.** Is `ANTHROPIC_API_KEY` (AI assistant/analytics) permitted for government data, or must AI
   be left off (rule-based fallback)? Government data-handling rules often say off.
6. **Release cadence.** Same-commit-as-prod (auto) or agency-approved windows (a separate gated workflow)?
7. **Support & backups SLA.** Backup frequency, PITR window, RTO/RPO for the silo.

---

## 5. Documentation to update (per the CLAUDE.md doc-sync policy)

This plan is **infrastructure + operations**, so it touches **ops runbooks**, not the ICFR narrative /
RCM / UAT stack — **no new/changed API endpoint, permission, control, or business logic** (the one possible
code change, a deploy job or an optional `NO_PSP` gate, is noted where it appears). Concretely, when each
phase lands:

- **`docs/ops/multi-tenant-subdomain-runbook.md`** — promote Model B from a one-row comparison to a real
  subsection (link to this plan; the go-live checklist below).
- **`docs/ops/deployment.md`** / **`docs/ops/railway-setup.md`** — add a "second/dedicated deployment"
  appendix (new project/env, per-silo Variables, build-time `NEXT_PUBLIC_API_URL`).
- **`docs/ops/secrets.md`** — note the per-silo must-differ subset (§3) and fresh-key generation.
- **`docs/ops/tenancy-model.md`** — cross-reference: "for physical isolation, see the silo plan (Model B)."
- **If S3 adds a deploy job or S4 adds a bootstrap script/`env.validation` gate** — extend
  `tools/cutover/src/onboarding.ts` and add the workflow to `ops-scripts-check`. Regenerate nothing in
  `compliance/` unless a *control* changes (none does here).

### Per-silo go-live checklist
- [ ] Isolation clause confirmed; Model B agreed (§4.1)
- [ ] Region/domain/PSP/AI decisions recorded (§4.2–4.5)
- [ ] DB-2 provisioned; `ierp_app` least-priv role applied; migrations ran clean (S1)
- [ ] Fresh `JWT_SECRET` + `APP_ENC_KEY`; boot-blocking env present; boot fails closed when one is removed (S2/S5)
- [ ] `NEXT_PUBLIC_API_URL` baked to api-gov; CORS + `AUTH_COOKIE_DOMAIN` set; login sticks (S2/S5)
- [ ] `TENANCY_MODE=single-company`, public signup **off**, `PLATFORM_ADMIN_USERNAMES` set (S2)
- [ ] Gov tenant provisioned (Admin, industry CoA, fiscal year, HQ branch, branding, tax profile) (S4)
- [ ] No connection string/bucket/replica points back at DB-1 (S5)
- [ ] Backups/PITR on DB-2; monitoring streams distinct (S5/S6)
- [ ] Post-deploy smoke green on the gov host (S3/S5)

---

## 6. Sequencing & recommendation

**Fastest safe path:** S1 → S2 → S4 can be done **manually first** (provision infra, set env, bootstrap the
tenant, deploy via `railway up` by hand) to get the agency live quickly; then formalize S3 (gated CI deploy)
and S6 (backup/upgrade automation) once the silo is proven. S5 verification runs throughout.

**Recommendation:** get §4.1–4.5 answered on paper first (one meeting) — the region/PSP/AI answers change S1
and S2 materially, and §4.1 is the last chance to save the silo's recurring cost if the contract actually
permits Model A. Everything downstream is reuse of infrastructure the platform already has.

---

## 7. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-07-03 | Platform / Security | Initial design — dedicated single-tenant silo (Model B) for a government customer: target architecture, six-phase runbook (infra → config/secrets → deploy → tenant bootstrap → verify → ops), per-silo must-differ secret matrix, confirm-before-build decisions, doc-sync targets, and a go-live checklist. Records the isolation-tier decision (fully-dedicated deployment) and the Model A off-ramp. |
