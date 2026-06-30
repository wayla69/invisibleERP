# 22 — Advanced scheduling (APS) + real-time streaming analytics

> **Status:** PLANNING. Promotes the two items parked as out-of-scope in `docs/21 §4` into a delivery plan.
> Both **build on existing primitives** (mfg-depth routings/RCCP; the `@Sse` `RealtimeService` bus) — they
> are *not* greenfield, and nothing already built will be rebuilt.

## Document control

| Field | Value |
|---|---|
| Owner | ERP / Product |
| Version | 0.1 DRAFT |
| Date | 2026-06-30 |
| Scope | (A) Finite-capacity **advanced production scheduling** on the manufacturing routings; (B) **real-time streaming analytics** — a live KPI/event feed. |

## 1. Current-state (build on, don't duplicate)

- **Manufacturing depth exists** — `modules/mfg-depth/`: `routings` + `routing_operations`
  (`work_center`, `setup_min`, `run_min_per_unit`), production WOs, and MRP with **rough-cut capacity
  planning** (`mrp.service.ts capacity()` — load vs. supplied available-minutes, flags overloaded centres).
  **Gap:** RCCP is a *bucket* check; there is **no finite-capacity sequencing** — no per-operation
  start/finish schedule, no work-centre queue/dispatch list, no makespan/late-flag, no persisted work-centre
  capacity calendar.
- **Realtime infra exists** — Nest `@Sse()` is already used (`pos-scale` table/KDS stream, `ai` chat stream)
  via a reusable in-process bus `RealtimeService` (rxjs `Subject` + per-tenant filter + a buffered, **HTTP-
  testable** `recent()` read) and `RealtimeScope` for tenant-safe SSE handlers. **Gap:** BI/analytics is
  **poll-based** (30 s read-through cache, daily snapshots); there is no **live KPI/event push**, so a
  dashboard can't update without re-polling.

## 2. Phase A — Finite-capacity scheduler (APS)

**Goal:** turn released work orders (and their routings) into a **finite-capacity schedule** — each operation
sequenced onto its work centre respecting capacity, predecessors, and competing WOs — with a dispatch list
and lateness signal. Extends `mfg-depth`; reuses `routings`/`routing_operations` and the WO spine.

- **Data:** a persisted **`work_centers`** master (code, name, `minutes_per_day` capacity, active) so capacity
  is governed, not ad-hoc. Tenant-scoped (RLS). Migration `0193` (+ journal). *(RCCP's request-supplied
  capacity stays for the bucket view; APS reads the master, falling back to a request override.)*
- **Algorithm:** forward **list scheduling** (finite capacity, infinite buffer): order candidate operations
  by (WO due date, routing seq), then place each on its work centre at `max(predecessor_finish,
  work_centre_free)`; advance the centre's running clock by `setup + run·qty`. Produce per-operation
  `start/finish` (elapsed working-minutes off a horizon start, mapped to a date via the centre's minutes/day),
  per-work-centre **load + utilisation + queue (dispatch list)**, the **makespan**, and a **late** flag when
  an operation's finish exceeds the WO due date. Deterministic; guards against missing routings/work centres.
- **API (mfg-depth, `api/mrp` or a new `api/aps`):** `POST .../schedule` `{ work_orders?: string[], horizon_start?, work_centers?: [...] }`
  → the schedule; `GET/POST api/work-centers` to maintain the master.
- **Control:** operational / non-financial (planning only — posts no GL) → **no new RCM control**.
- **Web:** a schedule view under `/production` — per-work-centre dispatch list + utilisation bars + late
  badges (a lightweight timeline, no new dependency).
- **Docs/harness:** PN-?? (manufacturing) note or `docs/21` cross-ref; UAT case; harness `tools/cutover/src/aps.ts`
  (sequence two WOs over a shared work centre → ordered dispatch, makespan, a late flag).

## 3. Phase B — Real-time streaming analytics (live KPI feed)

**Goal:** push live KPI/business-event updates to the dashboard instead of polling. Reuses the proven SSE bus.

- **Service:** a small `BiLiveService` mirroring `RealtimeService` (rxjs `Subject` + per-tenant filter + a
  ring-buffered `recent()` for HTTP-testability). Key moments **publish** an event: snapshot refresh
  (`kpi_refresh` with the new KPI deltas), and notable business events (e.g. a large sale, an at-risk signal).
- **API (bi):** `@Sse('api/bi/live/stream')` (per-tenant filtered) + `GET api/bi/live/recent` (buffered,
  testable) + an internal `publish()` called from `refreshSnapshot()` and selected hooks.
- **Web:** the dashboard opens an `EventSource` on `/api/bi/live/stream` and live-updates the KPI tiles
  (graceful fallback to the existing poll if SSE drops).
- **Control:** none (read-only telemetry). **No migration** (in-memory bus, per the existing pattern).
- **Docs/harness:** user-manual reports/analytics note; UAT case; extend `tools/cutover/src/bi.ts` (publish →
  `recent()` returns the event, tenant-filtered).

## 4. Delivery order & discipline
1. **docs/22** (this plan) — one PR.
2. **Phase A (APS)** — one PR (migration 0193 + scheduler + work-centre master + web + harness + docs).
3. **Phase B (streaming)** — one PR (SSE feed + web + harness + docs). Independent of A.

Each is CI-green (88-check matrix) before merge and doc-synced per the CLAUDE.md policy. A shares the
migration journal (sequence, don't overlap); B has no migration.

## 5. Out of scope
Multi-node/Redis-backed SSE fan-out (the in-process bus is per-node by design), drag-to-reschedule editing,
and machine-learning sequence optimisation — future increments if requested.

## 6. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-30 | ERP / Product | Initial plan for APS finite-capacity scheduling + real-time streaming analytics (the two `docs/21 §4` parked items). Grounded in a current-state check: both extend existing primitives (mfg-depth routings/RCCP; the `@Sse` `RealtimeService` bus). No greenfield rebuilds. |
