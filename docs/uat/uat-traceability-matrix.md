# UAT Traceability Matrix — Invisible ERP V2

**Status: DRAFT v5.2 · 2026-07-07** · *v5.2: master-data audit Phase 7 — Thai address standardization: UAT-O2C-269..270 (customer province canonicalised to the 77-province reference + postal 5-digit validation + unknown-province-kept) + UAT-P2P-117 (vendor equivalent); new read-only `GET /api/geo/provinces` (`common/thai-address.ts`); no new control, no migration; harnesses `customers.ts`/`match.ts`.* · *v5.1: master-data audit Phase 6 — universal master-data change history: UAT-O2C-267..268 (customer create/onboarding + field-level old→new + sensitive-column masking) + UAT-P2P-116 (vendor equivalent); the DB-trigger field-level change log (`data_change_log`, ITGC-AC-14) extended to the master + child tables (migration `0274`), append-only, DB-enforced; strengthens ITGC-AC-14, no new control; harnesses `customers.ts`/`match.ts`.* · *v5.0: master-data audit Phase 5 — match-merge / duplicate resolution (DQM) for both customer_master and vendors: UAT-O2C-264..266 (detect probable duplicates, governed merge with child-row repoint + survivorship + soft-retire, self/already-merge guards) + UAT-P2P-115 (vendor equivalent); app-side fuzzy name matching (`pg_trgm` not enabled) + generic `md_merge_repoint` (migration `0273`); no new control; harnesses `customers.ts`/`match.ts`.* · *v4.9: master-data audit Phase 4 — full relational Party-model depth for both customer_master and vendors: UAT-O2C-261..263 (customer multi-address/multi-contact/parent-company link) + UAT-P2P-114 (vendor multi-address/multi-contact/parent-vendor link); no new control; harnesses `customers.ts`/`match.ts`.* · *v4.8: master-data audit Phase 3 — UAT-O2C-260 (customer master gains credit_terms/sales_rep/category/language/external_ref + a direct-edit endpoint + its first web CRUD screen `/customers`, the fast-follow flagged in rev 0.10); no new control; harness `customers.ts`.* · *v4.7: master-data audit Phase 2 field-exposure cases — UAT-P2P-113 (vendor master direct-edit + supplier-list enrichment), UAT-GL-128..130 (item-master fields on `/setup/items`, warehouse master fields on `/setup/warehouses`, asset register location/department/serial/assigned-to), UAT-PAY-045 (employee-master fields on `/payroll`) — all "no new control", wiring existing schema columns to screens that previously omitted them; harnesses `match.ts`, `basics.ts`, `payroll.ts`.* · *v4.6: added UAT-P2P-112 (vendor bank-detail change maker-checker — new control EXP-11; a vendor's payee bank_name/bank_account is staged PendingApproval by `md_vendor` and applied only when a distinct `exec`/`approvals` user approves, self-approval → `SOD_VIOLATION`; migration `0270`); harness `match.ts`.* · *v4.5: added UAT-TAX-043 (issuing a full tax invoice upserts the buyer into customer_master — new buyer gets address/branch/tax-id, a repeat buyer's address is refreshed not duplicated; web buyer-name autocomplete searches it; migration 0269, no new control); harness `taxdocs.ts`.* · *v4.4: added UAT-TAX-042 (full tax invoice "ชำระเงินโดย" Paid By section — POS auto-derives from the sale's payment method, AR settable + a due date, presentation/data-adjacent, migration 0268, no new control); harness `taxdocs.ts`.* · *v4.3: Phase P3 detective-first maker-checker gaps + the cross-cutting readiness check (audit G14/G16/G10 + workflow-definition readiness) — UAT-O2C-258 (G14 POS void/refund exception report `GET /api/payments/exceptions/voids-refunds` for independent periodic review; voids + sub-threshold refunds single-user by design), UAT-O2C-259 (G10 bank-statement import single-user by design, imported lines folded into the reconciliation certifier's evidence — REC-02/R06; documentation only), UAT-TAX-041 (G16 voided-tax-invoice exception report `GET /api/tax-invoices/exceptions/voided`; void stays single-user per RD requirement), UAT-P2P-110 (cross-cutting workflow-definition readiness reporter `GET /api/workflow/readiness` detects engine-wired docTypes PR/PO/BUDGET/PMR/BQR that lack a definition and would auto-approve) — all detective/config, strengthening existing SoD (R08/R12/R06/EXP-03/R07) with NO new numbered control; harnesses `refund-approval.ts`/`bankrec.ts`/`taxdocs.ts`/`workflow.ts`.* · *v4.2: Phase P2 preventive maker-checker gaps (audit G9/G12/G13/G15) — UAT-O2C-253..254 (G12 CPQ: quote author cannot self-accept a billable quote → `SOD_VIOLATION`, no revenue; a distinct exec accepts → Dr 1100/Cr 4000; no migration), UAT-O2C-255..257 (G9 bank: a new account is PendingApproval + can't bank cash `BANK_NOT_APPROVED` until a distinct approver activates it; migration 0264), UAT-ADM-125..127 (G15 tenant PromptPay/Tax-ID change staged for a distinct approver; QR refused while pending; migration 0265), UAT-LOY-066..068 (G13 staff point transfers > 500 pts staged for a distinct approver; migration 0266) — all strengthening existing SoD (R02/R07/R10/R15/R16) + REC-05/CPQ-03/LYL-18 with NO new numbered control; harnesses `cpq-gl.ts`/`cash-banking.ts`/`promptpay.ts`/`loyalty.ts`.* · *v4.1: sensitive-field bulk-import maker-checker (audit gaps G5+G8) — UAT-ADM-121..124 added (a non-sensitive vendor import commits directly; an import that SETS a sensitive master field — customer/vendor credit limit, vendor payment terms, price-list price, promotion discount — is STAGED `PendingApproval` in `masterdata_import_batches` (migration `0263`) and writes nothing; requester self-approve → `SOD_VIOLATION`; a distinct `exec`/`approvals` approver applies it → the rows + credit limit are written), strengthening SoD **R02/R09/R10/R13** + MDM-01/MDM-03 (no new numbered control); harness `ext.ts`; narrative PN-17 §7.3d.* · *v4.0: price/promo rule activation → two-person maker-checker (audit gap G6) — UAT-O2C-250..252 added (a rule change stages `PendingApproval`/`active=false` so it affects no quote or sale; author self-approve → `SOD_VIOLATION`; a distinct `exec`/`approvals` approver activates it → the discount then applies), strengthening SoD **R10** / **MKT-01** (no new control); migration `0262`; harness `pricing.ts`.* · *v3.9: SoD self-service override → two-person maker-checker (audit gap G11, part b) — UAT-ADM-003 updated + UAT-ADM-117..120 added (a justified SoD override is STAGED PendingApproval and no longer self-applied — user NOT created; requester self-approve → `SOD_VIOLATION`; a distinct admin approves → user created with the conflicting set + who/why/rules persisted in the hash-chained audit meta; no-reason still `SOD_CONFLICT`), strengthening ITGC-AC-09; migration `0253` (`access_grant_exceptions`); harness `compliance.ts`.* · *v3.8: gift-card issuance maker-checker (audit gap G1) — UAT-GL-065..068 added (a gift card is a cash-equivalent 2200 liability; face > 5,000 THB now issues `PendingApproval` → no GL, not redeemable (`GIFT_CARD_INACTIVE`); issuer self-approve → `SOD_VIOLATION`; a distinct `creditors`/`exec` approver posts Dr 1000/Cr 2200 + activates; ≤ 5,000 THB still auto-issues), strengthening GC-01/GL-01 (SoD R14); migration 0252; harness `giftcards.ts`.* · *v3.7: EXP-08 fund-funding maker-checker (audit gap G3) — UAT-P2P-050/056 updated + UAT-P2P-058/059 added (petty-cash **fund establishment & replenishment** now route through a PendingApproval funding request → distinct-user approval posts Dr 1015 / Cr 1000; self-approval → SOD_VIOLATION); harnesses `basics.ts` / `compliance.ts`.* · *v3.6: added UAT-GL-060..064 (GL dual-control gap closures — opening-balance batch maker-checker G4 + distinct-reverser on manual reversal G2, strengthening GL-05/GL-17; harnesses `opening-balances.ts`, `basics.ts`).* · *v3.5: added UAT-ADM-114..116 (ITGC-AC-02 — Admin-grant restricted to the platform owner) + UAT-SEC-054 (ITGC-AC-18 — public signup → request-access queue, god-only company creation); harness `onboarding.ts` + `signup-gate.test.ts`.* · *v3.4: added UAT-GL-126..127 (FA-12 asset verification-exception + audit BI reports; harness `module-qr.ts`).* · *v3.3: added UAT-GL-121..125 (FA-11 asset custody-change maker-checker + audit-by-scan; harness `module-qr.ts`).* · *v3.2: added UAT-INV-069b/069c/070b (cross-browser scanner via @zxing fallback + 1D barcodes + continuous scan; `/q` page e2e `qr-resolver.spec.ts`).* · *v3.1: added UAT-INV-066..070 (QR camera scanning + `/q` deep-link resolver — capture-only, no control change; harness `module-qr.ts`).* · *v3.0: added UAT-P2P-104 (docs/34 Phase 4 — Email-to-Capture: verified send-from address + inbound bill webhook).* · *v2.9: added UAT-P2P-103 (docs/34 Phase 1 — Quick Capture over LINE `บิล` + photo).* · *v2.8: added UAT-P2P-101/102 (docs/34 Quick Capture lane — any `pr_raise` staffer snaps/uploads a bill → NeedsReview draft; SoD capturer ≠ poster).* · *v2.7: added UAT-O2C-234 (docs/32 FU4 — raise site cash from the project workspace; team walkthrough doc added).* · *v2.6: added UAT-P2P-100 (partial receive + short/damaged claim from chat).* · *v2.5: added UAT-P2P-099 (purchase spend insights — chat `spend` + `/spend-summary` + `purchase_spend` report).* · *v2.4: added UAT-P2P-098 (close-the-loop LINE notifications to the PR requester).* · *v2.3: added UAT-P2P-097 (proactive morning low-stock alert → one-tap reorder).* · *v2.2: added UAT-P2P-096 (reorder low stock → one-tap PR — web card + LINE `low`/`reorder`).* · *v2.1: reconciled the UAT-P2P-093 collision after merging main — 093 = vendor AP card (merged separately), PR→PO conversion renumbered to 094, one-tap goods receipt (web รับครบ + LINE `receive`) to 095.* · *v2.0: added the one-tap goods-receipt case (now 095).* · *v1.9: added the PR→PO conversion case (now 094).* · *v1.8: added UAT-RPT-049 (LP-3 — digest 2.0).* · *v1.7: added UAT-P2P-092, UAT-PAY-039, UAT-RPT-048 (LP-2 — copilot uplift).* · *v1.6: added UAT-SEC-049/050 (LP-1 — LINE OA production go-live pack).* · *v1.5: added UAT-P2P-086..091 (EXP-10 — AP invoice intake: scan → PO auto-map → matched-at-posting, duplicate refusal, cumulative guard, scheduled auto re-match release, direct image/PDF upload).* · *v1.5: added UAT-P2P-085 + UAT-RPT-047 (LC-5 copilot + ask).* · *v1.4: added UAT-RPT-046 (LC-4 LINE delivery + digest).* · *v1.3: added UAT-SEC-048 + UAT-PAY-038 (LC-3 leave via chat + channel governance).* · *v1.2: added UAT-P2P-084 (LC-2 petty-cash chat raise + EXP-08 notifications).* · *v1.1: added UAT-P2P-083 (LC-1 one-tap chat approvals).* · *v1.0: added UAT-P2P-081..082 (PO attachment evidence — web + LINE chat photo attach).* · *v0.9: added UAT-P2P-076..080 (LINE chat phase 2 — workflow notifications, chat approve/reject with engine SoD, self-service commands).* · *v0.8: added UAT-P2P-070..075 (LINE chat → PR — link-code identity binding, chat-raised PR into the same approval workflow, entry-integrity negatives).* · *v0.7: added UAT-O2C-226..227 (PROJ-03 project period-end close review UI + PROJ-04 timesheet project allocation surfaced in `/hcm`).* · *v0.6: added UAT-SEC-036..045 (ITGC-AC-17 — POS-PIN quick-login restriction).* · *v0.5: added UAT-ADM-094..096 (SoD R12 — /returns nav perm for AR/pos_refund).*

Maps every UAT case → cycle → requirement/feature → RCM control (where applicable) → process-narrative section. RCM control IDs reference `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx`; SoD rules (R01–R16) reference `packages/shared/src/permissions.ts`. Process-narrative files are in `docs/process-narratives/`.

Coverage check: every in-scope requirement/control should appear in ≥1 executed case (UAT exit criterion §7.4). Section numbers in the narrative column follow the common 14-section structure (§7 = Process narrative, §9 = Control matrix).

## 01 — Security & Access → `08-itgc.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-SEC-001 | JWT login returns token + role | ITGC-AC-01 | 08 §7, §9 |
| UAT-SEC-002 | Bad-credential rejection | ITGC-AC-01 | 08 §9, §13 |
| UAT-SEC-003 | Auth required on protected routes | ITGC-AC-02 | 08 §7 |
| UAT-SEC-004 | First login forces password change (hard API gate) | ITGC-AC-07 | 08 §7 |
| UAT-SEC-046 | Permission change revokes outstanding sessions immediately | ITGC-AC-15, ITGC-AC-02 | 08 §7 |
| UAT-SEC-047 | Employee DSAR access/erasure with statutory payroll retention | PDPA-02, ITGC-AC-19 | 08 §7 |
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
| UAT-SEC-019 | Input-validation hardening (qint/Zod) | ITGC-AC-02 | 08 §7 |
| UAT-SEC-020 | Username login case/whitespace-insensitive | ITGC-AC-01 | 08 §7 |
| UAT-SEC-021 | Password remains case-sensitive (not trimmed) | ITGC-AC-01 | 08 §7, §13 |
| UAT-SEC-022 | Logout revokes the token (jti denylist) | ITGC-AC-15 | 08 §7, §9 |
| UAT-SEC-023 | Deactivated account's existing token rejected live | ITGC-AC-15 | 08 §7, §9 |
| UAT-SEC-024 | Revoke-all-sessions invalidates pre-existing tokens | ITGC-AC-15 | 08 §7, §9 |
| UAT-SEC-025 | Audit hash chain verifies intact | ITGC-AC-16 | 08 §7, §9 |
| UAT-SEC-026 | Tampering a past audit row is detected (hash mismatch) | ITGC-AC-16 | 08 §7, §9 |
| UAT-SEC-027 | Member OTP login sets httpOnly cookie (no JS-readable token) | ITGC-AC-07 | 08 §7, 19 §7 |
| UAT-SEC-028 | Member cookie session authenticates self-scoped read | ITGC-AC-07 | 08 §7, 19 §7 |
| UAT-SEC-029 | Member cookie mutation requires CSRF double-submit | ITGC-AC-07 | 08 §7, 19 §7 |
| UAT-SEC-030 | Member logout clears + revokes the session | ITGC-AC-07 / ITGC-AC-15 | 08 §7, 19 §7 |
| UAT-SEC-031 | PDPA DSAR filed with statutory 30-day due date | PDPA-01 | 08 §7, §9 |
| UAT-SEC-032 | PDPA access/portability export | PDPA-01 | 08 §7, §9 |
| UAT-SEC-033 | PDPA erasure redacts PII + issues pseudonym | PDPA-02 | 08 §7, §9 |
| UAT-SEC-034 | PDPA erasure pseudonymises the audit trail at read-time (stored row immutable) | PDPA-02 / ITGC-AC-16 | 08 §7, §9 |
| UAT-SEC-035 | PDPA DSAR is tenant-isolated | PDPA-01 / ITGC-AC-03 | 08 §7, §9 |
| UAT-SEC-036 | Cashier PIN quick-login succeeds | ITGC-AC-17 | 08 §7, §9 |
| UAT-SEC-037 | PosSupervisor PIN login + open shift (no duplicate) | ITGC-AC-17 / R08 | 08 §7, §9 |
| UAT-SEC-038 | Self set/rotate own PIN (current-password step-up) | ITGC-AC-17 | 08 §7 |
| UAT-SEC-039 | Admin sets a staff PIN | ITGC-AC-17 | 08 §7 |
| UAT-SEC-040 | Wrong PIN rejected (generic UNAUTHORIZED) | ITGC-AC-17 | 08 §7, §9 |
| UAT-SEC-041 | Privileged account blocked from PIN (PIN_NOT_ALLOWED) | ITGC-AC-17 | 08 §7, §9 |
| UAT-SEC-042 | Malformed PIN rejected (DTO) | ITGC-AC-17 | 08 §7, §9 |
| UAT-SEC-043 | Repeated wrong PIN trips the lockout (LOGIN_LOCKED) | ITGC-AC-17 / ITGC-AC-07 | 08 §7, §9 |
| UAT-SEC-044 | Self set-PIN with wrong current password (BAD_CURRENT_PASSWORD) | ITGC-AC-17 | 08 §7, §9 |
| UAT-SEC-045 | Clear-PIN disables PIN login | ITGC-AC-17 | 08 §7, §9 |
| UAT-SEC-054 | Public signup files a request (no tenant); god approval provisions; prod self-serve always off | ITGC-AC-18 | 08 §7 (3b), 23 §7 (0) |

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
| UAT-O2C-009a | Card tender real PSP charge | REV-03 | 07 §7 |
| UAT-O2C-009b | No-token/declined never books funds | REV-03 | 07 §7 |
| UAT-O2C-009c | Card tender idempotency = one charge | REV-02 | 07 §7 |
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
| UAT-O2C-023 | Pricing rules apply at dine-in checkout | REV-01, GL-01 | 20 §8 |
| UAT-O2C-024 | Service charge + satang rounding post & balance | GL-01 | 20 §8 |
| UAT-O2C-025 | Pricing rules NOT applied unless opted in | REV-01 | 20 §8 |
| UAT-O2C-250 | Price/promo rule staged PendingApproval — does NOT apply | SoD R10, MKT-01 | 19 §7, §9 (`pricing.ts`) |
| UAT-O2C-251 | Rule author cannot self-approve (SOD_VIOLATION) | SoD R10 | 19 §7, §9 (`pricing.ts`) |
| UAT-O2C-252 | Distinct approver activates rule → discount applies | SoD R10, MKT-01 | 19 §7, §9 (`pricing.ts`) |
| UAT-O2C-253 | CPQ — quote author cannot self-accept a billable quote (`SOD_VIOLATION`); no revenue posts (G12) | SoD R07/R10 (CPQ revenue distinct-actor; no new numbered control) | 18 §7, §9 (`cpq-gl.ts`) |
| UAT-O2C-254 | CPQ — a distinct exec accepts → Dr 1100 AR / Cr 4000 posts 50000, TB balanced (G12) | SoD R07/R10 | 18 §7, §9 (`cpq-gl.ts`) |
| UAT-O2C-255 | Bank — new account is PendingApproval + inactive; a deposit into it is rejected `BANK_NOT_APPROVED` (G9) | SoD R02 (bank-account maker-checker; no new numbered control) | 07 §7, §9 (`cash-banking.ts`) |
| UAT-O2C-256 | Bank — requester cannot self-approve the new bank account (`SOD_VIOLATION`) (G9) | SoD R02 | 07 §7, §9 (`cash-banking.ts`) |
| UAT-O2C-257 | Bank — a distinct approver activates the account → banking proceeds (Dr bank / Cr 1000) (G9) | SoD R02 | 07 §7, §9 (`cash-banking.ts`) |
| UAT-O2C-258 | POS — void/refund exception report surfaces voids + refunds for independent review (G14) | SoD R08/R12 (detective; no new numbered control) | 07 §7, §9 (`refund-approval.ts`) |
| UAT-O2C-259 | Bank — statement import single-user by design; imported lines reviewed at reconciliation certification (G10, documentation) | REC-02 (compensating detective; no new control) | 07 §7, §9 (`bankrec.ts`) |
| UAT-O2C-260 | Customer master direct-edit + Oracle/NetSuite-grade fields (credit_terms/sales_rep/category/language/external_ref) + first web CRUD screen `/customers` | REV-15 (no new control) | 01 §7 (8b), rev 0.21 (`customers.ts`) |
| UAT-O2C-261 | Customer — multiple addresses, newest primary demotes the old one | REV-15 (no new control) | 01 §7 (8b), rev 0.22 (`customers.ts`) |
| UAT-O2C-262 | Customer — multiple contacts | REV-15 (no new control) | 01 §7 (8b), rev 0.22 (`customers.ts`) |
| UAT-O2C-263 | Customer — parent-company link (self-parent blocked); 360° surfaces addresses/contacts/parent together | REV-15 (no new control) | 01 §7 (8b), rev 0.22 (`customers.ts`) |
| UAT-O2C-264 | Customer — duplicate detection (tax-id/email/phone + fuzzy name) surfaces a steward review queue | REV-15 / DQM (no new control) | 01 §7 (8b), rev 0.23 (`customers.ts`) |
| UAT-O2C-265 | Customer — governed merge: child-row repoint + survivorship back-fill + soft-retire (record preserved) | REV-15 / DQM (no new control) | 01 §7 (8b), rev 0.23 (`customers.ts`) |
| UAT-O2C-266 | Customer — merge guards (self-merge, already-merged, merged rows leave the queue; MERGE_CONFLICT on collision) | REV-15 / DQM (no new control) | 01 §7 (8b), rev 0.23 (`customers.ts`) |
| UAT-O2C-267 | Customer — change history: create/onboarding event + field-level old→new + child changes (append-only, DB-enforced) | ITGC-AC-14 (strengthened; no new control) | 01 §7 (8b), rev 0.24 (`customers.ts`) |
| UAT-O2C-268 | Customer — sensitive columns masked in the change history | ITGC-AC-14 (strengthened; no new control) | 01 §7 (8b), rev 0.24 (`customers.ts`) |
| UAT-O2C-269 | Customer — address province canonicalised (77-province ref) + postal 5-digit validation | Data quality (no new control) | 01 §7 (8b), rev 0.25 (`customers.ts`) |
| UAT-O2C-270 | Customer — unrecognised province kept as entered (migration-safe) | Data quality (no new control) | 01 §7 (8b), rev 0.25 (`customers.ts`) |
| UAT-O2C-026 | Cashier-speed quick-tender & change (UI) | Feature (cashier speed) | 01 §0 |
| UAT-O2C-027 | AR receipt idempotency | REC-01 / GL-01 | 01 §7 |
| UAT-O2C-028 | Diner pulls QR menu | REST-08 | 20 §7 |
| UAT-O2C-029 | Diner self-order auto-fires to KDS | REST-08 | 20 §7, §8 |
| UAT-O2C-030 | Second submit appends to same order | REST-08 | 20 §7 |
| UAT-O2C-031 | Freeform/priced self-order rejected | REST-08 | 20 §7, §9 |
| UAT-O2C-032 | 86'd item self-order blocked | REST-08 | 20 §7, §9 |
| UAT-O2C-033 | Menu/order on ended session rejected | REST-08 | 20 §7, §13 |
| UAT-O2C-034 | Admin creates a buffet tier | REST-09 | 20 §7 |
| UAT-O2C-035 | Diner starts buffet (per-pax charge + window) | REST-09 | 20 §7, §8 |
| UAT-O2C-036 | Buffet food ฿0 but hits KDS | REST-09 | 20 §7, §9 |
| UAT-O2C-037 | Off-tier buffet item rejected | REST-09 | 20 §7, §9, §13 |
| UAT-O2C-038 | One mode per session (no mixing) | REST-09 | 20 §7, §9, §13 |
| UAT-O2C-039 | Ordering after buffet window blocked | REST-09 | 20 §7, §9, §13 |
| UAT-O2C-040 | Overtime surcharge billed past window | REST-09 | 20 §7, §9 |
| UAT-O2C-041 | KDS flags ticket origin (diner / buffet) | REST-08, REST-09 | 20 §5 |
| UAT-O2C-042 | Buffet behaviour analytics per tier | Feature (buffet analytics) | 20 §6, §12 |
| UAT-O2C-043 | Printed table-QR sticker | Feature (printed QR) | 20 §6 |
| UAT-O2C-044 | Scan printed QR opens/joins session | REST-04 | 20 §6 |
| UAT-O2C-045 | PromptPay pay returns scannable QR | REST-04 | 20 §6 |
| UAT-O2C-046 | PromptPay settlement webhook (auth + finalize) | REST-04 | 20 §6, §13 |
| UAT-O2C-047 | Webhook idempotent + payment-status poll | REST-04 | 20 §6 |
| UAT-O2C-048 | Staff starts buffet from the POS | REST-09 | 20 §6 |
| UAT-O2C-049 | Public diner endpoint rate-limited | Anti-abuse | 20 §6, §13 |
| UAT-O2C-050 | Diner self-order UI smoke (Playwright) | Feature (diner UI) | 20 §6 |
| UAT-O2C-051 | Move a live tab to a free table | Feature (table ops) | 20 §6 |
| UAT-O2C-052 | Move onto an occupied table blocked | Feature (table ops) | 20 §6, §13 |
| UAT-O2C-053 | Transfer line items between tables | Feature (table ops) | 20 §6 |
| UAT-O2C-054 | Merge two tabs into a combined bill | Feature (table ops) | 20 §6 |
| UAT-O2C-055 | Fire one course (hold the rest) | Feature (course firing) | 20 §5 |
| UAT-O2C-056 | Fire next course / empty course | Feature (course firing) | 20 §5, §13 |
| UAT-O2C-057 | Day-parting: menu flags availability | Feature (day-parting) | 20 §6 |
| UAT-O2C-058 | Day-parting: order outside window blocked | Feature (day-parting) | 20 §6, §13 |
| UAT-O2C-059 | CRM: enrol member + messaging send | MKT-04 | 19 §7 |
| UAT-O2C-060 | CRM: marketing-consent enforced | MKT-04 | 19 §7, §9 |
| UAT-O2C-061 | Food-cost: per-menu margin from recipe | Feature (food-cost) | 20 §12 |
| UAT-O2C-062 | Food-cost: ingredient cost contribution | Feature (food-cost) | 20 §12 |
| UAT-O2C-063 | Checkout auto-queues a receipt print job | REST-10 | 20 §7 |
| UAT-O2C-064 | Receipt ties out to the fiscal sale | REST-10 | 20 §7, §9 |
| UAT-O2C-065 | Receipt renders seller header + VAT + items | REST-10 | 20 §7 |
| UAT-O2C-066 | HTML receipt document served | REST-10 | 20 §7 |
| UAT-O2C-067 | Agent pulls + acks the next print job | REST-10 | 20 §7 |
| UAT-O2C-068 | Reprint flagged a COPY (สำเนา) | REST-10 | 20 §7, §9 |
| UAT-O2C-069 | Send receipt out-of-band (email) | REST-10 | 20 §7 |
| UAT-O2C-070 | Print jobs tenant-isolated (RLS) | REST-10 | 20 §7 |
| UAT-O2C-071 | Register a cash-drawer device | REST-11 | 20 §7 |
| UAT-O2C-072 | Cash checkout auto-pops the drawer | REST-11 | 20 §7, §9 |
| UAT-O2C-073 | No-sale open kicks + audits the drawer | REST-11 | 20 §7, §9 |
| UAT-O2C-074 | Drawer reconciliation by reason | REST-11 | 20 §7, §9 |
| UAT-O2C-075 | Set + poll customer display | Feature (display) | 20 §7 |
| UAT-O2C-076 | Mark an item sold-by-weight | REST-11 | 20 §7 |
| UAT-O2C-077 | Scale computes price server-side | REST-11 | 20 §7, §9 |
| UAT-O2C-078 | Scale read on non-weighed item rejected | REST-11 | 20 §7, §9 |
| UAT-O2C-079 | Peripheral registry tenant-isolated (RLS) | REST-11 | 20 §7 |
| UAT-O2C-080 | Take a customer deposit | REST-12 | 20 §7 |
| UAT-O2C-081 | Apply a deposit (recognise revenue) | REST-12 | 20 §7 |
| UAT-O2C-082 | Deposit over-apply rejected | REST-12 | 20 §7, §9 |
| UAT-O2C-083 | Refund the unused deposit | REST-12 | 20 §7 |
| UAT-O2C-084 | Open house account + charge within limit | REST-12 | 20 §7 |
| UAT-O2C-085 | Charge over credit limit rejected | REST-12 | 20 §7, §9 |
| UAT-O2C-086 | Settle a house account (THB) | REST-12 | 20 §7 |
| UAT-O2C-087 | FX settlement books realised FX gain | REST-12 | 20 §7, §9 |
| UAT-O2C-088 | Statement reconciles + over-settle rejected | REST-12 | 20 §7, §9 |
| UAT-O2C-089 | Card surcharge quote + charge | REST-12 | 20 §7 |
| UAT-O2C-090 | Payments-depth tenant isolation (RLS) | REST-12 | 20 §7 |
| UAT-O2C-091 | Receipt defaults to tenant language | Feature (i18n) | 20 §7 |
| UAT-O2C-092 | Receipt renders in English | Feature (i18n) | 20 §7 |
| UAT-O2C-093 | Bilingual (TH/EN) receipt | Feature (i18n) | 20 §7 |
| UAT-O2C-094 | Per-tenant default language persists | Feature (i18n) | 20 §7 |
| UAT-O2C-095 | Reposition a table on the floor plan | Feature (floor-plan layout) | 20 §6 |
| UAT-O2C-096 | Delete a free table (soft-delete) | Feature (floor-plan layout) | 20 §6 |
| UAT-O2C-097 | Delete a seated table blocked | Feature (floor-plan layout) | 20 §6, §13 |
| UAT-O2C-098 | Create a VIP room (zone) | Feature (floor-plan layout) | 20 §6 |
| UAT-O2C-099 | Move/resize/rename a room persists | Feature (floor-plan layout) | 20 §6 |
| UAT-O2C-100 | Assign / un-assign a table to a room | Feature (floor-plan layout) | 20 §6 |
| UAT-O2C-101 | Delete a room keeps its tables | Feature (floor-plan layout) | 20 §6 |
| UAT-O2C-102 | Rooms are tenant-isolated (RLS) | Feature (floor-plan layout) | 20 §6, 08 §RLS |
| UAT-O2C-103 | Set table shape / size / rotation / seats | Feature (floor-plan layout) | 20 §6 |
| UAT-O2C-104 | Invalid shape / rotation rejected | Feature (floor-plan layout) | 20 §6, §13 |
| UAT-O2C-105 | Optimistic-locked table update (rev) | Feature (floor-plan layout) | 20 §6, §13 |
| UAT-O2C-106 | Unconditional update / undo (no rev) | Feature (floor-plan layout) | 20 §6 |
| UAT-O2C-107 | Create with full initial appearance | Feature (floor-plan layout) | 20 §6 |
| UAT-O2C-108 | Floor-plan editor UI smoke (Playwright) | Feature (floor-plan UI) | 20 §6 |
| UAT-O2C-109 | Revenue attributed by room | Feature (floor-plan layout) | 20 §6 |
| UAT-O2C-110 | Room revenue is tenant-isolated (RLS) | Feature (floor-plan layout) | 20 §6, 08 §RLS |
| UAT-O2C-111 | Revenue snapshot survives a table move | Feature (floor-plan layout) | 20 §6 |
| UAT-O2C-112 | Deleted room keeps its past takings | Feature (floor-plan layout) | 20 §6 |
| UAT-O2C-113 | Service charge persisted + itemised on the receipt | REST-10 | 20 §7 |
| UAT-O2C-114 | Large-party receipt ties out incl. service charge | REST-10 | 20 §7, §9 |
| UAT-O2C-115 | Send receipt via LINE channel | REST-10 | 20 §7 |
| UAT-O2C-116 | Enrol/link member via LINE (idempotent) | Feature (LINE CRM) | 19 §7.8 |
| UAT-O2C-117 | One LINE account = one member | Feature (LINE CRM) | 19 §7.8 |
| UAT-O2C-118 | LINE push to userId, consent enforced | Feature (LINE CRM), MKT-04 | 19 §7.11 |
| UAT-O2C-119 | Aggregator menu push (real adapter) | Feature (aggregator adapter) | 20 §7.7 |
| UAT-O2C-120 | Accept/reject routes to KDS + notifies platform | Feature (aggregator adapter) | 20 §7.7 |
| UAT-O2C-121 | Status callback + mock fallback | Feature (aggregator adapter) | 20 §7.7 |
| UAT-O2C-122 | Multi-terminal realtime KDS event | Feature (multi-terminal SSE) | 20 §rev3.0 |
| UAT-O2C-123 | LINE marketing automation — closed loop | Feature (LINE automation), MKT-04 | 19 §7.12 |
| UAT-O2C-130 | Collections worklist (open overdue AR) | REV-12 | 01 §7, §9 |
| UAT-O2C-131 | Dunning stage recommended by aging | REV-12 | 01 §7 |
| UAT-O2C-132 | Record dunning action advances stage | REV-12 | 01 §7, §9 |
| UAT-O2C-133 | Dunning on paid invoice rejected (ALREADY_PAID) | REV-12 | 01 §9, §13 |
| UAT-O2C-134 | Credit status flags over-limit + serious overdue | REV-12, R09 | 01 §7, §9 |
| UAT-O2C-135 | Credit check denies further credit (held customer) | REV-12, R09 | 01 §9, §13 |
| UAT-O2C-136 | Order entry blocks 90+ defaulter (CREDIT_OVERDUE) | REV-12 | 01 §7, §9 |
| UAT-O2C-137 | Order entry — over-limit still blocked (parity) | REV-08 | 01 §9, §13 |
| UAT-O2C-138 | Order entry — good-standing customer can order | REV-12 | 01 §7 |
| UAT-O2C-139 | Automated dunning sweep advances overdue invoices | REV-12 | 01 §7 |
| UAT-O2C-140 | Dunning sweep is idempotent | REV-12 | 01 §7 |
| UAT-O2C-141 | Schedule daily automated dunning | REV-12 | 01 §7 |
| UAT-O2C-142 | Scheduler tick fires the dunning job | REV-12 | 01 §7 |
| UAT-O2C-143 | Dunning action dispatches a notice to the customer | REV-12 | 01 §7 |
| UAT-O2C-144 | Sweep dispatches notices, channel auto-picked | REV-12 | 01 §7 |
| UAT-O2C-145 | Credit Manager places a manual hold | REV-08, R09 | 01 §7, §9 |
| UAT-O2C-146 | Credit check denies a manually-held customer (CREDIT_HOLD) | REV-08 | 01 §9, §13 |
| UAT-O2C-147 | Self-release blocked, second person releases (SOD_SELF_RELEASE) | REV-08, R09 | 01 §7, §9, §13 |
| UAT-O2C-148 | Credit-limit change is STAGED for approval (ceiling not moved) | REV-08, R09 | 01 §7, §9 |
| UAT-O2C-247 | Credit-limit change — requester cannot self-approve (SOD_VIOLATION) | REV-08, R09 | 01 §7, §9, §13 |
| UAT-O2C-248 | Credit-limit change — a distinct approver applies it (→ 50000) | REV-08, R09 | 01 §7, §9 |
| UAT-O2C-249 | Credit-change audit shows the limit_change old→new | REV-08, R09 | 01 §7, §9 |
| UAT-O2C-149 | Customer statement of account (running balance) | REV-12 | 01 §7 |
| UAT-O2C-150 | Customer statement — multi-currency (base + filter) | REV-12 | 01 §7 |
| UAT-O2C-151 | Register quick sale (tap → cash → receipt + drawer) | Feature (POS register) | 01 §7 |
| UAT-O2C-152 | Register modifier line priced from the catalog | Feature (POS register) | 01 §7 |
| UAT-O2C-153 | Register PromptPay tender shows a scannable QR | Feature (POS register) | 01 §7 |
| UAT-O2C-154 | Register hold → recall round-trips the cart | Feature (POS register) | 01 §7 |
| UAT-O2C-155 | Register mirrors the cart to the customer display | REST-11 | 20 §7 |
| UAT-O2C-180 | Create a customer-of-record linking B2C + B2B | REV-15 | 01 §7 |
| UAT-O2C-181 | 360 view ties AR to the sub-ledger + shows loyalty | REV-15 | 01 §7, §9 |
| UAT-O2C-182 | Customer master register search | REV-15 | 01 §7 |
| UAT-O2C-183 | Small refund immediate; large refund needs approval | REV-16 | 07 §7 |
| UAT-O2C-184 | Refund SoD: requester ≠ approver | REV-16 | 07 §7, §9 |
| UAT-O2C-185 | Lead → convert → customer-of-record + opportunity | REV-17 | 01 §7, §9 |
| UAT-O2C-186 | Opportunity stage machine (won terminal) | REV-17 | 01 §7, §9 |
| UAT-O2C-187 | Marking lost requires a reason | REV-17 | 01 §7, §9 |
| UAT-O2C-188 | Weighted pipeline forecast + win-rate | REV-17 | 01 §7 |
| UAT-O2C-189 | Log + list a CRM activity | REV-17 | 01 §7 |
| UAT-O2C-202 | Won opportunity → project (won-only, traceable, idempotent) | CRM-WL | 16 §7 (1a), §9 |
| UAT-O2C-203 | Project WBS — planned-hours-weighted % complete roll-up | Feature (P1 WBS) | 16 §7 (7) |
| UAT-O2C-204 | Milestone completion raises the Fixed-price progress bill | PROJ-02 | 16 §7 (8), §9 |
| UAT-O2C-205 | Resource assignment snapshots the authorized rate card | PROJ-05 | 16 §7 (9), §9 |
| UAT-O2C-206 | Capacity utilization flags over-allocation | PROJ-05 | 16 §7 (9), §9 |
| UAT-O2C-207 | Timesheet → project labor maker-checker posts to WIP | PROJ-04 | 16 §7 (10), §9 |
| UAT-O2C-208 | Earned-value metrics + task dependency guard | PROJ-06 | 16 §7 (11), §9 |
| UAT-O2C-209 | Critical-path schedule (CPM) + EVM S-curve | PROJ-06 | 16 §7 (11) |
| UAT-O2C-210 | Win/loss analytics for the pipeline dashboard | REV-17 | 16 §7 (11) |
| UAT-O2C-211 | Schedulable BI report types (project_evm, crm_win_loss) | PROJ-06 / REV-17 | 16 §7 (11) |
| UAT-O2C-212 | Portfolio command center rollup | PROJ-06 | 16 §7 (11) |
| UAT-O2C-213 | Change-controlled baselines + variance | PROJ-07 | 16 §7 (12) |
| UAT-O2C-214 | Project templates: author + one-step apply | (operational) | 16 §7 (13) |
| UAT-O2C-215 | RACI accountability + "my tasks" | PROJ-04 (SoD note) | 16 §7 (14) |
| UAT-O2C-216 | Risk & issue register + portfolio top-risks | PROJ-08 | 16 §7 (15) |
| UAT-O2C-217 | POC over-time revenue recognition | PROJ-09 | 16 §7 (16) |
| UAT-O2C-218 | Change order — maker-checker contract variation | PROJ-10 | 16 §7 (17) |
| UAT-O2C-219 | Time-phased resource capacity calendar | PROJ-05 (operational) | 16 §7 (9) |
| UAT-O2C-220 | Project health history (EVM/RAG trend) | PROJ-06 (operational) | 16 §7 (18) |
| UAT-O2C-221 | PMO action center / exception inbox | PROJ-11 | 16 §7 (19) |
| UAT-O2C-222 | Pipeline-weighted forward resource & cash forecast | PROJ-05/PROJ-06 (operational) | 16 §7 (20) |
| UAT-O2C-223 | Period governance / status pack | PROJ-06 (operational) | 16 §7 (21) |
| UAT-O2C-224 | Program (cross-project) critical path | PROJ-06 (operational) | 16 §7 (22) |
| UAT-O2C-225 | Pipeline → FTE resourcing forecast | PROJ-05/PROJ-06 (operational) | 16 §7 (20) |
| UAT-O2C-226 | Project period-end close review — maker-checker (`/projects/close`) | PROJ-03 | 16 §7, §9 |
| UAT-O2C-227 | Timesheet project allocation + approval surfaced in list (`/hcm`) | PROJ-04 | 16 §7 (10), §9 |
| UAT-O2C-229 | Bill of Quantities (BoQ) + project-dimensioned procurement (M0) | maker-checker (BoQ approve); PROJ-12 (M1) | 16 §7 (23–24) |
| UAT-O2C-230 | Material-budget commitment enforcement (M1) | PROJ-12 | 16 §7 (25) |
| UAT-O2C-231 | Material requisition + over-budget LINE approval (M2) | PROJ-13 | 16 §7 (26) |
| UAT-O2C-232 | Stock reservation → issue-to-project (M3) | INV-13 | 16 §7 (27) |
| UAT-O2C-233 | Project-linked advances & reimbursements — site cash (M4) | PROJ-14 | 16 §7 (28) |
| UAT-O2C-234 | Raise site cash from the project workspace — web (FU4) | PROJ-14 | 16 §7 (28) |
| UAT-O2C-243 | Retention (เงินประกันผลงาน) shared sub-ledger — withhold / release / due (Phase 0) | Foundation for PROJ-16/PROJ-17 | 16 §14 (rev 0.35), 35 P0 |
| UAT-O2C-244 | Progress billing / งวดงาน — BoQ-line valuation, maker-checker certify, retention receivable (P1) | PROJ-16, SoD R17 | 16 §7 (29) / §14 (rev 0.36), 35 P1 |
| UAT-O2C-245 | Subcontractor management — subcontract vs BoQ budget, valuation certify, retention payable (P2) | PROJ-17, SoD R18 | 16 §7 (30) / §14 (rev 0.37), 35 P2 |
| UAT-O2C-246 | Tender / estimating → award — seed a project + draft BoQ from the winning bid (P3) | PROJ-18 | 16 §7 (31) / §14 (rev 0.38), 35 P3 |
| UAT-RE-01 | Real-estate unit inventory — no double allocation; availability grid ties out (P4) | RE-01 | 31 §3–4, 35 P4 (D1) |
| UAT-RE-02 | Real-estate sale contract — price/discount authority (maker-checker) (P4) | RE-02, SoD R19 | 31 §3–4, 35 P4 (D2) |
| UAT-RE-03 | Real-estate installment application — pay-once, exact amount (P4) | RE-03 | 31 §3–4, 35 P4 (D2) |
| UAT-RE-04 | Real-estate ownership transfer — settled-only, authorised revenue recognition (P5) | RE-04 | 31 §rev0.2, 35 P5 |
| UAT-O2C-194 | AR allowance: aging compute | REV-18 | 01 §7 (8d) |
| UAT-O2C-195 | AR allowance: computer cannot post own (SoD) | REV-18 | 01 §7 (8d) |
| UAT-O2C-196 | AR allowance: independent post books the delta (Dr 5720 / Cr 1190) | REV-18 | 01 §7 (8d) |
| UAT-O2C-197 | AR allowance: no double-post; register | REV-18 | 01 §7 (8d) |

## 03 — Procure-to-Pay → `02-procure-to-pay.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-P2P-001 | Create PO | EXP-01 | 02 §7 |
| UAT-P2P-002 | PO approval (maker≠checker) | EXP-01, R02 | 02 §9 |
| UAT-P2P-003 | Goods receipt | EXP-02 | 02 §7 |
| UAT-P2P-004 | 3-way match success | EXP-03 | 02 §7, §9 |
| UAT-P2P-005 | Matched pay (request+approve) + GL | EXP-06, GL-01 | 02 §7 |
| UAT-P2P-006 | Price variance block at AP-pay gate (MATCH_BLOCKED) | EXP-09, EXP-01 | 02 §8, §9, §13 |
| UAT-P2P-007 | Over-invoice block | EXP-03 | 02 §9, §13 |
| UAT-P2P-008 | Match tolerance | EXP-03 | 02 §9 |
| UAT-P2P-009 | Override-with-reason (independent overrider) | EXP-01, EXP-06, R04 | 02 §6, §9 |
| UAT-P2P-009b | Matcher cannot self-override (SoD) | EXP-01 | 02 §6 |
| UAT-P2P-010 | Override reset on re-match | EXP-03 | 02 §9, §13 |
| UAT-P2P-011 | Non-PO bill (AP-pay gate fails open, request+approve) | EXP-09, EXP-06 | 02 §7, §8 |
| UAT-P2P-012 | Blocklisted vendor (SUPPLIER_BLOCKED) | EXP-04, R13 | 02 §9, §13 |
| UAT-P2P-013 | Un-blocklist vendor | EXP-04 | 02 §7 |
| UAT-P2P-014 | RFQ→quote→award→PO | EXP-01 | 02 §7 |
| UAT-P2P-015 | Match idempotency | EXP-03 | 02 §7 |
| UAT-P2P-016 | RLS vendor isolation | ITGC-AC (RLS) | 08 §9 |
| UAT-P2P-017 | AP↔GL reconciliation | REC-01 | 04 §9 |
| UAT-P2P-018 | Supplier portal: vendor sees only own POs | Feature (supplier portal) | 02 §7 |
| UAT-P2P-019 | Supplier acknowledge + submit invoice | Feature (supplier portal) | 02 §7 |
| UAT-P2P-020 | Supplier cannot invoice another vendor's PO | Feature (supplier portal) | 02 §7 |
| UAT-P2P-021 | Supplier portal unlinked user refused | Feature (supplier portal) | 02 §7 |
| UAT-P2P-022 | AP bill idempotency | EXP-03 / GL-01 | 02 §7 |
| UAT-P2P-023 | AP payment-request idempotency | EXP-06 / GL-01 | 02 §7 |
| UAT-P2P-024 | Dimension routing — PO by vendor | EXP-03 (workflow) | 02 §7 |
| UAT-P2P-025 | PO approval routes through the engine | EXP-03 (workflow) | 02 §7 |
| UAT-P2P-026 | SLA escalation sweep flags + reminds | EXP-03 (workflow) | 02 §7 |
| UAT-P2P-027 | Escalation fallback approver can act | EXP-03 (workflow) | 02 §7 |
| UAT-P2P-028 | No-code builder replaces steps | Feature (workflow builder) | 02 §7 |
| UAT-P2P-029 | Vendor statement of account | EXP-06 | 02 §7 |
| UAT-P2P-030 | Petty cash — issue an advance | EXP-07 | 07 §7 |
| UAT-P2P-031 | Petty cash — settle reconciles or rejects | EXP-07 | 07 §7 |
| UAT-P2P-029 | Pre-paid bill creation blocked | EXP-06 | 02 §7, §9 |
| UAT-P2P-030 | Payment request creates no GL/paid effect | EXP-06 | 02 §7, §9 |
| UAT-P2P-031 | Requester self-approval blocked (SoD, incl. Admin) | EXP-06, R03/R07 | 02 §7, §9 |
| UAT-P2P-032 | Maker without approval authority blocked | EXP-06 | 02 §7, §9 |
| UAT-P2P-033 | Reject leaves bill unpaid | EXP-06 | 02 §7, §9 |
| UAT-P2P-060 | PR raised by any employee (company-wide `pr_raise`) | R03 (access design) | 02 §3, §6, §7 |
| UAT-P2P-061 | GR refused for a procurement-only user (R04 at permission layer) | R04 | 02 §7, §9 |
| UAT-P2P-062 | AP disbursement approved on finance Disbursements screen | EXP-06, R07 | 02 §3, §7 |
| UAT-P2P-066 | Vendor PII encrypted at rest; ghost-vendor detector still fires | ITGC-AC-19, EXP-02 | 02 §9 |
| UAT-P2P-070 | LINE chat: staff links LINE account with one-time code | EXP-03 (entry integrity) | 02 §3, §7 |
| UAT-P2P-071 | LINE chat: `pr` command raises a PR into the approval workflow | EXP-03 | 02 §7 |
| UAT-P2P-072 | LINE chat: unlinked / expired-code identities refused | EXP-03 (entry integrity) | 02 §7, §9 |
| UAT-P2P-073 | LINE chat: no `pr_raise` → refused; customer role gets no link code | EXP-03, R03 (access design) | 02 §7, §9 |
| UAT-P2P-074 | LINE chat: redelivery deduped; LINE account binds to one user | EXP-03 (entry integrity) | 02 §7, §9 |
| UAT-P2P-075 | LINE chat: free customer chat ignored; unlink stops the channel | EXP-03 (entry integrity) | 02 §7 |
| UAT-P2P-076 | LINE notify: approver queue-entry push; requester decision push | EXP-03 (workflow) | 02 §7 |
| UAT-P2P-077 | LINE chat: self-approve over chat refused (engine SoD) | EXP-03, R07 | 02 §3, §7, §9 |
| UAT-P2P-078 | LINE chat: approve without `procurement` refused; reject decides + notifies | EXP-03 | 02 §7, §9 |
| UAT-P2P-079 | LINE chat: `my prs` / `find` self-service lookups | Feature (chat self-service) | 02 §7 |
| UAT-P2P-080 | LINE chat: `cancel` own pending PR only; `stock` read-only | EXP-03 (entry integrity) | 02 §7 |
| UAT-P2P-081 | PO attachments: web upload/list/fetch; delete = uploader-or-Admin | EXP-01 (evidence) | 02 §7, §11 |
| UAT-P2P-082 | LINE chat: attach photo to PO; replay/stray/permission negatives | EXP-01 (evidence) | 02 §7 |
| UAT-P2P-083 | LINE chat: one-tap postback approve with confirm (replay-safe; SoD binds) | EXP-03, R07 | 02 §7 |
| UAT-P2P-084 | LINE chat: petty-cash raise + EXP-08 notifications (decision stays on web) | EXP-08, R07 | 07 §7 |
| UAT-SEC-048 | LINE chat governance: link registry, force-unlink, rate limit | ITGC-AC (chat channel) | 08 §7 |
| UAT-SEC-049 | LINE OA go-live: required Channel secret + webhook receipt health (fail-closed verify) | ITGC-AC (chat channel) | 08 rev 1.8 |
| UAT-SEC-050 | LINE OA go-live: test-push to the admin's own linked LINE (NOT_LINKED explained) | ITGC-AC (chat channel) | 08 rev 1.8 |
| UAT-SEC-051 | Platform-owner "god" sees all companies cross-org; per-tenant Admin stays org-scoped (env-gated, not a role) | ITGC-AC-18 | 01 §7 |
| UAT-PAY-038 | ESS leave raised from LINE chat + pushes (decision stays on web) | PAY (ESS leave) | 25 §7 |
| UAT-PAY-039 | LINE copilot AI-drafted leave — confirm-first, same ESS path | PAY (ESS leave; AI drafts) | 25 rev 1.0 |
| UAT-RPT-046 | LINE report delivery + daily digest + alert user-target (permission-at-subscribe) | Feature (LINE delivery) | 26 §7 |
| UAT-RPT-047 | LINE ask — governed NL analytics in chat (permission gate) | Feature (NL analytics) | 26 §7 |
| UAT-RPT-048 | LINE copilot LLM governance — schema validation, daily cap, DPA gate | PN-26 rev 1.8 | 26 rev 1.8 |
| UAT-RPT-049 | Digest 2.0 — KPI selection + per-recipient permission filter at send time | PN-26 rev 1.9 | 26 rev 1.9 |
| UAT-P2P-085 | LINE copilot — AI-drafted PR is confirm-first (no action without ยืนยัน) | EXP-03 (entry integrity) | 02 §7 |
| UAT-P2P-092 | LINE copilot AI-drafted expense/advance — confirm-first, EXP-07/08 path | EXP-07/08 (AI drafts) | 07 rev 1.3 |
| UAT-P2P-093 | Vendor AP card — list → statement of account | EXP-01 / AP | 05-finance-ar-ap.md |
| UAT-P2P-094 | Convert approved PR → PO (item reconcile against master + open new code) | EXP (PR→PO link) | 02 rev 2.3 |
| UAT-P2P-111 | PR→PO auto-group by supplier (1 PR → many POs) + item ผู้ขายประจำ (preferred supplier) + item names | EXP-02, EXP-03, R02/R07 (unchanged); PR→PO link | 02 rev 3.20 |
| UAT-P2P-095 | One-tap รับครบ (receive-all) — web button + LINE `receive <PO no>`; EXP-03 approval gate + R04 hold | EXP-02, EXP-03, R04 | 02 rev 2.4 |
| UAT-P2P-096 | Reorder low stock → one-tap PR (web สินค้าใกล้หมด card + LINE `low`/`reorder`); createPr path unchanged | EXP-03 (entry integrity) | 02 rev 2.5 |
| UAT-P2P-097 | Proactive morning low-stock alert (`low_stock_reorder_alert`) → one-tap [สั่งเติมทั้งหมด] reorder | EXP-03 (entry integrity) | 02 rev 2.6 |
| UAT-P2P-098 | Close-the-loop LINE pushes to the PR requester (PR→PO / PO approved / GR received) | EXP (follow-through) | 02 rev 2.7 |
| UAT-P2P-099 | Purchase spend insights — month total / top vendors / most-bought items (chat `spend` + `/spend-summary` + `purchase_spend` BI report) | EXP (reporting) | 02 rev 2.8 |
| UAT-P2P-100 | Partial receive (`receive <PO> <item> <qty>`) + short/damaged claim (`claim <PO/GR> <qty>`) from chat | EXP-02, EXP-03 | 02 rev 2.9 |
| UAT-P2P-101 | Quick Capture (docs/34) — `pr_raise` staffer snaps/uploads a bill → NeedsReview draft + `/mine`; extract-only `/api/doc-ai/extract-document` | EXP-10 (entry extension) | 02 rev 3.1 |
| UAT-P2P-102 | Quick Capture SoD — capturer (maker) cannot post the bill nor read the full AP worklist (both 403); booking stays `creditors` | EXP-10, EXP-06 | 02 rev 3.1 |
| UAT-P2P-103 | Quick Capture over LINE — `บิล` + photo files a NeedsReview draft (content API); no-`pr_raise` refused; redelivery-safe | EXP-10, EXP-06 | 02 rev 3.2 |
| UAT-P2P-104 | Email-to-Capture — verify send-from address (mailed code), inbound bill files a draft attributed to the sender; unknown/unverified/no-`pr_raise`/redelivery all file no draft | EXP-10, EXP-06 | 02 rev 3.3 |
| UAT-P2P-086 | AP intake: scan with PO no. → auto-map + book + match in one flow | EXP-10, EXP-01 | 02 §3, §7, §9 |
| UAT-P2P-087 | AP intake: vendor+amount auto-map only when unambiguous; ties → NeedsReview | EXP-10 | 02 §7, §9 |
| UAT-P2P-088 | AP intake: duplicate invoice number never auto-booked; post refused | EXP-10 | 02 §7, §9, §13 |
| UAT-P2P-089 | AP intake: cumulative guard — one PO not billable twice | EXP-10, EXP-01, EXP-09 | 02 §7, §9 |
| UAT-P2P-090 | AP intake: blocked-ahead-of-goods released by scheduled auto re-match; non-PO fail-open | EXP-10, EXP-09 | 02 §7, §9 |
| UAT-P2P-091 | AP intake upload: direct image/PDF (PDF text layer auto-post; keyless image → review; type/size gates) | EXP-10 | 02 §3, §7, §13 |
| UAT-UI-P2P-ACC-01 | Procurement & AP screens split by user group | R03/R04/R07 | 02 §3 |
| UAT-UI-SUP-01 | Supplier portal screen (vendor self-service) — PO ack + invoice submit | Feature (supplier portal UI) | 02 §7 |
| UAT-P2P-040 | Capital PO line → GR eligible (not stocked) | FA-10 | 02 §7, 09 §7 |
| UAT-P2P-041 | Register asset from GR → PendingApproval, no GL | FA-10 | 09 §7 |
| UAT-P2P-042 | Capitalization self-approval blocked (SoD, incl. Admin) | FA-10, R07 | 09 §7 |
| UAT-P2P-043 | Independent approval creates asset + posts GL (Dr 1500/Cr 2000) | FA-10, GL-01 | 09 §7 |
| UAT-P2P-044 | GR line cannot be capitalised twice | FA-10 | 09 §7 |
| UAT-UI-CAP-01 | Capitalize-from-GR screen (eligible → request → approve) | FA-10 | 09 §7 |
| UAT-P2P-050 | Establish a fund with opening cash → funding request PendingApproval, no cash until approved (G3) | EXP-08, R07 | 07 §7 (11), §9 |
| UAT-P2P-051 | Expense request → PendingApproval, no GL | EXP-08 | 07 §7 |
| UAT-P2P-052 | Petty-cash disbursement self-approval blocked (SoD, incl. Admin) | EXP-08, R07 | 07 §7, §9 |
| UAT-P2P-053 | Independent approval posts GL + decrements fund | EXP-08, GL-01 | 07 §7, §9 |
| UAT-P2P-054 | Draw beyond the fund balance blocked | EXP-08 | 07 §7 |
| UAT-P2P-055 | Advance approve → disburse → settle to fund | EXP-08, GL-01 | 07 §7 |
| UAT-P2P-056 | Replenish raises a funding request approved by a distinct user; capped at the float | EXP-08, R07 | 07 §7 (11) |
| UAT-P2P-057 | Pending petty-cash requests in GOV-01 monitor | EXP-08, GOV-01 | 07 §7 |
| UAT-P2P-058 | Fund-funding self-approval blocked (SOD_VIOLATION) — basics.ts / compliance.ts | EXP-08, R07 | 07 §7 (11), §9 |
| UAT-P2P-059 | Independent approval funds the fund (Dr 1015 / Cr 1000, balance rises) — basics.ts / compliance.ts | EXP-08, GL-01 | 07 §7 (11), §9 |
| UAT-UI-PCX-01 | Petty-cash fund + expense screen (funds → request → approve) | EXP-08 | 07 §7 |
| UAT-P2P-110 | Workflow-definition readiness reporter detects engine-wired docTypes (PR/PO/BUDGET/PMR/BQR) that lack a definition and would auto-approve (cross-cutting) | EXP-03/R07 config integrity (detective/config; no new numbered control) | 02 §7 (3), §9 (`workflow.ts`) |
| UAT-P2P-112 | Vendor bank-detail change maker-checker — stage → self-approve blocked → distinct approver releases it; re-stage supersedes; reject leaves vendor unchanged | EXP-11 (new) | 02 §7 (1), §9, rev 3.21 (`match.ts`) |
| UAT-P2P-113 | Vendor master direct-edit (contact/address/terms/rating/category/currency/notes) + supplier-list field enrichment | (no new control) | 02 §7 (1), rev 3.22 (`match.ts`) |
| UAT-P2P-114 | Vendor — multiple addresses/contacts (newest primary demotes the old one) + parent-vendor link (self-parent blocked) | (no new control) | 02 §7 (1), rev 3.23 (`match.ts`) |
| UAT-P2P-115 | Vendor — match-merge / DQM: duplicate detection + governed merge (child-row repoint + survivorship + soft-retire) + guards | (no new control) | 02 §7 (1), rev 3.24 (`match.ts`) |
| UAT-P2P-116 | Vendor — change history: field-level profile update old→new with actor (append-only, DB-enforced; sensitive masked) | ITGC-AC-14 (strengthened; no new control) | 02 §7 (1), rev 3.25 (`match.ts`) |
| UAT-P2P-117 | Vendor — address province canonicalised (77-province ref) + postal 5-digit validation | Data quality (no new control) | 02 §7 (1), rev 3.26 (`match.ts`) |

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
| UAT-INV-024 | STD GR PPV balanced under rounding | MFG-03 / GL-01 | 15 §9 |
| UAT-MFG-01 | WO completion full-yield (no variance) | MFG-02, GL-01 | 15 §7 |
| UAT-MFG-02 | WO completion short-yield → variance to 5810 | MFG-02, GL-01 | 15 §7 |
| UAT-INV-025 | Food-cost variance valued at ingredient cost | INV-04 (analytics) | 03 §12 |
| UAT-INV-026 | Variance summary nets fav/unfav + tenant-isolated | INV-04 (analytics) | 03 §12 |
| UAT-INV-027 | Branch replenishment splits transfer-before-buy | INV-05 | 03 §7, §9 |
| UAT-INV-028 | Auto-transfer moves branch stock; auto-PR raises residual | INV-05, EXP-03 | 03 §7, §9 |
| UAT-INV-029 | SoD transfer-vs-buy + RLS branch isolation | INV-05, ITGC-AC (RLS) | 03 §7, §9 |
| UAT-INV-040 | Bin layout geometry + utilisation in warehouse map | INV-08 | 03 §7, §9 |
| UAT-INV-041 | Locate an item to its bin(s) | INV-08 | 03 §7 |
| UAT-INV-042 | Bin capacity over-fill blocked on putaway | INV-08 | 03 §7, §9 |
| UAT-INV-043 | 3D warehouse view screen (utilisation colour + locate) | INV-08 | 03 §7 |
| UAT-INV-044 | Reservation reduces ATP; idempotent re-allocate (no leak) | INV-09 | 03 §7, §9 |
| UAT-INV-045 | Reserving beyond ATP blocked (INSUFFICIENT_ATP) | INV-09 | 03 §7, §9 |
| UAT-INV-046 | Release frees a cancelled reservation | INV-09 | 03 §7 |
| UAT-INV-047 | Fulfil is ATP-neutral vs on-hand drop | INV-09 | 03 §7 |
| UAT-INV-060 | StockCounter cannot see /stock-adjustment in nav | R11, INV-04 | 03 §7, §11 |
| UAT-INV-061 | StockCounter saves count — no Post button visible | R11, INV-04 | 03 §7 |
| UAT-INV-062 | InventoryController posts a counted stocktake from /stock-adjustment | R11, INV-04 | 03 §7 |
| UAT-INV-063 | POST /api/stocktake/:id/post blocked for wh_count-only token | R11, INV-04 | 03 §9 |
| UAT-INV-064 | InventoryController approves write-off from /stock-adjustment | R11, INV-07 | 03 §9 |
| UAT-INV-065 | APS finite-capacity scheduling | (operational) | 15 §7 (5b) |
| UAT-INV-066 | QR deep-link URL resolves same as raw payload (scan-update) | FA-04 (capture) | 09 §7.4, 03 §7.6 |
| UAT-INV-067 | scanCodeId no longer drops asset/bare tag | INV-04 / FA-04 (capture) | 03 §7.6, 09 §7.4 |
| UAT-INV-068 | Resolve endpoint identifies item/asset/unknown | FA-04 / INV-04 (capture) | 09 §7.4, 03 §7.6 |
| UAT-INV-069 | In-app camera scanner (cross-browser) fills the scan box | INV-04 (capture) | 03 §7.6 |
| UAT-INV-069b | Continuous multi-scan auto-adds session lines | INV-04 (capture) | 03 §7.6 |
| UAT-INV-069c | Scanner reads a 1D product barcode | INV-04 (capture) | 03 §7.6 |
| UAT-INV-070 | Phone native camera opens /q resolver (deep-link) | FA-04 / INV-04 (capture) | 09 §7.4, 03 §7.6 |
| UAT-INV-070b | /q resolver page identifies item/asset/empty (e2e) | FA-04 / INV-04 (capture) | 09 §7.4, 03 §7.6 |

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
| UAT-GL-060 | Opening-balance batch posts as Draft, excluded from TB (maker-checker, gap G4) | GL-05, R05 | 04 §7 (step 4), §9 |
| UAT-GL-061 | Opening batch self-approval blocked (SOD_VIOLATION) | GL-05, R05 | 04 §7 (step 4), §9, §13 |
| UAT-GL-062 | Distinct approver posts the opening batch → TB balances | GL-05 | 04 §7 (step 4), §9 |
| UAT-GL-063 | Preparer cannot reverse own posted entry (distinct reverser, gap G2) | GL-17, GL-05, R05 | 04 §2.2, §9, §13 |
| UAT-GL-064 | Distinct user reverses the posted entry successfully | GL-17, GL-05 | 04 §2.2, §9 |
| UAT-GL-065 | High-value gift-card issue (>5,000 THB) → PendingApproval, no GL, not redeemable (maker-checker gap G1) | GC-01, R14 | 22 §7 (steps 1/1a), §9, §13 |
| UAT-GL-066 | Gift-card issuer cannot self-approve the issuance (SOD_VIOLATION) | GC-01, R14 | 22 §7 (step 1a), §9, §13 |
| UAT-GL-067 | Distinct finance approver activates the card + posts Dr 1000/Cr 2200 | GC-01, GL-01, R14 | 22 §7 (step 1a), §9 |
| UAT-GL-068 | Small-value gift-card issue (≤5,000 THB) still auto-issues Active | GC-01, GL-01 | 22 §7 (step 1), §9 |
| UAT-GL-009 | Unbalanced JE block (UNBALANCED) | GL-02 | 04 §9, §13 |
| UAT-GL-010 | Trial balance ties | REC-01 | 04 §9 |
| UAT-GL-011 | Period close lock (PERIOD_CLOSED) | GL-04, R06 | 04 §9, §13 |
| UAT-GL-012 | Period re-open | GL-04 | 04 §7 |
| UAT-GL-013 | Year-end close to RE | GL-06 | 04 §7 |
| UAT-GL-014 | Balance sheet + RE | GL-06 | 04 §9 |
| UAT-GL-015 | Year-end close idempotency | GL-06 | 04 §9 |
| UAT-GL-016 | Sub-ledger reconciliation | REC-01 | 04 §9 |
| UAT-GL-045 | Control-account reconciliation pack (period-end) | REC-04 | 04 §7 |
| UAT-GL-046 | Pending-approvals monitor (maker-checker backlog) | GOV-01 | 04 §7 |
| UAT-GL-047 | Signup with industry provisions a curated chart | GL-10 | 04 §7 (step 14) |
| UAT-GL-048 | Overlay curates the picker but never gates postings | GL-10 | 04 §7 (step 14), §9 |
| UAT-GL-049 | Signup without industry defaults to the full chart | GL-10 | 04 §7 (step 14) |
| UAT-GL-050 | Industry template can't drift from the engine's codes | GL-10 | 04 §7 (step 14) |
| UAT-UI-COA-01 | Pick business type at signup (industry selector) | GL-10 | 04 §7 (step 14) |
| UAT-UI-COA-02 | View the industry chart of accounts (ผังบัญชี tab) | GL-10 | 04 §7 (step 14) |
| UAT-UI-COA-03 | Curate the chart in the UI — rename/group/active/re-order (overlay) | GL-11 | 04 §7 (step 14) |
| TC-GL-11-01 | Create a canonical account as platform Admin/HQ (+ duplicate → DUPLICATE_ACCOUNT) | GL-11 | 04 §7 (step 14) |
| TC-GL-11-02 | Deactivate an account with a non-zero balance → ACCOUNT_HAS_BALANCE | GL-11 | 04 §7 (step 14) |
| TC-GL-11-03 | Direct JE to an AR control account (1100) → CONTROL_ACCOUNT | GL-11 | 04 §7 (step 14) |
| TC-GL-11-04 | Tenant gl_coa holder blocked from a canonical CoA change → COA_ADMIN_ONLY | GL-11 | 04 §7 (step 14) |
| TC-GL-11-05 | Per-tenant overlay curation reflected + RLS-scoped (no cross-tenant leak) | GL-11 | 04 §7 (step 14) |
| TC-GL-11-06 | Overlay curation requires gl_coa (non-gl_coa → 403) | GL-11 | 04 §7 (step 14) |
| UAT-GL-017 | Reconciliation prepare→certify | REC-02/03 | 04 §9 |
| UAT-GL-018 | RLS GL isolation | ITGC-AC (RLS) | 08 §9 |
| UAT-GL-019 | Revenue recognition tenant-scoped | ITGC-AC-03 / REVREC-03 | 12 §7 |
| UAT-GL-020 | Bank reconciliation tenant-scoped | ITGC-AC-03 / REC-02 | 07 §7 |
| UAT-GL-048 | Bank adjustment maker-checker (request→Draft) | BANK-02 | 07 §7 |
| UAT-GL-049 | Bank adjustment self-approve blocked / approve closes diff | BANK-02 | 07 §7 |
| UAT-GL-050 | FX rate maker-checker — manual rate not usable until approved | FX-04 | 14 §7 |
| UAT-GL-051 | FX rate approved by different user → revaluation works | FX-04 | 14 §7 |
| UAT-GL-021 | Statement of Cash Flows reconstructed from GL | GL-07 | 04 §7, §9 |
| UAT-GL-022 | Cash flow reconciles to change in cash | GL-07 | 04 §9 |
| UAT-GL-023 | Year-end close excluded from cash flow | GL-07 | 04 §7, §9 |
| UAT-GL-024 | Direct-method cash flow by receipt/payment nature | GL-07 | 04 §7, §9 |
| UAT-GL-025 | Direct method ties to operating + Δcash | GL-07 | 04 §9 |
| UAT-GL-026 | Cash-flow forecast projects open AR/AP by due date | GL-07 | 04 §7 |
| UAT-EAM-001 | Raise a corrective maintenance work order | FA-06 | 09 §7 |
| UAT-EAM-002 | Complete WO → maintenance cost to AP (5710) | EXP-05, GL-01 | 09 §7, §9 |
| UAT-EAM-003 | Illegal WO transition rejected | FA-06 | 09 §7, §13 |
| UAT-EAM-004 | PM sweep raises due preventive WOs (time + meter) | FA-06 | 09 §7 |
| UAT-EAM-005 | PM generation is idempotent | FA-06 | 09 §7, §9 |
| UAT-EAM-006 | WO cost lines roll up to actual cost | FA-06 | 09 §7 |
| UAT-EAM-007 | Completion posts the rolled-up actual cost to AP | EXP-05, FA-06 | 09 §7, §9 |
| UAT-EAM-008 | Per-asset reliability & cost KPIs | FA-06 | 09 §7 |
| UAT-GL-027 | Unbalanced recurring template rejected (UNBALANCED) | GL-08 | 04 §7, §9 |
| UAT-GL-028 | Recurring run posts a Draft JE via maker-checker | GL-08, R05 | 04 §7, §9 |
| UAT-GL-029 | Recurring run idempotent; second person approves → hits GL | GL-08, GL-05, R05 | 04 §7, §9 |
| UAT-GL-030 | Register a prepaid schedule + capitalize | GL-09 | 04 §7 |
| UAT-GL-031 | Prepaid amortization run (straight-line) + idempotent | GL-09 | 04 §7 |
| UAT-GL-032 | Lease commencement recognises ROU + liability at PV | LSE-01 | 04 §7 |
| UAT-GL-033 | Lease periodic run (interest + payment + ROU depreciation) | LSE-01 | 04 §7 |
| UAT-GL-034 | Asset upward revaluation request → Draft, deferred | FA-07, FA-08 | 09 §7 |
| UAT-GL-035 | Asset impairment (after approval) + no-change guard + audit | FA-07, FA-08 | 09 §7 |
| UAT-GL-040 | Asset revaluation: preparer cannot self-approve (SoD) | FA-08, R07 | 09 §7 |
| UAT-GL-041 | Asset revaluation: independent approver makes it effective | FA-08, GL-01 | 09 §7 |
| UAT-GL-036 | Lease modification remeasures liability + ROU | LSE-01 | 04 §7 |
| UAT-GL-037 | Disposal (approved) recycles revaluation surplus to RE | FA-07, FA-09 | 09 §7 |
| UAT-GL-042 | Disposal request → Draft, pending (not yet disposed) | FA-09 | 09 §7 |
| UAT-GL-043 | Disposal: requester cannot self-approve (SoD) | FA-09, R07 | 09 §7 |
| UAT-GL-044 | Disposal: independent approver makes it effective | FA-09, GL-01 | 09 §7 |
| UAT-GL-038 | Working-capital health score | Feature (financial-health score) | 07 §7.10 |
| UAT-UI-LSE-01 | Lease screen reachable + create + run + modify (UI) | LSE-01 | 04 §7 |
| UAT-UI-EAM-01 | EAM screen reachable + WO lifecycle / PM sweep / reliability (UI) | FA-06 | 09 §7 |
| TC-GL-18-01 | FX revaluation run computes unrealized gain/loss | GL-18 | 04 §3.2 |
| TC-GL-18-02 | FX revaluation post maker-checker + idempotent (5400/1100/2000) | GL-18, R05 | 04 §3.2 |
| TC-GL-19-01 | Pre-lock validation of a clean period → ready | GL-19 | 04 §2.1 |
| TC-GL-19-02 | Unposted Draft JE blocks pre-lock readiness | GL-19 | 04 §2.1 |
| TC-GL-13-04 | Cost-centre master — create & list (web `/cost-centers`) | GL-13 | 04 §1.3 |
| TC-GL-13-05 | Dimensional P&L view per cost centre (web `/cost-centers`) | GL-13 | 04 §1.3 |
| TC-CON-02-01 | Consolidation eliminates IC + keeps group TB balanced | CON-03 | 11 §7.8 |
| TC-CON-02-02 | Consolidation run→post maker-checker (SELF_POST/ALREADY_POSTED) | CON-03, R07 | 11 §7.9 |
| TC-CON-02-03 | Unbalanced eliminations → CONSOL_UNBALANCED (rolled back) | CON-03 | 11 §7.8 |
| TC-CON-03-01 | Segment report (IFRS 8) groups P&L by dimension | CON-04 | 11 §7.10 |
| UAT-GL-101 | GlAccountant cannot see "รออนุมัติ (JE)" tab | R05, GL-05 | 04 §9 |
| UAT-GL-102 | FinancialController sees "รออนุมัติ (JE)" tab | R05, GL-05 | 04 §9 |
| UAT-GL-103 | GlAccountant can reach /accounting in nav (gl_post perm) | R05 | 04 §3 |
| UAT-GL-104 | GlAccountant cannot see /finance/period-close in nav | R05, GL-15 | 04 §7 |
| UAT-GL-105 | GlAccountant can reach /reconciliation in nav (recon_prep perm) | R06, REC-01 | 04 §7 |
| UAT-GL-106 | GlAccountant cannot see certify button on /reconciliation | R06, REC-03 | 04 §7 |
| UAT-GL-107 | FinancialController can certify a recon period | R06, REC-03 | 04 §7 |
| UAT-GL-108 | API certify blocked for recon_prep-only token | R06, REC-03 | 04 §9 |
| UAT-GL-113 | Snapshot reconciliation blocks a drifted close | GL-20 | 04 §9 |
| UAT-GL-114 | Trial balance reads the maintained snapshot | GL-01, GL-20 | 04 §7 |
| UAT-GL-115 | Item-posting determination off by default (parity) | GL-21 | 04 §9 |
| UAT-GL-116 | Determination on → COGS routes to item override; sub-ledger ties | GL-21 | 04 §9 |
| UAT-GL-117 | Determination fail-closed (INVALID_POSTING_ACCOUNT) | GL-21 | 04 §9 |
| UAT-GL-118 | Item-setup screens: category-level account drives posting | GL-21 | 04 §14 (rev 2.8) |
| UAT-GL-119 | Warehouse account default drives inventory posting (lowest tier) | GL-21 | 04 §14 (rev 2.9) |
| UAT-GL-120 | Item default_location_id + AR revenue account drive posting | GL-21 | 04 §14 (rev 2.10) |
| UAT-GL-121 | FA-11 custody change → maker-checker (register moves only on approval) | FA-11, R07 | 09 §7.4, §9 |
| UAT-GL-122 | Confirming current location = verification (no approval) | FA-11, FA-04 | 09 §7.4 |
| UAT-GL-123 | Custody reject leaves the asset in place | FA-11 | 09 §7.4 |
| UAT-GL-124 | Audit-by-scan reconciles + offline replay idempotent | FA-11 | 09 §7.4 |
| UAT-GL-125 | Audit misplaced → closing raises a custody request | FA-11 | 09 §7.4, §9 |
| UAT-GL-126 | FA-12 verification-exception report flags stale/never-verified assets | FA-12 | 09 §7.4, §9 |
| UAT-GL-127 | Audit results surfaced as a BI report | FA-12, FA-11 | 09 §7.4 |
| UAT-GL-128 | Item-master fields editable on `/setup/items` (barcode/UOM/stock thresholds/MRP lot-sizing/capital-asset flags) | GL-21 (no control change) | 04 §7 (16), rev 2.13 (`basics.ts`) |
| UAT-GL-129 | Warehouse master fields fully editable on `/setup/warehouses` (name/zone/type/capacity/temperature/notes) | GL-21 (no control change) | 04 §7 (16), rev 2.13 (`basics.ts`) |
| UAT-GL-130 | Asset register shows location/department/serial/assigned-to; capitalize form collects location/department/serial_no | FA-10 (no control change) | 09 §7.11, rev 1.4 (`basics.ts`) |

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
| UAT-TAX-017 | Deferred tax run → DTA from AR allowance (×CIT) | TAX-06 | 06 §9a, 04 §3.2 |
| UAT-TAX-018 | Deferred tax post maker-checker + idempotent (Dr 1700/Cr 5950) | TAX-06, R05 | 06 §9a, 04 §3.2 |
| UAT-TAX-018a | Deferred tax web screen — run → maker-checker post (`/deferred-tax`) | TAX-06, R05 | 06 §9a, 04 §3.2 |
| UAT-TAX-028 | Scheduled WHT-cert batch auto-issues the 50-ทวิ from AP-payment WHT | TAX-03 | 06 §14 (rev 0.9) |
| UAT-TAX-029 | WHT-cert batch idempotent (no duplicate on re-run) | TAX-03 | 06 §14 (rev 0.9) |
| UAT-TAX-030 | Scheduled PP30 filing-draft job registers the period return | TAX-05 | 06 §14 (rev 0.9) |
| UAT-TAX-031 | AP bill tax_code routes input VAT to the code's account | GL-21 | 06 §14 (rev 0.10) |
| UAT-TAX-032 | AR output VAT routes to the item vat_code account | GL-21 | 06 §14 (rev 0.10) |
| UAT-TAX-033 | PP30↔GL reconciliation spans the VAT-account set | TAX-04 | 06 §14 (rev 0.10) |
| UAT-TAX-034 | WHT tax_code defaults the income type + rate on an AP payment | TAX-03 | 06 §14 (rev 0.11) |
| UAT-TAX-035 | Issue a credit note (ใบลดหนี้ ม.86/10) against a tax invoice | TAX-07 | 06 §14 (rev 0.12) |
| UAT-TAX-036 | Maker-checker on a credit/debit note (SoD) | TAX-07, GL-05 | 06 §14 (rev 0.12) |
| UAT-TAX-037 | An approved credit/debit note adjusts output VAT in its period | TAX-07, TAX-04 | 06 §14 (rev 0.12) |
| UAT-TAX-038 | Print a credit note as a ม.86/10 document | TAX-07 | 06 §14 (rev 0.12) |
| UAT-TAX-039 | Full tax invoice PDF applies the no-code document template (presentation only; ม.86/4 fiscal integrity) | TAX-01 | 06 §14 (rev 0.13), 27 §7.13 |
| UAT-TAX-040 | Abbreviated 80mm slip applies the no-code document template (presentation only; ม.86/6 fiscal integrity) | TAX-01 | 06 §14 (rev 0.14), 27 §7.13 |
| UAT-TAX-041 | Voided-tax-invoice exception report surfaces voided invoices for independent review (G16) | Detective (no new numbered control; void stays single-user by RD requirement) | 06 §7 step 3, §9, §14 (rev 0.15) (`taxdocs.ts`) |
| UAT-TAX-042 | Full tax invoice: "ชำระเงินโดย" (Paid By) auto-derives for POS, settable for AR, prints with a due date | TAX-01 (presentation/data-adjacent; no new control; migration 0268) | 06 §14 (rev 0.17) (`taxdocs.ts`) |
| UAT-TAX-043 | Issuing a full tax invoice upserts the buyer into customer_master (address/branch/tax-id); repeat buyer refreshes, not duplicates; web autocomplete finds it | No new control (data-quality aid; migration 0269) | 06 §14 (rev 0.18) (`taxdocs.ts`) |

## 07 — Payroll → `05-payroll.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-PAY-001 | Create employees | PAY-01 | 05 §7 |
| UAT-PAY-002 | List employees | PAY-01 | 05 §7 |
| UAT-PAY-045 | Employee-master fields exposed (department/hourly_rate/pf_rate/sso_no/allowances/bank_account/start_date) | (no new control) | 05 rev 0.8 |
| UAT-PAY-003 | Run payroll prepares Draft JE (PendingApproval) | PAY-01, PAY-03, GL-01 | 05 §7 |
| UAT-PAY-004 | SSO+WHT+net totals | PAY-01 | 05 §9 |
| UAT-PAY-005 | SSO cap 750 | PAY-01 | 05 §9 |
| UAT-PAY-006 | SSO 5% below cap | PAY-01 | 05 §7 |
| UAT-PAY-007 | GL expense/payables (after approval) | PAY-01, PAY-03, GL-01 | 05 §9 |
| UAT-PAY-008 | Payroll idempotency | PAY-03 | 05 §7 |
| UAT-PAY-009 | ภ.ง.ด.1 summary | PAY-02 | 05 §7 |
| UAT-PAY-010 | Payslips | PAY-01 | 05 §7 |
| UAT-PAY-011 | PIT/WHT withholding | PAY-02 | 05 §9 |
| UAT-PAY-012 | RLS payroll isolation | ITGC-AC (RLS) | 08 §9 |
| UAT-PAY-013 | RBAC non-HCM block | ITGC-AC-07 | 08 §9 |
| UAT-PAY-014 | ESS self-service own data | Feature (ESS), ITGC-AC | 25 §7 |
| UAT-PAY-015 | ESS expense → AP reimbursement on approve | Feature (ESS), EXP-05, GL-01 | 25 §7 |
| UAT-PAY-019 | Reimbursement is an AP payable, settled via AP | EXP-05, REC-01 | 25 §7, 02 §7 |
| UAT-PAY-016 | ESS expense self-approval blocked | ITGC-AC-09 | 25 §7 |
| UAT-PAY-017 | ESS unlinked user refused | Feature (ESS) | 25 §7 |
| UAT-PAY-018 | Payroll run tenant-scoped | ITGC-AC-03 | 05 §7 |
| UAT-PAY-020 | Run posts Draft JE excluded from balances | PAY-03 | 05 §7 |
| UAT-PAY-021 | Preparer cannot approve own run (SoD) | PAY-03, R07 | 05 §7 |
| UAT-PAY-022 | Independent approver posts the run | PAY-03, GL-01 | 05 §7 |
| UAT-PAY-023 | Reject a pending run, then re-run | PAY-03 | 05 §7 |
| UAT-PAY-035 | Async payroll run executes off-thread via the job queue | PAY-03, availability | 05 §7 |
| UAT-PAY-036 | Async run idempotent + job status tenant-isolated | ITGC-AC-03 | 05 §7 |
| UAT-PAY-037 | Employee PII encrypted at rest; forms still show the real ID | ITGC-AC-19 | 05 §9 |
| UAT-UI-ESS-01 | ESS self-service screen reachable + own data + submit-only (UI) | Feature (ESS UI) | 25 §7 |
| UAT-PAY-024 | Approver inbox lists pending expense claims (tenant-scoped) | Feature (ESS), ITGC-AC-03 | 25 §7 |
| UAT-UI-ESS-02 | Expense approval screen — approve/reject + self-block (UI) | Feature (ESS UI), ITGC-AC-09 | 25 §7 |

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
| UAT-ADM-017 | AI-proposed action requires human approval | ITGC-AC-09, GL-01 | 08 §7 |
| UAT-ADM-018 | AI action — self-approval blocked (SoD) | ITGC-AC-09 | 08 §7 |
| UAT-ADM-019 | AI action — approver lacks kind permission | ITGC-AC-02/09 | 08 §7 |
| UAT-ADM-020 | AI action — tenant isolation (RLS) | ITGC-AC-03 | 08 §7 |
| UAT-ADM-021 | Custom field — define + slugged key | Feature (UDF) | 17 §7 |
| UAT-ADM-022 | Custom field — typed/required/option validation | Feature (UDF) | 17 §7 |
| UAT-ADM-023 | Custom field — typed read + bulk load | Feature (UDF) | 17 §7 |
| UAT-ADM-024 | Custom field — tenant isolation (RLS) | Feature (UDF) | 17 §7 |
| UAT-ADM-025 | Alert rule — create + reject unknown metric | Feature (alerts) | 17 §7 |
| UAT-ADM-026 | Alert sweep fires a breached rule | Feature (alerts) | 17 §7 |
| UAT-ADM-027 | Alert cooldown suppresses re-fire | Feature (alerts) | 17 §7 |
| UAT-ADM-028 | Alert rules tenant-isolated (RLS) | Feature (alerts) | 17 §7 |
| UAT-ADM-029 | Audit viewer — query, filter, paginate | ITGC-AC-10 | 08 §7.A.8 |
| UAT-ADM-030 | Audit viewer — CSV export + permission gate | ITGC-AC-10/02 | 08 §7.A.8 |
| UAT-ADM-031 | Audit viewer — tenant isolation (RLS) | ITGC-AC-10/03 | 08 §7.A.8 |
| UAT-ADM-032 | Bulk import — dry-run validates every row | Feature (bulk import), MDM-02 | 17 §7.3a |
| UAT-ADM-033 | Bulk import — checked commit (block vs skip) | Feature (bulk import) | 17 §7.3a |
| UAT-ADM-034 | Bulk import — tenant-scoped entity stamped | Feature (bulk import), MDM-01 | 17 §7.3a |
| UAT-ADM-037 | Bulk import — menu catalog (new-company load) | Feature (bulk import — menu_items), MDM-02 | 17 §7.3a |
| UAT-ADM-038 | Bulk import — direct `.xlsx` file round-trips | Feature (bulk import — xlsx), MDM-02 | 17 §7.3b |
| UAT-ADM-039 | Setup-page IO surface + SoD boundary (item-setup) | Feature (setup IO), R13 | 17 §7.3c |
| UAT-ADM-121 | Bulk import — non-sensitive vendor import commits directly | Feature (sensitive-import maker-checker), MDM-01, R02 | 17 §7.3d |
| UAT-ADM-122 | Bulk import — sensitive field (Credit_Limit/Payment_Terms) → STAGED PendingApproval, nothing written | Feature (sensitive-import maker-checker), MDM-03; R02, R09, R10 | 17 §7.3d, §9 |
| UAT-ADM-123 | Bulk import — requester cannot self-approve (SOD_VIOLATION) | Feature (sensitive-import maker-checker), MDM-03; R02/R09/R10 | 17 §7.3d, §9 |
| UAT-ADM-124 | Bulk import — distinct approver applies staged batch → rows + credit limit written | Feature (sensitive-import maker-checker), MDM-01; R02, R09, R10 | 17 §7.3d, §9 |
| UAT-ADM-125 | Tenant PromptPay/Tax-ID change STAGED PendingApproval, not applied; QR unaffected while pending (G15) | SoD R02 (tenant-profile maker-checker; no new numbered control) | 23 §7 step 6b (`promptpay.ts`) |
| UAT-ADM-126 | Requester cannot self-approve their own staged PromptPay/Tax-ID change (`SOD_VIOLATION`) (G15) | SoD R02 | 23 §7 step 6b (`promptpay.ts`) |
| UAT-ADM-127 | A distinct approver releases the staged change → tenant PromptPay id updates + QR generates (G15) | SoD R02 | 23 §7 step 6b (`promptpay.ts`) |
| UAT-ADM-035 | Webhook — register + secret-once + isolation | ITGC-AC-04/03 | 08 §7.A.9 |
| UAT-ADM-036 | Webhook — event emits a signed delivery (logged) | Feature (webhooks), ITGC-AC-04 | 08 §7.A.9 |
| UAT-ADM-037 | Webhook — redeliver / dispatch / revoke | Feature (webhooks) | 08 §7.A.9 |
| UAT-ADM-038 | Branding — set + render on receipt + validation | Feature (branding) | 23 §7.6a |
| UAT-ADM-039 | Branding — tenant-isolated | Feature (branding), ITGC-AC-03 | 23 §7.6a |
| UAT-ADM-040 | Notification inbox — targeted note reaches the right (tenant, role) user | Feature (notification inbox) | 27 §7.10 |
| UAT-ADM-041 | Notification inbox — tenant isolation (no cross-tenant) | Feature (notification inbox), ITGC-AC-03 | 27 §7.10 |
| UAT-ADM-042 | Notification inbox — broadcast vs role-targeted visibility | Feature (notification inbox) | 27 §7.10 |
| UAT-ADM-043 | Notification inbox — per-user mark-read, guard & mark-all | Feature (notification inbox) | 27 §7.10 |
| UAT-ADM-044 | Public API — OpenAPI doc + discovery open | Feature (public API) | 27 §7.11 |
| UAT-ADM-045 | Public API — API-key-only, scope identity | Feature (public API), ITGC-AC-07 | 27 §7.11 |
| UAT-ADM-046 | Public API — tenant isolation (RLS) over reads | Feature (public API), ITGC-AC-03 | 27 §7.11 |
| UAT-ADM-047 | Public API — scope gate | Feature (public API), ITGC-AC-07 | 27 §7.11 |
| UAT-ADM-048 | Public API — per-key rate limit | Feature (public API), anti-abuse | 27 §7.11 |
| UAT-ADM-049 | SSO — configure OIDC + secret write-only | Feature (SSO), ITGC-AC-04 | 27 §7.12 |
| UAT-ADM-050 | SSO — authorize URL / not-configured | Feature (SSO) | 27 §7.12 |
| UAT-ADM-051 | SSO — callback JIT-provisions + mints session | Feature (SSO), ITGC-AC-01 | 27 §7.12 |
| UAT-ADM-052 | SSO — id_token rejected (sig/aud) | Feature (SSO), ITGC-AC-01 | 27 §7.12 |
| UAT-ADM-053 | SCIM — token + auth + provision (SoD) | Feature (SCIM), ITGC-AC-09 | 27 §7.12 |
| UAT-ADM-054 | SCIM — deprovision = deactivate (soft) | Feature (SCIM), ITGC-AC-10 | 27 §7.12 |
| UAT-ADM-055 | SCIM/identity — tenant isolation + deactivated login block | Feature (SSO/SCIM), ITGC-AC-02/03 | 27 §7.12 |
| UAT-ADM-056 | Document templates — create, default & live preview | Feature (document templates) | 27 §7.13 |
| UAT-ADM-057 | Document templates — core integrity, gate, isolation, no GL | Feature (document templates) | 27 §7.13, §9 |
| UAT-ADM-058 | Custom objects — define, fields & record CRUD | Feature (custom objects) | 27 §7.14 |
| UAT-ADM-059 | Custom objects — validation reuse, isolation, no GL | Feature (custom objects) | 27 §7.14, §9 |
| UAT-ADM-060 | Object layouts — design, resolve & live preview | Feature (object layouts) | 27 §7.15 |
| UAT-ADM-061 | Object layouts — dup name, isolation, no GL | Feature (object layouts) | 27 §7.15, §9 |
| UAT-ADM-062 | Automation — create rule + run-event match/skip | Feature (automation) | 27 §7.16 |
| UAT-ADM-063 | Automation — validation, isolation, no GL | Feature (automation) | 27 §7.16, §9 |
| UAT-ADM-064 | Analytics studio — model + governed aggregate + RLS | Feature (semantic layer) | 27 §7.17 |
| UAT-ADM-065 | Analytics studio — unknown dimension rejected | Feature (semantic layer) | 27 §7.17, §9 |
| UAT-ADM-066 | Copilot — KB-grounded, cite-or-refuse | Feature (copilot) | 27 §7.18 |
| UAT-ADM-067 | Document AI — extract an AP draft | Feature (document AI) | 27 §7.19 |
| UAT-ADM-068 | NL analytics — plain language → governed query | Feature (NL analytics) | 27 §7.20 |
| UAT-ADM-069 | AI config — suggest + reject unknown target | Feature (AI config) | 27 §7.21, §9 |
| UAT-ADM-070 | Controls monitoring — scan, review, isolation, no GL | Feature (controls monitoring) | 27 §7.22, §9 |
| UAT-ADM-071 | i18n — set own locale, resolution, bad code, per-user | Feature (i18n) | 28 §4 |
| UAT-ADM-072 | White-label theme — set tokens, validation, RLS | Feature (white-label) | 30 §4 |
| UAT-ADM-073 | Onboarding — checklist + idempotent pack apply | Feature (onboarding) | 30 §4 |
| UAT-ADM-074 | Developer portal — keys, tiers, RLS | Feature (developer portal) | 29 §4 |
| UAT-ADM-075 | Connectors — register, sync, idempotent, per-tenant RLS | Feature (connectors) | 29 §4 |
| UAT-ADM-076 | Migration — dry-run field-map + validation + RLS | Feature (migration) | 30 §4 |
| UAT-ADM-077 | Localization — packs, apply, bad-country, RLS | Feature (localization) | 28 §4 |
| UAT-ADM-078 | e-Invoicing — submit, idempotent, validation | Feature (e-invoicing) | 28 §4 |
| UAT-ADM-079 | Ops — metrics + cache round-trip | Feature (scale/ops) | 30 §4 |
| UAT-ADM-080 | PWA — installable + offline shell | Feature (PWA) | 30 §4 |
| UAT-ADM-084 | R08 — Cashier cannot access `/pos/refunds` or `/pos/till` | SoD R08, ITGC-AC-09 | 21 §6 |
| UAT-ADM-085 | R08/R12 — Cashier cannot see "บันทึกคืนสินค้า" button | SoD R08/R12, ITGC-AC-09 | 21 §6 |
| UAT-ADM-086 | R12 — POS Supervisor can authorize pending refunds | SoD R12, ITGC-AC-09 | 21 §7 |
| UAT-ADM-087 | R12 — Self-approve refund request blocked | SoD R12, REV-16 | 21 §7 |
| UAT-ADM-088 | R08 — POS Supervisor can manage till + approve variance | SoD R08, POS-01 | 20 §6 |
| UAT-ADM-089 | R10 — Cashier cannot see pricing screen in nav | SoD R10, ITGC-AC-09 | 19 §4 |
| UAT-ADM-090 | R10 — Sales role cannot reach /pricing via direct URL | SoD R10, ITGC-AC-09 | 19 §4 |
| UAT-ADM-091 | R10 — PricingManager can access /pricing and create rule | SoD R10, MKT-01 | 19 §3 |
| UAT-ADM-092 | R10 — API: pos-only token blocked from pricing mutations | SoD R10, MKT-01 | 19 §3 |
| UAT-ADM-093 | R10 — API: pos token can still call pricing quote | SoD R10 (positive) | 19 §3 |
| UAT-ADM-094 | R12 — AR Clerk can see /returns in nav | SoD R12, ITGC-AC-09 | 01 §7 |
| UAT-ADM-095 | R12 — AR Clerk sees "บันทึกคืนสินค้า" button on /returns | SoD R12, REV-16 | 01 §7 |
| UAT-ADM-096 | R12 — POS Supervisor (pos_refund only) can reach /returns | SoD R12, POS-01 | 21 §6 |
| UAT-ADM-114 | Non-platform Admin cannot CREATE an Admin (`ADMIN_GRANT_DENIED`) | ITGC-AC-02 | 08 §7 (3a), §9 |
| UAT-ADM-115 | Non-platform Admin cannot PROMOTE to Admin; CAN manage a non-Admin role | ITGC-AC-02 | 08 §7 (3a), §9 |
| UAT-ADM-116 | Platform owner CAN grant the Admin role | ITGC-AC-02 | 08 §7 (3a), §9 |
| UAT-ADM-117 | SoD override request STAGED PendingApproval, user NOT created (G11 part b) | ITGC-AC-09, R03 | 08 §7 (6), §9 |
| UAT-ADM-118 | Requester cannot self-approve a staged SoD exception (`SOD_VIOLATION`) | ITGC-AC-09 | 08 §7 (6), §9, §13 |
| UAT-ADM-119 | Distinct admin approves → user created + who/why/rules in hash-chained audit meta | ITGC-AC-09, R03 | 08 §7 (6), §9 |
| UAT-ADM-120 | Conflicting set with NO reason still blocked (`SOD_CONFLICT`), incl. UPDATE | ITGC-AC-09, R03 | 08 §7 (6), §9, §13 |

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
| UAT-RPT-025 | Customer-360 detail + RLS + perm gate | Feature (CRM 360), ITGC-AC | 26 §7 |
| UAT-RPT-026 | Analytics HTTP layer (guard stack) | ITGC-AC-02 | 26 §7 |
| UAT-RPT-027 | Scheduled report subscription validation | Feature (scheduled reports) | 26 §5, §5a |
| UAT-RPT-028 | Scheduled report sweep runs due + records run | Feature (scheduled reports) | 26 §5a |
| UAT-RPT-029 | Scheduled report run-now + tenant isolation | Feature (scheduled reports), ITGC-AC-03 | 26 §5a |
| UAT-RPT-030 | Saved views visibility + owner-only delete | Feature (saved views), ITGC-AC-03 | 26 §5b |
| UAT-RPT-031 | Role dashboard catalog + layout validation | Feature (role dashboards) | 26 §3a |
| UAT-RPT-032 | Role dashboard resolution filtered to viewer perms | Feature (role dashboards), ITGC-AC-02 | 26 §3a |
| UAT-RPT-033 | Role dashboard default fallback + tenant isolation | Feature (role dashboards), ITGC-AC-03 | 26 §3a |
| UAT-RPT-034 | Menu-engineering matrix (Kasavana–Smith) | Feature (menu engineering) | 20 §rev2.7 |
| UAT-RPT-035 | Daypart / hour demand on the business clock | Feature (daypart), TZ (Asia/Bangkok) | 20 §rev2.7 |
| UAT-RPT-036 | Void / discount shrinkage analytics | Feature (loss prevention) | 20 §rev2.7 |
| UAT-RPT-037 | Staff / cashier performance | Feature (staff analytics) | 20 §rev2.9 |
| UAT-RPT-038 | Sales trend vs prior window | Feature (sales trend) | 20 §rev2.9 |
| UAT-RPT-039 | BOM availability forecast (servings-remaining) | Feature (BOM availability) | 20 §rev2.9 |
| UAT-RPT-040 | Production plan — demand-ML forecast | Feature (production plan, demand-ML) | 20 §rev3.3 |
| UAT-RPT-041 | One-click draft PO + AI tools | Feature (production plan), AI | 20 §rev3.2 |
| UAT-RPT-042 | Residual-gap BI report types (exec / budget / supplier) | RG-1/2/3 (docs/21); ELC-06 | docs/21 §2 |
| UAT-RPT-043 | Streaming analytics — live KPI feed | (operational) | docs/22 Phase B |
| UAT-RPT-044 | Weekly-seasonal demand auto-selects the day-of-week model | demand forecasting | 26 §7 |
| UAT-RPT-045 | Thai-holiday demand model applies the learned uplift | demand forecasting | 26 §7 |
| UAT-UI-DEM-01 | Demand forecasting screen (forecast / backtest / accuracy) (UI) | Feature (demand ML UI) | 13 §7 |
| UAT-UI-BUD-01 | Budget vs Actual screen (set budget + variance) (UI) | Feature (budget-vs-actual UI) | 13 §7 |
| UAT-BUD-02 | Budget maker-checker — pending excluded until approved | BUD-01 | 13 §7 |
| UAT-UI-INS-01 | Insights screen — anomalies / replenishment / AI insight (UI) | Feature (insights UI), BI-04 | 26 §7 |

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

## 11 — Loyalty & CRM (Members & Points) → `19-marketing-pricing-loyalty.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-LOY-001 | Member directory list + search | Feature (member directory) | 19 §7 (8a) |
| UAT-LOY-002 | Directory RBAC gate | ITGC-AC-02/07 | 19 §6 |
| UAT-LOY-066 | Over-threshold staff transfer STAGED PendingApproval, moves NO points; sub-threshold/member-self still immediate (G13) | LYL-18 (SoD R15/R16; no new numbered control) | 19 §7 (29), §9 (`loyalty.ts`) |
| UAT-LOY-067 | Requesting staff member cannot self-approve their own staged over-threshold transfer (`SOD_VIOLATION`) (G13) | LYL-18 (SoD R15/R16) | 19 §7 (29), §9 (`loyalty.ts`) |
| UAT-LOY-068 | A distinct approver releases the staged transfer → points move + pending queue clears (G13) | LYL-18 (SoD R15/R16) | 19 §7 (29), §9 (`loyalty.ts`) |
| UAT-LOY-003 | Member 360 + points history | Feature (CRM 360) | 19 §7 |
| UAT-LOY-004 | Withdraw marketing consent stops sends | MKT-04, MKT-05 | 19 §7, §9 |
| UAT-LOY-005 | Consent register persists per purpose | MKT-05 | 19 §7 |
| UAT-LOY-006 | Points-liability tie-out (acct 2250) | MKT-06 | 19 §7, §9 |
| UAT-LOY-007 | Members tenant-isolated (RLS) | ITGC-AC (RLS) | 08 §9 |
| UAT-LOY-008 | Liability accrual posts & ties out to GL 2250 | MKT-06 | 19 §7, §9 |
| UAT-LOY-009 | Accrual run idempotent (no double-post) | MKT-06 | 19 §7 |
| UAT-LOY-010 | Tie-out tenant-scoped (Admin bypass) + all-member basis | MKT-06, ITGC-AC (RLS) | 19 §7 |
| UAT-LOY-011 | Aged points expire (breakage) & release liability | MKT-06 | 19 §7, §9 |
| UAT-LOY-012 | Period close auto-accrues the liability | MKT-06 | 19 §7, §9 |
| UAT-LOY-013 | Scheduled maintenance sweep (expire + accrue, per tenant) | MKT-06 | 19 §7, §9 |
| UAT-LOY-014 | Reward burn → single-use code → liability release → double-use blocked | MKT-07 | 19 §7, §9 |
| UAT-LOY-015 | Reward eligibility guards (points/stock/limit/tier) | MKT-07 | 19 §7 |
| UAT-LOY-016 | Tier auto-recompute + journey | MKT-08 | 19 §7, §9 |
| UAT-LOY-017 | Mission claim grants reward once (single-claim) | MKT-08 | 19 §7, §9 |
| UAT-LOY-018 | Referral rewards both once + anti-gaming + tenant-scoped | MKT-08, ITGC-AC (RLS) | 19 §7, §9 |
| UAT-LOY-019 | Member self-service app — phone-OTP login, self-scoped, staff routes blocked | LYL-10, ITGC-AC | 19 §7 (21), control 21 |
| UAT-LOY-019b | Member OTP brute-force cap holds (adversarial-review fix) | LYL-10b | 19 control 21 |
| UAT-LOY-020 | Spin-the-wheel — weighted draw, free→cost, per-prize stock cap | MKT-09 | 19 §7 (22), control 22 |
| UAT-LOY-021 | Campaign — segmented send respects opt-out, audited, idempotent | MKT-10 | 19 §7 (23), control 23 |
| UAT-LOY-022 | Partner privilege — tier-gated single-use claim, limit, partner redeem | MKT-11 | 19 §7 (24), control 24 |
| UAT-LOY-023 | Loyalty analytics — tenant-scoped liability + funnel + churn | LYL-15 | 19 §7 (25) |
| UAT-LOY-024 | LINE login — linked account mints a member token; unlinked rejected | ITGC-AC, LYL-16 | 19 §7 (26), control 26 |
| UAT-LOY-025 | Receipt upload — submit → staff approve → points granted via earnInTx | LYL-17 | 19 §7 (27), control 27 |
| UAT-LOY-026 | Receipt upload — reject leaves the balance untouched; re-review blocked | LYL-17 | 19 §7 (27), control 27 |
| UAT-LOY-027 | Receipt upload — duplicate member/date/amount claim blocked | LYL-17 | 19 §7 (27), control 27 |

## Coverage summary

| Cycle | Cases | Control-type cases |
|---|---|---|
| 01 Security & Access | 45 | 33 |
| 02 Order-to-Cash | 57 | 27 |
| 03 Procure-to-Pay | 28 | 13 |
| 04 Inventory & WMS | 29 | 12 |
| 05 GL & Close (incl. fixed assets / EAM) | 55 | 37 |
| 06 Tax | 14 | 5 |
| 07 Payroll | 22 | 9 |
| 08 Admin / SoD / Audit | 80 | 47 |
| 09 Reports & Analytics | 29 | 6 |
| 10 Customer Portal | 12 | 5 |
| 11 Loyalty & CRM | 28 | 24 |
| **Total** | **399** | **217** |

> Note (2026-06-29): the "01 Security & Access" counts were reconciled to the actual case rows in `01-security-access-uat.md` (45 cases / 33 control, incl. the new UAT-SEC-036…045 for ITGC-AC-17). The other cycles' counts predate recent additions and may be understated — a separate full recount/reconciliation is pending and out of scope for this change.
