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

### Remaining grandfathered exceptions — RESOLVED / DECIDED (2026-07-02, docs/24 R5-1)
- **Unjournaled orphans — RESOLVED:** `0085_floor_zone_geometry`, `0088_dine_in_order_zone` were journaled
  as **append-only entries (idx 214/215)**. Safe because both are idempotent (`ADD COLUMN IF NOT EXISTS` +
  a null-guarded backfill), already applied in prod (their journal-order application is a no-op), and no
  intervening migration references the columns they add (verified). The CI gate's `GRANDFATHERED` list is
  now **empty**.
- **Duplicate numbers — DECIDED, stay grandfathered:** `0085`, `0088`, `0104`, `0105` are already applied
  in prod and drizzle tracks by full tag — renumbering applied migrations is the dangerous move, so they
  stay. Full filenames sort deterministically, and the risk class ("fresh-DB rebuild diverges from prod")
  is now **guarded by the `migration-parity` harness** (CI matrix): it builds a fresh database twice —
  filename order (the harness path) vs journal order (the prod `drizzle-kit migrate` path) — and fails on
  any table/column/type/default/index divergence (currently 4,254 columns / 974 indexes, identical).

## 4. Adding migrations going forward

- Use `db:generate` to draft, **or** hand-write — either way assign the **next free number** and ensure the
  journal entry exists (the CI gate enforces it). Hand-append the RLS loop for new tenant tables.
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
| 2026-07-02 | v1.2 | Platform / DB | **docs/24 R5-1:** orphans journaled append-only (idx 214/215; CI `GRANDFATHERED` now empty); dup-number grandfathering made a recorded decision (cannot renumber applied migrations); new `migration-parity` CI harness proves filename-order ≡ journal-order schema. |
