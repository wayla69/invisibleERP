# Ops — Drizzle migration debt & numbering

> **Status:** v1.0 · **Date:** 2026-06-25 · **Owner:** Platform / DB
> Captures the known drift in the Drizzle migration tooling, the **safe day-to-day workflow**, and a
> **remediation procedure** for the risky parts (to run deliberately, not on a busy `main`).

---

## 1. TL;DR for adding a migration today

- **Hand-write** the `.sql` in `apps/api/drizzle/` using the **next free 4-digit number**, and **add a
  matching entry** to `apps/api/drizzle/meta/_journal.json` (idx = last + 1, a new `when`, `tag` =
  filename without `.sql`). New tenant-scoped tables must re-run the RLS loop (copy from `0081`/`0121`).
- **Do NOT run `drizzle-kit generate`** for a normal change — the snapshot baseline is stale, so it emits a
  ~95 KB full-schema catch-up instead of your one table (see §3).
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

## 3. The snapshot drift (the real debt)

`apps/api/drizzle/meta/*_snapshot.json` no longer reflects the live schema — migrations have been
hand-written for a long time, so the snapshot baseline never advanced. Consequences:

- `drizzle-kit generate` diffs current schema against the stale snapshot → a **giant catch-up migration**
  that tries to (re)create most of the schema. It is **not safe to apply** (contains non-idempotent
  `CREATE TYPE` / `ALTER TYPE ADD VALUE`), so the normal generate workflow is unusable.
- New migrations are therefore hand-written (§1), which is why numbers collide (§2).

### Grandfathered exceptions (tracked in the CI gate)
- **Unjournaled orphans:** `0085_floor_zone_geometry`, `0088_dine_in_order_zone`. Both are **idempotent**
  (`ADD COLUMN IF NOT EXISTS` + a conditional backfill), already applied in prod via direct SQL.
- **Duplicate numbers:** `0085`, `0088`, `0104`, `0105` (historical concurrent merges). Already applied;
  cannot be renumbered safely.

## 4. Remediation procedure (do on a QUIET main, in isolation)

Rebuilding the snapshot baseline is a careful, reviewable workstream — **not** a drive-by change:

1. Branch from a quiet `main` (no other migration PRs in flight) in a throwaway worktree.
2. Journal the two idempotent orphans (`0085_floor_zone_geometry`, `0088_dine_in_order_zone`) as
   append-only journal entries; remove them from the gate's grandfather list. They re-run as no-ops where
   unrecorded (IF NOT EXISTS).
3. Regenerate the snapshot baseline so `drizzle-kit generate` produces an **empty** diff against the live
   schema — without emitting an applyable catch-up migration. Validate by running `generate` again and
   confirming "No schema changes".
4. Verify against a **fresh** DB: `db:migrate` from zero must succeed, and the `cutover`/`tenant-isolation`
   harnesses (which run every `.sql` directly) must stay green. Confirm prod's `__drizzle_migrations`
   reconciliation plan before deploy.
5. Only after that, drop the duplicate-number grandfather list (`0085/0088/0104/0105`) from the gate.

Until then, the hand-written workflow (§1) + the CI guard (§2) are the supported path.

---

## Revision history

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-06-25 | v1.0 | Platform / DB | Initial: documents the migration-number collision pattern (+ the new CI duplicate-number guard), the snapshot drift that makes `db:generate` unusable, the grandfathered orphans/dup-numbers, and a safe remediation procedure for a quiet main. |
