# 57 · Track B — Multi-echelon (supplier → DC → branch) replenishment

**Status: DRAFT v0.4 · 2026-07-23** · Owner: Supply-chain / Planning · Depends on **docs/54**
(delivered — `services/forecast-engine` + `modules/scm-planning`) and **docs/55 §4** (Track B phases
B1–B4, cross-cutting rules, controls SCM-05/SCM-06)

Plan for the largest SCM depth lift: order across **tiers** (supplier → distribution centre / central
kitchen → branch) with **risk pooling** at the DC, rather than treating each of the 33 branches in
isolation. The TypeScript ERP stays the system of record and orchestrator; the OR compute extends the
existing stateless Python engine with a **new route** `/v1/optimize-network`. Strictly **two stocking
echelons** to start (DC + branch), a deliberate scope boundary argued in §1 and §9.

This is a **planning document only** — no code, contract, schema, or control change lands with it.
Every forward-looking piece below is marked *planned*.

---

## 1. Problem & approach

### 1.1 Why per-branch-in-isolation is wrong

docs/54 plans each `(branch, ingredient)` against that branch's own demand and its own supplier lead
time. For a chain that stocks through a **central kitchen / DC**, that is provably wasteful: every
branch carries its own safety stock against its own lead-time uncertainty, and the chain pays for the
sum. Consolidating the buffer one tier up **pools** the branch-level noise, so the same end-customer
service level is met with materially less system inventory. Track B models the topology explicitly and
places the buffer where it is cheapest.

### 1.2 Network topology (the master data of §3)

The tenant's supply network is a **directed acyclic graph** of stocking/flow nodes:

```
supplier ──lane──▶ DC / central kitchen ──lane──▶ branch (end-customer demand)
 echelon 0            echelon 1                      echelon 2
 (source)         (pools risk here)            (leaf; observed demand)
```

- **Nodes** carry a `kind` (`supplier` / `central_kitchen` / `dc` / `branch`) and an **echelon**
  index. Suppliers (echelon 0) are unbounded external sources — no base-stock, only a lane lead time.
  The DC (echelon 1) and branches (echelon 2) are the two **stocking** echelons this track optimizes.
- **Lanes** are the edges: each carries its own `lead_time {mean, std}`, `unit_cost`, `moq`,
  `pack_size`, `fixed_order_cost`. A branch is served by exactly one inbound lane from its DC; a DC by
  one inbound lane from its supplier. (Multi-sourcing and >2 echelons are explicitly out of scope — §9.)

Topology is **governed master data** (B1), not inferred: it is declared, validated (DAG, exactly two
stocking echelons, every branch reachable from a DC), and version-audited.

### 1.3 Two-echelon risk pooling (the reason the whole track exists)

Let branch `i` face protection-period demand with mean `μ_i` and standard deviation `σ_i`. Held
independently, branch safety stock is `z·σ_i` each, totalling `z·Σ_i σ_i`. Held **pooled at the DC**
against the aggregate:

```
σ_DC = √( Σ_i σ_i²  +  2·Σ_{i<j} ρ_ij·σ_i·σ_j )   ≤   Σ_i σ_i
```

Equality holds only at perfect positive correlation (`ρ_ij = 1`); for imperfectly correlated branch
demand `σ_DC` is strictly smaller, and the **pooling benefit** `Σσ_i − σ_DC` is the saving Track B
harvests. The correlation matrix `ρ` is estimated from the same per-branch history the docs/54
extractor already produces. The engine **reports** `independent_safety_units` vs `pooled_safety_units`
per run so the benefit is visible, never asserted.

### 1.4 Base-stock via a guaranteed-service MEIO approximation

We use the **guaranteed-service model** (GSM; Graves–Willems / Simchi-Levi), which is the tractable,
auditable MEIO approximation — as opposed to the stochastic-service (Clark–Scarf exact) recursion,
which does not close-form on a general tree and is far harder to explain to an approver.

Each node `v` commits an **outbound service time** `S_out(v)` (days it guarantees to fill a downstream
order) and sees an **inbound service time** `S_in(v)` = the outbound time of its supplying node. Its
**net replenishment lead time** is

```
τ(v) = S_in(v) + L(inbound lane, v) − S_out(v)          (τ ≥ 0 enforced)
```

and its **installation base-stock** covers demand over `τ` at the node's service level:

```
B(v) = μ(v)·τ(v)  +  z_α·σ(v)·√τ(v)        (σ(v) = σ_DC at the DC, σ_i at a branch)
```

The **decision** is the service-time vector `{S_out}` that minimizes total safety-stock holding cost
across both echelons subject to the guaranteed end-customer service (`S_out(branch) = 0`, i.e. branches
serve the customer off the shelf). For a single-DC distribution tree the Graves–Willems dynamic program
**collapses to a one-dimensional search** over the DC's outbound service time `S_out(DC) ∈ [0, L_branch]`
— cheap, deterministic, and easy to certify. That collapse is *why* we start at 2 echelons (§9).

**Echelon vs installation.** The DC's **echelon base-stock** (its own stock plus all downstream stock
and in-transit) must dominate the aggregate of its branches' installation base-stock — a coherence
invariant asserted as a test (§8), not the pooling claim of §1.3.

### 1.5 Fair-share allocation on DC shortage (B3)

When the DC's projected on-hand cannot cover the sum of branch replenishment orders in a period, the
engine **rations** rather than serving first-come. Given available `A < Σ_i r_i` (branch requests
`r_i`) and per-branch service-priority weights `w_i`:

- **Proportional** (default): `a_i = A · r_i / Σ_j r_j`.
- **Fair-share / equal-runout**: allocate so branches reach the **same projected days-of-cover** (or
  same fill probability) — the virtual-allocation rule; equalize `(on_hand_i + a_i)/μ_i` across `i`.
- **Priority-weighted**: fair-share within a priority tier before the next tier is served.

All three satisfy `0 ≤ a_i`, `Σ_i a_i ≤ A`, and are symmetric under equal `(r_i, w_i, μ_i)` — the
properties tested in §8. The **policy in force** is approved governed data; a per-run deviation from it
is an **override** that must be logged and second-approved (control SCM-06, §5).

### 1.6 DRP time-phased roll-up (B4)

Distribution Requirements Planning nets requirements bottom-up and time-phases them. Per branch `i`,
period `t`:

```
net_req_i[t]      = max(0, gross_req_i[t] − sched_receipts_i[t] − proj_on_hand_i[t−1])
planned_release_i = net_req_i[t] offset back by L(DC→branch)            (respecting moq/pack)
```

Branch planned **releases** become the DC's **gross requirements**:
`gross_req_DC[t] = Σ_i planned_release_i[t]`, then the DC is netted and time-phased the same way, and
the DC's planned releases become the **supplier's** gross requirements. The supplier-facing releases —
and only those — hand off to procurement as PRs. **The handoff reuses the existing
`ProcurementService.createPr` seam** (§4.4); Track B builds no new PR/PO writer.

---

## 2. Engine contract deltas

A **new route** `/v1/optimize-network` is added alongside `/v1/optimize`. `/v1/forecast` and
`/v1/optimize` are unchanged and back-compatible. TypeScript
(`packages/shared/src/scm-engine.ts`) stays the **source of truth**; `contracts.py` mirrors it; the
shared JSON fixtures under `services/forecast-engine/tests/fixtures` are parsed by **both** vitest
(`apps/api/test/scm-contract.test.ts`) and pytest, so contract drift fails one side's CI.

### 2.1 Contract-version bump

Adding a route + response fields is additive, but per docs/55 §2 rule 2 **any engine payload change
bumps the version**: `SCM_ENGINE_CONTRACT_VERSION '1' → '2'` (*planned*). Both the zod literals and the
pydantic `Literal["2"]` move together in one PR; the parity test proves they agree. Requests still carry
**no tenant identifiers and no PII** — node/lane codes and quantities only; extraction stays in the API
under RLS.

### 2.2 Request — `zOptimizeNetworkRequest` (sketch, *planned*)

One item at a time across the whole network (as `/v1/optimize` is chunked per item), so the payload is
a topology + per-branch demand paths + this item's cost params:

```ts
zNetworkNode   = { node_id, kind: 'supplier'|'central_kitchen'|'dc'|'branch', echelon: 0|1|2,
                   service_time_out_days?: number,          // branch (end customer) = 0
                   holding_cost_per_day: number,
                   current_inventory: [{ remaining_days, qty }],   // FEFO layers, perishable
                   in_transit: [{ arrival_ds, qty }] }
zNetworkLane   = { from_node, to_node,
                   lead_time: { mean_days, std_days },
                   unit_cost, moq, pack_size, fixed_order_cost }
zDemandPath    = { node_id,                                // a leaf/branch node
                   demand_scenarios: number[][] }          // K×H post-BoM-explosion paths
zOptimizeNetworkRequest = {
  contract_version: '2', request_id, start_ds, horizon_days,
  item_code, shelf_life_days, review_period_days,
  unit_price, salvage_value, disposal_cost, goodwill_cost,   // stockout/waste economics (as /v1/optimize)
  service_level,                                              // end-customer target
  nodes: zNetworkNode[], lanes: zNetworkLane[], demand_paths: zDemandPath[],
  allocation: { method: 'proportional'|'fair_share'|'priority',
                priorities?: Record<node_id, number> },
  time_budget_ms }
```

### 2.3 Response — `zOptimizeNetworkResponse` (sketch, *planned*)

```ts
zNetworkNodePlan = {
  node_id, echelon,
  service_time_out_days,                          // the GSM decision at this node
  base_stock: number[],                           // per horizon day — echelon base-stock
  installation_base_stock: number[],              // per horizon day — installation (own) base-stock
  safety_stock: number[],                         // per horizon day
  orders: [{ order_ds, arrival_ds, from_node, qty, packs }],
  expected: { fill_rate, lost_sales_units, waste_units, waste_cost, profit } }
zAllocation = { ds, from_node, to_node, requested, allocated, shortfall }   // emitted only on projected shortage
zOptimizeNetworkResponse = {
  contract_version: '2', request_id,
  node_plans: zNetworkNodePlan[],
  allocations: zAllocation[],
  pooling: { independent_safety_units, pooled_safety_units, pooling_benefit_pct },
  errors: zEngineItemError[] }
```

Reuse of existing pieces: `zEngineItemError`, `zEngineErrorEnvelope`, `SCM_ENGINE_HEADERS`, the HMAC
convention, and the `expected` FEFO-simulator metrics block are all unchanged. New engine item/error
codes (planned): `NETWORK_NOT_DAG`, `ECHELON_DEPTH_EXCEEDED`, `LANE_ENDPOINTS_INVALID`,
`UNREACHABLE_BRANCH`, `NEGATIVE_NET_LEAD_TIME`.

### 2.4 Shared-fixture parity rule

At least one `optimize-network` request+response fixture pair joins the shared corpus; the TS test and
pytest both round-trip it. A field added on one side without the other fails that side's CI — the same
drift guard docs/54 relies on.

---

## 3. Data model / migrations

A **new** `scm-network` schema shard (its own bounded context, §4). Two tenant tables, each with the
**canonical 0232-form RLS loop** and a **leading `(tenant_id, …)` index**, in a **journaled** migration
at the **next free `NNNN` at implementation** (re-derive from the `_journal.json` tail after any main
merge — docs/54 already consumed `0459`, so the network migration is well past `0428`).

### 3.1 `supply_nodes` (*planned*)

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `tenant_id` | int | RLS scope; **canonical 0232-form loop** |
| `node_code` | text | tenant-unique business key |
| `name` | text | |
| `kind` | text | `supplier` \| `central_kitchen` \| `dc` \| `branch` |
| `echelon` | int | 0 supplier · 1 DC · 2 branch |
| `branch_id` | int null | FK → `branches` when `kind='branch'` (intra-tenant link) |
| `service_time_out_days` | numeric | GSM outbound commitment; branch = 0 |
| `holding_cost_per_day` | numeric | per-unit holding at this node |
| `active` | bool | |
| `created_at` / `updated_at` | timestamptz | |

Index `idx_supply_nodes_tenant (tenant_id, node_code)`. `branch_id` links to the existing intra-tenant
`branches` (docs — a company is one tenant; branches are `branches.tenant_id`), so no `org_id` work.

### 3.2 `supply_lanes` (*planned*)

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `tenant_id` | int | RLS scope; **canonical 0232-form loop** |
| `from_node_id` / `to_node_id` | int | FK → `supply_nodes` |
| `lead_time_mean_days` / `lead_time_std_days` | numeric | per-lane lead-time distribution |
| `unit_cost` | numeric | landed cost on this lane |
| `moq` / `pack_size` / `fixed_order_cost` | numeric | per-lane ordering constraints |
| `active` | bool | |
| `created_at` / `updated_at` | timestamptz | |

Index `idx_supply_lanes_tenant (tenant_id, from_node_id, to_node_id)`. Migration rules honoured: append
one `_journal.json` entry (sequential `idx`, strictly ascending `when` > current max), grant `app_user`
in the `DO $$ … GRANT … $$` block, copy `0232`'s RLS body verbatim (never the plain `0081`/`0002` form).
Both tables carry a real `tenant_id` column, so the `tenant-idx` gate and the generic RLS loop apply —
they are genuinely tenant-scoped, not platform tables.

### 3.3 Network plan persistence (*planned*)

`scm_network_plans` / `scm_network_plan_lines` (echelon plans, per-node base-stock and orders,
allocations, maker/checker identities, `pr_no` on DC→supplier conversion) and `scm_allocation_policies`
(the approved fair-share policy per DC + its approval trail) — same maker-checker lifecycle columns as
the docs/54 `scm_order_plans`. All with the canonical RLS loop + tenant-leading index.

---

## 4. API / module design

### 4.1 A new bounded context: `modules/scm-network`

Per docs/55 §2 rule 1 and the CLAUDE.md Architecture-Gatekeeper Bounded-Context rule, multi-echelon
network planning is a **distinct business responsibility** — it is **not** appended to
`modules/scm-planning` (which owns single-tier branch/order plans) and it is **not** put in
`modules/procurement` just because it ends in a PR. It is a new sub-module, registered as **one line** in
`SupplyChainDomainModule` (docs/46 growth seam), re-exporting its services. Every file stays under the
600-LOC `check-service-size` ceiling; new logic lands as sub-services, never on a facade.

Services (*planned*):

- **`ScmNetworkService`** — master-data CRUD + topology validation (DAG, ≤ 2 stocking echelons, branch
  reachability, `kind`↔`echelon` consistency) and the plan lifecycle facade.
- **`ScmNetworkExtractService`** — builds the engine payload: nodes/lanes from §3, and the per-branch
  demand paths **by consuming `scm-planning`'s public forecast surface** (loose coupling — it calls the
  documented service API, never reaches into another module's tables or internal state, and runs no
  cross-domain SQL join). Correlation matrix `ρ` estimated here from the extracted branch histories.
- **`ScmNetworkRunService`** — orchestrates extract → engine (`/v1/optimize-network`) or in-process
  fallback → persist echelon plans + allocations → DRP roll-up. Reuses the docs/54
  `ScmEngineClientService` (HMAC, chunking, idempotency, version) — no second engine client.
- **`ScmAllocationService`** — evaluates/records the approved allocation policy and any per-run override.

### 4.2 Engine trust boundary (kept from docs/54)

The API zod-validates and **clamps** every engine quantity before persistence (qty ≥ 0, ≤ 2× node max,
`detail.clamped` flagged), and validates topology **before** calling out (`NETWORK_NOT_DAG` etc. are
rejected in the API, never trusted from the engine). A buggy/compromised engine cannot plant absurd
orders into a Draft plan.

### 4.3 Maker-checker on network plans

Network plans reuse the docs/54 duties **`scm_plan`** (build/edit) and **`scm_approve`** (approve),
binding the maker to the **submitter** (not `created_by` — nightly runs are scheduler-created). Self-
approval → `403 SOD_SELF_APPROVAL`; approve without `scm_approve` → 403 at the guard. Only an **Approved**
network plan may roll up to PRs. Setting or **overriding** the allocation policy is a distinct sub-duty
**`scm_allocate`** (*planned*), with a new **SoD rule R25** (build/override allocation vs approve it),
mirroring R24. `scm_allocate` is a sub-permission so no coarse module key confers it.

### 4.4 PR handoff — reuse, do not rebuild

The DRP roll-up's **supplier-facing** planned releases convert through the **exact same seam**
`scm-planning` already uses: `ProcurementService.createPr({ items, remarks: 'SCM network plan …',
reason: 'SCM-NET' }, user)` — the loose-coupling API that MRP `planToPr`, WMS `autoPr`, PMR, and
`convertPlanToPr` all share. Conversion is **idempotent** by `pr_no` (a second convert returns the first
PR). Track B posts **no GL entries** of its own and inserts **no** PR/PO rows directly.

---

## 5. Controls (RCM)

Two new controls land with their `build_rcm.py` `add(...)`, an **xlsx regenerate**
(`python3 compliance/build_rcm.py`), and a **census-span bump** across the tagged markdown
(`CONTROL_STATUS_HONEST.md`, `COSO_ICFR_Audit_Readiness_Plan.md`, `iso27001-gap-analysis.md`,
`soc2-readiness.md`), verified by `node tools/ci/check-rcm-census.mjs` — current total **+2** (re-derive
the live count at implementation; the `check-rcm-census` gate fails on any stale span).

### SCM-05 — Multi-echelon (network) plan approval *(Preventive; B2)*

**Assertion.** A multi-echelon network plan is built AND approved by **different** people before any
requirement rolls up to a purchase requisition. A network run persists plans as **Draft** (never
actionable); the planner edits and **submits** → PendingApproval, surfaced in GOV-01. Approval requires
**`scm_approve`** (a sub-permission; SoD **R24** flags `scm_plan`+`scm_approve`) AND approver ≠ submitter
(`assertMakerChecker` → `403 SOD_SELF_APPROVAL`). Only an **Approved** plan may roll up, and the roll-up
goes through the procurement PR API (idempotent by `pr_no`). Engine base-stock/order quantities are
zod-validated and **clamped** before persistence. **Test of one:** submit then approve as the submitter
→ 403; approve as a second `scm_approve` holder → Approved; convert → real `purchase_requests` rows,
re-convert → same `pr_no`; cross-tenant read/approve → nothing/404.

### SCM-06 — DC-shortage allocation fairness *(Preventive; B3)*

**Assertion.** When the DC cannot fill all branch orders, rationing follows the **approved** allocation
policy; deviations are **logged and second-approved**. The policy (method + priorities) is governed data
set/changed under **`scm_allocate`** + SoD **R25** (maker ≠ approver). At run time the engine allocates
by the approved method and returns per-lane `{requested, allocated, shortfall}`; the API asserts
`0 ≤ allocated`, `Σ allocated ≤ available`, and symmetry under equal inputs. A planner-entered **override**
of the computed fair-share is **rejected unless a justification is recorded** (`ALLOCATION_OVERRIDE_
UNLOGGED`) **and** it enters the two-person approval queue (`ESCALATION`-style), so no branch is
quietly favoured. **Test of one:** force a shortage → allocation is non-negative, sums to available, and
equal-priority equal-demand branches receive equal shares; an unjustified override → 403; a justified
override → staged for a second approver, not auto-applied.

---

## 6. Phases

| Phase | Scope & deliverables | Size | Control |
|---|---|---|---|
| **B1** | **Network master data.** `scm-network` sub-module + `supply_nodes` / `supply_lanes` (§3) with RLS + tenant-leading indexes + journaled migration; topology CRUD + validation (DAG, ≤ 2 stocking echelons, reachability); web master screen. Topology as governed master data. | M | — |
| **B2** | **Two-echelon optimization.** `/v1/optimize-network` (contract `1→2`), GSM base-stock + risk-pooling engine (§1.3–§1.4) + pytest soundness properties; `ScmNetworkExtractService` (correlation `ρ`, branch demand paths via scm-planning's public API) + `ScmNetworkRunService`; network-plan persistence + maker-checker; in-process fallback. | **XL** | **SCM-05** |
| **B3** | **Allocation & fair-share.** Shortage rationing (proportional / fair-share / priority, §1.5); approved allocation policy (`scm_allocate` + SoD R25) with logged, second-approved overrides. | L | **SCM-06** |
| **B4** | **DRP roll-up.** Time-phased branch→DC→supplier net-requirements (§1.6); supplier-facing releases hand off to the **existing** `ProcurementService.createPr` seam (reuse, do not rebuild). | L | — |

Each phase is ~1–3 doc-synced PRs (PN-34, user manual, UAT cycle 18, RCM). B2 is the architectural lift
(new optimizer + new module + correlation estimation); the rest builds on it.

---

## 7. UAT (extend cycle 18)

New cases append to cycle 18 (docs/54 shipped UAT-SCM-001..042); keep the traceability matrix and the
single-line `**Status: DRAFT vN**` header in sync (mind the doubling trap of CLAUDE.md mantra #18).

| Case | Type | Scenario | Expected |
|---|---|---|---|
| UAT-SCM-05x | Positive | Declare supplier→DC→branch topology, run a network plan | Draft echelon plans: DC + branch base-stock, `pooling_benefit_pct > 0` reported |
| UAT-SCM-05x | Control | Submit then approve as the **submitter** | `403 SOD_SELF_APPROVAL` |
| UAT-SCM-05x | Positive | Approve as a second `scm_approve` holder, then roll up | Approved → DRP releases → `createPr` PR; re-convert → same `pr_no` (idempotent) |
| UAT-SCM-05x | Negative | Declare a cyclic / 3-echelon topology | `NETWORK_NOT_DAG` / `ECHELON_DEPTH_EXCEEDED` at validation |
| UAT-SCM-06x | Control | Force a DC shortage; two equal-priority equal-demand branches | Allocation non-negative, `Σ ≤ available`, **equal shares** |
| UAT-SCM-06x | Control | Override the computed fair-share **without** a justification | `403 ALLOCATION_OVERRIDE_UNLOGGED` |
| UAT-SCM-06x | Control | Override **with** justification | Staged for a second approver (not auto-applied) |
| UAT-SCM-06x | Boundary | **Cross-tenant:** Tenant A reads/approves Tenant B's network plan or supply node ID | 0 rows / `404` — RLS isolation |

The cross-tenant boundary case is mandatory (CLAUDE.md Multi-Tenant Test Protocol).

## 8. Verification

- **Engine (pytest soundness — asserted as tests, docs/54 §3.5 flavour, *planned*):**
  1. **Echelon conservation** — at every node/period, receipts = issues + Δ on-hand (flow balance).
  2. **No-negative allocation** — `a_i ≥ 0` and `Σ a_i ≤ available` for all rationing methods;
     symmetry under equal `(r_i, w_i, μ_i)`.
  3. **Echelon coherence** — the DC's echelon base-stock ≥ the aggregate of its branches' installation
     base-stock, every day.
  4. **Pooling non-negativity** — `pooled_safety_units ≤ independent_safety_units` (benefit ≥ 0), with
     equality only at `ρ ≡ 1`.
  5. **Non-negative net lead time** — GSM `τ(v) ≥ 0` for every node after the service-time solve.
  6. **Degenerate reduction** — a single-branch, single-DC network reproduces the docs/54 single-tier
     newsvendor/MILP order for that item (the new route must not contradict the old one).
- **Contract parity (TS):** `pnpm --filter @ierp/api test:coverage` (includes `scm-contract.test.ts`;
  new `optimize-network` fixtures).
- **API / controls:** extend `tools/cutover/src/scm.ts` (the `scm` harness) — positive network run,
  maker-checker rejection, shortage-allocation fairness, override staging, and the cross-tenant
  boundary. Keep it in the `scm-mfg` shard (a new `cutover:` inside an existing shard needs **no**
  branch-protection change).
- **Gates:** shared build → `pnpm -r typecheck` → `pnpm -r build` → api coverage → the five ratchets
  (`check-service-size` for the new module files, `tenant-idx` for the two tables, `migrations-journaled`
  + `check-rcm-census` for the migration/controls).

## 9. Operational notes / risks

- **MEIO approximation limits.** GSM assumes demand is *covered* over the net lead time at the chosen
  service level and does **not** model stockout propagation between echelons (the DC never itself
  stocks out in the model). It is an approximation, not the Clark–Scarf exact policy — the correct
  altitude for a mid-market planner (docs/55 §0), and the reason we report pooling/fill diagnostics so a
  human can sanity-check rather than trust blindly.
- **Why 2 echelons first.** A single-DC, two-stocking-echelon distribution tree collapses the
  Graves–Willems service-time DP to a 1-D search (§1.4) — deterministic, fast, certifiable. General
  trees (multi-DC, cross-dock, >2 echelons, multi-sourcing) require the full spanning-tree DP and make
  the control story much harder; they are deliberately deferred.
- **Data needs.** Risk pooling is only real if the correlation `ρ` is estimated from enough clean
  per-branch history; sparse/short branches fall back to `ρ = 0` (independent) or the docs/54 single-tier
  planner. Lane lead-time distributions and node holding costs are new master data a tenant must
  populate before the pooling benefit is trustworthy.
- **Fallback.** As in docs/54, `SCM_ENGINE_URL`/`SCM_ENGINE_SECRET` unset ⇒ the API runs an in-process
  network fallback (independent per-branch base-stock + proportional allocation, no pooling) — safe and
  auditable, without the GSM optimum. Every output persists its rationale.
- **Golden-master / money paths.** Track B touches no golden-master money path (`buildSale`, ledger
  posting); it ends at a maker-checker'd PR. No re-pin expected.

## 10. Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.4 | 2026-07-23 | Supply-chain / Planning | **B2b delivered — the API half of B2.** New endpoints on the `modules/scm-network` bounded context: `POST /api/scm-network/plans/run {item_code}` builds a two-echelon plan; `GET /api/scm-network/plans[/:id]`; `POST /api/scm-network/plans/:id/{submit,approve,reject,convert}`. **Engine/fallback:** the run calls the B2a `/v1/optimize-network` route (GSM base-stock + risk pooling) when `SCM_ENGINE_URL`/`SCM_ENGINE_SECRET` are set and demand paths exist, else an **in-process fallback** (independent per-branch base-stock `B=μ·(L+R)+z·σ·√(L+R)`, DC echelon = Σ, no pooling — safe/auditable, §9); every engine quantity is zod-validated + **clamped** before persistence (the §4.2 trust boundary). Demand paths come via scm-planning's PUBLIC `demandPathsFor` seam (loose coupling — no cross-module table access, §4.1). **Persistence:** `scm_network_plans` + `scm_network_plan_lines` (migration **0471**, canonical 0232-form RLS loop excluding `audit_expectations`, leading tenant indexes); plans persist as **Draft** (never actionable). **Control SCM-05** (§5, Preventive): Draft→PendingApproval→Approved→Converted — build gated `scm_plan`; approve/reject gated `scm_approve` (**SoD R24 reused — NO new SoD rule**); approver ≠ submitter enforced by `assertMakerChecker` → **403 SOD_SELF_APPROVAL**, the maker bound to the SUBMITTER (not `created_by`). Only an Approved plan rolls the DC's supplier order up to a PR through the existing `ProcurementService.createPr` seam (reason `SCM-NET`, idempotent by `pr_no`). **No GL, no golden-master money path.** ToE: `tools/cutover/src/scm.ts` +8 B2 checks (fallback run persists Draft across both echelons + DC echelon base-stock ≥ branch installation; submit→PendingApproval; self-approve→403 `SOD_SELF_APPROVAL`; independent approve→Approved; convert→PR idempotent by `pr_no`; cross-tenant read→404), in the `scm-mfg` CI shard. Doc-sync: PN-34 §7.15 (rev 0.8) + control matrix SCM-05, manual ch.21 §2 (rev 0.8), UAT §14 (UAT-SCM-057..060) + traceability, RCM control **SCM-05** + census. **B3 next** — allocation & fair-share (SCM-06, SoD R25). |
| 0.3 | 2026-07-23 | Supply-chain / Planning | **B2a delivered — engine route + contract (the engine-only half of B2).** New **`/v1/optimize-network`** route on the stateless forecast-engine (`services/forecast-engine/app/network.py`): guaranteed-service two-echelon MEIO base-stock with risk pooling (§1.3–§1.4). One item at a time; the payload is a topology + per-branch demand paths + item economics (no tenant ids / PII). The 1-D service-time search over `S_out(DC) ∈ [0, L_supplier]` minimizes safety-stock holding cost across both echelons; pooled `σ_DC = √(Σσ_i² + 2Σρσσ)` is estimated from the branch demand paths; per-node ORDER schedules + `expected` FEFO metrics REUSE the docs/54 single-tier optimizer (`solve_item`/`simulate`) so a single-branch network reproduces the single-tier order. Fair-share `allocate()` (proportional / fair_share / priority) is a tested pure primitive; allocation LINES emit only on a projected DC shortage (the policy governance + logged overrides are **B3/SCM-06**). **Contract is ADDITIVE — no version bump** (still `2`): `zOptimizeNetworkRequest`/`zOptimizeNetworkResponse` (+ `zNetworkNode`/`zNetworkLane`/`zDemandPath`/pooling) added to `packages/shared/src/scm-engine.ts` (source of truth) + `contracts.py` mirror + a shared `optimize_network_{request,response}.json` fixture parsed by BOTH vitest and pytest. Verification: engine **pytest 87** (14 network soundness — valid plan / allocation non-negativity+symmetry / echelon coherence / pooling non-negativity + ρ≡1 equality / non-negative net lead time / degenerate reduction; + 3 fixture parity/e2e); TS `scm-contract.test.ts` **14**; `pnpm -r typecheck` clean. **B2b (next PR)** wires the API — `ScmNetworkExtractService` (correlation ρ + branch demand paths via scm-planning's public API) + `ScmNetworkRunService`, network-plan persistence + maker-checker, **control SCM-05**, the `scm` harness, and PN-34/manual/UAT/RCM doc-sync. No GL, no golden-master money path. |
| 0.2 | 2026-07-22 | Supply-chain / Planning | **B1 delivered.** New `modules/scm-network` bounded context + `supply_nodes`/`supply_lanes` (migration 0463, canonical 0232-form RLS loop + leading `(tenant_id, …)` index) via `POST /api/scm-network/nodes\|lanes` (governed master data, `scm_plan`-gated). `GET /api/scm-network/topology` assembles the active graph and validates it in `scm-network-topology.ts` — kind↔echelon consistency, ≤2 stocking echelons (`ECHELON_DEPTH_EXCEEDED`), each lane steps down exactly one echelon + single-sourcing (`LANE_ENDPOINTS_INVALID`/`MULTI_SOURCED_NODE`), acyclic (`NETWORK_NOT_DAG`), branch reachability (`UNREACHABLE_BRANCH`). No engine call, no contract change (the `/v1/optimize-network` route + contract `→2` bump land with **B2**), no control (SCM-05/06 arrive with B2/B3), no GL. Web master screen `/network` (nodes/lanes tabs + validity banner, use-client 289→290). ToE: `cutover/scm.ts` +8 B1 checks (declare/validate/reject-malformed/cross-tenant). Docs: PN-34 §7.12, manual ch.21 §2, UAT §10 (UAT-SCM-048..050). |
| 0.1 | 2026-07-21 | Supply-chain / Planning | Initial plan for docs/55 Track B — multi-echelon (supplier → DC → branch) replenishment: network topology as governed master data (`scm-network` sub-module, `supply_nodes` / `supply_lanes`), a guaranteed-service two-echelon MEIO base-stock approximation with risk pooling on the new `/v1/optimize-network` engine route (contract `1→2`), fair-share DC-shortage allocation, and a DRP time-phased roll-up that reuses the existing procurement PR handoff. New controls **SCM-05** (network-plan approval) / **SCM-06** (allocation fairness) + SoD **R25**. Phases B1–B4 (B2 XL). **Planning only — no code, contract, schema, or control change.** |
