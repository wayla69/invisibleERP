# UAT Traceability Matrix — Invisible ERP V2

**Status: DRAFT v0.1 · 2026-06-22**

Maps every UAT case → cycle → requirement/feature → RCM control (where applicable) → process-narrative section. RCM control IDs reference `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx`; SoD rules (R01–R13) reference `packages/shared/src/permissions.ts`. Process-narrative files are in `docs/process-narratives/`.

Coverage check: every in-scope requirement/control should appear in ≥1 executed case (UAT exit criterion §7.4). Section numbers in the narrative column follow the common 14-section structure (§7 = Process narrative, §9 = Control matrix).

## 01 — Security & Access → `08-itgc.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-SEC-001 | JWT login returns token + role | ITGC-AC-01 | 08 §7, §9 |
| UAT-SEC-002 | Bad-credential rejection | ITGC-AC-01 | 08 §9, §13 |
| UAT-SEC-003 | Auth required on protected routes | ITGC-AC-02 | 08 §7 |
| UAT-SEC-004 | First-login forced password change | ITGC-AC-04 | 08 §7 |
| UAT-SEC-005 | Password min-length policy | ITGC-AC-05 | 08 §9 |
| UAT-SEC-006 | Mandatory MFA for privileged role | ITGC-AC-06 | 08 §9 |
| UAT-SEC-007 | MFA not forced for low-privilege role | ITGC-AC-06 | 08 §9 |
| UAT-SEC-008 | TOTP enrolment | ITGC-AC-06 | 08 §7 |
| UAT-SEC-009 | MFA_REQUIRED enforcement | ITGC-AC-06 | 08 §9, §13 |
| UAT-SEC-010 | MFA_INVALID enforcement | ITGC-AC-06 | 08 §9, §13 |
| UAT-SEC-011 | Password + TOTP authn | ITGC-AC-06 | 08 §7 |
| UAT-SEC-012 | MFA disable | ITGC-AC-06 | 08 §7 |
| UAT-SEC-013 | Effective permissions exposed | ITGC-AC-07 | 08 §7 |
| UAT-SEC-014 | RBAC deny without permission | ITGC-AC-07 | 08 §9 |
| UAT-SEC-015 | RLS cross-tenant isolation | ITGC-AC (RLS) | 08 §7, §9 |
| UAT-SEC-016 | Edge security headers | ITGC-OP | 08 §9 |
| UAT-SEC-017 | Aggregator webhook requires secret | ITGC-AC-03 | 08 §7 |
| UAT-SEC-018 | PSP webhook tenant-scoped | ITGC-AC-03 | 08 §7 |

## 02 — Order-to-Cash → `01-order-to-cash.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-O2C-001 | Create sales order | REV-01 | 01 §7 |
| UAT-O2C-002 | Order within credit limit | REV-08 | 01 §9 |
| UAT-O2C-003 | Credit-limit block (CREDIT_LIMIT) | REV-08 | 01 §9, §13 |
| UAT-O2C-004 | Credit-hold block (CREDIT_HOLD) | REV-08 | 01 §9, §13 |
| UAT-O2C-005 | Order status transitions | REV-02 | 01 §7 |
| UAT-O2C-006 | AR invoice generation (INV-) | REV-04 | 01 §7 |
| UAT-O2C-007 | AR receipt (RCP-) | REV-05 | 01 §7 |
| UAT-O2C-008 | Portal sale VAT + loyalty | REV-03, GL-01 | 01 §7 |
| UAT-O2C-009 | Tender capture | REV-06 | 01 §7 |
| UAT-O2C-010 | Full refund | REV-09 | 01 §7 |
| UAT-O2C-011 | Over-refund block | REV-09 | 01 §9, §13 |
| UAT-O2C-012 | Return + restock + GL reversal | REV-09, GL-01 | 01 §7, §9 |
| UAT-O2C-013 | Partial return pro-rata VAT | REV-09 | 01 §7 |
| UAT-O2C-014 | Over-return block (OVER_RETURN) | REV-09 | 01 §9, §13 |
| UAT-O2C-015 | No-captured-payment block | REV-09 | 01 §13 |
| UAT-O2C-016 | Till open/close Z-report variance | REV-11, REC-02 | 07 §7, §9 |
| UAT-O2C-017 | Blind drawer close | REV-11 | 07 §9 |
| UAT-O2C-018 | PromptPay async settlement | REV-06 | 07 §7 |
| UAT-O2C-019 | RLS return isolation | ITGC-AC (RLS) | 08 §9 |
| UAT-O2C-020 | POS home store overview | Feature (POS dashboard) | 01 §0 |
| UAT-O2C-021 | Cashier read-only shift KPIs | RBAC (least-privilege read) | 01 §0 |
| UAT-O2C-022 | ERP/POS workspace switcher | Feature (ERP/POS workspaces) | 00 §4 |

## 03 — Procure-to-Pay → `02-procure-to-pay.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-P2P-001 | Create PO | EXP-01 | 02 §7 |
| UAT-P2P-002 | PO approval (maker≠checker) | EXP-01, R02 | 02 §9 |
| UAT-P2P-003 | Goods receipt | EXP-02 | 02 §7 |
| UAT-P2P-004 | 3-way match success | EXP-03 | 02 §7, §9 |
| UAT-P2P-005 | Matched pay + GL | EXP-03, GL-01 | 02 §7 |
| UAT-P2P-006 | Price variance block (MATCH_BLOCKED) | EXP-03 | 02 §9, §13 |
| UAT-P2P-007 | Over-invoice block | EXP-03 | 02 §9, §13 |
| UAT-P2P-008 | Match tolerance | EXP-03 | 02 §9 |
| UAT-P2P-009 | Override-with-reason | EXP-03, R04 | 02 §9 |
| UAT-P2P-010 | Override reset on re-match | EXP-03 | 02 §9, §13 |
| UAT-P2P-011 | Non-PO bill (gate fails open) | EXP-03 | 02 §7 |
| UAT-P2P-012 | Blocklisted vendor (SUPPLIER_BLOCKED) | EXP-04, R13 | 02 §9, §13 |
| UAT-P2P-013 | Un-blocklist vendor | EXP-04 | 02 §7 |
| UAT-P2P-014 | RFQ→quote→award→PO | EXP-01 | 02 §7 |
| UAT-P2P-015 | Match idempotency | EXP-03 | 02 §7 |
| UAT-P2P-016 | RLS vendor isolation | ITGC-AC (RLS) | 08 §9 |
| UAT-P2P-017 | AP↔GL reconciliation | REC-01 | 04 §9 |

## 04 — Inventory & WMS → `03-inventory-cogs.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-INV-001 | Stock + low-stock count | INV-01 | 03 §7 |
| UAT-INV-002 | Bin creation | INV-02 | 03 §7 |
| UAT-INV-003 | Putaway updates stock | INV-02 | 03 §7 |
| UAT-INV-004 | Putaway idempotency | INV-02 | 03 §9 |
| UAT-INV-005 | Wave → pick lists | INV-03 | 03 §7 |
| UAT-INV-006 | Re-wave idempotency | INV-03 | 03 §9 |
| UAT-INV-007 | Pick decrements stock | INV-03 | 03 §7 |
| UAT-INV-008 | Over-pick block (PICK_SHORT) | INV-03, R11 | 03 §9, §13 |
| UAT-INV-009 | Pack | INV-03 | 03 §7 |
| UAT-INV-010 | Ship + tracking | INV-03 | 03 §7 |
| UAT-INV-011 | WMS posts zero GL | INV-04 | 03 §9 |
| UAT-INV-012 | Replenishment suggestion | INV-01 | 03 §7 |
| UAT-INV-013 | Auto-PR | INV-01 | 03 §7 |
| UAT-INV-014 | RMA restock + credit | REV-07 | 03 §7 |
| UAT-INV-015 | RMA restock idempotency | REV-07 | 03 §9 |
| UAT-INV-016 | Cycle-count variance review | INV-01 | 03 §7, §9 |
| UAT-INV-017 | RLS bin/suggestion isolation | ITGC-AC (RLS) | 08 §9 |
| UAT-INV-018 | Trial balance balanced | REC-01 | 04 §9 |
| UAT-INV-019 | Multi-level MRP explosion + netting | Feature (MRP) | 15 §5a |
| UAT-INV-020 | MRP plan-to-PR creates a real PR | Feature (MRP→PR) | 15 §5a |
| UAT-INV-021 | Circular BOM rejected | Feature (MRP guard) | 15 §5a |
| UAT-INV-022 | MRP lot-sizing (min/multiple/EOQ) | Feature (MRP lot-sizing) | 15 §5a |
| UAT-INV-023 | Rough-cut capacity overload flag | Feature (RCCP) | 15 §5a |

## 05 — General Ledger & Close → `04-general-ledger-close.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-GL-001 | COA seeded | GL-01 | 04 §7 |
| UAT-GL-002 | Manual JE posts Draft | GL-05 | 04 §9 |
| UAT-GL-003 | Draft excluded from balances | GL-05 | 04 §9 |
| UAT-GL-004 | Pending-approval queue | GL-05 | 04 §7 |
| UAT-GL-005 | Self-approval block (SOD_VIOLATION) | GL-05, R05 | 04 §9, §13 |
| UAT-GL-006 | Independent approver posts | GL-05 | 04 §9 |
| UAT-GL-007 | Reject → Voided | GL-05 | 04 §9 |
| UAT-GL-008 | Maker-checker binds Admin | GL-05, R05 | 04 §9 |
| UAT-GL-009 | Unbalanced JE block (UNBALANCED) | GL-02 | 04 §9, §13 |
| UAT-GL-010 | Trial balance ties | REC-01 | 04 §9 |
| UAT-GL-011 | Period close lock (PERIOD_CLOSED) | GL-04, R06 | 04 §9, §13 |
| UAT-GL-012 | Period re-open | GL-04 | 04 §7 |
| UAT-GL-013 | Year-end close to RE | GL-06 | 04 §7 |
| UAT-GL-014 | Balance sheet + RE | GL-06 | 04 §9 |
| UAT-GL-015 | Year-end close idempotency | GL-06 | 04 §9 |
| UAT-GL-016 | Sub-ledger reconciliation | REC-01 | 04 §9 |
| UAT-GL-017 | Reconciliation prepare→certify | REC-02/03 | 04 §9 |
| UAT-GL-018 | RLS GL isolation | ITGC-AC (RLS) | 08 §9 |

## 06 — Tax → `06-tax-compliance.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-TAX-001 | VAT 7% calc | TAX-01 | 06 §7 |
| UAT-TAX-002 | VAT on portal sale | TAX-01, REV-03 | 06 §7 |
| UAT-TAX-003 | Currency rounding | TAX-01 | 06 §9 |
| UAT-TAX-004 | Currency list | TAX-01 | 06 §7 |
| UAT-TAX-005 | e-Tax XML (UBL 2.1) | TAX-02 | 06 §7 |
| UAT-TAX-006 | e-Tax header fields | TAX-02 | 06 §7 |
| UAT-TAX-007 | e-Tax parties/tax IDs | TAX-02 | 06 §7 |
| UAT-TAX-008 | e-Tax tax/totals | TAX-02 | 06 §9 |
| UAT-TAX-009 | e-Tax escaping | TAX-02 | 06 §9 |
| UAT-TAX-010 | e-Tax submission | TAX-02 | 06 §7 |
| UAT-TAX-011 | e-Tax resubmit idempotency | TAX-02 | 06 §9 |
| UAT-TAX-012 | Tax-invoice numbering | TAX-03 | 06 §9 |
| UAT-TAX-013 | WHT on payroll | PAY-02 | 05 §7, 06 §7 |

## 07 — Payroll → `05-payroll.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-PAY-001 | Create employees | PAY-01 | 05 §7 |
| UAT-PAY-002 | List employees | PAY-01 | 05 §7 |
| UAT-PAY-003 | Run payroll posts GL | PAY-01, GL-01 | 05 §7 |
| UAT-PAY-004 | SSO+WHT+net totals | PAY-01 | 05 §9 |
| UAT-PAY-005 | SSO cap 750 | PAY-01 | 05 §9 |
| UAT-PAY-006 | SSO 5% below cap | PAY-01 | 05 §7 |
| UAT-PAY-007 | GL expense/payables | PAY-01, GL-01 | 05 §9 |
| UAT-PAY-008 | Payroll idempotency | PAY-01 | 05 §9 |
| UAT-PAY-009 | ภ.ง.ด.1 summary | PAY-02 | 05 §7 |
| UAT-PAY-010 | Payslips | PAY-01 | 05 §7 |
| UAT-PAY-011 | PIT/WHT withholding | PAY-02 | 05 §9 |
| UAT-PAY-012 | RLS payroll isolation | ITGC-AC (RLS) | 08 §9 |
| UAT-PAY-013 | RBAC non-HCM block | ITGC-AC-07 | 08 §9 |
| UAT-PAY-014 | ESS self-service own data | Feature (ESS), ITGC-AC | 25 §7 |
| UAT-PAY-015 | ESS expense → GL on approve | Feature (ESS), GL-01 | 25 §7 |
| UAT-PAY-016 | ESS expense self-approval blocked | ITGC-AC-09 | 25 §7 |
| UAT-PAY-017 | ESS unlinked user refused | Feature (ESS) | 25 §7 |
| UAT-PAY-018 | Payroll run tenant-scoped | ITGC-AC-03 | 05 §7 |

## 08 — Admin / SoD / Audit → `08-itgc.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-ADM-001 | SoD block on create (SOD_CONFLICT) | ITGC-AC-09, R03 | 08 §9 |
| UAT-ADM-002 | Block names rule | ITGC-AC-09, R03 | 08 §13 |
| UAT-ADM-003 | Justified override | ITGC-AC-09, R03 | 08 §9 |
| UAT-ADM-004 | Override without reason rejected | ITGC-AC-09 | 08 §9 |
| UAT-ADM-005 | Clean set accepted | ITGC-AC-09 | 08 §7 |
| UAT-ADM-006 | SoD block on update | ITGC-AC-09, R03 | 08 §9 |
| UAT-ADM-007 | Access-review report | ITGC-AC-08 | 08 §9 |
| UAT-ADM-008 | Access-review CSV export | ITGC-AC-08 | 08 §9 |
| UAT-ADM-009 | UAR certification | ITGC-AC-08 | 08 §9 |
| UAT-ADM-010 | Audit log capture | ITGC-AC-10 | 08 §9 |
| UAT-ADM-011 | Audit UPDATE blocked | ITGC-AC-10 | 08 §9 |
| UAT-ADM-012 | Audit DELETE blocked | ITGC-AC-10 | 08 §9 |
| UAT-ADM-013 | API key authn | ITGC-AC-07 | 08 §7 |
| UAT-ADM-014 | Self-serve signup | ITGC-AC-04 | 08 §7 |
| UAT-ADM-015 | Duplicate tenant 409 | ITGC-AC-04 | 08 §13 |
| UAT-ADM-016 | SoD conflict report | ITGC-AC-08/09 | 08 §9 |

## 09 — Reports & Analytics → `01`/`04` narratives

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-RPT-001 | Dashboard KPIs | — (reporting) | 01 §12 |
| UAT-RPT-002 | Finance KPI MTD | — | 04 §12 |
| UAT-RPT-003 | Stock summary | — | 03 §12 |
| UAT-RPT-004 | Notifications | — | 03 §12 |
| UAT-RPT-005 | Replenishment analytics | — | 03 §12 |
| UAT-RPT-006 | AR aging | REC-01 | 01 §9 |
| UAT-RPT-007 | AP aging | REC-01 | 02 §9 |
| UAT-RPT-008 | P&L / income statement | GL-06 | 04 §9 |
| UAT-RPT-009 | Daily sales + export | — | 01 §12 |
| UAT-RPT-010 | Monthly P&L export | — | 04 §12 |
| UAT-RPT-011 | Stock summary export | — | 03 §12 |
| UAT-RPT-012 | AP aging export | REC-01 | 02 §12 |
| UAT-RPT-013 | Sales-cube / trend | — | 01 §12 |
| UAT-RPT-014 | Anomaly detection | — | 04 §12 |
| UAT-RPT-015 | Reconciliation dashboard | REC-01 | 04 §9 |
| UAT-RPT-016 | RLS report isolation | ITGC-AC (RLS) | 08 §9 |
| UAT-RPT-017 | Read-only role cannot mutate | ITGC-AC-07 | 08 §9 |
| UAT-RPT-018 | RAG ingest + retrieve a policy | Feature (RAG) | 26 §7 |
| UAT-RPT-019 | RAG cite-or-refuse (off-topic) | Feature (RAG safety) | 26 §7 |
| UAT-RPT-020 | RAG tenant isolation (RLS) | ITGC-AC-03 | 26 §7 |
| UAT-RPT-021 | Demand ML backtest beats naive | BI-01 (backtest accuracy) | 26 §8a |
| UAT-RPT-022 | Demand forecast auto-select + persist | BI-04 (advisory) | 26 §8a |
| UAT-RPT-023 | Demand forecast input guards | Feature (demand ML guard) | 26 §8a |
| UAT-RPT-024 | Demand forecasts tenant-isolated (RLS) | ITGC-AC (RLS) | 26 §8a |

## 10 — Customer Portal → `01-order-to-cash.md` / `08-itgc.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-POR-001 | Customer login | ITGC-AC-01 | 08 §7 |
| UAT-POR-002 | Portal inventory RLS | ITGC-AC (RLS) | 08 §9 |
| UAT-POR-003 | Self-serve sale VAT 7% | REV-03, GL-01 | 01 §7 |
| UAT-POR-004 | Loyalty accrual | REV-03 | 01 §7 |
| UAT-POR-005 | Sale wires GL+payment | REV-06, GL-01 | 01 §7 |
| UAT-POR-006 | Sale links to till | REV-11 | 07 §9 |
| UAT-POR-007 | Portal sale return | REV-09 | 01 §7 |
| UAT-POR-008 | RMA credit | REV-07 | 03 §7 |
| UAT-POR-009 | Cross-tenant sale RLS | ITGC-AC (RLS) | 08 §9 |
| UAT-POR-010 | Over-return guard | REV-09 | 01 §9 |
| UAT-POR-011 | Billing plans public | — | 08 §7 |
| UAT-POR-012 | Credit hold/limit on portal | REV-08 | 01 §9 |

## Coverage summary

| Cycle | Cases | Control-type cases |
|---|---|---|
| 01 Security & Access | 18 | 12 |
| 02 Order-to-Cash | 19 | 9 |
| 03 Procure-to-Pay | 17 | 9 |
| 04 Inventory & WMS | 23 | 6 |
| 05 GL & Close | 18 | 9 |
| 06 Tax | 13 | 4 |
| 07 Payroll | 18 | 7 |
| 08 Admin / SoD / Audit | 16 | 10 |
| 09 Reports & Analytics | 24 | 5 |
| 10 Customer Portal | 12 | 5 |
| **Total** | **159** | **69** |
