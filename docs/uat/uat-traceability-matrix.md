# UAT Traceability Matrix — Invisible ERP V2

**Status: DRAFT v0.6 · 2026-06-29** · *v0.6: added UAT-SEC-036..045 (ITGC-AC-17 — POS-PIN quick-login restriction).* · *v0.5: added UAT-ADM-094..096 (SoD R12 — /returns nav perm for AR/pos_refund).*

Maps every UAT case → cycle → requirement/feature → RCM control (where applicable) → process-narrative section. RCM control IDs reference `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx`; SoD rules (R01–R16) reference `packages/shared/src/permissions.ts`. Process-narrative files are in `docs/process-narratives/`.

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
| UAT-O2C-148 | Credit-limit change is audited | REV-08, R09 | 01 §7, §9 |
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
| UAT-UI-P2P-ACC-01 | Procurement & AP screens split by user group | R03/R04/R07 | 02 §3 |
| UAT-UI-SUP-01 | Supplier portal screen (vendor self-service) — PO ack + invoice submit | Feature (supplier portal UI) | 02 §7 |
| UAT-P2P-040 | Capital PO line → GR eligible (not stocked) | FA-10 | 02 §7, 09 §7 |
| UAT-P2P-041 | Register asset from GR → PendingApproval, no GL | FA-10 | 09 §7 |
| UAT-P2P-042 | Capitalization self-approval blocked (SoD, incl. Admin) | FA-10, R07 | 09 §7 |
| UAT-P2P-043 | Independent approval creates asset + posts GL (Dr 1500/Cr 2000) | FA-10, GL-01 | 09 §7 |
| UAT-P2P-044 | GR line cannot be capitalised twice | FA-10 | 09 §7 |
| UAT-UI-CAP-01 | Capitalize-from-GR screen (eligible → request → approve) | FA-10 | 09 §7 |
| UAT-P2P-050 | Establish petty-cash fund within float (วงเงิน) | EXP-08 | 07 §7, §9 |
| UAT-P2P-051 | Expense request → PendingApproval, no GL | EXP-08 | 07 §7 |
| UAT-P2P-052 | Petty-cash disbursement self-approval blocked (SoD, incl. Admin) | EXP-08, R07 | 07 §7, §9 |
| UAT-P2P-053 | Independent approval posts GL + decrements fund | EXP-08, GL-01 | 07 §7, §9 |
| UAT-P2P-054 | Draw beyond the fund balance blocked | EXP-08 | 07 §7 |
| UAT-P2P-055 | Advance approve → disburse → settle to fund | EXP-08, GL-01 | 07 §7 |
| UAT-P2P-056 | Replenish capped at the float limit | EXP-08 | 07 §7 |
| UAT-P2P-057 | Pending petty-cash requests in GOV-01 monitor | EXP-08, GOV-01 | 07 §7 |
| UAT-UI-PCX-01 | Petty-cash fund + expense screen (funds → request → approve) | EXP-08 | 07 §7 |

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
| UAT-GL-045 | Control-account reconciliation pack (period-end) | REC-04 | 04 §7 |
| UAT-GL-046 | Pending-approvals monitor (maker-checker backlog) | GOV-01 | 04 §7 |
| UAT-GL-047 | Signup with industry provisions a curated chart | GL-10 | 04 §7 (step 14) |
| UAT-GL-048 | Overlay curates the picker but never gates postings | GL-10 | 04 §7 (step 14), §9 |
| UAT-GL-049 | Signup without industry defaults to the full chart | GL-10 | 04 §7 (step 14) |
| UAT-GL-050 | Industry template can't drift from the engine's codes | GL-10 | 04 §7 (step 14) |
| UAT-UI-COA-01 | Pick business type at signup (industry selector) | GL-10 | 04 §7 (step 14) |
| UAT-UI-COA-02 | View the industry chart of accounts (ผังบัญชี tab) | GL-10 | 04 §7 (step 14) |
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

## 07 — Payroll → `05-payroll.md`

| UAT ID | Requirement / Feature | RCM control / SoD | Narrative § |
|---|---|---|---|
| UAT-PAY-001 | Create employees | PAY-01 | 05 §7 |
| UAT-PAY-002 | List employees | PAY-01 | 05 §7 |
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

## Coverage summary

| Cycle | Cases | Control-type cases |
|---|---|---|
| 01 Security & Access | 45 | 33 |
| 02 Order-to-Cash | 55 | 25 |
| 03 Procure-to-Pay | 27 | 12 |
| 04 Inventory & WMS | 29 | 12 |
| 05 GL & Close (incl. fixed assets / EAM) | 55 | 37 |
| 06 Tax | 13 | 4 |
| 07 Payroll | 22 | 9 |
| 08 Admin / SoD / Audit | 80 | 47 |
| 09 Reports & Analytics | 29 | 6 |
| 10 Customer Portal | 12 | 5 |
| 11 Loyalty & CRM | 25 | 21 |
| **Total** | **392** | **211** |

> Note (2026-06-29): the "01 Security & Access" counts were reconciled to the actual case rows in `01-security-access-uat.md` (45 cases / 33 control, incl. the new UAT-SEC-036…045 for ITGC-AC-17). The other cycles' counts predate recent additions and may be understated — a separate full recount/reconciliation is pending and out of scope for this change.
