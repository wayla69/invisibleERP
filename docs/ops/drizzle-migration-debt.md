# Ops — Drizzle migration debt & numbering

> **Status:** v1.0 · **Date:** 2026-06-25 · **Owner:** Platform / DB
> Captures the known drift in the Drizzle migration tooling, the **safe day-to-day workflow**, and a
> **remediation procedure** for the risky parts (to run deliberately, not on a busy `main`).

---

## 1. TL;DR for adding a migration today

- **Hand-write** the `.sql` in `apps/api/drizzle/` using the **next free 4-digit number**, and **add a
  matching entry** to `apps/api/drizzle/meta/_journal.json` (idx = last + 1, a new `when`, `tag` =
  filename without `.sql`). New tenant-scoped tables must re-run the RLS loop (copy from `0081`/`0121`).
- **`drizzle-kit generate` is usable again** for drafting a normal change — the snapshot baseline was
  resynced (migration `0129_baseline_resync`, §3), so generate now emits a **minimal** diff for your change
  instead of a ~2,500-line full-schema catch-up. Two caveats remain, so review its output: it does **not**
  emit the RLS loop for a new tenant-scoped table (hand-append it, copy from `0081`/`0121`), and the
  filename it picks (`last idx + 1`) can still collide with a concurrent PR — see §2.
- The **`migrations-journaled` CI gate** enforces: every `.sql` is journaled, every journal tag has a
  `.sql`, **no duplicate migration numbers**, and no duplicate journal tag/idx.
- When you merge `main` and your number was taken by another PR, **renumber** your `.sql` + journal entry
  to the next free id and bump the comment header. (This is the recurring pain the number guard now
  catches early.)

## 2. Why migration numbers collide

Migrations are sequential (`0119`, `0120`, …) and hand-assigned. When two PRs are open at once they both
grab the same next number; on merge the appended `_journal.json` lines conflict and, without the guard, one
`.sql` could silently win (prod `drizzle-kit migrate` applies journal order). This bit the sidebar-prefs PR
three times in one hour (`0119`→`0121`→`0122`). **Mitigation in place:** the duplicate-number guard (CI).
**Possible future fix:** switch new migrations to timestamp-prefixed names so two PRs never collide.

## 3. The snapshot drift — RESOLVED (2026-06-25)

**Background.** `apps/api/drizzle/meta/*_snapshot.json` had frozen at `0046` (the last time `generate` was
used) while migrations `0047`–`0123` were hand-written, so only 3 snapshot files existed for 129
migrations. `drizzle-kit generate` therefore diffed the live schema against a 76-migration-stale baseline
and emitted a ~2,500-line catch-up containing non-idempotent `CREATE TYPE` / `ALTER TYPE ADD VALUE` — not
applyable, so the generate workflow was unusable and every new migration was hand-written (→ the number
collisions in §2).

**Why it was safe to fix.** Snapshots are read **only** by `drizzle-kit generate` (dev tooling). Neither
`drizzle-kit migrate` (prod) nor the cutover harnesses read them — both apply the `.sql` files directly
(the harness `readdirSync(...).filter('.sql').sort()` via PGlite). So advancing the snapshot baseline has
**zero runtime/prod effect**.

**The fix.** `drizzle-kit generate` was run to regenerate `meta/0129_snapshot.json` (now reflecting the
current schema) and a matching journal entry; the generated catch-up `.sql` (non-idempotent) was
**neutralised to a no-op** (`0129_baseline_resync.sql` = `SELECT 1;`) since the schema is already created by
`0000`–`0123`. Result: a second `db:generate` reports **"No schema changes"**, and a future change once
again produces a minimal diff. Verified: `migrations-journaled` gate ✅, `tenant-isolation` harness ✅,
`e2e` harness ✅ (fresh PGlite DB from all 130 `.sql`).

### Remaining grandfathered exceptions — RESOLVED / DECIDED (2026-07-02, docs/27 R5-1)
- **Unjournaled orphans — RESOLVED (they never were):** remediating this found `0085_floor_zone_geometry`
  and `0088_dine_in_order_zone` had been journaled **all along** (idx 102/103) — the CI `GRANDFATHERED`
  list was dead code masking that fact (an entry only fires for a file NOT in the journal, and both were).
  The list is now **empty**, so any genuinely unjournaled file fails the gate again.
- **Duplicate numbers — DECIDED, stay grandfathered:** `0085`, `0088`, `0104`, `0105` are already applied
  in prod and drizzle tracks by full tag — renumbering applied migrations is the dangerous move, so they
  stay. Full filenames sort deterministically, and the risk class ("fresh-DB rebuild diverges from prod")
  is now **guarded by the `migration-parity` harness** (CI matrix): it builds a fresh database twice —
  filename order (the harness path) vs journal order (the prod `drizzle-kit migrate` path) — and fails on
  any table/column/type/default/index divergence (currently 4,254 columns / 974 indexes, identical).

## 3bis. Non-monotonic journal `when` — the silent-skip class (2026-07-03 deploy outage)

**The failure mode.** `drizzle-kit migrate` only applies journal entries whose `when` is **strictly
greater** than the `created_at` of the last applied migration. A journal entry whose `when` is **≤ an
earlier entry's** therefore never qualifies once prod has migrated past that earlier entry — it is
**silently skipped forever**. Fresh databases (the PGlite harnesses, `migration-parity`) apply everything
in a single pass where the filter can't bite, so CI stays green while prod silently lacks the objects.

**The incident.** `0145_table_reservations` (`when` 2023610000004 < 0144's 2023620000004) and
`0146_tip_distribution` (`when` == 0144's) merged after prod had already migrated at `0144` — prod never
created `table_reservations` / `tip_distributions` / `tip_distribution_lines`. Invisible until
`0218_tenant_indexes_backfill` became the first migration to reference `tip_distribution_lines`: every
prod deploy from 2026-07-02 onward failed pre-deploy `db:migrate` with 42P01 and Railway served the stale
June-30 build.

**The fix (recorded decision).**
- `0145`/`0146` journal entries stay untouched (same rationale as the dup-number decision: don't rewrite
  applied-journal history; bumping their `when` would re-fire them on every environment that *did* apply
  them). Instead **`0218` idempotently re-creates their objects** (guarded `CREATE TYPE`, `CREATE TABLE IF
  NOT EXISTS`, RLS loop) before its index statements — a no-op where 0145/0146 ran, the backfill where
  they were skipped. Verified on both paths with a PGlite simulation (prod-like: journal minus 0145/0146,
  then 0218; fresh: full journal).
- The **`migrations-journaled` gate now fails on any non-monotonic `when`** (0145/0146 grandfathered).
  When you renumber a migration after merging `main`, also make sure its `when` is **greater than the
  current journal maximum** — renumbering the filename alone is not enough.

## 4. Adding migrations going forward

- Use `db:generate` to draft, **or** hand-write — either way assign the **next free number** and ensure the
  journal entry exists (the CI gate enforces it). Hand-append the RLS loop for new tenant tables.
- The journal `when` must be **strictly greater than the current maximum** (the CI gate enforces
  monotonicity — see §3bis for why a lower/equal `when` is silently skipped in prod).
- The snapshot baseline is current; keep it that way by letting `generate` advance it, or by leaving the
  baseline alone for hand-written no-DDL-snapshot changes (it stays valid).
- If the snapshot drifts again, repeat the §3 fix: `generate` → keep the new snapshot + journal entry →
  neutralise the catch-up `.sql` to a no-op → confirm a second `generate` is empty + harnesses green.

---

## Revision history

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-06-25 | v1.0 | Platform / DB | Initial: documents the migration-number collision pattern (+ the new CI duplicate-number guard), the snapshot drift that makes `db:generate` unusable, the grandfathered orphans/dup-numbers, and a safe remediation procedure for a quiet main. |
| 2026-06-25 | v1.1 | Platform / DB | **Snapshot drift resolved**: regenerated the baseline (`0129_baseline_resync`, snapshot-only, catch-up neutralised to a no-op). `db:generate` now yields a minimal diff again; zero runtime/prod effect (snapshots are generate-only). Verified by the `migrations-journaled` gate + `tenant-isolation`/`e2e` harnesses. §3/§4 rewritten; orphan-journaling + dup-number grandfathering left as low-priority follow-ups. |
| 2026-07-02 | v1.2 | Platform / DB | **docs/27 R5-1:** the 'orphans' were found journaled all along (idx 102/103) — stale dead-code `GRANDFATHERED` list removed (now empty); dup-number grandfathering made a recorded decision (cannot renumber applied migrations); new `migration-parity` CI harness proves filename-order ≡ journal-order schema. |
| 2026-07-03 | v1.3 | Platform / DB | **§3bis — non-monotonic `when` silent-skip (prod deploy outage):** 0145/0146 (`when` ≤ 0144's) were never applied in prod; 0218's tenant-index on the missing `tip_distribution_lines` failed every deploy since 2026-07-02. Fix: 0218 now idempotently re-creates the 0145/0146 objects (PGlite-verified on prod-like + fresh paths); `migrations-journaled` gate extended to fail on any new non-monotonic `when` (0145/0146 grandfathered). |
