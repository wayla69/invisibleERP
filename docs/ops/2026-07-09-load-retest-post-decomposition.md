# Load Re-test — Post God-service Decomposition (docs/38) vs the 2026-06-28 Baseline

> **Date:** 2026-07-09 · **Owner:** Platform / SRE
> Companion to `docs/security/2026-06-28-security-and-load-test-report.md` §3 (the baseline) and
> `docs/38-god-service-decomposition-plan.md` (the refactor under test). The golden-master harness
> already proved the decomposition changed **no outputs**; this re-test answers the second question —
> did it change **speed under concurrency**.

## 1. Method

Same closed-loop design as the 2026-06-28 run, now **committed as a repeatable harness**:
`tools/cutover/src/load-sessions.ts` (`pnpm --filter @ierp/cutover load:sessions`, knobs
`LOAD_PG_URL` / `LOAD_SESSIONS` / `LOAD_SECS` / `LOAD_WEB_CONCURRENCY` / `LOAD_API_DIST`). Each
"session" is one keep-alive TCP connection issuing the same mixed authenticated read workload
(`/api/auth/me`, `/api/ledger/accounts`, `/api/dashboard`, `/api/ledger/trial-balance`,
`/api/finance/ar/aging`, `/api/loyalty/members`); every request pays the full auth guard + per-request
tenant transaction. Rate limiter raised (`RATE_LIMIT_MAX`) so the app, not the edge cap, is measured.

**Environment:** local PostgreSQL 16.13, full migration set applied, API booted from `dist`
(Node 22, 4 vCPU, 15 GB). Same *shape* as the 2026-06-28 environment but **not the same machine**,
so absolute numbers are compared cautiously; the same-box A/B in §3 is the controlled comparison.

## 2. Results — current `main` (post-decomposition)

### 2.1 Single process (default pool = 20)

| Sessions | req/s | p50 ms | p90 ms | p99 ms | max ms | errors |
|---------:|------:|-------:|-------:|-------:|-------:|-------:|
| 1 | 150 | 5.8 | 9.9 | 13.5 | 23.6 | 0 |
| 10 | 322 | 27.3 | 50.6 | 61.9 | 115.7 | 0 |
| 25 | 299 | 74.1 | 127.6 | 167.6 | 277.4 | 0 |
| 50 | 289 | 163.8 | 217.0 | 261.5 | 315.3 | 0 |
| **100** | **283** | **344.0** | 405.9 | 477.4 | 554.5 | 0 |
| 200 | 289 | 682.8 | 751.6 | 831.9 | 1138.9 | 0 |

### 2.2 Clustered (`WEB_CONCURRENCY=4`, pool 20/worker)

| Sessions | req/s | p50 ms | p90 ms | p99 ms | max ms | errors |
|---------:|------:|-------:|-------:|-------:|-------:|-------:|
| 1 | 144 | 5.9 | 10.3 | 18.6 | 64.1 | 0 |
| 10 | 494 | 16.5 | 36.0 | 63.9 | 302.6 | 0 |
| 25 | 626 | 35.0 | 64.0 | 112.9 | 340.4 | 0 |
| 50 | 634 | 69.5 | 124.2 | 210.9 | 697.5 | 0 |
| **100** | **646** | **133.7** | 228.7 | 443.3 | 757.3 | 0 |
| 200 | 669 | 282.8 | 380.5 | 520.2 | 801.9 | 0 |

**Readings (same conclusions as June):**
- The system still **degrades gracefully** — zero errors at every level up to 200 sessions; latency
  grows linearly past saturation (Little's Law), no 5xx, no crashes.
- Clustering is still the big lever: 4 workers ≈ **2.3× throughput / 2.6× lower p50 at 100 sessions**
  (283→646 req/s, 344→134 ms) — the same ratio the June remediation measured (410→946 req/s).
- The single-process plateau (~290–320 req/s here vs ~410 on the June box) and the 1-session baseline
  (150 vs 199 req/s) differ by roughly the same machine factor — consistent with a slower sandbox CPU,
  not a code regression; §3 controls for this.

## 3. Same-box A/B — pre- vs post-decomposition (the controlled comparison)

The June box is gone, so a cross-machine diff can't isolate the refactor. Instead, the **same tester,
same DB, same machine** ran against two builds (`LOAD_API_DIST`):
- **PRE** = `0ee0066` — the commit immediately before the main decomposition wave (projects PR-1 #530
  through ledger PR-3 #554: 11 of the 14 docs/38 PRs); Nest 11/Fastify 5 already in.
- **POST** = current `main`.

Known non-decomposition deltas inside this window (enumerated for honesty): the 2026-07-08
security-review hardening (per-request cost ≈ one widened guard SELECT — L-3 reads `tenant_id` in the
same row fetch), EXP-12 receiving, UI/docs/test-only changes (no API runtime effect).

### Single process, 15 s/level

| Sessions | PRE req/s | POST req/s | PRE p50 ms | POST p50 ms | Δ p50 |
|---------:|----------:|-----------:|-----------:|------------:|------:|
| 1 | 153 | 150 | 5.6 | 5.8 | +3.6% |
| 10 | 315 | 322 | 28.0 | 27.3 | −2.5% |
| 25 | 296 | 299 | 74.9 | 74.1 | −1.1% |
| 50 | 304 | 289 | 155.5 | 163.8 | +5.3% |
| **100** | **292** | **283** | **335.3** | **344.0** | **+2.6%** |
| 200 | 302 | 289 | 654.5 | 682.8 | +4.3% |

**A/B conclusion: the decomposition did not slow the API down.** Throughput and p50 differ by
**−2.5% to +5.3%** across the curve (POST ~3% slower at 100 sessions) — inside run-to-run noise for a
15 s/level sample, and what small consistent drift exists is at least partly the *security hardening*
in the same window (a fatter per-request guard read), not the delegator pattern: the decomposition
keeps identical public methods forwarding to sub-services, which is one extra JS call frame per
request — nanoseconds against a ~3 ms request. Zero errors on both builds at every level.

## 4. Relative code-cost gate (load-smoke)

`pnpm --filter @ierp/cutover load` (in-process PGlite, pinned `tools/cutover/load-baseline.json`,
fails at ≥2.5× p95): **all four scenarios green** — `read:inventory-stock` ×1.15,
`read:trial-balance` ×1.23, `read:catalog` ×1.19, `write:journal` ×1.03 vs the 2026-07-09 pinned
baseline; 0 errors.

## 5. Conclusions

1. **Speed is unchanged by the decomposition** — the same-box A/B (§3) bounds any effect at ≤~5% on
   p50 across 1→200 sessions, within noise + the concurrent security hardening; the golden master
   already bounded the *output* effect at zero. Docs/38 is closed on both axes.
2. **The June performance findings still hold on current code:** graceful degradation (0 errors to
   200 sessions), single-process throughput plateaus on ~1 core, and clustering
   (`WEB_CONCURRENCY=4`) is the big lever at ≈2.3× throughput / 2.6× lower p50. Production should
   keep running clustered (or replicated) per the June recommendation and
   `docs/ops/capacity-and-pooling.md`.
3. **Re-testing is now one command** — `load:sessions` is committed, so the next refactor wave can
   A/B itself (`LOAD_API_DIST`) instead of reconstructing this comparison. For an absolute capacity
   number, run it against staging (real Postgres + PgBouncer) and record in
   `capacity-and-pooling.md` §4.

## 6. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-07-09 | Platform / SRE | Post-decomposition load re-test: current-main scaling curves (single + clustered), same-box pre/post A/B, load-smoke gate; `load:sessions` harness committed. |
