# Fixed Assets & Depreciation — Process Narrative

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-09-FA |
| Process owner | `<<Controller / Fixed-Asset Accountant>>` |
| Approver | `<<CFO>>` |
| Version | **0.1 DRAFT** |
| Effective date | `<<effective-date>>` |
| Review cadence | Annual + on significant change |
| Related RCM controls | FA-01, FA-02, FA-03, FA-04, FA-05, FA-06, EXP-05, GL-01, REC-01; SoD R07, R05, R01 |
| Related policy | `compliance/policies/03-delegation-of-authority.md`, `compliance/policies/11-financial-close-policy.md` |

## 2. Purpose

To define and control the fixed-asset lifecycle — acquisition/capitalization, the asset register, periodic depreciation, custody/location tracking, and disposal — so that property, plant and equipment and accumulated depreciation are **valid, complete, accurate, properly cut off, and authorized**, that net book value (NBV) is fairly stated, and that every depreciation and disposal posting reaches the GL as a balanced journal entry.

## 3. Scope

**In scope:** asset categories and capitalization defaults (`/api/assets/categories`), asset acquisition (`POST /api/assets`, FA-), the asset/NBV register (`GET /api/assets`), QR labelling and custody scan-update (`/api/assets/scan-update`, non-GL), the per-asset depreciation schedule (`GET /api/assets/:assetNo/schedule`), the monthly straight-line depreciation run (`POST /api/assets/depreciation/run`, DEP-), and disposal (`PATCH /api/assets/:assetNo/dispose`, DISP-).

**Also in scope — Enterprise Asset Management (EAM):** maintenance **work orders** (`/api/eam/work-orders`, corrective/preventive/inspection), **preventive-maintenance (PM) schedules** (`/api/eam/pm-schedules`, time- or meter-based) with an idempotent **due-generation sweep** (`/api/eam/pm/run`, also a daily scheduled job `eam_pm_generate`), and **meter readings** (`/api/eam/assets/:assetNo/meter`). Completing a work order with a vendor cost raises an **AP payable** for the maintenance spend.

**Out of scope:** the manual journal lifecycle and period close that the FA postings flow through (see `04-general-ledger-close.md`), procurement and AP settlement of the asset purchase / maintenance (see `02-procure-to-pay.md`), and VAT on acquisition/disposal (see `06-tax-compliance.md`).

## 4. References

- ISO 9001:2015 cl. 4.4 (process approach), cl. 7.1.3 (infrastructure), cl. 7.5 (documented information), cl. 9.1 (monitoring/measurement).
- `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx` — FA-01..05, GL-01, REC-01.
- `compliance/policies/03-delegation-of-authority.md` (capital expenditure and disposal authority), `11-financial-close-policy.md` (depreciation cutoff).
- Code: `apps/api/src/modules/assets/assets.service.ts` + `assets.controller.ts`, `apps/api/src/modules/eam/eam.service.ts` + `eam.controller.ts` (EAM), `apps/api/src/modules/ledger/ledger.service.ts`, `apps/api/src/common/doc-number.service.ts`.

## 5. Definitions & abbreviations

| Term | Meaning |
|---|---|
| NBV | Net Book Value = cost − accumulated depreciation |
| Salvage | Estimated residual value; depreciation floors NBV at salvage |
| Useful life | `useful_life_months` over which cost less salvage is depreciated |
| FA- / DEP- / DISP- / MWO- | Document-number prefixes (acquisition / depreciation / disposal / maintenance work order) |
| Work order (WO) | A maintenance job against an asset: corrective, preventive or inspection; lifecycle open → in_progress → completed/cancelled |
| PM schedule | Preventive-maintenance plan per asset, time-based (`interval_days`) and/or meter-based (`meter_interval`) |
| Meter reading | A usage reading (`asset_meters`) that can trigger meter-based PM |
| Asset register | `GET /api/assets` — cost, accumulated depreciation, NBV totals |
| Scan-update | Location/holder change logged to `assetMovements` (custody audit, non-GL) |
| Idempotency key | `${tenant}:${period}` for a depreciation run |

GL accounts used: **1500** asset cost, **1590** accumulated depreciation (contra), **5200** depreciation expense, **1000** cash, **2000** AP, **1510** gain/loss on disposal, **5700** repairs & maintenance (EAM work-order cost), **2100** input VAT.

## 6. Roles & responsibilities (RACI)

Single-duty roles enforce SoD: the role that **initiates** an asset acquisition or disposal is never the role that **approves** it (rule **R07**); the role that **posts** the depreciation JE (`gl_post`) is separated from the role that **closes the period** (`gl_close`) (**R05**); and asset-master/category configuration access is administered separately (**R01**).

| Activity | FaAccountant | CustodianStaff | FinancialController | Controller | ExecutiveViewer / CFO |
|---|---|---|---|---|---|
| Maintain asset categories / capitalization defaults | **A/R** | I | C | A | I |
| Initiate asset acquisition (FA-) | **A/R** | I | I | C | I |
| Approve capitalization / capex | I | I | **A/R** | A | C |
| Custody scan-update (location/holder) | C | **A/R** | I | I | I |
| Run monthly depreciation (DEP-, `gl_post`) | **A/R** | I | I | A | I |
| Review depreciation run (idempotency + balanced JE) | R | I | **A/R** | A | I |
| Approve disposal (DISP-) | I | I | **A/R** | A | C |
| Review NBV register completeness | R | I | **A/R** | A | I |

## 7. Process narrative

1. **Category & capitalization defaults.** FaAccountant maintains asset categories via `POST /api/assets/categories` / `GET /api/assets/categories`; each category carries capitalization defaults (`useful_life_years = 5`, asset acct **1500**, accumulated acct **1590**, depreciation-expense acct **5200**). Category/master access is segregated from posting (**R01**, **FA-04**).
2. **Asset acquisition / capitalization (decision point).** FaAccountant initiates `POST /api/assets`. Useful life is mandatory — a request missing `useful_life_months` is rejected `NO_LIFE` (`400`). On capitalization a balanced acquisition JE (doc prefix **FA-**) posts **Dr 1500 Cr 1000** for a cash purchase or **Dr 1500 Cr 2000** for an on-account (AP) purchase; Σdebit = Σcredit by construction (**FA-01**, **GL-01**). Capex authorization is segregated from initiation (**R07**).
3. **Asset register / NBV.** `GET /api/assets` returns the register with cost, accumulated depreciation, and NBV totals. The register is the system of record for NBV completeness, reviewed by FinancialController against the GL 1500/1590 balances (**FA-05**, **REC-01**).
4. **QR labelling & custody (non-GL).** `GET /api/assets/:assetNo/qr` and `GET /api/assets/qr/labels` produce asset tags. `POST /api/assets/scan-update` records a location/holder change to `assetMovements` as a custody audit trail; this is **non-GL** (no posting) but supports existence/custody verification (**FA-04**).
5. **Depreciation schedule.** `GET /api/assets/:assetNo/schedule` exposes the per-asset straight-line schedule: monthly charge = (cost − salvage) / `useful_life_months`, with each period’s charge **capped at NBV − salvage** so NBV never falls below salvage.
6. **Monthly depreciation run (decision point).** FaAccountant runs `POST /api/assets/depreciation/run` for a period (`YYYY-MM`). The run is **idempotent per `${tenant}:${period}`** — a re-run for the same tenant/period does not double-post. Per-tenant it produces **ONE balanced entry per tenant per period** (doc prefix **DEP-**) so each shop trial balance ties: **Dr 5200 Cr 1590**. Fully-depreciated assets flip status when NBV ≤ salvage and stop accruing (**FA-02**, **GL-01**). The DEP- entry flows through the normal ledger period guard, so a **closed period is rejected** (`PERIOD_CLOSED`) — see `04-general-ledger-close.md`.
7. **Depreciation run review.** `GET /api/assets/depreciation/runs` lists prior runs. FinancialController reviews each run for idempotency (no duplicate period) and balanced posting before close (**FA-02**, **R05**).
8. **Disposal (decision point).** FinancialController-approved disposal is executed via `PATCH /api/assets/:assetNo/dispose`. A disposal of an already-disposed asset → `ALREADY_DISPOSED` (`400`); an unknown asset → `NOT_FOUND` (`404`). The balanced disposal JE (doc prefix **DISP-**) clears the asset: **Dr 1590** (remove accumulated) + **Dr 1000** (cash proceeds) + **Cr 1500** (remove cost). Gain/loss = proceeds − NBV: a **gain** posts **Cr 1510**, a **loss** posts **Dr 1510** (**FA-03**, **GL-01**). Disposal authorization is segregated from custody and from the FA register owner (**R07**).
9. **Maintenance (EAM).** A maintenance **work order** is raised against a registered asset (`POST /api/eam/work-orders`, **MWO-**; an unknown asset → `ASSET_NOT_FOUND`) and progresses through a guarded lifecycle **open → in_progress → completed/cancelled** (an out-of-order move → `BAD_TRANSITION`). On **completion with a vendor and an actual cost**, the maintenance spend is routed through **AP** (`createApTxn`, expense account **5700**): **Dr 5700** net **+ Dr 2100** input VAT **/ Cr 2000** gross — so the cost is a payable that settles through the normal AP flow and reconciles (in-house work with no vendor records the cost only). **PM schedules** (`POST /api/eam/pm-schedules`) define a preventive cadence (time `interval_days` and/or `meter_interval`, against `asset_meters` readings); the **due-generation sweep** (`POST /api/eam/pm/run`, cron-callable, and the daily scheduled job **`eam_pm_generate`** via the report scheduler) raises a preventive WO for every due schedule and rolls it forward. The sweep is **idempotent** — a schedule with an outstanding generated WO is skipped and its due date is advanced on generation (**FA-06**).

## 8. Process flow

```mermaid
flowchart TD
    A[FaAccountant POST /api/assets acquire] --> B{useful_life_months present? FA-01}
    B -- "No" --> B1[Reject NO_LIFE 400]
    B -- "Yes" --> C[Post FA- Dr 1500 Cr 1000 or Cr 2000 GL-01]
    C --> D[Asset register NBV GET /api/assets FA-05]
    D --> E[QR label + custody scan-update non-GL FA-04]
    E --> F[Run depreciation POST depreciation/run period YYYY-MM]
    F --> G{Idempotent per tenant:period? FA-02}
    G -- "already run" --> G1[No double-post - skip]
    G -- "new" --> H{Period open? GL period guard}
    H -- "Closed" --> H1[Reject PERIOD_CLOSED]
    H -- "Open" --> I[Post one DEP- per tenant Dr 5200 Cr 1590 GL-01]
    I --> J{NBV <= salvage?}
    J -- "Yes" --> J1[Flip status fully depreciated]
    J -- "No" --> K[Disposal requested]
    J1 --> K
    K --> L{Asset exists and not disposed? FA-03}
    L -- "missing" --> L1[Reject NOT_FOUND 404]
    L -- "already disposed" --> L2[Reject ALREADY_DISPOSED 400]
    L -- "OK approved" --> M[Post DISP- Dr 1590 Dr 1000 Cr 1500 gain Cr 1510 loss Dr 1510 GL-01]
```

**Swimlane description by role:** **FaAccountant** maintains categories, initiates acquisition, and runs monthly depreciation. **CustodianStaff** performs the QR scan-update for location/holder custody (non-GL). The **system** enforces the `NO_LIFE` guard, the per-tenant balanced posting, idempotency per tenant/period, the salvage cap, the fully-depreciated status flip, and routes every FA-/DEP-/DISP- entry through the ledger period guard. **FinancialController** approves capex and disposals, reviews each depreciation run and the NBV register tie-out. **Controller/CFO** owns capitalization defaults and final disposal authority.

## 9. Control matrix

| Step | Risk | Control | Type | RCM ID | Evidence / Record |
|---|---|---|---|---|---|
| 2 | Asset capitalized without depreciable life | `NO_LIFE` guard requires `useful_life_months` | Prev / Auto | FA-01 | `NO_LIFE` rejections; acquisition JE FA- |
| 2 | Acquisition unposted / unbalanced | Balanced FA- JE Dr 1500 Cr 1000/2000 | Prev / Auto | FA-01, GL-01 | Acquisition JE tie-out |
| 6 | Depreciation double-posted on re-run | Idempotency per `${tenant}:${period}` | Prev / Auto | FA-02 | Re-run test; `depreciation/runs` |
| 6 | Per-tenant TB does not tie | One balanced DEP- entry per tenant per period | Prev / Auto | FA-02, GL-01 | Per-tenant TB tie-out |
| 6 | Asset depreciated below salvage | Monthly charge capped at NBV − salvage; status flip | Prev / Auto | FA-02 | Schedule export; status log |
| 6 | Depreciation posted to closed period | Ledger period guard rejects `PERIOD_CLOSED` | Prev / Auto | FA-02, GL-01 | Close-lock test |
| 8 | Disposal mis-stated / double disposal | `ALREADY_DISPOSED`/`NOT_FOUND` guard; balanced DISP- with gain/loss | Prev / Auto | FA-03, GL-01 | Disposal JE; rejection tests |
| 4 | Asset existence/custody unverified | QR + scan-update to `assetMovements` custody audit | Det / Hybrid | FA-04 | `assetMovements` log; physical count |
| 3 | NBV register incomplete vs GL | NBV register completeness review vs 1500/1590 | Det / Hybrid | FA-05, REC-01 | Register-to-GL reconciliation |
| 2,8 | Self-initiated capex / disposal | SoD: initiate vs approve segregated | Prev / Manual | R07 | SoD conflict report |
| 6 | Poster also closes period | SoD: `gl_post` vs `gl_close` segregated | Prev / Manual | R05 | SoD conflict report |
| 1 | Unauthorized category/master change | Asset-master access administered separately | Prev / Manual | R01, FA-04 | Access review |
| 9 | Maintenance spend not captured / not payable / not reconciled | WO completion routes cost to AP (Dr 5700 / Cr 2000); guarded WO lifecycle | Prev / Auto | EXP-05, GL-01 | WO→AP tie-out; `BAD_TRANSITION` test; basics harness |
| 9 | Preventive maintenance missed | PM schedule + idempotent due-generation sweep (cron / daily `eam_pm_generate`) | Det / Auto | FA-06 | Generated WO log; sweep run log |

## 10. Inputs & outputs

**Inputs:** asset categories + capitalization defaults, acquisition request (cost, salvage, useful life, cash/AP), custody scan events, depreciation period (`YYYY-MM`), disposal request (proceeds).
**Outputs:** capitalized asset + acquisition JE (FA-), asset/NBV register, QR labels, `assetMovements` custody trail, per-tenant monthly depreciation JE (DEP-), disposal JE with gain/loss (DISP-).

## 11. Records & retention

| Record | Store | Retention |
|---|---|---|
| Asset register (cost, accum dep, NBV) | Application DB (RLS-scoped) | `<<7 years / per Thai law>>` |
| Acquisition / depreciation / disposal JEs | Ledger | `<<7 years>>` |
| Depreciation run log | `depreciation_runs` | `<<7 years>>` |
| Custody movements | `assetMovements` (append-only) | `<<7 years>>` |
| Asset-master / category changes | `audit_log` (immutable) | `<<7 years>>` |

## 12. KPIs / metrics

- Acquisitions rejected for `NO_LIFE` (data-quality signal).
- Depreciation re-run double-posts detected (target: 0; idempotency holds).
- Per-tenant TB tie-out exceptions after each DEP- run (target: 0).
- NBV register-to-GL (1500/1590) reconciliation differences (target: 0).
- Disposals processed with correctly computed gain/loss; `ALREADY_DISPOSED` attempts.

## 13. Exception & error handling

| Error code | Trigger | Handling |
|---|---|---|
| `NO_LIFE` (400) | Acquisition without `useful_life_months` | Originator supplies life; resubmit |
| `ALREADY_DISPOSED` (400) | Dispose an asset already disposed | Verify asset status; no action |
| `NOT_FOUND` (404) | Dispose unknown `assetNo` | Verify asset number |
| `PERIOD_CLOSED` | DEP-/disposal JE into a closed period | Re-open per close policy (authorized) or post to open period |
| `SOD_VIOLATION` / SoD conflict | Conflicting initiate/approve or post/close duties | AccessAdmin remediates (see `08-itgc.md`) |

## 14. Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-22 | `<<author>>` | Initial draft. |
| 0.2 DRAFT | 2026-06-24 | `<<author>>` | Added **Enterprise Asset Management (EAM)** §7.9: maintenance work orders (cost → AP, acct 5700), preventive-maintenance schedules + idempotent due-generation sweep (cron / daily `eam_pm_generate`), meter readings; control **FA-06**. Verified by the `basics` harness. |
