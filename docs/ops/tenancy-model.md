# Ops — Multi-tenancy & RLS model (single-company vs multi-company org scope)

> **Status:** v1.0 · **Date:** 2026-07-03 · **Owner:** Platform / Security
> The authoritative reference for how tenant isolation is enforced (Row-Level Security), how an Admin's
> bypass is scoped under `TENANCY_MODE`, and the control that guards it (**ITGC-AC-18**). Read this before
> touching any `tenant_isolation` policy or the `TenantTxInterceptor`.

---

## 1. TL;DR

- Every tenant-scoped table has a `tenant_id` column, `ENABLE`+`FORCE ROW LEVEL SECURITY`, and a
  `tenant_isolation` RLS policy. The app connects and `SET LOCAL ROLE app_user` (a **non-superuser** — so
  FORCE-RLS actually applies) then sets per-request GUCs. A forgotten `WHERE tenant_id = …` cannot leak.
- **`TENANCY_MODE` (env) selects the Admin bypass scope:**
  - `single-company` (default): HQ/Admin gets a **global** RLS bypass (`app.bypass_rls='on'`) — the legacy
    "HQ sees all branches" model, correct for one company with many outlets. Every bypassed request is
    audit-logged (`rls_bypass` meta).
  - `multi-company`: an Admin is **org-scoped** via `app.org_id` — it sees its own tenant **plus every
    sibling tenant sharing its `org_id`**, but never another org's data. A missing `org_id` **fails closed**
    (sees only its own tenant). Only pre-auth (login/signup) keeps a global bypass.
- The multi-company org clause lives on the `tenant_isolation` policy of **every `tenant_id` table** and on
  the `tenants` self-policy. Both must carry it, or org **sharing** silently breaks (see §4).

## 2. Per-request scope decision (`common/tenant-tx.interceptor.ts`)

Each non-SSE, non-`@NoTx` request runs inside a tenant transaction that sets four GUCs in one round-trip:
`app.bypass_rls`, `app.tenant_id`, `app.org_id`, `app.actor`. The decision:

| Mode | Pre-auth (no user) | Admin | Other roles (staff/customer) |
|---|---|---|---|
| `single-company` | global bypass | global bypass | scoped to own `tenant_id` |
| `multi-company` | global bypass | org-scoped (`app.org_id = user.orgId`; **null ⇒ own tenant only**) | scoped to own `tenant_id` |

`req.user.orgId` is sourced live from the `users` row each request (`common/guards.ts`, AC-15) — so an Admin
whose org changes takes effect immediately, and a forged JWT claim cannot widen scope. `TENANCY_MODE` is
validated in `common/env.validation.ts`.

## 3. The RLS policies

**Every `tenant_id` table** — `tenant_isolation` (the *canonical* org-clause form; installed by 0196,
re-applied by 0232):

```sql
USING (
  coalesce(current_setting('app.bypass_rls', true), '') = 'on'
  OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  OR (nullif(current_setting('app.org_id', true), '') IS NOT NULL
      AND tenant_id IN (SELECT id FROM tenants
                        WHERE org_id = nullif(current_setting('app.org_id', true), '')::bigint))
)  -- WITH CHECK identical
```

The org subquery depends only on the `app.org_id` GUC (not the row), so Postgres evaluates it once per query
(InitPlan) — per-row cost is unchanged, and the single-company path (`bypass`/`tenant_id`) is byte-for-byte
the legacy behaviour. The subquery reads `tenants` under RLS; the `tenants` self-policy (below) lets it see
the org's siblings, so the `IN (…)` set resolves correctly.

**`tenants` table** — `tenant_self_isolation` (0196, **direct DDL**; `tenants` has no `tenant_id` column so
it is *not* covered by the generic RLS loop):

```sql
USING (
  coalesce(current_setting('app.bypass_rls', true), '') = 'on'
  OR id = nullif(current_setting('app.tenant_id', true), '')::bigint
  OR (nullif(current_setting('app.org_id', true), '') IS NOT NULL
      AND org_id = nullif(current_setting('app.org_id', true), '')::bigint)
)
```

## 4. Migration history (why 0232 exists)

1. **`0196_hybrid_org_tenancy`** — added `org_id` to `tenants`/`users`; added the org clause to
   `tenant_isolation` on every `tenant_id` table (via a `DO`-loop over `information_schema`) and to the
   `tenants` self-policy (direct DDL).
2. **`0218_tenant_indexes_backfill`** (2026-07-03 hotfix) — re-ran the generic RLS loop to (re)enable RLS on
   backfilled tables, but its loop recreated `tenant_isolation` with the **PLAIN** body
   (`bypass OR tenant_id = app.tenant_id`), **silently dropping 0196's org clause on every data table**.
   Effect in `multi-company`: an org-scoped Admin saw only its own tenant's rows — org **sharing** stopped
   working. Isolation was never weakened (fail-**closed**, no leak). The `tenants` self-policy was untouched
   (not in the loop), so tenants-level org isolation kept working — masking the data-table regression.
3. **`0232_reapply_org_rls`** — re-applies the org-clause policy to every `tenant_id` table (runs after 0218
   → wins). The `DO`-loop executes identically on PGlite and real Postgres.

**Forward rule:** the org-clause body is canonical. Any new tenant table's hand-appended RLS loop, or any
future migration that `DROP`/`CREATE`s `tenant_isolation`, **must copy 0232's loop** (not the plain
`0081`/`0121`/`0002` form), or it re-introduces this bug.

## 5. Verification / Test of Effectiveness

- **`cutover/pg-smoke`** (real Postgres only): an org-scoped Admin sees only its own org's **tenants** row,
  a tenant-scoped user is FORCE-RLS isolated, and single-company global bypass sees all.
- **`cutover/pg-core`** (real Postgres in CI, PGlite locally — same code both backends): the **data-table**
  org-sharing check — an org-A Admin sees **both** org-A sibling tenants' `background_jobs` rows
  (`org1===2`) and **never** org-B's, while per-company staff isolation (`t1=1`, `t2=1`) and single-company
  HQ bypass stay green. This is the regression guard for §4.

## 6. Status & known issues

**No known limitation.** Cross-account org **sharing** on data tables works as designed and is proven on both
PGlite and real Postgres (§5). The historical gap — an org-scoped Admin over-isolating to its own tenant on
data tables — was root-caused (0218 clobbered 0196) and fixed (0232), with a hard `pg-core` assertion added
so it cannot recur silently. `multi-company` remains **opt-in**; default `single-company` installs are
unaffected.

---

### Revision history

| Date | Version | Change |
|---|---|---|
| 2026-07-03 | v1.0 | Initial version. Documents the as-built hybrid tenancy model and the ITGC-AC-18 data-table org-clause fix (0218 clobber → 0232 re-apply; `pg-core` `org1===2` guard). |
