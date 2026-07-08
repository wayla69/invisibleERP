# 38 — God-service decomposition (design for review · workstream 2.1)

> **Status:** IN PROGRESS — sign-off received 2026-07-08 (Wave 4 decision A); the `bi` pilot is underway
> (PR-1 landed, see §8-log in docs/07-backend.md). This is a **refactor of financial-critical services
> with zero intended behaviour change**, so the whole plan is built around *proving* nothing moved.
> Nothing here changes a public API, a GL posting, or a control — it only relocates code behind
> unchanged facades.
>
> **Step 1 (characterize) is DELIVERED** ahead of the sign-off: the golden-master harness
> `tools/parity/src/goldenmaster.ts` (CI gate `parity/golden`) pins ~500 output paths across all four
> target services against `tools/parity/golden/goldenmaster.json` — see §2bis. The safety net now exists;
> the decision in §7 is only about whether/when to start extracting.

## 1. Targets (largest services, by line count)

| Service | LOC | Harness coverage (the safety net) | Risk |
|---------|-----|-----------------------------------|------|
| `modules/projects/projects.service.ts` | ~1,659 | `projects` 248 | med |
| `modules/procurement/procurement.service.ts` | ~1,432 | `basics`, `match`, `ext` | med-high (P2P + 3-way match) |
| `modules/ledger/ledger.service.ts` | ~1,266 | `basics`, `compliance`, `worldclass`, `multiledger` | **high (GL core, SoD)** |
| `modules/bi/bi.service.ts` | ~1,101 | `bi`, `bi-cache`, scheduler harnesses | med |

## 2. Principle — characterization-first, facade-preserving

Order for **every** extraction (never skip step 1):

1. **Characterize.** Before touching a service, add a golden-master harness that snapshots its current
   outputs across representative inputs (mirrors how the parity harnesses already lock `forecasting`/
   `analytics`). This captures *current behaviour as the spec* — including quirks — so any drift is caught.
2. **Extract behind a facade.** Move a bounded-context cluster of methods into a new sub-service
   (`ledger-posting.service.ts`, etc.). The original class keeps its public methods as **thin delegators**
   (`postEntry(dto) { return this.posting.postEntry(dto) }`), so every caller, `@Injectable` graph entry,
   and `@Optional()` harness constructor is unchanged. Public API = byte-identical.
3. **Verify.** Golden-master + the existing harnesses must be **green and unchanged** (not "adjusted"). A
   diff in any asserted number = stop and revert (the CLAUDE.md debug mantra: never bend the test to the
   refactor).
4. **One sub-service per PR.** Small, reviewable, independently revertable.

## 2bis. The golden-master harness (delivered)

`tools/parity/src/goldenmaster.ts` (`pnpm --filter @ierp/parity golden`, `NODE_OPTIONS=--experimental-sqlite`;
CI matrix job `parity/golden`) instantiates the real compiled services (`apps/api/dist`) standalone on a
fresh PGlite, runs a deterministic seed world, and deep-compares the **entire canonicalized output** of:

- **ledger** — `postEntry` (immediate + Draft/maker-checker + SoD self-approve rejection + idempotent dedupe +
  UNBALANCED/INVALID_LINE guards), `createRecurring`/`runDueRecurring` (incl. same-day re-run), `createPrepaid`/
  `runDuePrepaid`, `trialBalance` (touched accounts), `cashFlowStatement`/`cashFlowDirect`, `incomeStatement`,
  `balanceSheet`;
- **procurement** — PR→approve (incl. role rejection)→PO→approve→GR full-close + partial-receive;
- **projects** — create, WBS tasks (with dependency), `logCost` billable/non-billable, milestone, closed-form
  `evm` (BAC/PV/EV/AC/CPI/SPI/EAC), CPM `schedule`, `portfolioEvm`;
- **bi** — `kpiBoard`, `salesCube`, `financeTrend` (the pilot's read core)

against the pinned snapshot `tools/parity/golden/goldenmaster.json` (~500 leaf paths). Volatile values are
masked before comparison (`<TS>`/`<STAMP>`/`<DATE>`/`<PERIOD>`), and all seeds are dated *relative* to the
business day (Asia/Bangkok), so the snapshot is stable on any run date while every behavioural number stays
locked. **Re-pin** (`UPDATE_GOLDEN=1 … golden`) is only legitimate for a conscious product change, committed
in the same PR with the diff explained — during a decomposition PR, any drift means stop and revert (§2.3).

## 3. Per-service split (bounded contexts)

- **ledger** → `posting` (`postEntry`/approve — GL-05 SoD), `recurring` (GL-08), `prepaid` (GL-09),
  `cashflow` (`cashFlowStatement`/`Direct`/`Forecast` — GL-07 + the `CF_CLASSIFY` map), leaving
  `ledger.service` as the facade + shared COA helpers. **Do NOT touch** any block commented parity-locked.
- **procurement** → `pr` (requisitions), `po` (orders), `grn` (receiving), `match` already partly separate —
  keep the 3-way-match assertion path (`assertPayable`, EXP-01/09) exactly where callers expect it.
- **projects** → `wbs` (tasks/milestones), `resourcing` (rate cards, PROJ-05), `evm` (earned value, PROJ-06),
  `timesheet` (labor maker-checker, PROJ-04).
- **bi** → `report-registry` (`REPORT_TYPES`), `generate` (`generateReport`), `schedule` (the action-job
  scheduler — keep the `@Optional()` injections intact so partial harnesses stay constructible).

## 4. Sequencing (pilot → riskiest last)

1. **Pilot: `bi`** — medium risk, well-fenced by `bi`/`bi-cache`. Proves the characterization+facade recipe
   on something that isn't the GL. Land it, review, confirm the pattern.
2. **`projects`** — strong single harness (248), fewer cross-cutting controls.
3. **`procurement`** — more controls (3-way match), do after the recipe is proven.
4. **`ledger` LAST** — the GL core. Only after the pattern has shipped 3× cleanly. Split one sub-service at a
   time (cashflow first — most self-contained; posting last — most SoD-sensitive), each its own PR, each
   gated on `basics` + `compliance` + `worldclass` + `multiledger` all green and unchanged.

## 5. Guardrails / definition of done (per PR)
- Public method signatures unchanged (a `tsc` + a grep for external callers proves it).
- No parity-locked block moved or edited (`grep "ห้ามเปลี่ยน — parity"` in the touched file must be empty, or
  the locked block stays verbatim in place).
- Golden-master harness + all listed harnesses green **with identical numbers**.
- Ratchets flat (`check-ts-debt`, `check-use-client`), `check-rcm-census` unchanged (no control moved).
- No migration, no doc-behaviour change → doc-sync = a note in `docs/07-backend.md` that the service was
  split, and this plan's revision history.

## 6. Why this is worth doing (and the honest cost)
- **Benefit:** the 1,600-line files are single-owner merge-conflict magnets and can't be unit-tested in
  isolation; splitting them unlocks the unit-test pyramid (2.4) and lowers bus-factor.
- **Cost:** this is **weeks of careful work**, mostly writing characterization tests, for **zero user-visible
  change** — pure risk-reduction. It should NOT be bundled with feature work, and it competes for attention
  with revenue/compliance items. Recommend scheduling it as a dedicated, low-priority background track
  **after** the P0/P1 revenue+compliance work is operating — not ahead of it.

## 7. Decision needed
Sign-off on: (a) doing this at all now vs. deferring behind revenue/compliance; (b) the pilot = `bi`;
(c) the hard rule that a changed harness number aborts the extraction (revert, don't adjust).

## Revision history
| Version | Date | Author | Change |
|---------|------|--------|--------|
| 0.1 | 2026-07-07 | Platform / IT | Initial decomposition plan for review — characterization-first + facade-preserving recipe, per-service bounded contexts, pilot=bi → ledger last, per-PR guardrails, honest cost/benefit + a recommendation to defer behind revenue/compliance work. |
| 0.5 | 2026-07-08 | Platform / IT | Pilot PR-3 landed — subscription scheduler → `bi-schedule.service.ts` (267 LOC; facade delegators pass `this` as BiReadPort; onModuleInit registration stays on the facade; ctor param 33-safe append). **bi pilot COMPLETE**: 1,211→532 LOC facade + registry 98 + generate 463 + schedule 267; golden 496 identical on all three cuts; recipe proven → `projects` next per §4. |
| 0.4 | 2026-07-08 | Platform / IT | Pilot PR-2 landed: `generateReport` + `execScorecard` → `bi-generate.service.ts` behind a `BiReadPort` callback interface (facade passes `this`; no forwardRef cycle); 23 `@Optional` deps on the new service; ctor order preserved (new service appended as param 31). bi.service 1,211→743 LOC. Golden 496 identical, bi/bi-cache/async-jobs/worldclass green. |
| 0.3 | 2026-07-08 | Platform / IT | Sign-off received (user decision A, Wave 4); pilot PR-1 landed — `REPORT_TYPES`/`FREQUENCIES` extracted verbatim to `modules/bi/report-registry.ts` (pure const module: no DI/constructor change, so the goldenmaster positional-construction canary is provably unaffected). Golden 496 identical without re-pin; bi/bi-cache/async-jobs green. PR-2 = `generate` (needs a read-port for the kpiBoard/salesCube/financeTrend/pipelineTrend callbacks — ~20 @Optional deps move), PR-3 = `schedule`. Constructor param ORDER is a HARD constraint (goldenmaster passes the first 12 positionally) — new params append only. |
| 0.2 | 2026-07-08 | Platform / IT | Step 1 delivered: golden-master characterization harness (`tools/parity/src/goldenmaster.ts` + pinned `golden/goldenmaster.json`, ~500 paths over ledger/procurement/projects/bi) added as CI gate `parity/golden` (§2bis). Extraction itself still awaits §7 sign-off. |
