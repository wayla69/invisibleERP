# Supply Chain Planning — Demand Forecasting & Replenishment — Process Narrative

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-34-SCM |
| Process owner | `<<Supply-chain planner / Controller>>` |
| Approver | `<<COO / CFO>>` |
| Version | **0.1 DRAFT** |
| Effective date | `<<effective-date>>` |
| Review cadence | Nightly planning run · per demand-spike replan · per order-plan approval · monthly forecast-accuracy review |
| Version note | Rev **0.1** (2026-07-21) — docs/54 Phase 2: per-(branch, item) probabilistic demand planning + perishable-aware order optimization. New controls **SCM-01** (order-plan maker-checker), **SCM-02** (planning-job monitoring & idempotency), **SCM-03** (auditable demand-driven order sizing); migration `0459`; new permissions `scm_plan` / `scm_approve` with SoD rule **R24**. The compute engine is an optional external microservice (`services/forecast-engine`, docs/54 Phase 1); with it disabled the module plans in-process. |
| Related RCM controls | SCM-01, SCM-02, SCM-03, INV-10 (waste), EXP-01/EXP-12 (PR/receiving), GOV-01 (pending approvals), ITGC-OP-04 (job failure alerting) |
| Related policy | `compliance/policies/09-inventory-policy.md` |

## 2. Purpose

Define the controlled process by which the chain decides **how much of each ingredient to buy, for each
branch, each day** — replacing habit and fixed reorder points with a demand forecast that is measured,
explainable and independently approved before it becomes committed spend.

The economic problem is asymmetric and perishable: order too little and the branch stocks out (lost sale plus
goodwill); order too much and the surplus is thrown away at its full cost. The process therefore sizes orders
against an explicit cost trade-off rather than a service-level rule of thumb, and every proposed quantity
carries the rationale that produced it.

## 3. Scope

- **In scope:** extraction of per-(branch, item) demand history from POS and kitchen records; the Thai
  holiday / closure / payday calendar applied to that history; probabilistic demand forecasting; explosion of
  menu demand to ingredient demand through the recipe (BoM); perishable-aware order sizing against shelf life,
  lead-time variability and current FEFO stock; the Draft → approval → purchase-requisition lifecycle;
  demand-spike detection and targeted replanning; and the scenario ("what-if") tool.
- **Out of scope:** purchase-order issue, receiving and three-way match (PN-02, controls EXP-01/EXP-12) — this
  process hands off at the **purchase requisition** and posts no GL entries of its own; inter-branch transfers
  and min/max replenishment (the existing WMS replenishment path); and manufacturing MRP (PN-07).

## 4. References

- `docs/54-dynamic-scm-forecasting-plan.md` — the program plan, the mathematics (§3) and the ADRs.
- `services/forecast-engine/README.md` — the external compute service and its contract.
- `packages/shared/src/scm-engine.ts` — the wire contract (source of truth).
- PN-01 (POS sales), PN-02 (procure-to-pay), PN-17 (master data), PN-16 (projects).

## 5. Definitions

| Term | Meaning |
|---|---|
| **Planning unit** | One branch of one tenant. Sales that carry no branch fall into the untagged (NULL-branch) unit. |
| **Sample path** | One simulated future demand series. The forecaster returns many; ordering decisions are made across all of them rather than on a single average. |
| **Protection period** | Lead time + review period — the window a replenishment decision must cover before the next delivery can arrive. |
| **Order-up-to level (S\*)** | The stock position the plan aims to reach, set at the cost-optimal demand quantile. |
| **Dynamic safety stock** | S\* minus expected protection-period demand. Recomputed every run, so it moves with seasonality and lead-time variability instead of being a fixed number. |
| **Critical ratio** | Cu / (Cu + Co) — the shortage cost as a share of shortage + surplus cost. The quantile the order aims at. |
| **FEFO layer** | A quantity of stock with a known expiry date (first-expiring, first-out). |
| **Channel partition** | The rule that separates retail from dine-in demand so a dish settled through the kitchen is not also counted as a POS line. |

## 6. RACI

| Activity | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| Maintain planning settings & item policies | Planner (`scm_plan`) | Controller | Head chef | Branch managers |
| Review a Draft plan, adjust quantities, submit | Planner (`scm_plan`) | Controller | Branch manager | — |
| Approve / reject a submitted plan | Approver (`scm_approve`) ≠ the submitter | Controller | Planner | Purchasing |
| Convert an approved plan to a requisition | Planner (`scm_plan`) | Controller | Purchasing | Finance |
| Investigate a demand spike | Planner | Controller | Branch manager | — |
| Monitor job health & forecast accuracy | IT Ops / Planner | Controller | — | Internal audit |

## 7. Process narrative

### 7.1 Extracting the demand signal

A planning run begins by reconstructing, for each planning unit, how much of each menu item was actually sold
per business day (Asia/Bangkok), over a configurable look-back (default 400 days).

Demand is read from **two channels, partitioned so neither dish is counted twice**. This is not a detail: when
a dine-in check is settled, the checkout copies every non-voided order line — **including the ฿0 buffet
lines** — into the POS sale tables. A naive union of the POS and kitchen tables therefore counts every dine-in
dish twice and would systematically over-order. The process instead reads:

- the **retail leg** from POS sales, *excluding* anything settled as a dine-in or split payment; and
- the **restaurant leg** from the kitchen order lines directly, which is also the only place an order that has
  not yet been paid appears.

Only SKUs that carry a recipe count as dish demand, so service charges and synthetic split-bill lines can
never enter the signal. Dine-in orders carry no branch of their own, so they are attributed to the outlet
named in settings (`dine_in_branch_id`); when that is unset the demand pools in the untagged unit, and the
share that did so is reported on every run so the misconfiguration is visible rather than silent.

Two classes of day are then removed from the fitted history: days the branch was **closed** (a configured
weekday or a dated closure), and days flagged as **stocked out**. A stockout is a supply cap, not observed
demand — leaving those zeros in teaches the forecast that demand fell, which suppresses the next order and
prolongs the stockout.

### 7.2 Forecasting demand

Each (branch, menu item) series is forecast over the planning horizon (default 14 days). Series are not all
alike — a daily staple and an occasional special need different treatment — so each is classified by how often
it sells and how variable those sales are, and routed to a model suited to that pattern (seasonal, intermittent
or sparse). The Thai public-holiday calendar, tenant promotions and the local pay cycle are supplied as inputs
so the forecast anticipates them rather than being surprised.

The forecaster returns a **distribution**, not a single number: many simulated future paths, from which any
quantile can be read. This is what makes cost-based ordering possible in §7.4.

Where the external compute engine is disabled or unreachable, the run degrades to an in-process forecast and
says so on the plan (`engine: fallback`). Planning never stops because an optional service is down.

### 7.3 Exploding menu demand to ingredients

Ordering happens at ingredient level, but the signal (seasonality, holidays) lives at menu level. Each menu
item's forecast is therefore exploded through its recipe, allowing for yield and preparation waste, to give
ingredient demand.

The explosion is applied **to each simulated path**, not to summary quantiles. Quantiles are not additive — the
95th percentile of a total is not the sum of the 95th percentiles — and combining them would both misstate the
number and destroy the fact that a busy Songkran evening lifts every dish at once.

### 7.4 Sizing the order

For each ingredient the process computes what to order today against:

- the **cost of being short** (lost margin plus goodwill) versus the **cost of surplus** (purchase cost less
  salvage, plus disposal) — their ratio sets the demand quantile the order aims at;
- **lead time and its variability**, taken from that item's own recent receipt history where enough
  observations exist, otherwise from the supplier or item master;
- **shelf life**, so the plan never buys more than can be sold within the goods' own life;
- **current stock by remaining life** (the FEFO layers) and quantities already **in transit** on open POs; and
- ordering constraints — minimum order quantity, pack size, and any fixed cost per order.

Each proposed line records the reasoning behind it: the model used, expected fill rate, expected waste and
lost sales, the per-day order-up-to and safety-stock levels, and any cap that was applied. A reviewer can
therefore see *why* a number was proposed, which is what makes the quantity reviewable at all.

Quantities returned by the external engine are validated and **clamped** before they are stored, so a faulty
or compromised compute service cannot place an absurd quantity in front of a hurried approver.

### 7.5 Approval and hand-off to purchasing — control SCM-01

A run never produces an order. It produces a **Draft** plan per branch.

1. The planner reviews the Draft, adjusts any line quantity, and **submits** it. The plan moves to
   *PendingApproval* and appears in the GOV-01 pending-approvals centre with its value and age.
2. An **approver** acts on it. Approval requires the `scm_approve` duty, which is a single-purpose permission
   no broad module grant confers, and the approver **must be a different person from the submitter** —
   self-approval is refused (`SOD_SELF_APPROVAL`). Because nightly plans are created by the scheduler rather
   than a person, the "maker" for this test is the human who *submitted*, never the system that created it.
3. Rejection requires a reason and returns the plan to the planner, who can adjust and resubmit.
4. Only an **approved** plan may be **converted**, which raises a **purchase requisition** through the normal
   purchasing process — this module never writes a purchase order directly. The requisition number is stamped
   on the plan, so converting twice cannot raise two requisitions.

From that point the requisition follows the existing procure-to-pay controls (PN-02): approval thresholds,
purchase order, receiving and three-way match. **This process posts no journal entries.**

### 7.6 Demand spikes and replanning — control SCM-02

Demand does not only change overnight. Each (branch, item) series carries a running baseline of its normal
level and variability, plus a cumulative-deviation detector that catches a slow drift as well as a sudden
jump. An observation is judged **against the baseline as it stood before that day** — scoring it after folding
it in would let a large spike inflate its own reference and hide itself.

When a series breaches its threshold (subject to a minimum-volume floor, so small-number noise is ignored) an
event is recorded, the planner is notified, and — if the tenant has enabled automatic replanning — **one**
replan job is queued for that branch covering all of its spiking items. A replan is an ordinary, narrower
planning run: it produces a Draft plan that still requires the same independent approval.

Two dedupe mechanisms keep this proportionate: an event is unique per (branch, item, business day), and a
cooldown suppresses repeat firing. One viral evening therefore produces one event and one replan job, not
forty.

### 7.7 Scheduling, idempotency and failure handling — control SCM-02

The nightly plan and the spike scan are scheduled like any other recurring job. Both are **idempotent by
construction**: at most one non-failed nightly run can exist per tenant per business day (enforced by the
database, not by convention), and the spike scan advances a per-series watermark so it only ever folds in
business days it has not already processed — running it hourly and running it daily give the same result.

Job failures are handled by the shared queue: retry with backoff, then dead-letter with an operations alert
and an administrator notification. A failed run records the full underlying error so the cause is diagnosable
afterwards rather than appearing as an unexplained absence of a plan.

### 7.8 Scenario planning

Planners can ask "what if?" — a bounded, synchronous evaluation over a handful of items with an adjusted
demand multiplier, service level or horizon (for example, doubling demand for a festival). Scenarios are
advisory: they compute and return, and **write nothing**.

### 7.9 Forecast reconciliation hierarchy (docs/58 Track C · C1)

Per-(branch, item) forecasts are produced independently, so their roll-ups do not naturally sum coherently
across item→category→total or branch→region→company. To prepare for coherent multi-level views and
reconciliation (Track C), a planner can **declare an aggregation structure** as governed master data:
`PUT /api/scm-planning/hierarchy` accepts, per axis (`branch` or `item`), a set of nodes each naming its
parent (branch → region → company, region rows tagged `group`). The service validates the declaration is a
forest — unique node codes, every parent resolvable, no cycle (a violation is rejected `SCM_HIERARCHY_INVALID`)
— and stores it in `scm_forecast_hierarchy` (tenant-scoped, RLS). Where a tenant declares nothing, the
**forest is synthesized** from the native structure — one *Total* root over one leaf per active branch, or
one leaf per item category — so Track C stays off (docs/54 behaviour) until a tenant opts in. `GET
…/hierarchy/forest?axis=` returns the assembled forest (source `declared` or `synthesized`) that the
reconciliation step (C2, forthcoming) consumes. This is **definition only**: it introduces no new control
(reconciliation is a forecast-quality property; SCM-01/02/03 still govern the run and its approval) and does
not yet change any forecast number.

### 7.10 Promotion & price-effect demand (docs/56 Track A · A1) — control SCM-04

Forecasts respond to more than the calendar: a governed **promotion** lifts demand, and the planner should
order to the promoted level, not the baseline. On each planning run the API assembles the promo signal
**server-side** (`ScmPromoExtractService`) from the tenant's **approved, active, date-ranged** `promotions`
(category-scoped) under RLS — a per-`(menu sku, business day)` `promo_flag`/`discount` regressor over the
history and the horizon. Crucially this is **never taken from the run request**: a run cannot assert a promo
that does not exist in the governed data, so a fabricated or ungoverned promo has no way into the forecast
(**control SCM-04**, preventive). The forecast engine consumes the regressor — Prophet fits it as a learned
coefficient (generalizing the existing payday regressor); the intermittent/bootstrap paths apply a
capped multiplicative uplift (`U_MAX`, so a fat-fingered discount cannot plant an absurd path). Each forecast
persists its **attribution** (promo uplift %, the regressors used) onto `scm_demand_forecasts`, so a reviewer
can see that a line's lift is the approved weekend promo — and tie it back to its source — rather than a
trend. Advisory what-ifs run with `scenario=true` and are barred from the auto-convert path; a production run
is always `scenario=false`. Price elasticity is a later phase (A2); A1 carries the promo/discount lever.

### 7.11 Coherent forecast reconciliation (docs/58 Track C · C2)

Independent per-(branch, item) forecasts do not naturally sum to a coherent chain total. Track C adds a
**reconciliation step** between forecasting and order sizing: on each engine-backed run the API sends the
forecast engine an aggregation forest (currently a bottom-up TOTAL over the branch's menu series, using the
hierarchy declared in §7.9 or the synthesized default), and the engine returns a **reconciled** result per
node — leaves *and* aggregates — that sum coherently, reconciled on the sample paths (not the quantiles,
which are not additive). The API then explodes the **reconciled leaf** paths to ingredients. For bottom-up
the leaves are unchanged (so branch order quantities are unaffected) while the aggregates now equal their
children exactly, giving the planner a coherent multi-level view. A **trust boundary** applies: the API
checks the returned aggregate really equals the sum of its leaves within tolerance and, on any violation,
falls back to the base forecast rather than persisting an incoherent one. This is a forecast-quality
property, not a new authority — it introduces **no new control** (SCM-01/02/03 still govern the run and its
approval) and changes no GL posting. Top-down and the optimal MinT reconciliation are later phases (C3/C4).

### 7.12 Multi-echelon supply-network master data (docs/57 Track B · B1)

The docs/54 planner sizes each `(branch, ingredient)` in isolation. A chain that stocks through a central
kitchen or distribution centre (DC) can do better — pooling the safety buffer one tier up meets the same
branch service level with materially less system inventory. Track B models that topology explicitly; **B1
lands the governed master data it needs**, definition only (the two-echelon optimizer is B2). A planner
declares the supply network as a directed graph of **nodes** (`supply_nodes`: a `supplier` (echelon 0),
`central_kitchen`/`dc` (echelon 1), or `branch` (echelon 2, linked to the intra-tenant `branches` row) with
its holding cost and service-time commitment) and **lanes** (`supply_lanes`: a directed edge carrying that
lane's lead-time mean/σ, unit cost, MOQ, pack size and fixed order cost) through `POST /api/scm-network/
nodes|lanes`. Both tables are tenant-scoped (migration 0463, canonical 0232-form RLS loop + leading
`(tenant_id, …)` index); every mutation carries a combined `(id, tenant)` guard so an id is never assumed to
belong to the caller, and a lane's endpoints must both be the caller's own nodes. `GET
/api/scm-network/topology` assembles the active nodes + lanes and **validates** them: `kind`↔`echelon`
consistency, at most two stocking echelons (a third tier is rejected `ECHELON_DEPTH_EXCEEDED`), each lane
steps down exactly one echelon and no node is multi-sourced, the graph is acyclic (`NETWORK_NOT_DAG`), and
every branch is reachable from a supplier through a DC (else `UNREACHABLE_BRANCH`). The API never trusts a
topology from the engine — it is validated here before any optimize call. B1 introduces **no new control**
(SCM-05/SCM-06 arrive with the optimizer and allocation in B2/B3) and posts no GL entries; it is topology
definition that a later network run will consume.

### 7.13 Own-price elasticity (docs/56 Track A · A2)

A promotion is not only a calendar flag — it is a **price cut**, and how much demand a price move buys is
the item's **own-price elasticity** ε. A2 estimates it and puts it to work in the advisory scenario tool.
The signal is server-derived: `ScmPromoExtractService` now emits, per menu sku per business day, the
**effective price** (the item's base price reduced by any governed promotion's discount that day), so a
promotion's price cut becomes the price *variation* over history — never taken from the run request. The
engine estimates ε as the slope of an **OLS log-log fit** of demand on price over the observed history
(stockout-censored days excluded), gated by an **identifiability floor**: unless there are enough paired
observations, real price movement, and a credible fit (r²), it returns **ε = null** — a spurious elasticity
is never emitted. A credible ε (clamped to a sane band) is returned in the forecast attribution; the run
persists it to `scm_price_elasticity` (migration 0464, tenant-scoped) via `ScmElasticityService`, keyed by
`(tenant, item[, branch])` and readable at `GET /api/scm-planning/elasticity`. The **scenario what-if**
gains an optional `price_multiplier`: for each menu item it applies `demand × (price_multiplier)^ε` (with no
credible ε on file the response is 1 — unchanged), so a planner can ask "what if we raise this price 10%?"
and see the demand — and the order — respond. This is **advisory only** (scenario persists nothing and never
becomes an order) and introduces **no new control**; ε is a forecast-quality input governed by the same
SCM-01/02/03 as the run. Cannibalization across sibling items is the next phase (A3).

### 7.14 Cannibalization & halo — cross-price elasticity (docs/56 Track A · A3)

A price move on one item rarely stays with that item: cut the price of one dish and a similar dish beside
it may sell less (**cannibalization**), while some pairings sell *more* together (**halo**). A3 models this
as a **category-scoped cross-price elasticity** γ_{a,b} = ∂log(demand_a)/∂log(price_b), estimated API-side
(`ScmCrossElasticityService`) from the same governed data a run already extracts — per-item demand and the
server-derived effective price — using the **same log-log OLS with the same identifiability floor** as the
own-price elasticity (γ = null when not identified, so a spurious cross term is never emitted). Crucially it
is estimated **only for sibling pairs that share an `item_categories` category** — never the full
cross-product — which keeps it tractable and meaningful (a drink's price should not "explain" an unrelated
ingredient). A run persists the credible pairs to `scm_cross_elasticity` (migration 0466, tenant-scoped);
`GET /api/scm-planning/cross-elasticity` lists them. The **scenario what-if** now composes both effects: for
each item in the what-if whose price moved, its demand responds through its own ε **and** the cross-elasticity
of every sibling whose price also moved in that scenario — total exponent `ε_i + Σ γ_{i,j}`, so
`demand_i × (price_multiplier)^(ε_i + Σ γ_{i,j})`. γ>0 (substitutes) offsets the own-price lift of a price
cut; γ<0 (complements) reinforces it. With nothing on file the response is 1 (unchanged). **Advisory only**,
**no new control** — the same forecast-quality governance as A2. This completes Track A's demand-shaping
levers (promo, own-price, cross-price); attribute-based cold-start (A4) is a later wave.

## 8. Process flow

```mermaid
flowchart TD
  subgraph Signal
    A[POS retail sales<br/>excl. dine-in / split] --> C[Per-branch, per-item<br/>daily demand]
    B[Kitchen order lines<br/>incl. ฿0 buffet] --> C
    C --> D[Remove closed days<br/>+ stockout-censored days]
    D --> E[Thai holidays · promotions · payday]
  end
  E --> F{External engine<br/>configured?}
  F -- yes --> G[Probabilistic forecast<br/>per menu item]
  F -- no --> G2[In-process forecast<br/>engine = fallback]
  G --> H[Explode to ingredients<br/>through the recipe, per path]
  G2 --> H
  H --> I[Size the order:<br/>shortage vs surplus cost,<br/>shelf life, lead time,<br/>FEFO stock, in transit]
  I --> J[(Draft order plan<br/>per branch)]
  J --> K[Planner reviews / edits<br/>and SUBMITS]
  K --> L[[GOV-01 pending approvals]]
  L --> M{Approver ≠ submitter<br/>holds scm_approve?}
  M -- no --> N[403 SOD_SELF_APPROVAL<br/>or permission denied]
  M -- reject --> O[Rejected + reason<br/>→ back to planner]
  M -- approve --> P[Approved]
  P --> Q[Convert → Purchase requisition<br/>idempotent by pr_no]
  Q --> R[[PN-02 procure-to-pay:<br/>PR approval → PO → GR → match]]
  S[Sales arrive] --> T[Spike detector<br/>baseline + cumulative deviation]
  T -->|breach, deduped + cooldown| U[Spike event + planner alert]
  U -->|auto-replan enabled| V[One replan job per branch]
  V --> I
```

## 9. Control matrix

| Control | Type | Frequency | Description | Evidence |
|---|---|---|---|---|
| **SCM-01** | Preventive · Automated | Per plan | An order plan is built and submitted by a planner but can only be approved by a different user holding `scm_approve`; self-approval is refused. Only an approved plan converts, and conversion raises a purchase requisition through the purchasing API, idempotently. Engine quantities are clamped before storage. | Order plans with maker/checker identities, the GOV-01 queue entry, the linked requisition number |
| **SCM-02** | Detective/Preventive · Automated | Per scheduled run | Planning jobs ride the shared queue (retry → dead-letter → ops alert). A duplicate nightly enqueue plans exactly once (database-enforced); the spike scan is watermarked so any cadence is idempotent; spike events are deduped per day with a cooldown. | Plan-run register (status, engine, error), spike-event register, background-job rows |
| **SCM-03** | Preventive/Detective · Automated | Per planning run | Demand is extracted by channel partition so a dine-in dish is counted once; closed and stockout days are excluded; menu demand is exploded per scenario; order size respects shelf life, lead-time variability and FEFO stock; every line records its rationale. The shelf-life cap holds even when the external engine is unavailable. | Demand forecasts per run with accuracy, order-plan lines with full rationale |
| **SCM-04** | Preventive · Automated | Per planning run | Promo/price forecast inputs are governed and auditable: the `promo_flag`/`discount` regressors on a production run are **server-derived** from the tenant's approved `promotions` under RLS (never the request body), so a fabricated promo cannot inflate a forecast. Advisory what-ifs are `scenario`-flagged and barred from auto-convert; a per-day uplift cap plus the order clamp bound any residual lift; each forecast persists its promo attribution. | Demand forecasts carrying promo/price attribution tied to approved promotions |
| INV-10 | — | Per waste event | Waste/spoilage capture feeds the observed spoilage rate used to calibrate planning. | Waste log by reason |
| GOV-01 | Detective | Continuous | Submitted plans appear in the unified pending-approvals monitor with their age. | Pending-approvals worklist |

**Segregation of duties.** Rule **R24** flags any user holding both `scm_plan` (build/edit plans) and
`scm_approve` (approve them). The `Planner` role is seeded with `scm_plan` only. The in-application
maker ≠ checker test is the operative control regardless of the permissions held.

## 10. Inputs & outputs

| Inputs | Outputs |
|---|---|
| POS sales + kitchen order lines (demand) | Per-(branch, item) demand forecasts with accuracy |
| Recipes / BoM (menu → ingredient) | Draft order plans with per-line rationale |
| FEFO stock layers, branch stock, open purchase orders | Approved plans → purchase requisitions |
| Item master + per-(branch, item) policies (shelf life, service level, costs) | Demand-spike events + replan runs |
| Thai holiday calendar, branch closures, pay cycle | Planning-run register (status, engine, errors, metrics) |
| Waste log (observed spoilage) | Scenario results (advisory, not persisted) |

## 11. Records & retention

| Record | Retention |
|---|---|
| Planning runs + demand forecasts | 90 days by default (configurable); pruned by the nightly job |
| Order plans + lines (approved / converted) | Retained with the purchasing record — the audit trail for committed spend |
| Draft plans never submitted | Pruned with their run |
| Demand baselines + spike events | Retained (baselines are running state; events are the replan audit trail) |
| Status-log entries for each plan transition | Per the standard document audit-trail retention |

## 12. KPIs

| KPI | Purpose |
|---|---|
| Forecast accuracy (WAPE) per branch/item | Is the forecast good enough to act on? Trend it monthly. |
| Waste cost from expiry/spoilage vs plan expectation | Did the plan's expected waste materialise? A persistent gap means the cost inputs are wrong. |
| Stockout / fill rate | The other half of the trade-off — a low waste figure bought with lost sales is not a win. |
| Plan approval lead time (submit → approve) | A stale queue is a control breakdown and a stockout risk. |
| Share of demand in the untagged branch unit | Should be ~0 once dine-in attribution is configured. |
| Spike events per week, and how many led to a replan | Detector tuning: too many is noise, zero is a threshold set too high. |

## 13. Exception handling

| Exception | Handling |
|---|---|
| External engine unavailable / not configured | Run continues in-process (`engine: fallback`); the shelf-life cap still applies. Only one of the two engine settings present raises a one-time misconfiguration alert. |
| Engine returns an unexpected response | The response is rejected, the run fails with the reason recorded, and the queue retries then dead-letters with an ops alert. |
| Engine returns an implausible quantity | Clamped before storage and flagged on the line. |
| Item has no recipe / no shelf life recorded | The item is excluded from ingredient planning; shelf life can be suggested from receipt history and applied deliberately. |
| Dine-in branch attribution unset | Demand pools in the untagged unit; the share is reported on every run so it is visible. |
| Plan submitted with no positive quantity | Rejected (`PLAN_EMPTY`). |
| Approver is the submitter | Refused (`SOD_SELF_APPROVAL`); under the SME control profile, permitted only with a recorded justification. |
| Plan already converted | Re-conversion returns the original requisition number; no second requisition is raised. |

## 14. Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-07-21 | Supply-chain / Planning | Initial narrative — docs/54 Phase 2: per-(branch, item) probabilistic demand planning and perishable-aware order optimization. New controls SCM-01/02/03, migration `0459`, permissions `scm_plan`/`scm_approve`, SoD rule R24, harness `cutover/scm.ts` (20 checks). |
| 0.4 | 2026-07-22 | Supply-chain / Planning | Added §7.11 — coherent forecast reconciliation (docs/58 Track C · C2): the API sends a bottom-up aggregation forest and explodes the reconciled leaf paths (coherence trust-boundary → degrade to base). No new control (SCM-01/02/03 unchanged), no GL/schema change. Harness `cutover/scm.ts` +1 C2 check. |
| 0.7 | 2026-07-22 | Supply-chain / Planning | Added §7.14 — cannibalization & halo cross-price elasticity (docs/56 Track A · A3): `ScmCrossElasticityService` estimates γ_{a,b}=∂log(demand_a)/∂log(price_b) API-side by log-log OLS with the A2 identifiability floor, CATEGORY-SCOPED to `item_categories` siblings only (never the full cross-product); a run persists credible pairs to `scm_cross_elasticity` (migration 0466); `GET /api/scm-planning/cross-elasticity`. The scenario what-if composes own ε + Σ sibling γ (`demand × price^(ε+Σγ)`). Advisory only, no new control. apps/api vitest +7 (estimator) & `cutover/scm.ts` +3 A3 checks. |
| 0.6 | 2026-07-22 | Supply-chain / Planning | Added §7.13 — own-price elasticity (docs/56 Track A · A2): `ScmPromoExtractService` emits a governed effective price (base × (1−discount)) so a promo's price cut identifies ε; the engine estimates ε by an OLS log-log fit with an identifiability floor (ε=null when not identified), returned in attribution; the run persists it to `scm_price_elasticity` (migration 0464) via `ScmElasticityService` (`GET /api/scm-planning/elasticity`); the scenario what-if gains `price_multiplier` applying `demand × (price)^ε`. Advisory only, no new control. Harness `cutover/scm.ts` +4 A2 checks; engine pytest +7. |
| 0.5 | 2026-07-22 | Supply-chain / Planning | Added §7.12 — multi-echelon supply-network master data (docs/57 Track B · B1): governed `supply_nodes`/`supply_lanes` (migration 0463, canonical RLS + tenant-leading index) via `POST /api/scm-network/nodes\|lanes`, and `GET /api/scm-network/topology` assembling + validating the two-echelon DAG (kind↔echelon, ≤2 stocking echelons, single-sourcing, acyclic, branch reachability). Definition only — no new control (SCM-05/06 arrive with the optimizer in B2/B3), no GL. New `modules/scm-network` bounded context. Harness `cutover/scm.ts` +8 B1 checks. |
| 0.3 | 2026-07-22 | Supply-chain / Planning | Added §7.10 — promotion & price-effect demand (docs/56 Track A · A1): server-derived promo/discount regressors from approved `promotions` under RLS (never client input), Prophet `add_regressor` + capped Croston/bootstrap uplift, attribution persisted on `scm_demand_forecasts` (migration 0462). New control **SCM-04** (promo-forecast governance) in the control matrix. Harness `cutover/scm.ts` +3 A1 checks. |
| 0.2 | 2026-07-22 | Supply-chain / Planning | Added §7.9 — forecast reconciliation hierarchy (docs/58 Track C · C1): declare/synthesize aggregation structures via `scm_forecast_hierarchy` (migration `0461`) and `GET/PUT/DELETE /api/scm-planning/hierarchy(/forest)`. Definition only — no new control (SCM-01/02/03 unchanged), no forecast-number change yet (reconciliation lands with C2). Harness `cutover/scm.ts` +4 C1 checks. |
