# General Ledger & Financial Close — Process Narrative

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-04-GL |
| Process owner | `<<Controller>>` |
| Approver | `<<CFO>>` |
| Version | **0.1 DRAFT** |
| Effective date | `<<effective-date>>` |
| Review cadence | Each period close + annual |
| Related RCM controls | GL-01, GL-02, GL-03, GL-04, GL-05, GL-06, GL-07, GL-08, GL-09, GL-10, GL-11, GL-15, GL-16, GL-19, LSE-01, REC-01, REC-02, REC-03, REC-04, GOV-01, CON-01, CON-02; SoD R05, R06 |
| Related policy | `compliance/policies/11-financial-close-policy.md`, `compliance/policies/13-segregation-of-duties-policy.md` |

## 2. Purpose

To control journal entry, the trial balance / financial statements, period and year-end close, and reconciliations so that the general ledger is **balanced, complete, accurate, properly cut off, and authorized**, and so that manual journals receive **independent review** (maker-checker) before they affect reported results.

## 3. Scope

**In scope:** manual journal entry (`/api/ledger/journal`) posting as Draft → GL-05 maker-checker approve/reject; trial balance, income statement, balance sheet, **statement of cash flows (indirect)**; period open/close (`gl_close`); year-end close; subledger-to-GL, bank, and intercompany reconciliations; consolidation and FX revaluation.

**Out of scope:** source-cycle postings (revenue, AP, inventory, payroll, tax) which are documented in their own narratives but flow into the GL here.

## 4. References

- ISO 9001:2015 cl. 4.4, cl. 7.5 (documented information), cl. 9.1 (monitoring/measurement).
- `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx` — GL-01..06, REC-01..03, CON-01/02.
- `compliance/policies/11-financial-close-policy.md` (close calendar), `13-segregation-of-duties-policy.md` (R05, R06).
- Code: `apps/api/src/modules/ledger/ledger.service.ts` + `ledger.controller.ts`, `apps/api/src/modules/reconciliation/reconciliation.service.ts`, `apps/api/src/modules/consolidation/`, `apps/api/src/modules/fx/fx.service.ts`.

## 5. Definitions & abbreviations

| Term | Meaning |
|---|---|
| JE | Journal Entry (JE- prefix) |
| Maker-checker | Preparer of a JE may never approve it (GL-05) |
| Draft / Posted / Voided | JE lifecycle states; only Posted affects balances |
| Period close | Locking a fiscal period against further posting |
| TB / IS / BS | Trial Balance / Income Statement / Balance Sheet |
| SCF | Statement of Cash Flows (indirect method; the third primary statement) |
| RE | Retained Earnings |
| Recon prepare → certify | Two-person reconciliation sign-off |

## 6. Roles & responsibilities (RACI)

SoD: the **preparer** of a manual JE (GlAccountant) is never its **approver** (FinancialController) — enforced even for Admin (**GL-05**, **R05**); the **preparer** of a reconciliation (`recon_prep`) is never its **certifier** (`approvals`) (**R06**); the role posting JEs (`gl_post`) is separated from the role that **closes the period** (`gl_close`) (**R05**).

| Activity | GlAccountant | FinancialController | Controller | ExecutiveViewer / CFO |
|---|---|---|---|---|
| Prepare manual JE (`gl_post`) | **A/R** | I | A | I |
| Approve / reject manual JE (`gl_close`/checker, ≠ preparer) | I | **A/R** | A | C |
| Run TB / IS / BS / SCF | R | R | **A/R** | I |
| Close / open fiscal period (`gl_close`) | I | **A/R** | A | I |
| Year-end close (`exec`) | I | C | **A/R** | A |
| Prepare reconciliation (`recon_prep`) | **A/R** | C | A | I |
| Certify reconciliation (`approvals`) | I | **A/R** | A | C |

## 7. Process narrative

1. **JE invariants (decision point).** Every JE must be balanced by construction: Σdebit = Σcredit, each line single-sided and non-negative; an unbalanced entry → `UNBALANCED`, a malformed line → `INVALID_LINE` (**GL-01**).
2. **Period-close lockout (decision point).** Posting into a **Closed** fiscal period is rejected `PERIOD_CLOSED` on both the initial post and at approval time (per-tenant fiscal calendar) (**GL-02**).
3. **Idempotent posting.** A unique key `(tenant, source, source_ref, ledger)` with `ON CONFLICT DO NOTHING` prevents concurrent double-booking of the same source document (**GL-04**).
4. **Manual JE maker-checker (the key control).** A manual JE submitted via `POST /api/ledger/journal` with `pendingApproval` posts as **Draft** and is **excluded from the trial balance** until approved. `approveEntry` (permission `gl_close`) sets it **Posted** only if the approver is **not** the preparer (`createdBy`); a self-approval → `SOD_VIOLATION` — enforced **even for Admin**. `rejectEntry` sets it **Voided** with the reason appended to the memo; Voided/Draft never affect balances (**GL-05**, **R05**). Posting (`gl_post`) and approval (`gl_close`) are different permissions.
5. **Cross-tenant posting gate.** HQ cross-tenant posting (`hqTenant`) is gated to Admin (explicit tenant override, also audited); a non-Admin override is ignored and RLS pins the context (**GL-06**).
6. **Financial statements.** Controller runs the trial balance, income statement, balance sheet, and **statement of cash flows** — built only from Posted entries in open/closed periods. The **statement of cash flows** (`GET /api/ledger/cash-flow?from&to`, indirect method) is reconstructed from the same GL data: operating cash = net income + non-cash add-backs (depreciation, acct 1590) + working-capital movements (AR/inventory/AP/accruals), then investing (fixed assets, acct 1500) and financing (equity/dividends, accts 3000/3100). **Year-end CLOSE journals are excluded** (they reclassify P&L to retained earnings and carry no cash). The statement **reconciles by construction** to the movement in the cash accounts (1000/1010/1020) — the response carries a `reconciled` flag and lists any `unclassified_accounts` for transparency (**GL-07**). A **direct-method** presentation (`GET /api/ledger/cash-flow-direct`) classifies actual cash movements by the nature of their contra account (receipts from customers, payments to suppliers/employees, tax & payroll remittances, investing, financing) and reconciles to the same Δcash. A forward **cash-flow forecast** (`GET /api/ledger/cash-flow-forecast?weeks=`) projects the cash balance from today using open AR (expected inflows by due date) and open AP (expected outflows), so Treasury sees the projected closing position and any week that runs short (**GL-07**).
7. **Reconciliations (decision point, two-person).** Subledger-to-GL reconciliation imports GL items, auto-matches, clears unmatched, and is **certified** by a different person — preparer (`recon_prep`) ≠ certifier (`approvals`) (**REC-01**, **R06**). Bank reconciliation against statements (**REC-02**, see `07-cash-treasury.md`); intercompany reconciliation/elimination on consolidation (**REC-03**). A **period-end control-account reconciliation PACK** (`GET /api/finance/reconciliation/controls`) gives the Controller a single 'are the books reconciled?' view: it ties every major sub-ledger to its GL control account in one read — **AR↔1100**, **AP↔2000**, **Inventory↔1200**, **Gift cards / customer deposits↔2200**, **Deferred revenue↔2400** — reporting per line `{sub_ledger, gl_control, variance, reconciled}` plus an overall `all_reconciled` flag and an `exceptions` count (liability controls are sign-flipped before comparison). Any non-reconciled line is a **control finding** to investigate before sign-off; this is the detective backstop that catches a sub-ledger silently drifting from the GL before the financial statements are issued (**REC-04**). A **pending-approvals monitor** (`GET /api/finance/approvals/pending`) is the companion governance view: a single worklist of **every** item still awaiting independent (maker-checker) approval across the system — manual JEs (**GL-05**), bank adjustments (**BANK-02**), AP disbursements (**EXP-06**), payroll runs (**PAY-03**), asset revaluations (**FA-08**), asset disposals (**FA-09**), inventory write-offs (**INV-07**), manual FX rates (**FX-04**) and budgets (**BUD-01**) — each with its **age in days** and an **overdue** roll-up. The controller reviews it before close so nothing sits un-actioned: a stale item is either a transaction stuck before it can take effect, or a control silently bypassed because no one chased the second sign-off (**GOV-01**, COSO *Monitoring*).
8. **Period close.** FinancialController closes the period via `gl_close` after reconciliations are certified, per the close calendar; the period then rejects further posting (**GL-02**, **GL-06**). Closing a period also **auto-accrues the loyalty points liability** to the period *before* locking it (best-effort; see `19-marketing-pricing-loyalty.md` §7 step 13).
9. **Year-end close.** Year-end close is restricted to `exec`; an attempt without it → `403`. Closing entries roll to retained earnings (**GL-03**). The year-end close first accrues the loyalty liability so its `5700` points-expense is swept to retained earnings (the `2250` liability stays on the balance sheet; cross-ref `19` §7 step 13).
10. **Consolidation & FX.** Consolidation run (ownership %, entity currency) is gated by `approvals` (**CON-01**); period-end FX revaluation posts unrealized FX (acct 5400) (**CON-02**).
11. **Recurring / template journals.** A standing entry (monthly rent/insurance accrual, prepaid amortization, etc.) is defined once via `POST /api/ledger/recurring` — a **balanced template** (its lines are validated `Σdebit = Σcredit` at save time, so a broken template can never be persisted → `UNBALANCED`) plus a cadence (`daily`/`weekly`/`monthly`) and a first-run date. The scheduled job **`gl_recurring_journals`** (cron-callable via `POST /api/ledger/recurring/run`, and runnable daily through the report scheduler) posts every **due** template as a **Draft** JE through the **normal maker-checker flow** (GL-05) — so a recurring accrual still requires a second person to approve before it affects balances — and rolls `next_run_date` forward. The run is **idempotent**: `next_run_date` is advanced on posting and the `(tenant, source, source_ref, ledger)` key dedupes, so a same-day re-run posts nothing. Templates can be paused/resumed (`POST /api/ledger/recurring/:id/active`) without losing history (**GL-08**, **GL-05**, **R05**).
12. **Prepaid amortization.** A prepaid asset (annual insurance, rent paid up front) is registered once via `POST /api/ledger/prepaid` with a **total + term in months** (optionally capitalizing the up-front payment **Dr 1280 / Cr 1000**). The scheduled job **`gl_prepaid_amortize`** (`POST /api/ledger/prepaid/run`, daily-schedulable) amortizes a **straight-line slice each period** (**Dr expense / Cr 1280**), the **last period taking the remainder** so the prepaid asset fully clears. Posting is **direct** (systematic, like depreciation) and **idempotent per `(schedule, period)`** via the JE idempotency key + `next_run_date` advance (**GL-09**).
13. **Lease accounting (IFRS 16 / TFRS 16).** A lease is capitalized via `POST /api/leases`: at commencement a **right-of-use asset** and a **lease liability** are recognised at the **present value of the lease payments** (**Dr 1600 / Cr 2600**, non-cash). The scheduled job **`lease_periodic_run`** (`POST /api/leases/run`) posts each period — **interest unwinding** on the liability (**Dr 5900**), the **cash payment** reducing the liability (**Dr 2600 / Cr 1000**), and **straight-line ROU depreciation** (**Dr 5210 / Cr 1690**) — with the **last period clearing the liability + ROU exactly**. Idempotent per `(lease, period)`. A **lease modification / remeasurement** (`POST /api/leases/:leaseNo/modify` — revised payment, remaining term, or rate) **remeasures the liability** at the PV of the revised payments and **adjusts the ROU asset by the same delta** (Dr/Cr **1600 ↔ 2600**); a downward remeasurement larger than the ROU floors it at zero and books the excess as a P&L gain (**Cr 1510**). Depreciation then runs straight-line over the **revised remaining term** (**LSE-01**, see also `09-fixed-assets-depreciation.md`). At close the **lease-liability reconciliation** (`GET /api/leases/liability-reconciliation`) ties the **GL lease-liability control account (2600)** to the **sum of the remaining liability balances on the lease schedule** — `gl_liability` vs `schedule_liability` with a `difference` and a `reconciled` flag (a divergence means a manual JE hit 2600 outside the lease engine, or a periodic run / remeasurement didn't post). The `/leases` screen surfaces this as a tie-out banner (**LSE-01**).

14. **Chart of Accounts management (WS1.1 — GL-11).** The Chart of Accounts is **master data** with **two distinct write surfaces**, matching two distinct duties. Both resolve under `/api/ledger/accounts`; the CoA-write controller (`coa.controller.ts`) carries **no colliding read** — the tenant-curated account list is served by `GET /api/ledger/accounts` in `LedgerController` (perm `exec`/`creditors`/`ar`/`gl_coa`). The account hierarchy is: **account_groups** (tenant-scoped groups, `NULL tenant_id` = global template visible to all tenants) → **accounts** (the canonical posting universe, extended with Thai name, group link, control flags, normal balance, postability, dimension requirements, and effective dates). Key controls:

    - **Canonical universe (`accounts`) — platform/HQ duty.** The `accounts` table is the **global, immutable posting universe SHARED by every tenant** (no `tenant_id`; the engine hard-references its codes). Creating, editing, or retiring a canonical account changes the chart **all tenants post against**, so it is restricted to the **platform Admin/HQ operator** (role `Admin`) **in addition to** the `gl_coa` permission. A tenant's own `gl_coa` holder (e.g. FinancialController) is intentionally refused (`COA_ADMIN_ONLY`) so it can never silently mutate the shared universe.
        - **Account creation** (`POST /api/ledger/accounts`, Admin/HQ): auto-defaults `normal_balance` (`C` for Liability/Equity/Revenue, `D` for Asset/Expense). Duplicate code → `DUPLICATE_ACCOUNT`.
        - **Account update** (`PATCH /api/ledger/accounts/:code`, Admin/HQ): name, Thai name, group, postability, dimension requirements, effective dates. Disabling postability when the account already has posted entries → `CODE_HAS_POSTINGS`.
        - **Account deactivation** (`POST /api/ledger/accounts/:code/deactivate`, Admin/HQ): sets `active=false` and `is_postable=false`. Blocked if the account carries a **non-zero net balance** → `ACCOUNT_HAS_BALANCE` (prevents orphaning a balance in a "closed" account).
    - **Per-tenant chart curation (`tenant_accounts` overlay) — tenant `gl_coa` duty.** A tenant shapes **its own chart** — which canonical accounts are **active** on it and **how they are named / grouped / ordered** — via `PATCH /api/ledger/accounts/:code/overlay` (perm `gl_coa`), which upserts the caller tenant's `tenant_accounts` row (`active`, `display_name`, `display_name_th`, `group_label`, `sort_order`). The `tenant_id` is taken from the **request context (never the caller-supplied)** and the table is **RLS-scoped**, so a tenant can only ever curate its **own** chart — it can neither read nor mutate another tenant's overlay. The overlay may only reference an **existing canonical code** (it does not mint new accounts — that is the Admin/HQ duty above → `ACCOUNT_NOT_FOUND`) and **never gates postings** (see step 15). Curating with no tenant context → `TENANT_REQUIRED`.
    - **Control-account guard**: four accounts are flagged `is_control = true` at setup — **1100 (AR)**, **2000 (AP)**, **1200 (INV)**, **1500 (FA)**. Direct manual JE postings to a control account are **rejected** (`CONTROL_ACCOUNT`) unless the caller sets `viaSubledger: true`. Only the AR, AP, Inventory, and Fixed-Assets service methods set this flag, ensuring those balances are exclusively maintained by their respective sub-ledgers (defeats a common audit bypass where a direct JE hides a sub-ledger discrepancy).
    - **Permissions / SoD**: `gl_coa` is a dedicated sub-permission for CoA maintenance — separated from `gl_post` so the accountant who posts JEs cannot also reclassify accounts (COSO control-environment integrity). FinancialController holds `gl_coa` (+ `gl_close`); GlAccountant does not. `gl_coa` authorises **tenant chart curation** (the overlay) and read of the CoA list; **canonical** universe changes additionally require the **Admin/HQ** role.
    - **Residual risk (shared canonical universe).** Because `accounts` is deliberately global, an account's *definition* (code / type / normal balance) is common across tenants — correct for the branch-model deployment (one company, many shops sharing a chart) and acceptable for the separate-companies SaaS deployment, where per-tenant *presentation* is fully isolated by the RLS-scoped overlay and canonical *definition* changes are centralised to the Admin/HQ operator. Minting genuinely tenant-specific **new** codes remains a centralised (Admin/HQ) act by design.

    (**GL-11**, see also the industry-CoA template layer at step 15 below.)

15. **Industry Chart-of-Accounts at company creation.** The GL engine binds to a **fixed, global account universe** (canonical codes are immutable — every posting hard-references its code). On top of that, each tenant gets a **per-tenant overlay** (`tenant_accounts`) that curates *which* canonical accounts are active and *how* they are named/grouped for its industry. At **company creation** the customer picks a business type (`restaurant` / `retail` / `distribution` / `services` / `general`); `signup` materialises the chosen template into the overlay (`provisionTenantCoA`) **inside the signup transaction**, right after fiscal-year provisioning. Adopting an industry pack later (`POST /api/onboarding/apply-pack`) does the same. Every template account code is **asserted to exist in the canonical chart at boot** (`assertTemplatesSubsetOf` in `seedChartOfAccounts`) so a drifted template **fails fast** and can never reach a tenant; provisioning is **idempotent + additive** (never deletes), so re-running only adds missing accounts. The overlay is **presentation-only — it never gates postings**: `GET /api/ledger/accounts` returns the tenant's curated chart by default but `?all=true` exposes the full canonical universe, and reports surface any account that is **active OR carries activity** (so a curated-out account that receives a posting still appears) (**GL-10**).

## 8. Process flow

```mermaid
flowchart TD
    A[Prepare manual JE POST /api/ledger/journal pendingApproval] --> B{Balanced? lines valid? GL-01}
    B -- "No" --> B1[Reject UNBALANCED / INVALID_LINE]
    B -- "Yes" --> C{Period open? GL-02}
    C -- "Closed" --> C1[Reject PERIOD_CLOSED]
    C -- "Open" --> D[Post as Draft - excluded from TB GL-05]
    D --> E{Approver != preparer? GL-05/R05}
    E -- "same person / Admin" --> E1[Reject SOD_VIOLATION]
    E -- "reject" --> E2[Voided - never affects balances]
    E -- "independent approve" --> F[Posted - appears in TB GL-05]
    F --> G[Run TB / IS / BS / SCF - cash flow reconciles to Δcash GL-07]
    G --> H[Subledger / bank / IC reconciliations REC-01/02/03]
    H --> I{Preparer != certifier? R06}
    I -- "Yes" --> J[Certify recon - approvals]
    J --> K[Close period gl_close GL-02/06]
    K --> L[Year-end close exec -> roll to RE GL-03]
    L --> M[Consolidation approvals + FX reval CON-01/02]
```

**Swimlane description by role:** **GlAccountant** prepares manual JEs (Draft) and reconciliations. The **system** enforces balance/line invariants, period locks, idempotency, the maker-checker rule (even for Admin), and the cross-tenant gate. **FinancialController** independently approves JEs, certifies reconciliations, and closes periods. **Controller/CFO** owns year-end close and consolidation, gated by `exec`/`approvals`.

## 9. Control matrix

| Step | Risk | Control | Type | RCM ID | Evidence / Record |
|---|---|---|---|---|---|
| 1 | Unbalanced / one-sided JE | Double-entry balanced-by-construction | Prev / Auto | GL-01 | Invariant tests; `UNBALANCED` |
| 2 | Posting to a closed period (cutoff) | Period-close lockout `PERIOD_CLOSED` | Prev / Auto | GL-02 | Close-lock test |
| 3 | Concurrent double-booking | Ledger idempotency unique key + ON CONFLICT | Prev / Auto | GL-04 | Dedup test |
| 4 | Manual JE without independent review | Maker-checker; Draft excluded from TB; preparer ≠ approver (even Admin) | Prev / Hybrid | GL-05, R05 | JE approvals; harness ToE; `SOD_VIOLATION` |
| 5 | Mis-post to another tenant's books | HQ cross-tenant posting gated to Admin (+ RLS) | Prev / Auto | GL-06 | Override test |
| 7 | Subledgers diverge from GL undetected | Subledger-to-GL recon + independent certify | Det / Hybrid | REC-01, R06 | Certified recon |
| 7 | A sub-ledger silently drifts from its GL control account before the FS are issued | **Period-end control-account reconciliation pack** — one read ties AR/AP/Inventory/Gift-cards/Deferred-revenue to GL 1100/2000/1200/2200/2400 and flags any out-of-balance (`exceptions`, `all_reconciled`) | **Det / Auto** | **REC-04** | Reconciliation pack (`GET /api/finance/reconciliation/controls`); `giftcards` + `compliance` harness |
| 7 | A maker-checker approval sits un-actioned (transaction stalls, or a control is quietly bypassed) | **Pending-approvals monitor** — one worklist of every item awaiting approval across GL-05/BANK-02/EXP-06/PAY-03/FA-08/FA-09/INV-07/FX-04/BUD-01, with age + overdue roll-up; reviewed before close | **Det / Auto** | **GOV-01** | Pending-approvals worklist (`GET /api/finance/approvals/pending`); `compliance` harness |
| 7 | Bank balance not reconciled | Bank reconciliation vs statements | Det / Hybrid | REC-02 | Bank rec |
| 7 | Intercompany not eliminated/agreed | IC reconciliation + elimination | Det / Hybrid | REC-03 | IC recon |
| 6 | Cash flow statement mis-stated / doesn't tie to cash | SCF (indirect) reconstructed from GL; `reconciled` tie-out to Δcash; CLOSE entries excluded | Det / Auto | GL-07 | `basics` harness reconciliation check |
| 9 | Unauthorized year-end close / RE roll | Year-end close restricted to `exec` | Prev / Hybrid | GL-03 | Close package; 403 test |
| 10 | Consolidation / FX mis-stated | Consolidation gated by `approvals`; FX reval | Hybrid | CON-01, CON-02 | Consol TB; FX reval JE |
| 11 | Standing accrual missed / posts unbalanced or unapproved | Recurring-journal template validated balanced at save; scheduled run posts a **Draft** JE through maker-checker (GL-05); idempotent per due date | Prev / Auto | GL-08 | `basics` recurring-JE checks |
| 12 | Prepaid not amortized over its term | Prepaid schedule amortizes a straight-line slice each period (Dr expense / Cr 1280); last period clears the asset; idempotent | Det / Auto | GL-09 | `basics` prepaid checks |
| 13 | Lease not capitalised (ROU + liability omitted) | Commencement recognises ROU=liability=PV; periodic run posts interest + payment + ROU depreciation; idempotent | Det / Auto | LSE-01 | `basics` lease checks |
| 13 | Lease liability (2600) diverges from the schedule (manual JE / missed run) | Lease-liability reconciliation: GL 2600 vs Σ remaining schedule liability, with a `reconciled` flag + tie-out banner reviewed at close | **Det / Auto** | **LSE-01** | Lease-liability reconciliation; `basics` lease checks |
| 14 | CoA changed without authorisation; **a tenant mutates the SHARED canonical chart**; code changed after postings; account deactivated with live balance; direct JE bypasses sub-ledger on a control account | CoA Change Control — **two surfaces**: canonical universe writes (`accounts`, shared) require **Admin/HQ + `gl_coa`** (a tenant `gl_coa` holder is refused, `COA_ADMIN_ONLY`); per-tenant curation (`tenant_accounts` overlay) is **`gl_coa`, RLS-scoped** to the caller's own tenant. Code-change blocked if postings exist (`CODE_HAS_POSTINGS`); deactivation blocked if non-zero balance (`ACCOUNT_HAS_BALANCE`); control accounts (1100/2000/1200/1500) reject direct postings unless `viaSubledger:true` (`CONTROL_ACCOUNT`) | Prev / Auto | GL-11 | `compliance` GL-11 ToE (canonical Admin-only + `COA_ADMIN_ONLY`; overlay RLS-scoping; DUPLICATE_ACCOUNT / ACCOUNT_HAS_BALANCE); control-account guard test |
| 15 | New company starts on an unguided chart, or an industry template drifts from the engine's fixed codes | Industry CoA templates: per-tenant overlay over an **immutable** canonical universe; chosen at signup (`provisionTenantCoA`, in-txn); every template code **asserted ⊆ canonical at boot**; idempotent + additive; overlay is presentation-only (never gates postings — `?all=true` exposes the full universe) | Prev / Auto | GL-10 | `basics` + `compliance` industry-CoA checks |

## 10. Inputs & outputs

**Inputs:** source-cycle postings, manual JE requests, subledger balances, bank statements, FX rates, ownership %, close calendar.
**Outputs:** Posted JEs (JE-), trial balance, income statement, balance sheet, **statement of cash flows (indirect)**, certified reconciliations, closed periods, year-end close package, consolidated TB.

## 11. Records & retention

| Record | Store | Retention |
|---|---|---|
| Journal entries (Draft/Posted/Voided) | Ledger (RLS-scoped) | `<<7 years>>` |
| JE approval / rejection trail | `audit_log`, memo annotations | `<<7 years>>` |
| Reconciliations + certifications | `reconciliation` tables | `<<7 years>>` |
| Period/year close records | `fiscal_periods` | `<<7 years>>` |
| Financial statements | Reports / exports | `<<7 years>>` |

## 12. KPIs / metrics

- Manual JEs posted: % with distinct approver (target 100%); count of `SOD_VIOLATION`.
- Postings rejected for `PERIOD_CLOSED`.
- Reconciliation completeness and on-time certification per close.
- Days to close; number of post-close adjustments.

## 13. Exception & error handling

| Error code | Trigger | Handling |
|---|---|---|
| `UNBALANCED` / `INVALID_LINE` | Bad JE structure | Correct and resubmit |
| `PERIOD_CLOSED` | Post/approve into closed period | Re-open per close policy (authorized) or post to open period |
| `SOD_VIOLATION` | Preparer approves own JE | Route to independent approver (always, incl. Admin) |
| `NOT_PENDING` | Approve/reject a non-Draft JE | Verify JE state |
| `403` on year-end close | Lacks `exec` permission | CFO/Controller performs close |
| `DUPLICATE_ACCOUNT` | Account code already exists in CoA | Use a new code or update the existing account |
| `CODE_HAS_POSTINGS` | Attempt to disable postability on an account with posted entries | Retain postability; use `effective_to` date-fence instead |
| `ACCOUNT_HAS_BALANCE` | Attempt to deactivate an account with non-zero balance | Clear the balance via a correcting JE first |
| `COA_ADMIN_ONLY` | A tenant `gl_coa` holder attempts a **canonical** CoA change (create/update/deactivate) | Curate your own chart via the overlay (`PATCH …/:code/overlay`); canonical changes are made by the Admin/HQ operator |
| `TENANT_REQUIRED` | Overlay curation attempted with no tenant context (e.g. a global/HQ token) | Perform curation from a tenant-scoped session |
| `ACCOUNT_NOT_FOUND` | Overlay curation (or update) references a code not in the canonical chart | Use an existing canonical code (a new code is an Admin/HQ canonical add) |
| `CONTROL_ACCOUNT` | Direct JE to a control account (1100/2000/1200/1500) without `viaSubledger:true` | Post via the relevant sub-ledger (AR/AP/Inventory/Fixed Assets) |

## 14. Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 2.3 | 2026-07-03 | Platform | **Dedicated Chart-of-Accounts reference screen (UI only).** New read-only web page `/chart-of-accounts` (nav *Ledger & GL* → ผังบัญชี, perm `gl_coa`/`gl_post`/`gl_close`/`approvals`/`creditors`/`ar`/`exec`) surfaces the existing chart (`GET /api/ledger/accounts` curated / `?all=true` canonical) grouped by account type and **enriched** with the canonical attributes (normal balance, control-account flag + subledger, postability, required dimensions) already stored on `accounts`. Search / type-filter / industry↔full toggle / CSV export; posts nothing and edits nothing. **No control change**, no new endpoint, no migration, no RCM change. (CoA *management* — GL-11 — was made reachable + tenant-scoped separately, see 1.9.) ToE: web typecheck; UAT `05-general-ledger-close-uat.md` TC-GL-052. |
| 1.9 | 2026-07-03 | Platform | **GL-11 reachability + two-surface write semantics.** The CoA-write controller was unreachable (`@Controller('ledger/accounts')` — the app has no global prefix, so it resolved outside `/api`) and carried a `@Get()` that would collide with `LedgerController`'s `GET /api/ledger/accounts`. Fixed the base to `@Controller('api/ledger/accounts')` and removed the colliding read. **Write semantics split into two surfaces** (step 14 rewritten): **canonical** `accounts` writes (the global SHARED universe) now require the **platform Admin/HQ role + `gl_coa`** — a tenant `gl_coa` holder is refused (`COA_ADMIN_ONLY`) so it can never mutate the chart other tenants post against; **per-tenant chart curation** lands on the **RLS-scoped `tenant_accounts` overlay** via the new `PATCH /api/ledger/accounts/:code/overlay` (`gl_coa`, `active`/`display_name`/`display_name_th`/`group_label`/`sort_order`; `TENANT_REQUIRED`/`ACCOUNT_NOT_FOUND`). `gl_coa` added to the CoA-list read perms. Control matrix + error table updated; RCM GL-11 activity regenerated. ToE: `compliance` gains 9 GL-11 checks (Admin creates → 201; tenant `gl_coa` → `COA_ADMIN_ONLY`; non-`gl_coa` → 403; `DUPLICATE_ACCOUNT`; `ACCOUNT_HAS_BALANCE`; overlay curate reflected + RLS-scoped + `gl_coa`-gated — 132 checks) with `basics` 215 green. UAT `05-general-ledger-close-uat.md` TC-GL-11-01 updated + TC-GL-11-04/05 added. |
| 1.7 | 2026-07-02 | Platform | **GL-01 precision hardening (docs/27 R1-4 / AUD-ARC-04).** The balanced-by-construction checks (`postEntry`, recurring-template validation) and the trial-balance / balance-sheet `balanced` flags now compare **exact bigint minor units** (`common/money.ts` `toMinor4`, scale 4 — pg numeric strings parsed with no float hop; JS inputs clamped once) instead of independently-rounded float sums. Same error codes (`UNBALANCED`), same response shapes/4-dp values — a correctness-of-invariant hardening, no control-statement change, no migration. ToE: `basics` 212 / `compliance` 114 / `worldclass` 58 green; new unit suite `apps/api/test/money.test.ts` (7) incl. beyond-2^53 exactness + order-independence; vitest coverage scope ratcheted to include `common/money.ts`. |
| 1.8 | 2026-07-02 | Platform | **GL-20 + R1-2 — GL period-balance snapshots (docs/27 / AUD-ARC-02).** The trial balance now reads a maintained `gl_period_balances` snapshot (Σdebit/Σcredit per tenant/ledger/period/cost-center/account, POSTED only) instead of aggregating the full `journal_lines` table per request. The snapshot is written **in the same transaction** as the two balance-affecting transitions (`postEntry`→Posted, `approveEntry` Draft→Posted; Posted entries stay DB-immutable per GL-17/0165, corrections are contra reversals that post normally). Migration `0218` creates the table (RLS loop re-run, unique key, tenant index) and backfills from the existing Posted ledger. New **detective control GL-20**: the GL-19 pre-lock validator re-aggregates the period's raw lines per account and any snapshot mismatch is a HARD blocker `gl_snapshot_drift` (out-of-band writers are exactly what it catches; resync = re-run the 0212 backfill recompute). P&L/BS/cash-flow statements still read the raw ledger (date-ranged; a later optimization). RCM **170** (xlsx regenerated; census tags updated + CI-guarded). ToE: `basics` TC-GL-20 (clean ok → induced drift blocks & names the account → rebuild clears; 215 checks) + every existing TB assertion now exercises the snapshot path (worldclass 58, compliance 114, multiledger 17, costcenter 10, fxreval 15, giftcards 27, payroll 22, opening-balances 5, financial-health 4, parity writeflow 36 all green). UAT `05-general-ledger-close-uat.md` gains TC-GL-20. |
| 1.9 | 2026-07-03 | Platform | **Web UI for deferred tax (TAX-06, §3.2) + cost-centre master & dimensional P&L (§1.3).** No backend/control change — operator-facing screens over existing read/compute endpoints. New route **`/deferred-tax`** (Ledger nav): a run→review→post workspace mirroring `/fx` — a "คำนวณงวดใหม่" tab calls `POST /api/ledger/deferred-tax/run` (period/as-of/tax-rate/dep-factor → staged **Open** run with a temporary-difference breakdown) and a "รายการที่คำนวณ / โพสต์" tab lists runs (`GET /api/ledger/deferred-tax`) with a **โพสต์เข้า GL** button gated to a different user (server enforces `SELF_POST`). New route **`/cost-centers`** (Ledger nav): a master tab (create/list via `POST`/`GET /api/ledger/cost-centers`) + a "กำไร-ขาดทุนตามมิติ" tab (pick a cost centre + date range → `GET /api/ledger/cost-centers/:code/pl`, revenue/expense/net + per-account lines). Nav entries under the Ledger subgroup + i18n keys added. No migration, no RCM change (read/compute only). UAT `05-general-ledger-close-uat.md` + `06-tax-uat.md` gain UI walkthroughs; user manual `06-general-ledger.md` documents both screens. |
| 1.6 | 2026-06-30 | Platform | **GL-19 — programmatic pre-lock validation (Track-D RG-4, `docs/21`).** Read-only `GET /api/ledger/close/validate?period=YYYY-MM` (`close.service.ts validate`, perm `gl_close`/`gl_post`/`exec`) asserts the books-are-clean conditions the checklist sign-off can't: no unposted Draft JEs in the period, Posted entries balance in aggregate, every posted entry is individually balanced, and suspense/clearing (2380/2390/1999/9999) net ~zero (advisory) → `ready` + `blockers`/`warnings` + a per-check breakdown, surfaced before the GL-16 lock. Posts nothing; the hard lock still runs GL-15 + GL-16. New **detective** control **GL-19** in `build_rcm.py` → RCM **143**. No migration (read-only; reuses `journal_entries`/`journal_lines`). §2.1 control matrix gains a GL-19 block; Related-RCM list updated. ToE: `basics` harness (TC-GL-19-01 clean period ready; TC-GL-19-02 a Draft JE → `ready=false` + `unposted_drafts` blocker). UAT `05-general-ledger-close-uat.md` (TC-GL-19-01/02). |
| 0.1 DRAFT | 2026-06-22 | `<<author>>` | Initial draft. |
| 0.2 | 2026-06-24 | Platform | Steps 8–9: period close and year-end close now auto-accrue the loyalty points liability before locking (year-end `5700` swept to RE). Cross-ref `19-marketing-pricing-loyalty.md` §7 (CRM Phase 1.5). |
| 0.3 | 2026-06-26 | Platform | WS1.1: Added step 14 — CoA as master data (account_groups table, accounts extended, GL-11 control). Control-account guard for 1100/2000/1200/1500. `gl_coa` permission. Updated control matrix (step 14 GL-11, renumbered former 14→15), error-handling table, and RCM control list. |
| 0.4 | 2026-06-26 | Platform | **GOV-01 — pending-approvals monitor (COSO Monitoring).** Step 7: `FinanceService.pendingApprovals` on `GET /api/finance/approvals/pending` — one worklist of every item awaiting independent (maker-checker) approval across the system (manual JE GL-05, AP disbursement EXP-06, payroll PAY-03, asset revaluation FA-08, asset disposal FA-09, inventory write-off INV-07), each with its age in days + an overdue roll-up + total amount. The controller's pre-close 'what is stuck?' view; a stale item is a control finding. Read-only; no migration. New RCM control **GOV-01** (RCM now 85); control matrix gains a step-7 monitoring row. New `/approvals` screen. ToE: `compliance` (a Draft JE surfaces in the worklist with its control ID, amount + age). |
| 0.3 | 2026-06-26 | Platform | **REC-04 — period-end control-account reconciliation PACK.** Step 7: `FinanceService.reconcileControls` on `GET /api/finance/reconciliation/controls` ties every major sub-ledger to its GL control account in one read — AR↔1100, AP↔2000, Inventory↔1200, Gift cards↔2200, Deferred revenue↔2400 — with per-line `{sub_ledger, gl_control, variance, reconciled}` + `all_reconciled`/`exceptions` (liabilities sign-flipped). New RCM control **REC-04** (RCM now 84); control matrix gains a step-7 detective row. New control-account overview on `/reconciliation`. Read-only detective; no migration. ToE: `giftcards` (2200 ties, 5 lines, all reconciled) + `compliance` (inventory 1200 ties, exceptions surfaced). |
| 0.4 | 2026-06-26 | Platform | **Pending-approvals monitor extended (GOV-01).** The unified pending-approvals monitor (`FinanceService.pendingApprovals` on `GET /api/finance/approvals/pending`, control **GOV-01**) now also covers the **bank-adjustment (BANK-02)**, **FX-rate (FX-04)** and **budget (BUD-01)** maker-checkers added in this series — a Draft BANKADJ journal entry is control-tagged BANK-02, and the pending FX-rate and budget queues are aggregated alongside the existing GL-05/EXP-06/PAY-03/FA-08/FA-09/INV-07 sources. (An earlier branch-local "aging monitor" was consolidated into GOV-01 rather than shipped as a second endpoint.) No new control / no migration. ToE: `compliance` (GOV-01 surfaces a Draft JE with control + amount + age + overdue roll-up). |
| 0.6 | 2026-06-26 | Platform | **GL-17 — controlled emergency reopen of a locked period (operating-spine PR6 complement to GL-15/16).** `POST /api/ledger/close/reopen` unlocks a `Locked` period ONLY with a mandatory `reason` (`REASON_REQUIRED`) and only by a user ≠ the locker (`SELF_REOPEN`); it flips the close run to `ReadyToLock` and `fiscal_periods.status` back to `Open` so corrective postings are allowed, after which a *different* `gl_close` user must re-lock (GL-16 still binds). The reason is stamped on `close_runs.note` and the reopen is captured by the append-only hash-chained `audit_log` (ITGC-AC-16). No migration (reuses the GL-15/16 schema). New RCM control **GL-17**. ToE: `basics` harness (TC-GL-16b: no-reason→REASON_REQUIRED, locker→SELF_REOPEN, different-user→ReadyToLock + period Open + JE posts, re-lock→Locked). UAT `05-general-ledger-close-uat.md` updated. |
| 0.5 | 2026-06-26 | Platform | **GL-10 — industry Chart-of-Accounts at company creation.** New step 14: the customer picks a business type at signup (`restaurant`/`retail`/`distribution`/`services`/`general`) and `BillingService.signup` materialises the matching template into a per-tenant overlay (`tenant_accounts`) via `LedgerService.provisionTenantCoA`, in-transaction after fiscal-year provisioning; `applyPack` does the same when an industry pack is adopted later. The canonical chart stays the **immutable** posting universe; every template code is **asserted ⊆ canonical at boot** (`assertTemplatesSubsetOf`); provisioning is idempotent + additive; the overlay is **presentation-only** (`GET /api/ledger/accounts` curated by default, `?all=true` = full universe — never gates postings). Migration **0139** (`tenant_accounts` + `tenants.industry`). New RCM control **GL-10** (RCM now 98); control matrix gains a step-14 preventive row. ToE: `basics` + `compliance` industry-CoA checks. |
| 0.3 DRAFT | 2026-06-24 | `<<author>>` | Added **Statement of Cash Flows (indirect)** (`GET /api/ledger/cash-flow`) as the third primary statement, control **GL-07** (reconciles to Δcash; CLOSE excluded), and the `basics` reconciliation harness. |
| 0.4 DRAFT | 2026-06-25 | `<<author>>` | §7.6 — added the **direct-method** statement of cash flows (`/api/ledger/cash-flow-direct`, receipts/payments by nature, reconciles to Δcash) and a forward **cash-flow forecast** (`/api/ledger/cash-flow-forecast`, AR/AP due-date projection). Verified by the `basics` harness. |
| 0.5 DRAFT | 2026-06-25 | `<<author>>` | §7 step 11 — added **recurring / template journal entries** (`/api/ledger/recurring`, scheduled job `gl_recurring_journals`): balanced-at-save template + cadence; the run posts each due template as a **Draft** JE through maker-checker (GL-05) and is idempotent. New control **GL-08**. Verified by the `basics` harness. |
| 0.6 DRAFT | 2026-06-25 | `<<author>>` | §7 steps 12–13 — added **prepaid amortization** (`/api/ledger/prepaid`, job `gl_prepaid_amortize`, straight-line Dr expense / Cr 1280; **GL-09**) and **lease accounting (IFRS 16)** (`/api/leases`, job `lease_periodic_run`, ROU+liability at PV then interest/payment/depreciation; **LSE-01**). Verified by the `basics` harness. |
| 0.7 DRAFT | 2026-06-25 | `<<author>>` | §7 step 13 — added **lease modification / remeasurement** (`/api/leases/:leaseNo/modify`): remeasures the liability at the revised PV and adjusts the ROU by the same delta (Dr/Cr 1600↔2600), then depreciates over the remaining term (**LSE-01**). Verified by the `basics` harness. |
| 0.8 DRAFT | 2026-06-25 | `<<author>>` | **Lease management UI surfaced** — new screen `/leases` (ERP nav → การเงิน ▸ สมุดบัญชี & แยกประเภท) drives the already-documented IFRS 16 endpoints: create lease (ROU+liability at PV), "run-due" periodic posting, and modification/remeasurement. UI-only addition; no process/GL/control change (**LSE-01**). See user manual `06-general-ledger.md` §Leases and UAT `05-general-ledger-close-uat.md`. |
| 0.9 DRAFT | 2026-06-26 | Platform | §7 step 13 — added the **lease-liability reconciliation** (`GET /api/leases/liability-reconciliation`): ties GL **2600** to the sum of the remaining liability balances on the lease schedule (`gl_liability` vs `schedule_liability`, `difference`, `reconciled`), surfaced as a tie-out banner on `/leases`. Detective tie-out over the existing **LSE-01**; no new control, no migration. Verified by the `basics` harness (after run + remeasurement, GL 2600 = schedule, reconciled, difference 0). |
| 1.0 DRAFT | 2026-06-26 | WS1.3 | WS1.3 — added **multi-dimensional GL postings**: `branch_id`, `project_id`, `department_id` columns on `journal_lines`; `PostingService` context stamping; `GET /api/ledger/income-statement/by-branch` per-branch P&L endpoint; `departments` master table with RLS. New control **GL-13**. Verified by the `basics` harness (TC-GL-13-01/02/03). Migration 0157. |
| 1.1 DRAFT | 2026-06-26 | WS1.4 | WS1.4 — added **sub-ledger tie-out / reconciliation**: `POST /api/ledger/tie-out/run` reconciles each GL control account (1100 AR / 2000 AP / 1200 INV / 1500 FA) to the sum of its sub-ledger detail, recording the variance + a Matched/Variance status; `POST /api/ledger/tie-out/:id/certify` is **maker-checker** (certifier ≠ runner → `SELF_CERTIFY`). New `subledger_tieout_runs` table (RLS), new control **GL-14**. Verified by the `basics` harness (TC-GL-14-01/02/03). Migration 0160. |
| 1.5 | 2026-06-26 | Platform | **Period-close UI surfaced.** New screen `/finance/period-close` (ERP nav → การเงิน ▸ สมุดบัญชี & แยกประเภท, perm `gl_close`/`exec`) drives the already-documented GL-15/GL-16/GL-17 workflow: start a close run → sign-off checklist steps → lock (maker-checker; locker ≠ starter) → emergency reopen with mandatory reason (SoD: reopener ≠ locker). Run list sidebar + live checklist status from `GET /api/ledger/close` + `/status`. UI-only addition; no process/GL/control change. |
| 1.6 | 2026-06-28 | Platform | **SoD screen split for R05 (GL posting vs JE approval) and R05 nav fix.** `/accounting` nav: added `gl_post`, `gl_close`, `approvals` to perm list so GlAccountant (gl_post) and FinancialController (gl_close) can reach the page (previously only `exec/creditors/ar`, which excluded single-duty GL staff). In-page: "รออนุมัติ (JE)" tab is now conditionally rendered only for users who hold `approvals`, `gl_close`, or `exec` (`canApproveJE` via `hasPerm`); GlAccountant sees journal/posting tabs only. This enforces the GL-05 maker-checker at the UI layer to match the API gate already in place. |
| 1.7 | 2026-06-28 | Platform | **SoD screen split for R06 (recon preparer ≠ certifier) and nav fix.** `/reconciliation` nav: added `recon_prep`, `approvals`, `gl_close` so GlAccountant (`recon_prep`) can reach the page. In-page: the "รับรองงวด" certify button is now hidden from `recon_prep`-only users (`canCertify = hasPerm(me, 'approvals', 'gl_close', 'exec')`); preparer can still open/import/auto-match. API already gates `POST /api/recon/periods/:id/certify` on `approvals`; this adds the matching UI enforcement (control REC-03 / R06). |
| 1.4 DRAFT | 2026-06-26 | WS3.2 | WS3.2 — **FX revaluation + deferred tax** (§3.2): two period-scoped, maker-checker, idempotent-per-(tenant, period) close runs. **FX revaluation (GL-18)** — `POST /api/ledger/fx-reval/run` restates open foreign-currency AR/AP to the closing rate (from the request `rates` map or the latest **approved** `fx_rates`; else `MISSING_RATE`) → unrealized FX to **5400**; `/:id/post` (poster ≠ runner → `SELF_POST`) posts net gain (Cr 5400) / loss (Dr 5400) with the 1100/2000 control restatements through the `PERIOD_LOCKED` gate; `ALREADY_POSTED` on re-post/re-run. **Deferred tax (TAX-06)** — `POST /api/ledger/deferred-tax/run` computes DTA from the posted AR allowance (× CIT 20%) + DTL from accelerated depreciation (book NBV vs an assumed tax NBV — documented 1.5× simplification, no tax-dep ledger yet), nets to `net_deferred` and the **delta vs the prior posted run**; `/:id/post` (poster ≠ runner → `SELF_POST`) posts the delta to **1700/5950** (benefit Dr 1700 / Cr 5950). New COA **1700/2700/5950**; new `fx_reval_runs` + `deferred_tax_runs` tables (RLS); close checklist gains `fx_reval`(advisory) + `deferred_tax`(advisory) steps. New controls **GL-18** + **TAX-06**. Verified by the `basics` harness (TC-GL-18-01/02, TC-TAX-06-01/02). Migration 0168. |
| 1.3 DRAFT | 2026-06-26 | WS2.2 | WS2.2 — **GL immutability + audit log + reversal** (§2.2): a **Posted** journal entry is immutable — a production DB trigger (`gl_block_posted_mutation`, migration 0164) blocks UPDATE/DELETE of posted `journal_entries` (permitting only the `is_reversed` flag flip), and an app guard (`attemptVoidPosted`) returns `GL_IMMUTABLE` + logs `MUTATE_BLOCKED`. Corrections happen ONLY via **reversal** (`POST /api/ledger/journal/:id/reverse`): a new immediately-posted contra entry (swapped Dr/Cr, `reversal_of`, original flagged `is_reversed`) that respects the period gates; errors `ENTRY_NOT_FOUND`/`NOT_POSTED`/`ALREADY_REVERSED`. New `gl_audit_log` table (RLS) recording POST/APPROVE/REVERSE/MUTATE_BLOCKED (`GET /api/ledger/audit?entryId=`). New control **GL-17**. Verified by the `basics` harness (TC-GL-17-01/02/03). Migration 0164. |
| 1.2 DRAFT | 2026-06-26 | WS2.1 | WS2.1 — **hard period close + checklist**: `POST /api/ledger/close/start` opens a `close_runs` record (InProgress) per (tenant, period) and seeds a standard checklist (`close_run_steps`); `POST /api/ledger/close/step` marks steps Done → run advances to **ReadyToLock** when all required steps are done; `POST /api/ledger/close/lock` hard-locks the period (requires ReadyToLock else `STEPS_INCOMPLETE`; **maker-checker** locker ≠ starter → `SELF_LOCK`). New `'Locked'` period status; `postEntry` now rejects ALL postings into a Locked period with `PERIOD_LOCKED` regardless of the legacy `allowClosedPeriod` escape (only the system year-end closing entry, `source='CLOSE'`, is exempt). New `close_runs` / `close_run_steps` tables (RLS), new controls **GL-15** (checklist completeness) + **GL-16** (segregated lock). Verified by the `basics` harness (TC-GL-15-01/02/03, TC-GL-16-01/02). Migration 0162. |

## 1.3 Multi-dimensional GL Postings (WS1.3)

### Overview
`journal_lines` now carries three optional dimension columns: `branch_id`, `project_id`, and `department_id`.
These enable per-location and per-project P&L views without separate ledger books.

### How dimensions are stamped
- **Manual JEs** (`POST /api/ledger/journal`): pass `branch_id`, `project_id`, `dept_id` on each line object.
- **Automated postings via `PostingService.post()`**: `PostingContext` accepts `branchId?`, `projectId?`, `departmentId?`; the service stamps all lines in the generated entry with those values.

### Per-branch income statement
`GET /api/ledger/income-statement/by-branch?from=YYYY-MM-DD&to=YYYY-MM-DD`

Returns:
```json
{
  "period": { "from": "...", "to": "..." },
  "branches": {
    "1":           { "revenue": 500, "expense": 0, "net": 500, "lines": [...] },
    "2":           { "revenue": 300, "expense": 0, "net": 300, "lines": [...] },
    "unassigned":  { "revenue": 0,   "expense": 200, "net": -200, "lines": [...] }
  }
}
```
Lines without a `branch_id` are grouped under `"unassigned"`.

### Departments master table
The `departments` table holds a tenant-scoped department registry (code, name, active flag).
RLS policy `tenant_isolation_departments` restricts reads to the caller's tenant.

### Cost centres + dimensional P&L
`cost_centers` is a tenant-scoped master (code, name, `type` = department/branch/project, optional
`parent_code`). Endpoints (perm `exec`/`masterdata`): `POST /api/ledger/cost-centers` (create),
`GET /api/ledger/cost-centers` (list), `GET /api/ledger/cost-centers/:code/pl?from&to` (per-cost-centre
income statement — revenue/expense/net + per-account lines, filtered on `journal_lines.cost_center_code`).
The income-statement endpoint also accepts `?cost_center=` for the same dimensional filter. **Web UI:**
**`/cost-centers`** (Ledger nav) — a master tab (create/list) + a "กำไร-ขาดทุนตามมิติ" tab that renders the
per-cost-centre P&L for a chosen centre and date range. Read/compute only — no new control.

### Control GL-13 — Dimension Completeness
| Control ID | GL-13 |
|------------|-------|
| Name | Multi-dimensional GL posting dimension completeness |
| Type | Application — Automated |
| Risk | Revenue / expense mis-attributed to wrong branch / project, obscuring per-location P&L |
| Mitigation | `branch_id`, `project_id`, `department_id` columns on `journal_lines`; `PostingService` stamps from context; `income-statement/by-branch` provides per-location P&L review |
| Test | TC-GL-13-01/02/03 (basics.ts harness) |

## 1.4 Sub-ledger Tie-out / Reconciliation (WS1.4)

### Overview
At period-end the four GL **control accounts** must each equal the sum of their sub-ledger detail. A
tie-out run computes both sides as of a date, records the **variance**, and requires an independent
**certification** (maker-checker) so the reconciliation is reviewed by someone other than its preparer.

The control accounts (flagged `is_control=TRUE`, `control_subledger` set in WS1.1):
- **1100** — Accounts Receivable (`AR`)
- **2000** — Accounts Payable (`AP`)
- **1200** — Inventory (`INV`)
- **1500** — Fixed Assets (`FA`)

### Running a tie-out
`POST /api/ledger/tie-out/run` — body `{ "subledger": "AR" | "AP" | "INV" | "FA", "as_of_date"?: "YYYY-MM-DD" }`
(permission `gl_close` or `gl_post`). `runBy` is taken from the authenticated user. It computes:

- **GL balance** — Σ(`debit − credit`) of **posted** `journal_lines` on the control account up to the
  as-of date, scoped to the caller's tenant.
- **Sub-ledger balance** — summed from the originating detail tables (queried directly):
  - **AR** — Σ outstanding (`amount − paid_amount`) of `ar_invoices` issued up to the as-of date.
  - **AP** — Σ outstanding (`amount − paid_amount`) of `ap_transactions` dated up to the as-of date.
  - **INV** — Σ `inv_balances.total_value` (perpetual on-hand × cost). `inv_balances` is a current
    snapshot with no per-date history, so the as-of is **advisory** for INV.
  - **FA** — Σ (`acquire_cost − accumulated_depreciation`) of non-disposed `fixed_assets` (a current
    register snapshot — as-of **advisory**).
- **variance** = `gl_balance − subledger_balance`; **status** = `Matched` when `|variance| < 0.01`,
  else `Variance`.

Runs **upsert** on (`tenant_id`, `subledger`, `as_of_date`) — a same-day re-run refreshes the figures
and clears any prior certification. Results persist in `subledger_tieout_runs` (RLS-isolated by tenant).

`GET /api/ledger/tie-out` (optional `?subledger=`/`?as_of_date=`) lists runs newest-first;
`GET /api/ledger/tie-out/:id` fetches one.

### Certification (maker-checker)
`POST /api/ledger/tie-out/:id/certify` — body `{ "note"?: string }` (permission `gl_close`). Sets
`status = Certified` and records the certifier + timestamp. A `Variance` may be certified with an
explanatory `note` describing the reconciling items. **Segregation of duties:** the certifier must
**differ** from the runner — certifying your own run is rejected with **`SELF_CERTIFY`** (HTTP 400).

### Error codes
| Code | Meaning |
|------|---------|
| `SELF_CERTIFY` | The certifier equals the runner — maker-checker SoD violation (a different `gl_close` user must certify). |
| `BAD_SUBLEDGER` | `subledger` not one of AR/AP/INV/FA. |
| `NO_CONTROL_ACCOUNT` | No account is flagged `is_control` for the requested sub-ledger. |
| `NOT_FOUND` | Tie-out run id does not exist. |

### Control GL-14 — Sub-ledger Tie-out
| Control ID | GL-14 |
|------------|-------|
| Name | Sub-ledger tie-out / control-account reconciliation |
| Type | Application — Automated (Detective, Monthly) |
| Risk | GL control-account balances drift from sub-ledger detail without detection, masking posting errors or fraud |
| Mitigation | Tie-out run computes GL vs sub-ledger balance + variance per control account; maker-checker certification (certifier ≠ runner, `SELF_CERTIFY`) |
| Owner | Financial Controller |
| Test | TC-GL-14-01/02/03 (basics.ts harness) |

## 2.1 Hard Period Close + Checklist (WS2.1)

Period close is now a **controlled, checklist-driven, irreversible workflow** rather than a single soft
status flip. A `close_runs` record (one per tenant+period) drives a sequence of `close_run_steps`; the
period can only be **Locked** once every required step is complete, and the lock is **segregated** from the
preparer (maker-checker).

### Close-run lifecycle
`Open → InProgress → ReadyToLock → Locked`

1. **InProgress** — `POST /api/ledger/close/start { period }` (perm `gl_close`) creates the run as
   `InProgress` and seeds the standard checklist. Upsert-safe: a re-start of a non-locked period returns the
   existing run; a re-start of a Locked period is rejected (`PERIOD_ALREADY_LOCKED`).
2. **ReadyToLock** — `POST /api/ledger/close/step { close_run_id, step_key, detail? }` (perm `gl_close`)
   marks a step `Done` (records `completed_by` + timestamp). When **all required** steps are `Done`, the run
   automatically advances to `ReadyToLock`.
3. **Locked** — `POST /api/ledger/close/lock { close_run_id }` (perm `gl_close`) hard-locks the period.
   - Requires `ReadyToLock` — else `STEPS_INCOMPLETE` (the response lists the pending required `step_key`s).
   - **Maker-checker**: the locker (`locked_by`) MUST differ from the starter (`started_by`) — else
     `SELF_LOCK`. Both identities + `locked_at` are retained as the SoD evidence trail.
   - Locking writes `'Locked'` into `fiscal_periods.status`.

Read endpoints: `GET /api/ledger/close/status?period=YYYY-MM` (the run + its steps) and `GET /api/ledger/close`
(recent runs) — perms `gl_close`, `gl_post`, `exec`.

### Seeded checklist (`close_run_steps`)
| step_key | Title | Required |
|---|---|---|
| `subledger_tieout` | Sub-ledger tie-out (AR/AP/INV/FA) reconciled | Yes |
| `bank_rec` | Bank reconciliation complete | Yes |
| `depreciation` | Depreciation posted for the period | Yes |
| `recurring` | Recurring / prepaid journals run | Yes |
| `fx_reval` | FX revaluation posted | No (advisory) |
| `trial_balance_review` | Trial-balance review & sign-off | Yes |

### The new hard `PERIOD_LOCKED` gate (replaces the soft escape)
Previously a `Closed` period could be posted into by any caller passing `allowClosedPeriod: true`. WS2.1 adds
a strictly stronger gate: `LedgerService.postEntry` now rejects **every** entry dated into a **Locked** period
with **`PERIOD_LOCKED`**, *regardless* of `allowClosedPeriod`. The legacy soft `Closed` / `allowClosedPeriod`
behaviour is unchanged (backward compatible) — `Locked` is additive and irreversible. The **only** exemption
is the system year-end closing entry (`source = 'CLOSE'`), so `closeYear` can still post its P&L-sweep JE into
December. (Locked is not exposed as a normal re-open; reversing a hard close is an out-of-band/audited action.)

### New error codes
`PERIOD_LOCKED` (post into a locked period), `PERIOD_ALREADY_LOCKED` (start/step on a locked run),
`STEPS_INCOMPLETE` (lock before required steps done), `SELF_LOCK` (locker = starter),
`CLOSE_RUN_NOT_FOUND`, `STEP_NOT_FOUND`.

### Control GL-15 — Close-checklist completeness
| Control ID | GL-15 |
|------------|-------|
| Name | Hard period close — checklist completeness |
| Type | Application — Automated (Preventive, Monthly) |
| Risk | A period is closed with key close procedures skipped, or a closed period is silently re-posted |
| Mitigation | Required checklist steps must all be `Done` before lock (`STEPS_INCOMPLETE`); a Locked period rejects all postings (`PERIOD_LOCKED`, except `source='CLOSE'`) |
| Owner | Financial Controller |
| Test | TC-GL-15-01/02/03 (basics.ts harness) |

### Control GL-16 — Segregated period lock (SoD)
| Control ID | GL-16 |
|------------|-------|
| Name | Segregated period lock (maker-checker) |
| Type | Application — Automated (Preventive, Monthly) |
| Risk | One person both performs and locks the close, concealing a misstatement over their own work |
| Mitigation | Locker (`locked_by`) must differ from starter (`started_by`) → `SELF_LOCK`; both identities + `locked_at` retained as evidence |
| Owner | Financial Controller |
| Test | TC-GL-16-01/02 (basics.ts harness) |

### Control GL-19 — Programmatic pre-lock validation (detective)
| Control ID | GL-19 |
|------------|-------|
| Name | Close pre-lock validation (books-are-clean) |
| Type | Application — Automated (Detective, Pre-lock / period-end) |
| Risk | A period is locked on a manual checklist sign-off while the books are not clean — an unposted draft JE sits in the period, or an entry/batch does not balance — so the statements are produced on an incomplete/inconsistent basis the checklist alone could not catch |
| Mitigation | Read-only `GET /api/ledger/close/validate?period=YYYY-MM` asserts (1) **no unposted Draft JEs** in the period, (2) Posted entries **balance in aggregate** (Σdebit = Σcredit), (3) **every posted entry is individually balanced**, (4) suspense/clearing (2380/2390/1999/9999) net ~zero (advisory). Returns `ready` + explicit `blockers`/`warnings` + a per-check breakdown, surfaced before the GL-16 lock. Posts nothing; the hard lock still runs GL-15 + GL-16 |
| Owner | Financial Controller |
| Test | TC-GL-19-01/02 (basics.ts harness) |

## 2.2 GL Immutability & Reversal (WS2.2)

### Overview
A **posted** journal entry is the ledger's record of record and is **immutable** — it can never be edited or
deleted. The only way to correct a posted entry is a transparent **reversal**: a new, immediately-posted
contra entry that swaps every line's debit/credit so the original and its reversal net to zero on every
affected account. Every important GL action and every blocked mutation attempt is written to a dedicated
**GL audit trail** (`gl_audit_log`).

### Two-layer immutability enforcement
1. **Production DB trigger** (`gl_block_posted_mutation`, migration 0164) — a `BEFORE UPDATE OR DELETE`
   trigger on `journal_entries` that `RAISE`s on any attempt to UPDATE or DELETE a `Posted` row. The single
   permitted change is the reversal bookkeeping flag `is_reversed` (the trigger blocks only changes to
   `status` or `entry_date`), so the reversal flow can flag the original without re-opening it.
2. **Application guard** (`attemptVoidPosted`) — refuses to mutate a posted entry, returns
   `GL_IMMUTABLE` (HTTP 400) and records a `MUTATE_BLOCKED` audit row. This is the deterministically-testable
   layer (the DB trigger is the prod backstop); there is no edit/delete endpoint for a posted JE.

### Reversal flow (`POST /api/ledger/journal/:id/reverse`)
- Loads the original posted entry + lines. Errors: `ENTRY_NOT_FOUND`, `NOT_POSTED` (only Posted entries are
  reversible), `ALREADY_REVERSED` (an entry may be reversed only once).
- Posts a NEW contra entry (`source = 'REVERSAL'`, `reversal_of = <original id>`, dated `date ?? today` on the
  Asia/Bangkok business day) with every line's Dr/Cr swapped and all dimensions (branch/project/dept/cost
  centre) carried over. The reversal goes through the **normal posting path**, so the WS2.1 `PERIOD_LOCKED`
  and the `PERIOD_CLOSED` gates still apply to the reversal date.
- Flags the original `is_reversed = true` (the only column the DB trigger permits changing) and logs a
  `REVERSE` audit row `{ originalId, reversalId, reason }`.

### GL audit trail (`gl_audit_log`, `GET /api/ledger/audit?entryId=`)
Tenant-scoped (RLS), append-only by intent. Actions: `POST` (an entry reached Posted), `APPROVE` (a Draft was
approved to Posted via GL-05 maker-checker), `REVERSE`, `MUTATE_BLOCKED`. Each row carries the actor, a
detail JSON, and a timestamp.

### Error codes
| Code | Meaning |
|------|---------|
| `ENTRY_NOT_FOUND` | No journal entry with that id |
| `NOT_POSTED` | The entry is not Posted (only posted entries can be reversed) |
| `ALREADY_REVERSED` | The entry has already been reversed |
| `GL_IMMUTABLE` | A posted entry cannot be edited/deleted — correct it via a reversal |

### Control GL-17 — Posted-entry immutability + reversal-only correction
| Control ID | GL-17 |
|------------|-------|
| Name | Posted GL immutable; corrections via reversal only; full audit trail |
| Type | Application — Automated (Preventive, Per entry / continuous) |
| Risk | A posted entry is silently edited/deleted (restating history with no trail) instead of being corrected by a transparent, auditable reversal |
| Mitigation | DB trigger (`gl_block_posted_mutation`) blocks UPDATE/DELETE of posted entries; app guard returns `GL_IMMUTABLE`; corrections only via `reverseEntry` (contra entry, `reversal_of`, original `is_reversed`); every POST/APPROVE/REVERSE/MUTATE_BLOCKED logged to `gl_audit_log` |
| Owner | Financial Controller |
| Test | TC-GL-17-01/02/03 (basics.ts harness) |

## 3.2 FX Revaluation & Deferred Tax (WS3.2)

Two period-end close runs, each a governed wrapper (compute → maker-checker post) over a balance-sheet
valuation, one row per `(tenant, period)`, idempotent, posting through the normal `LedgerService.postEntry`
path so the WS2.1 `PERIOD_LOCKED` gate and the GL-17 audit trail apply.

### FX Revaluation (GL-18) — `fx_reval_runs`
Restates open foreign-currency monetary balances (AR/AP whose `currency <> 'THB'` and `status <> 'Paid'`,
dated on/before the as-of) to the period-end **closing rate**.

- **Run** — `POST /api/ledger/fx-reval/run` (`{ period: 'YYYY-MM', as_of_date?, rates?, tenant_id? }`).
  For each open document: `delta_thb = open_foreign × (closing_rate − booked_rate)`. The closing rate per
  currency comes from the request `rates` map first, else the latest **Approved** `fx_rates` row (FX-04 —
  an unapproved manual rate can never drive the reval); a currency with no rate from either → `MISSING_RATE`.
  Stages an **Open** run with per-document `detail` and the net. Re-running an Open period refreshes it;
  a Posted period → `ALREADY_POSTED`.
- **Post** — `POST /api/ledger/fx-reval/:id/post`. Maker-checker: the poster MUST differ from the runner
  (`SELF_POST`). Posts the GL entry (`source = 'FXREVAL-RUN'`, `viaSubledger: true` for the control legs):
  - **AR** (asset): `delta > 0` is a **gain** → **Dr 1100**; `delta < 0` → **Cr 1100**.
  - **AP** (liability): `delta > 0` is a **loss** → **Cr 2000**; `delta < 0` → **Dr 2000**.
  - **5400** takes the balancing P&L **net = Σ(AR delta) − Σ(AP delta)**: net **gain → Cr 5400** (income),
    net **loss → Dr 5400**.
  Marks the run Posted. (This is the governed, period-close counterpart of the ad-hoc `FxService.revalue`.)

### Deferred Tax (TAS 12 / TFRS, TAX-06) — `deferred_tax_runs`
Recognises deferred tax from book-vs-tax **temporary** differences at the CIT rate (default **0.20**).

- **Run** — `POST /api/ledger/deferred-tax/run` (`{ period, as_of_date?, tax_rate?, tax_dep_factor?, tenant_id? }`).
  Temporary differences gathered:
  1. **AR allowance** (deductible temp diff) — the latest **posted** `ar_allowance` (WS2.3/REV-18). Book
     recognises the allowance now; tax deducts the loss only on write-off ⇒ a deductible temp diff ⇒
     **DTA = allowance × CIT**.
  2. **Accelerated depreciation** (taxable temp diff) — book NBV (`fixed_assets.net_book_value`) vs an
     **assumed** tax NBV. *Simplifying assumption:* the model has no parallel tax-depreciation ledger, so
     tax depreciation is assumed **faster than book by a documented factor** (default **1.5×**, capped at
     the depreciable base cost − salvage), overridable per run via `tax_dep_factor`. `bookNBV − taxNBV > 0`
     ⇒ a taxable temp diff ⇒ **DTL = (bookNBV − taxNBV) × CIT**. A deliberate approximation until a tax-dep
     ledger is modelled.
  `net_deferred = DTA − DTL`; the run records the **delta vs the prior posted run**. Stages an **Open** run;
  a Posted period → `ALREADY_POSTED`.
- **Post** — `POST /api/ledger/deferred-tax/:id/post`. Maker-checker (`SELF_POST`). Posts the period
  **delta** (`source = 'DEFTAX'`): an **increase** in the net asset (`delta > 0`) is a deferred tax
  **benefit** → **Dr 1700 DTA / Cr 5950** (a credit to 5950 reduces tax expense); a **decrease**
  (`delta < 0`) → **Dr 5950 / Cr 1700**. The net is carried on **1700** for simplicity (account **2700**
  exists for split DTL presentation/disclosure; the P&L and net effect are identical). Marks the run Posted.
- **Web UI** — **`/deferred-tax`** (Ledger nav, perms `gl_close`/`gl_post`/`exec`). A "คำนวณงวดใหม่" tab
  runs the computation (showing the DTA/DTL split + temporary-difference breakdown) and a "รายการที่คำนวณ /
  โพสต์" tab lists staged/posted runs with a **โพสต์เข้า GL** button; the maker-checker rule is enforced
  server-side (`SELF_POST`), and the screen shows the runner/poster per row.

### COA accounts (added WS3.2)
| Code | Name | Type | Normal balance |
|------|------|------|----------------|
| 1700 | Deferred Tax Asset | Asset | D |
| 2700 | Deferred Tax Liability | Liability | C |
| 5950 | Deferred Tax Expense | Expense | D |
| 5400 | FX Gain/Loss (Unrealized) — *pre-existing* | Expense | D (loss) / C (gain) |

### Close-checklist integration
The WS2.1 close checklist gains two **advisory** steps — `fx_reval` (pre-existing) and `deferred_tax` (new)
— so the period close surfaces both as expected procedures. Both are advisory (do not gate the lock),
keeping existing close runs backward-compatible.

### Error codes
| Code | Meaning |
|------|---------|
| `FX_RUN_NOT_FOUND` | No FX revaluation run with that id |
| `DT_RUN_NOT_FOUND` | No deferred tax run with that id |
| `MISSING_RATE` | No closing rate for a currency (pass it in `rates` or set an approved `fx_rate`) |
| `ALREADY_POSTED` | The run (or its period) is already posted |
| `SELF_POST` | Maker-checker: the poster cannot be the runner |

### Controls
| Control ID | GL-18 | TAX-06 |
|------------|-------|--------|
| Name | Period-end FX revaluation (maker-checker) | Deferred tax recognition (maker-checker) |
| Type | Application — Automated (Preventive, Monthly/period-end) | Application — Automated (Preventive, Quarterly/year-end) |
| Risk | Open FX monetary balances not restated, or revalued/posted by one person | Temporary differences not recognised as deferred tax, or posted by one person |
| Mitigation | Run→post run table; rate from approved `fx_rates`/explicit; `SELF_POST`; 5400/1100/2000 via period-lock gate | Run→post run table; DTA(allowance)+DTL(accel-dep, documented simplification); delta posting; `SELF_POST`; 1700/5950 |
| Owner | Financial Controller | Tax / Financial Controller |
| Test | TC-GL-18-01/02 (basics.ts) | TC-TAX-06-01/02 (basics.ts) |
