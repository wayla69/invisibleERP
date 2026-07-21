# User Acceptance Testing (UAT) Plan — Invisible ERP

**Status: DRAFT v0.1 · 2026-06-22**

> **Disclaimer:** This is an engineering/QA working draft to accelerate UAT readiness for SOX 404(a) / ISO 9001 alignment. It is not legal, accounting, or compliance advice. Validate scope, control selection, and acceptance criteria with the business process owners and your independent audit firm. All `<<placeholders>>` must be completed by the named owner before this plan is approved and made effective.

---

## 1. Objective

Confirm that Invisible ERP meets the business and control requirements of each financially-significant cycle **from the business user's perspective**, and that the application's preventive/detective controls actually block the risks they are designed to block. UAT is the final gate before production cutover sign-off.

Each UAT case is traceable to:
- a **process narrative** section (`docs/process-narratives/`),
- a **Risk & Control Matrix (RCM)** control ID (`compliance/Invisible_ERP_SOX_RCM_v1.xlsx`), where the case exercises a control, and
- the **automated control-evidence harness** (`tools/cutover/src/*.ts`) that already asserts the same expected results end-to-end, so UAT and ToE evidence agree.

## 2. Scope

### In scope (11 cycles)

| # | Cycle | UAT file | UAT ID prefix |
|---|---|---|---|
| 01 | Security & Access (login, MFA, password, RBAC) | [`01-security-access-uat.md`](./01-security-access-uat.md) | UAT-SEC |
| 02 | Order-to-Cash (POS orders, AR, receipts, till, refunds) | [`02-order-to-cash-uat.md`](./02-order-to-cash-uat.md) | UAT-O2C |
| 03 | Procure-to-Pay (PR→PO→GR→3-way match→AP pay) | [`03-procure-to-pay-uat.md`](./03-procure-to-pay-uat.md) | UAT-P2P |
| 04 | Inventory & WMS (GR, lots, cycle count, pick/pack/ship) | [`04-inventory-uat.md`](./04-inventory-uat.md) | UAT-INV |
| 05 | General Ledger & Financial Close | [`05-general-ledger-close-uat.md`](./05-general-ledger-close-uat.md) | UAT-GL |
| 06 | Tax (VAT, WHT, e-Tax XML, tax-invoice numbering) | [`06-tax-uat.md`](./06-tax-uat.md) | UAT-TAX |
| 07 | Payroll (SSO, PIT, payslips, ภ.ง.ด.1) | [`07-payroll-uat.md`](./07-payroll-uat.md) | UAT-PAY |
| 08 | Admin / SoD / Access Governance / Audit | [`08-admin-sod-uat.md`](./08-admin-sod-uat.md) | UAT-ADM |
| 09 | Reports & Analytics | [`09-reports-analytics-uat.md`](./09-reports-analytics-uat.md) | UAT-RPT |
| 10 | Customer Portal (self-serve POS, loyalty, inventory) | [`10-customer-portal-uat.md`](./10-customer-portal-uat.md) | UAT-POR |
| 11 | Loyalty & CRM (member directory, 360, PDPA consent, points liability) | [`11-loyalty-crm-uat.md`](./11-loyalty-crm-uat.md) | UAT-LOY |
| 18 | Supply Chain Planning (demand forecasting, order plans, spikes) | [`18-supply-chain-planning-uat.md`](./18-supply-chain-planning-uat.md) | UAT-SCM |

### Out of scope
- Non-functional load/performance and penetration testing (covered by separate plans).
- Code-level unit tests and the cutover harnesses themselves (they are *referenced* as oracles, not re-run as UAT).
- `<<any modules deferred from this release — list here>>`.

## 3. References

| Artefact | Location |
|---|---|
| Process narratives (per-cycle, RCM-linked) | `docs/process-narratives/` |
| UAT traceability matrix | [`./uat-traceability-matrix.md`](./uat-traceability-matrix.md) |
| User manual | `<<docs/user-manual/ — link once authored>>` |
| Risk & Control Matrix (RCM) | `compliance/Invisible_ERP_SOX_RCM_v1.xlsx` |
| Segregation-of-Duties matrix + ruleset (R01–R16) | `compliance/Invisible_ERP_SoD_Matrix_v1.xlsx`, `packages/shared/src/permissions.ts` |
| API specification | `docs/02-api-spec.md` |
| Cutover / control-evidence harnesses (expected-result oracles) | `tools/cutover/src/compliance.ts`, `e2e.ts`, `match.ts`, `worldclass.ts`, `payroll.ts`, `returns.ts`, `wms.ts`, `etax.ts`, `pos-p1.ts` |
| Cutover runbook | `docs/08-cutover-runbook.md` |

## 4. Test environment & data setup

- **Environment:** dedicated UAT tenant on the staging stack (NestJS API + Next.js web, Postgres with RLS enabled, JWT auth). URL: `<<https://uat.example.com>>`, API base `/api`.
- **Localization:** Thai locale, currency THB, **VAT 7%**, business timezone Asia/Bangkok (date/period boundaries use Bangkok time, not UTC).
- **Seed data (mirror the cutover harness seeds):**
  - Tenants: `HQ` (head office / bypass), `T1` (ร้านหนึ่ง, VAT-registered), `T2` (ร้านสอง) for cross-tenant RLS checks; plus a credit-limited tenant (`creditLimit` 1000, with an open AR invoice ~800) for credit tests.
  - Chart of accounts seeded (includes 1000, 1500/1510/1590, 2000, 2100, 2350, 2360, 3100 Retained Earnings, 4000, 5100, 5200, 5600, 5610).
  - Master items, at least one approved vendor and one blocklistable vendor, a customer with portal login, loyalty config (1 point / baht).
  - Employees for payroll (e.g. 30,000 and 12,000 baht/month salaries).
- **Reset policy:** the dataset is restored from a known snapshot before each formal UAT run so doc-number sequences and balances are deterministic.

## 5. Roles needed for execution

Provision one UAT account per role used by the cases. Roles are least-privilege single-duty plus the coarse roles:

- **Coarse:** Admin, Sales, Customer, Warehouse, Procurement, Planner.
- **Single-duty:** Cashier, PosSupervisor, ArClerk, ApClerk, Buyer, WarehouseOperator, InventoryController, StockCounter, GlAccountant, FinancialController, MasterDataAdmin, PricingManager, CreditManager, ReturnsClerk, AccessAdmin, ExecutiveViewer.

**SoD guardrail for provisioning:** maker and checker for any approval must be different roles/users (e.g. GlAccountant prepares JEs, FinancialController approves). Do not grant a single UAT account both sides of any SoD rule R01–R16 unless the test explicitly exercises the override path.

## 6. Entry criteria

1. Build deployed to UAT is the release candidate; build/version recorded: `<<version>>`.
2. All cutover harnesses pass green in CI (e2e, compliance, match, worldclass, payroll, returns, wms, etax, pos-p1).
3. Process narratives and this UAT plan are reviewed; traceability matrix complete.
4. Seed data loaded and verified; UAT role accounts provisioned with MFA where required for privileged roles.
5. Defect-tracking tool ready; UAT testers briefed.

## 7. Exit criteria

1. 100% of **High** priority and **all Control-type** cases executed with **Pass**.
2. ≥ 95% of all UAT cases executed; ≥ 90% overall Pass rate.
3. **Zero open Critical or High defects**; Medium defects have an agreed remediation plan or accepted waiver signed by the business owner.
4. Traceability matrix shows every in-scope requirement/control covered by at least one executed case.
5. Sign-off (Section 11) obtained from UAT Lead, Business Owner, and IT.

## 8. Defect severity definitions

| Severity | Definition | Example |
|---|---|---|
| **Critical** | Control failure or data integrity loss; blocks cutover. | A preparer can self-approve a JE; audit_log can be updated; cross-tenant data leak. |
| **High** | Core business flow broken with no workaround; or wrong financial amount. | Credit-limit breach not blocked; VAT computed wrong; payroll net incorrect. |
| **Medium** | Flow works but with an inconvenient workaround, or non-financial defect. | Confusing error message; export missing a non-key column. |
| **Low** | Cosmetic / minor usability. | Label typo, alignment, Thai translation nit. |

## 9. Execution workflow

1. Tester picks cases for their assigned cycle, in ID order; preconditions first.
2. Execute steps exactly as written using the stated role and test data.
3. Compare actual vs **Expected result** (error codes/amounts are exact — a different code is a Fail).
4. Record **Pass/Fail** and evidence (screenshot or API response with status + body) in the **Result**/**Notes** columns.
5. Log any Fail as a defect with severity (Section 8), steps to reproduce, and evidence; link the UAT ID.
6. Re-test fixed defects; update Result. UAT Lead reviews daily and updates the traceability matrix.

## 10. Status legend

`Pass` · `Fail` · `Blocked` · `N/A` · `Not Run` (default).

## 11. Sign-off

UAT is accepted when all parties below sign, confirming the exit criteria (Section 7) are met.

| Role | Name | Signature | Date |
|---|---|---|---|
| UAT Lead | `<<name>>` | `<<__________>>` | `<<____ / ____ / ____>>` |
| Business Owner | `<<name>>` | `<<__________>>` | `<<____ / ____ / ____>>` |
| IT / Application Owner | `<<name>>` | `<<__________>>` | `<<____ / ____ / ____>>` |

Outstanding-defect summary at sign-off: Critical `<<0>>` · High `<<0>>` · Medium `<<n>>` · Low `<<n>>`.

## 12. Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-22 | `<<author>>` | Initial UAT plan + 10 cycle test lists + traceability matrix. |
| 0.2 | 2026-06-24 | Platform | Added cycle 11 — Loyalty & CRM (`11-loyalty-crm-uat.md`, UAT-LOY): member directory, 360, PDPA consent, points-liability tie-out. Total cases 260 → 267. |
