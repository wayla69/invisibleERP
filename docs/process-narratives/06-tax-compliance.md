# Tax Compliance (VAT / WHT / e-Tax) — Process Narrative

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-06-TAX |
| Process owner | `<<Tax / Controller>>` |
| Approver | `<<CFO>>` |
| Version | **0.1 DRAFT** |
| Effective date | `<<effective-date>>` |
| Review cadence | Each filing period + annual |
| Version note | Rev **0.15** (2026-07-06) — detective exception report for voided tax invoices (G16). |
| Related RCM controls | TAX-01, TAX-02, TAX-03, TAX-04, TAX-05, TAX-06, TAX-07, REV-10, PAY-02 |
| Related policy | `compliance/policies/11-financial-close-policy.md` |

## 2. Purpose

To control the computation, documentation, transmission, and reconciliation of Thai indirect and withholding taxes — VAT 7% (output/input), withholding tax (WHT), and e-Tax invoicing — so that taxes are **accurately computed, legally documented, timely filed, and reconciled to the general ledger**.

## 3. Scope

**In scope:** VAT 7% output/input computation, WHT computation and ภ.ง.ด. reporting, e-Tax invoice generation (ETDA UBL 2.1 XML) and transmission, legal tax-invoice numbering (per ม.86/4(4)), and tax-account-to-GL reconciliation. **C2 extension:** pluggable country tax providers (SG GST 9%, MY SST 6% with food-exempt category, EU VAT 20% placeholder); e-invoicing adapters for MY (LHDN MyInvois UBL 2.1) and SG (Peppol BIS3 InvoiceNow) as functional stubs.

**Out of scope:** the underlying sales/purchase transactions (see `01-order-to-cash.md`, `02-procure-to-pay.md`), payroll PIT/PND1 (see `05-payroll.md`). Full production MY/SG e-invoice submission (LHDN API credentials / Peppol AP registration) is a go-live workstream outside this scope.

## 4. References

- ISO 9001:2015 cl. 4.4, cl. 8.6, cl. 9.1.
- `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx` — TAX-01..03.
- Thai law: Revenue Code VAT 7%, ม.86/4(4) (tax-invoice particulars), ETDA e-Tax UBL 2.1; ภ.ง.ด. WHT returns.
- Code: `apps/api/src/modules/tax/tax-providers.ts` + `tax.service.ts`, `apps/api/src/modules/tax/documents/etax-xml.ts` + `etax-sign.ts` (XAdES signature) + `etax-email.service.ts`, `apps/api/src/modules/pos/fiscal/etax.service.ts` (provider submission), `apps/api/src/modules/tax/reports/`, `apps/api/src/common/doc-number.service.ts`.
- **e-Tax production go-live spike (charter + go/no-go):** `docs/ops/etax-production-spike.md` — current-state map, the 5 remaining gaps (Exclusive XML C14N, CA cert + HSM, real SP/email transmission, PDF/A-3, submission retry), the SP-vs-email decision, and the costed workstream. Read this before scheduling the RD go-live workstream.

## 5. Definitions & abbreviations

| Term | Meaning |
|---|---|
| VAT | Value Added Tax (TH standard rate 7%) |
| Output / Input VAT | VAT on sales / on purchases |
| WHT | Withholding Tax |
| e-Tax | Electronic tax invoice (ETDA UBL 2.1 XML) |
| ม.86/4(4) | Revenue Code section on tax-invoice particulars |
| ภ.ง.ด. (PND) | Withholding-tax return series |
| ETDA | Electronic Transactions Development Agency |

## 6. Roles & responsibilities (RACI)

| Activity | Tax Clerk | Tax / Controller | FinancialController | MasterDataAdmin |
|---|---|---|---|---|
| Maintain tax-rate config | C | **A/R** | C | C |
| Compute VAT (output/input) | (system) | A | C | I |
| Generate e-Tax invoice (XML + transmit) | **A/R** | A | I | I |
| Allocate legal tax-invoice number | (system) | A | I | I |
| Compute WHT + prepare ภ.ง.ด. | **A/R** | A | C | I |
| File returns | R | **A/R** | C | I |
| Reconcile tax accounts to GL | C | A | **A/R** | I |

## 7. Process narrative

1. **Rate configuration.** VAT/GST/SST is computed via a pluggable `TaxProvider` (registered per ISO-3166 country code: TH 7%, SG 9% GST, MY 6% SST, EU 20% VAT) with no hard-coded rate in callers; the provider is unit-tested (**TAX-01**). Rate config changes are master-data-controlled and audited. Unknown countries fall back to a `ZeroTaxProvider` (0%, explicitly labelled "No Tax").
2. **VAT computation.** On each sale/purchase, output/input VAT is computed by the provider and carried into the revenue/expense journal (sales VAT posts with the automatic revenue JE, **REV-10**). Re-computation on a sample ties to the filed return (**TAX-01**).
3. **Tax-invoice numbering (decision point).** A legally compliant, monthly per-seller sequential tax-invoice number is allocated atomically (doc numbering), satisfying ม.86/4(4) — gapless and unique.
   **Voided tax invoice — single-user by design + detective review (G16).** An issued tax invoice may be **voided** by a single user: this is an **RD requirement** (a voided fiscal number is retained and **never reused**, preserving the gapless sequence), so a preventive second-person gate is intentionally **not** applied here — a value-changing sales adjustment must instead go through a dual-controlled credit/debit **note** (**TAX-07**, step in §7 note below / §9). The void itself is sequence- and audit-logged. As the recommended **detective** control, `GET /api/tax-invoices/exceptions/voided` (`exec`/`ar`/`fin_report`; optional `from`/`to` on the **issue date**) lists **every voided tax invoice** (doc no., type, issue date, source, grand total, void reason, `created_by`) with a **count** and **total**, tenant-scoped — for independent periodic review of void activity. Read-only; posts nothing.
4. **e-Tax invoice generation, signing & transmission.** The e-Tax invoice is generated as ETDA UBL 2.1 XML; when a CA-issued certificate is configured (`ETAX_SIGNING_*`) it is sealed with an enveloped **XAdES** digital signature (RSA-SHA256 over the document + XAdES SignedProperties carrying SigningTime and the SigningCertificate digest), making it tamper-evident. The signed document is transmitted either to the customer by *e-Tax by Email* (CC the ETDA timestamp mailbox) or to a service provider (`ETAX_PROVIDER`: `mock` sandbox, or `http` for INET/Frank/Leceipt). Submission is idempotent (an `Accepted` document is never re-sent). XML schema correctness/escaping and signature integrity are tested (**TAX-02**).
5. **WHT computation.** On qualifying supplier payments/transactions, WHT is computed and a withholding certificate / ภ.ง.ด. line is prepared (**TAX-03**).
6. **Return preparation & filing.** Monthly ภ.พ.30 (VAT) and ภ.ง.ด. (WHT) returns are prepared and filed by the period deadline.
7. **Reconciliation (decision point).** Output/input VAT and WHT per the returns are reconciled to the GL VAT/WHT liability and input-VAT accounts; differences are investigated and cleared before filing, with evidence retained (ties to REC-01). For **VAT**, the ภ.พ.30 report (`GET /api/tax-reports/pp30`) computes net VAT = output (from issued tax invoices) − input (from AP bills) and **reconciles it to the GL account 2100 (Tax Payable) net movement** for the period (Σ credit − Σ debit over Posted entries), returning a `reconciliation.tied` verdict; a non-tie is a finding to clear before submitting (**TAX-04**). Output VAT posts to 2100 on each sale (Cr) and reverses on returns (Dr); input VAT posts on AP bills (Dr). WHT remittance is likewise tied to its GL account before filing (**TAX-03**).

## 8. Process flow

```mermaid
flowchart TD
    A[Sale / purchase transaction] --> B[Compute VAT 7% via provider TAX-01]
    B --> C[Allocate legal tax-invoice number ม.86/4(4)]
    C --> D[Generate e-Tax UBL 2.1 XML + email CC ETDA TAX-02]
    A --> E[Compute WHT on qualifying payments TAX-03]
    B --> F[VAT carried into auto revenue/expense JE REV-10]
    E --> G[Prepare ภ.ง.ด. / ภ.พ.30 returns]
    F --> G
    G --> H{Returns reconcile to GL tax accounts? VAT TAX-04 / WHT TAX-03}
    H -- "difference" --> H1[Investigate + adjust before filing]
    H -- "agrees" --> I[File returns by deadline]
```

**Swimlane description by role:** The **system** computes VAT via the tested provider, allocates the legal invoice number, and emits the e-Tax XML. **Tax Clerk** generates documents and prepares returns. **Tax/Controller** owns rate config and filing. **FinancialController** reconciles tax accounts to the GL before filing.

## 9. Control matrix

| Step | Risk | Control | Type | RCM ID | Evidence / Record |
|---|---|---|---|---|---|
| 1,2 | VAT computed incorrectly (penalty risk) | Pluggable, unit-tested rate provider (no hard-coded rate) | Auto | TAX-01 | VAT unit tests; return tie-out |
| 3 | Non-sequential / non-compliant tax-invoice number | Atomic monthly per-seller numbering (ม.86/4(4)) | Prev / Auto | TAX-01 | Doc-number sequence |
| 4 | Non-compliant / unsigned / untransmitted e-Tax invoice | ETDA UBL 2.1 XML generation + XAdES digital signature (tamper-evident) + idempotent transmission (email CC ETDA or SP) | Auto | TAX-02 | e-Tax XML/signature samples, submission log, email log |
| 5 | WHT mis-computed / not reported | WHT computation + ภ.ง.ด. reporting | Auto | TAX-03 | WHT report; certificates |
| 6,7 | VAT return (ภ.พ.30) diverges from the GL VAT account | ภ.พ.30 ↔ GL-2100 reconciliation: net VAT (output − input) tied to the 2100 net movement, with a tie verdict, before filing | Det / Auto | TAX-04 | ภ.พ.30 return + GL-2100 reconciliation tie |
| 3 | A sales adjustment is not on a compliant ใบลดหนี้/ใบเพิ่มหนี้, or is issued + GL-posted by one person (mis-stated output VAT / fictitious credit note hiding a receivable diversion) | Credit/Debit note (ม.86/10 / 86/9): references the original invoice + reason (credit-cap enforced), issued PendingApproval + Draft GL, approved by a DIFFERENT user (approver ≠ issuer) which posts the GL + signs the note into the ภ.พ.30 of its issue period | Prev / Auto | TAX-07 | ใบลดหนี้/ใบเพิ่มหนี้ register + CN/DN JE + signed output-VAT row + SoD test |
| 3 | Issued tax invoice voided without review (single-user by RD requirement — number retained, never reused) | **Voided-tax-invoice exception report (G16)** — `GET /api/tax-invoices/exceptions/voided` lists every voided invoice (doc no./type/issue date/source/grand total/void reason/created_by) with count + total for independent periodic review; value-changing adjustments must instead route via the dual-controlled credit/debit note (TAX-07) | Det / Manual | TAX-07 (adjustments); detective | Voided-tax-invoice exception report; `taxdocs` harness |
| 7 | WHT remittance diverges from GL | WHT-account-to-GL reconciliation before filing | Det / Hybrid | TAX-03 | Reconciliation evidence |

## 9a. Deferred tax (TAS 12 / TFRS, TAX-06)

Income tax expense must reflect not only current tax but **deferred** tax arising from **temporary**
differences between the carrying amount of an asset/liability for **book** purposes and its **tax** base.
WS3.2 adds a governed, maker-checker, idempotent-per-(tenant, period) deferred-tax run (the full workflow,
alongside FX revaluation GL-18, is in `04-general-ledger-close.md` §3.2).

1. **Run** — `POST /api/ledger/deferred-tax/run` gathers temporary differences:
   - **AR allowance for doubtful accounts** (a *deductible* temp diff): book recognises the allowance now,
     tax deducts the loss only on write-off ⇒ **DTA = posted allowance (REV-18) × CIT** (default **20%**).
   - **Accelerated depreciation** (a *taxable* temp diff): book NBV vs an assumed tax NBV. **Simplification:**
     no parallel tax-depreciation ledger exists, so tax depreciation is assumed faster than book by a
     documented factor (default **1.5×**, capped at the depreciable base), overridable per run ⇒
     **DTL = (bookNBV − taxNBV) × CIT**.
   It nets to `net_deferred = DTA − DTL` and records the **delta vs the prior posted run**.
2. **Post** — `POST /api/ledger/deferred-tax/:id/post` (maker-checker, poster ≠ runner → `SELF_POST`) posts
   the period **delta**: an increase in the net asset (deferred tax **benefit**) → **Dr 1700 / Cr 5950**;
   a decrease → **Dr 5950 / Cr 1700**. Posting flows through the period-lock gate; `ALREADY_POSTED` on re-post.

New COA accounts: **1700** Deferred Tax Asset, **2700** Deferred Tax Liability, **5950** Deferred Tax Expense.

**Web UI:** the workflow is operable from **`/deferred-tax`** (Ledger nav, perms `gl_close`/`gl_post`/`exec`)
— a "คำนวณงวดใหม่" tab runs the computation (period / as-of / tax-rate / dep-factor, showing the DTA/DTL
split + temporary-difference breakdown) and a "รายการที่คำนวณ / โพสต์" tab lists runs with a **โพสต์เข้า GL**
button; maker-checker (`SELF_POST`) is enforced server-side.

### Control TAX-06 — Deferred tax recognition (maker-checker)
| Control ID | TAX-06 |
|------------|--------|
| Name | Deferred tax recognised from temporary differences; segregated post |
| Type | Application — Automated (Preventive, Quarterly / year-end) |
| Risk | Temporary differences not recognised as deferred tax, or computed and posted by one person — income tax expense + DTA/DTL mis-stated |
| Mitigation | Run→post `deferred_tax_runs`; DTA (allowance×CIT) + DTL (accel-dep, documented simplification); delta-vs-prior posting to 1700/5950; `SELF_POST`; period-lock gate |
| Owner | Tax / Financial Controller |
| Test | TC-TAX-06-01/02 (basics.ts harness) |

## 10. Inputs & outputs

**Inputs:** sales/purchase transactions, tax-rate config, vendor/customer tax IDs, payment data.
**Outputs:** computed VAT/WHT, legal tax invoices, e-Tax XML, ภ.พ.30 / ภ.ง.ด. returns, reconciliations.

## 11. Records & retention

| Record | Store | Retention |
|---|---|---|
| Tax invoices + e-Tax XML | Tax-docs / Application DB | `<<per Revenue Code (≥5 yrs)>>` |
| VAT/WHT computations | Application DB | `<<per Revenue Code>>` |
| Filed returns (ภ.พ.30 / ภ.ง.ด.) | Tax-reports / filings | `<<per Revenue Code>>` |
| Tax-to-GL reconciliations | Application DB | `<<7 years>>` |

## 12. KPIs / metrics

- VAT/WHT computation exceptions (target: 0; re-computed sample agrees).
- e-Tax XML validation failures / transmission failures.
- On-time filing rate (ภ.พ.30 / ภ.ง.ด.).
- Tax-account-to-GL reconciliation differences (target: 0).

## 13. Exception & error handling

| Exception | Trigger | Handling |
|---|---|---|
| Rate/computation error | Provider returns unexpected value | Tax/Controller reviews config; correct before posting |
| XML validation failure | e-Tax document fails schema | Regenerate; do not transmit invalid XML |
| Reconciliation difference | Return ≠ GL tax account | Investigate and clear before filing |
| Numbering gap/duplicate | Sequence anomaly | Investigate doc-counter; remediate per ม.86/4(4) |

## 14. Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 0.18 | 2026-07-07 | Platform / Tax | **Issuing a full tax invoice keeps the customer master directory reusable — buyer autocomplete + persisted address (migration 0269, presentation/data-adjacent).** `customer_master` gains **`address`** (encrypted at rest, like `tax_id`/`notes` on this table — never searched via `ilike`, so it's safe to encrypt transparently per `database/encrypted-column.ts`) and **`branch_code`** (plaintext). `CustomerMasterService.upsertFromInvoiceBuyer` is called (best-effort, never blocks issuance) at the end of **`TaxInvoiceService.issueFull`**: a genuinely new buyer name creates a `customer_master` row from the invoice's buyer block (name/tax_id/branch/address); **re-issuing for an existing buyer name (same tenant) REFRESHES its address/branch/tax-id** rather than creating a duplicate — dedup is by exact **name** match (not tax ID: `tax_id` is stored encrypted and isn't equality-queryable without a companion blind-index column, which this doesn't add). `CustomersModule` now `exports` `CustomerMasterService`/`CustomersService` and is imported into `TaxDocsModule` (no import cycle — `CustomersModule` has no dependency back on tax). Web `/tax/invoices`' buyer-name field gains a debounced (`GET /api/customer-master?search=`) autocomplete dropdown showing name + tax-id/address preview; picking a match fills name/tax-ID/address/branch so a repeat buyer never needs retyping. `CreateCustomerBody`/`shapeCustomer` extended with `address`/`branch_code` so the same fields round-trip through the existing `POST/GET /api/customer-master` endpoints. No RCM control change (a convenience/data-quality aid, not a control) — verified end-to-end in a real browser against a throwaway Postgres instance (login → issue for a new buyer → reload → autocomplete finds it → pick fills all fields), not just the harness. ToE: `taxdocs` **100** (+3: new-buyer upsert with tax-id/branch/address; re-issuing for the same buyer name refreshes the address with no duplicate row). |
| 0.17 | 2026-07-07 | Platform / Tax | **ใบกำกับภาษีเต็มรูป (ม.86/4) gains a receipt-style "ชำระเงินโดย" (Paid By) section + due date + seller phone/fax (presentation/data-adjacent, migration 0268).** Closing the gap vs. the combined ใบเสร็จรับเงิน/ใบกำกับภาษี layout many businesses use: `fullTaxInvoiceHtml` now prints the seller's **Tel/Fax** (read live from `tenants.phone`/new `tenants.fax`, like the existing logo pattern — contact info, not a frozen ม.86/4 snapshot field; **fax** is editable on the Company Setup screen, `PATCH /api/tenant/profile`, alongside phone — manual `11-administration.md` §13 updated), an optional **วันครบกำหนดชำระเงิน** (due date) row, and a **"ชำระเงินโดย (Paid By)"** block (โอนเงิน/เงินสด/เช็คธนาคาร/อื่นๆ + ธนาคาร/เลขที่เช็ค/สาขา) — always printed (boxes unchecked, fields blank when no payment was recorded) so the layout is stable either way. New nullable `tax_invoices` columns `due_date`/`paid_by`/`paid_by_other`/`paid_bank`/`paid_cheque_no`/`paid_branch` (migration **0268**, ADD COLUMN only — table already tenant-scoped/RLS'd). **`TaxInvoiceService.issueFull`** auto-derives Paid By for a **POS**-sourced invoice from the sale's own `payment_method` (`classifyPaidBy`: cash/transfer-promptpay-qr/cheque, else "other" with the raw label preserved); an **AR**-sourced invoice (or an explicit override) accepts `due_date`/`payment` in the request body (`IssueFullBody`). Also: title order flipped to **"ใบเสร็จรับเงิน/ใบกำกับภาษี"**, item-table amount column labelled **"(ไม่รวมภาษี)"**, totals rows gain an English gloss (Sub Total/VAT/Grand Total), and the default footer signature captions changed to **"ผู้รับเงิน (Collector)" / "ผู้อนุมัติจ่ายเงิน (Authorized By)"** (still overridable per-tenant via the existing no-code document-template captions). Web `/tax/invoices` issue form gains due-date + Paid-By inputs (bank/cheque-no/branch shown conditionally). None of this is a ม.86/4-mandatory particular — the seller/buyer identity, VAT, and grand-total lines are unchanged and still structural. **No new/changed RCM control** (reinforces TAX-01). ToE: `taxdocs` **97** (+4: POS auto-derives `paid_by=cash` from the sale; an AR invoice with neither payment nor due_date leaves both null; an AR invoice with an explicit payment+due_date persists and round-trips; the PDF prints "ชำระเงินโดย" with the correct box ticked + the bank + due date). UAT `06-tax-uat.md` UAT-TAX-042. |
| 0.16 | 2026-07-07 | Platform / Tax | **หนังสือรับรองการหักภาษี ณ ที่จ่าย (50-ทวิ) PDF matched verbatim to the RD's official form (approve_wh3_081156.pdf, presentation-only).** `whtCertificateHtml` (`tax-docs-pdf.service.ts`) is rebuilt against the actual gov't PDF text (source verified directly, not inferred): payer then payee render as **stacked full-width boxes** (not side-by-side — matches the real form) each with a **13-cell boxed Tax-ID grid** (`taxIdBoxes`) and the printed ชื่อ/ที่อยู่ hint captions; a **ลำดับที่ ___ ในแบบ** line plus all **7** ภ.ง.ด. checkboxes (1)–(7) in two rows, with the official cross-reference footnote; the income table's row 4 splits into **(ก) ดอกเบี้ย ม.40(4)(ก)** / **(ข) เงินปันผล ม.40(4)(ข)** with the FULL dividend credit/no-credit sub-list (1)/(1.1)–(1.4)/(2)/(2.1)–(2.5), verbatim wording — presentational only, no new data captured, boxes render unchecked; row 5/6 wording, the "ภาษีที่หักและนำส่งไว้" column header, and "รวมเงินภาษีที่หักนำส่ง (ตัวอักษร)" (dropped an invented "ทั้งสิ้น") now match the source exactly; added the printed กบข./ประกันสังคม/สำรองเลี้ยงชีพ contribution line; footer split into the printed **คำเตือน** (ม.50 ทวิ/ม.35 penalty notice) box + certify/signature + a company-seal (ตราประทับ) box; the **หมายเหตุ** is now the exact 3-item Tax-ID definition from the source (dropped the earlier paraphrased placeholder). No schema, endpoint, computation, or GL change — `total_paid`/`total_wht`/`pnd_type`/`wht_condition` are unchanged and still drive the same fields. **No migration, no new/changed RCM control** (reinforces the existing tax-document-integrity control, TAX-01/TAX-03). ToE: `taxdocs` **93** unchanged/green (string-level assertions on "มาตรา 50 ทวิ" / บาทตัวอักษร still hold). |
| 0.15 | 2026-07-06 | Platform / Tax | **G16 — voided-tax-invoice exception report (maker-checker gap remediation, Phase P3; detective control — no new RCM control).** §7 step 3 note + §9 control matrix (detective row). New **detective** report `GET /api/tax-invoices/exceptions/voided` (`exec`/`ar`/`fin_report`; optional `from`/`to` on the **issue date**) lists **every voided tax invoice** (doc no., type, issue date, source, grand total, void reason, `created_by`) with a **count** and **total**, tenant-scoped, for independent periodic review. The **void itself stays single-user by design** — an **RD requirement** (a voided fiscal number is retained and **never reused**, keeping the ม.86/4(4) sequence gapless); value-changing sales adjustments are separately dual-controlled via the credit/debit **note** (**TAX-07**). Read-only; posts nothing; no migration, no new endpoint on the write path. No new numbered control (RCM census unaffected). ToE: `taxdocs.ts` (voiding an issued invoice → it surfaces in the report with its reason). Manual `07-tax.md` (void-review callout) + UAT `06-tax-uat.md` (UAT-TAX-041) + traceability matrix updated. |
| 0.14 | 2026-07-05 | Platform / Tax | **ใบกำกับภาษีอย่างย่อ (ม.86/6) 80mm slip now applies the tenant's no-code document template.** The abbreviated thermal slip is wired live: its layout moves into a shared pure renderer (`common/a4-template.ts` `renderAbbreviatedTaxSlip`) used by BOTH the live renderer (`tax-docs-pdf.service.ts` `abbreviatedTaxInvoiceHtml(inv, cfg)`) and the template designer's preview, so the two can never drift. Only the **thermal-appropriate knobs** apply — the **header note** (a slogan/branch line) and **footer notes** (`terms_text` + `extra_lines`); accent colour, logo, seller-line toggles, amount-in-words and signature captions do NOT apply to a monochrome slip. The controller resolves the active `tax_invoice_abbreviated` template **fail-open**, normalized `{ fiscal: true }`; the mandatory ม.86/6 elements (seller legal name + Tax ID, the "ใบกำกับภาษีอย่างย่อ" title, the VAT-inclusive total) are structural and never config-gated. The designer's abbreviated **preview now renders the real 80mm slip** (not an A4 mock-up), and the web knob panel for the slip shows only the header/footer-note fields. No amounts change; **nothing** posts to the GL. `tax_invoice_abbreviated` flips **planned → live** (both tax invoices now live). **No migration, no new RCM control** (presentation-only; reinforces TAX-01). ToE: `taxdocs` **91** (+4: catalog-live, header/footer notes applied live, ม.86/6 fiscal+core integrity) and `ext` (+2: slip preview honours notes, slip fiscal integrity). Manual `07-tax.md` + `12-platform-customization.md`, UAT `06-tax-uat.md` (UAT-TAX-040), and process narrative `27-platform-customization.md` (§7.13 + rev 1.9) updated. |
| 0.13 | 2026-07-05 | Platform / Tax | **ใบกำกับภาษีเต็มรูป (ม.86/4) PDF now applies the tenant's no-code document template (presentation-only; fiscal integrity enforced).** The full-tax-invoice renderer (`tax-docs-pdf.service.ts`, its own fiscal shell shared with the credit/debit note + WHT 50-ทวิ form) is **parameterized in place**: an `accentColor` gate identical to `common/doc-html.ts` plus the shared `a4LogoHtml`/`a4HeaderNoteHtml`/`a4FooterHtml` helpers, so a tenant's active `tax_invoice_full` template (accent, logo, header note, footer terms/captions, amount-in-words toggle) applies at print time on `GET /api/tax-invoices/:docNo/pdf`. The controller resolves the active template **fail-open** and normalizes it with **`{ fiscal: true }`** — the ม.86/4 mandatory seller name/address/tax-id lines are **force-kept regardless of the knobs**, and the "ใบกำกับภาษี" wording + VAT/total are structural (never config-gated). Seller **logo** is read live from the tenant row (presentation, not part of the immutable seller snapshot). No amounts change; **nothing** posts to the GL. `tax_invoice_full` flips **planned → live** in the document-template catalog (the abbreviated 80mm slip stays planned). **No migration, no new RCM control** (presentation-only; reinforces the existing tax-document-integrity control, TAX-01). ToE: `taxdocs` **87** (+6: catalog-live, template-applied-live incl. accent/note/terms/logo, amount-in-words toggle, ม.86/4 fiscal integrity, core-integrity). Manual `07-tax.md` + `12-platform-customization.md`, UAT `06-tax-uat.md` (UAT-TAX-039), and process narrative `27-platform-customization.md` (§7.13 + rev 1.8) updated. |
| 0.12 | 2026-07-05 | Platform / Tax | **ใบลดหนี้ (ม.86/10) / ใบเพิ่มหนี้ (ม.86/9) — credit/debit note with maker-checker + output-VAT adjustment (new control TAX-07, migration `0248`).** A seller (`ar`/`pos`) issues a **credit note** (reduces the sale + output VAT — returns / price reduction / defect / post-sale discount) or **debit note** (increases it — undercharge / added goods) that MUST reference the original issued full tax invoice + state a **reason** (ม.86/10(4)); a credit note cannot exceed the original net (`CREDIT_EXCEEDS_ORIGINAL`). `tax_invoice_type` gains `credit_note`/`debit_note`; `tax_invoice_status` gains **`PendingApproval`**; `tax_invoices` gains `original_doc_no`/`reason`/`gl_entry_no` (0248 — ADD COLUMN only, existing RLS). The note is issued **PendingApproval** and posts a **Draft** GL entry (credit: Dr 4000 + Dr 2100 / Cr 1100; debit: Dr 1100 / Cr 4000 + Cr 2100, via the AR sub-ledger); a **DIFFERENT user** (`approvals`/`gl_close`/`exec`) approves — **approver ≠ issuer** enforced (`SOD_VIOLATION`, reusing the GL-05 ledger approval) — which posts the GL AND flips the note to **Issued**. Only an Issued note feeds the ภ.พ.30 output-VAT report, which **signs by type** (credit − / debit +) into the note's issue period, so the VAT effect and GL-2100 movement land together and the **TAX-04** report↔GL tie holds. Endpoints: `POST /api/tax-invoices/credit-note`·`/debit-note` (`ar`/`pos`), `POST /api/tax-invoices/:docNo/approve-note`·`/reject-note` (`approvals`/`gl_close`/`exec`); the note prints as a proper ม.86/10 document (`creditDebitNoteHtml`) via the existing `/pdf`. New RCM control **TAX-07** (182 controls). ToE: `taxdocs` **81** (+12: reference/reason/credit-cap guards; PendingApproval excluded from output VAT; issuer self-approve → SOD_VIOLATION; independent approve → Issued + GL Posted + output VAT −7; debit +3.5; CN PDF). Web `/tax/invoices` gains a note-issue card + an approve action. Manual `07-tax.md` + UAT `06-tax-uat.md` (UAT-TAX-035..038) updated. |
| 0.8 | 2026-07-03 | Platform | **Web UI for deferred tax (TAX-06).** New `/deferred-tax` screen (Ledger nav) operates the existing run→review→post endpoints — no backend/control change. §9a documents the screen; UAT `06-tax-uat.md` gains a UI walkthrough. |
| 0.6 | 2026-06-28 | Platform | **C2 — Pluggable tax + e-invoicing (SG/MY/EU).** `SgTaxProvider` (GST 9%), `MyTaxProvider` (SST 6%, food exempt), `EuTaxProvider` (20% generic EU placeholder) added to `tax-providers.ts` and registered in `TaxService` constructor. `MYR` (Malaysian Ringgit, 2dp) added to the ISO-4217 currency catalogue (`money.ts`). `EInvoiceService` gains `buildMyInvoisXml` (LHDN MyInvois UBL 2.1) and `buildSgPeppolXml` (Peppol BIS3 InvoiceNow) document-builder stubs — `submit` routes to the appropriate builder when the active provider is MY/SG. Controller Zod schema updated to accept optional `currency` field in the invoice doc. Basics harness extended: 8 new C2 checks (TC-C2-01..08). §3 scope, §7 narrative and §8 flow updated. |
| 0.1 DRAFT | 2026-06-22 | `<<author>>` | Initial draft. |
| 0.2 DRAFT | 2026-06-24 | `<<author>>` | e-Tax invoices: added XAdES digital signing (`etax-sign.ts`, configurable cert) and idempotent provider submission (mock + generic `http` SP). Updated step 4, control TAX-02 matrix, and code refs. New harness `tools/cutover/src/etax-sign.ts`; `etax.ts` extended (submit + signed-fallback). |
| 0.3 | 2026-06-26 | Platform | **Registered the VAT-return ↔ GL reconciliation as a named control (TAX-04).** The ภ.พ.30 report (`GET /api/tax-reports/pp30`) already computes net VAT (output − input) and ties it to the **GL 2100 (Tax Payable)** net movement for the period with a `reconciliation.tied` verdict — but the §9 control matrix mis-attributed this VAT reconciliation to TAX-03 (WHT). Split step 6/7 into **TAX-04** (VAT ภ.พ.30 ↔ GL-2100, detective, pre-filing) vs TAX-03 (WHT remittance ↔ GL); strengthened §7. No app-code change (capability pre-existed: output VAT posts Cr 2100 on sale, Dr on return; input VAT Dr 2100 on AP). ToE: `taxdocs` harness adds an explicit reconciliation-block assertion. RCM 94 → 95. |
| 0.5 | 2026-06-26 | WS3.2 | **Deferred tax recognition (TAS 12 / TFRS, new control TAX-06).** New `POST /api/ledger/deferred-tax/run` computes deferred tax from book-vs-tax **temporary** differences — a **DTA** from the latest posted AR allowance (REV-18) × CIT (default 20%), and a **DTL** from accelerated depreciation (book NBV vs an *assumed* tax NBV; documented **1.5× simplification** as the model has no separate tax-depreciation ledger) — nets to `net_deferred` and the **delta vs the prior posted run**. `POST /api/ledger/deferred-tax/:id/post` is **maker-checker** (poster ≠ runner → `SELF_POST`) and posts the period delta to **1700 Deferred Tax Asset / 5950 Deferred Tax Expense** (benefit Dr 1700 / Cr 5950) through the WS2.1 period-lock gate; idempotent per (tenant, period) (`ALREADY_POSTED`). New COA 1700/2700/5950; new `deferred_tax_runs` table (migration **0168**, RLS). See `04-general-ledger-close.md` §3.2 (full workflow incl. FX revaluation GL-18). ToE: `basics` (TC-TAX-06-01/02). New RCM control **TAX-06** (128 controls). UAT `06-tax-uat.md` updated. |
| 0.6 | 2026-06-30 | Platform / Tax | **WHT withheld at AP payment + ภ.ง.ด.→GL tie-out (TAX-03 Partial → Implemented).** Vendor WHT is now withheld *at the moment of payment* and posted to the GL, closing the gap where WHT certificates (50-ทวิ) were issued standalone with no GL effect. The AP-payment maker-checker (`PATCH /api/finance/ap/transactions/:no/pay` → `POST /api/finance/ap/payments/:no/approve`) accepts an optional `wht_rate` (+ `wht_income_type`); on approval the WHT is computed on the **pre-VAT base** (prorated by the bill's net/gross) and posts **Dr 2000 AP / Cr 2361 Vendor-WHT-Payable / Cr 1000 (vendor paid net)** — so the liability owed to the Revenue Department is on the books, separate from payroll PND1 (account 2360). New `GET /api/tax-reports/pnd-tieout` reconciles three ways: GL 2361 movement ↔ WHT withheld on approved AP payments (flags out-of-process JEs) ↔ 50-ทวิ certificates issued (flags un-certificated withholding). New COA **2361** (+ CF classify); `ap_payments.wht_*` columns (migration **0204**). ToE: `taxdocs` (+4: WHT calc, ฿30 on a ฿1000 base, rate guard, tie-out). RCM TAX-03 → Implemented (gaps 4 → 3). UAT/manual updated. |
| 0.7 | 2026-07-02 | Platform | **Module consolidation (docs/28 PR #2) — code pointers only.** `modules/tax-docs` → `modules/tax/documents/`, `modules/tax-reports` → `modules/tax/reports/` under the `TaxModule` umbrella (new internal `TaxCoreModule` breaks the docs→core dependency cycle). Pure folder/import move — no route, permission, control, table or behavior change; §code references updated. |
| 0.4 | 2026-06-26 | Platform | **Thai tax filing register + remittance calendar (Step 7 — operating-spine PR7, new control TAX-05).** The tax-reports module already *computes* ภ.พ.30 / ภ.ง.ด.3/53 with GL reconciliation, deadlines and PDF export, but nothing persisted that a return was *filed*. New `thai_tax_filings` table (migration `0165`) snapshots a computed return into a **DRAFT→SUBMITTED→ACCEPTED** record (one per tenant/type/period) with the figures as filed + the Revenue-Department `submission_ref`. `POST /api/tax-reports/filings` files (idempotent; never overwrites a SUBMITTED/ACCEPTED period), `/:id/submit` requires a reference (`SUBMISSION_REF_REQUIRED`) and stamps SUBMITTED, `/:id/accept` → ACCEPTED; `GET /api/tax-reports/remittance-calendar` lists every monthly obligation (ภ.พ.30 by the 15th, ภ.ง.ด. by the 7th of the next month) with its filing status. New `/tax/reports` "การยื่นแบบ & ปฏิทิน" tab. ToE: `taxdocs` harness (+9). New RCM control **TAX-05** (124 controls). UAT `06-tax-uat.md` updated. |
| 0.8 | 2026-07-02 | Platform | **Module consolidation (docs/28 PR #5) — code pointers only.** POS satellite modules moved under `modules/pos/` (`audit`, `control`, `fiscal`, `labor`, `scale`, `terminal`) beneath the `PosModule` umbrella; routes, permissions, controls and tables unchanged. |
| 0.11 | 2026-07-04 | Platform / Tax | **WHT tax-code default on AP payment (docs/33 PR7, TAX-03).** The WHT side of the `tax_codes` master is now live: an AP payment request (`PATCH /api/finance/ap/transactions/:no/pay`) may carry a **`wht_tax_code`** that DEFAULTS the withholding **income type + rate** from the configured WHT code (ค่าจ้างทำของ `40(7-8)` / ค่าบริการ `3tre-service`) when the operator leaves them blank — an explicit `wht_income_type`/`wht_rate` still takes precedence, and a non-WHT or inactive code is rejected (`INVALID_WHT_TAX_CODE`). Unchanged: the WHT is still computed on the pre-VAT base and posted Dr 2000 / Cr 2361 / Cr 1000 at approval; the tie-out (pndTieOut) and auto-cert (PR4) are untouched. No control change (TAX-03 unchanged), no migration; RCM activity refreshed (181). ToE: `taxdocs` **69** (a `wht_tax_code` defaults the 3% rate; a VAT code used as a WHT code → `INVALID_WHT_TAX_CODE`). UAT `06-tax-uat.md` UAT-TAX-034. |
| 0.10 | 2026-07-04 | Platform / Tax | **VAT-account routing — `vat_code` drives VAT posting (docs/33 PR6, GL-21/TAX-04).** The `tax_codes` master is now *live*: a configured VAT code drives both the **rate** and the **output/input VAT GL account** instead of the flat 7/107 → single 2100. **AR** (`finance.service.ts syncArInvoices`): when the tenant has opted into `posting_determination`, an invoice's output VAT routes to the account of the **uniform item `vat_code`** resolved from the order's lines (item → category); a mixed-code or un-opted order keeps the 2100 default (parity). **AP** (`createApTxn`): the bill accepts an explicit `tax_code` → input VAT routes to the code's input account at its rate (honoring the code's inclusive/exclusive convention); an unknown or non-VAT code fails closed (`UNKNOWN_TAX_CODE`/`NOT_A_VAT_CODE`), and the account is validated postable at setup + by `postEntry`. **TAX-04 kept correct under routing:** `pp30`'s VAT-return↔GL reconciliation now sums the **whole VAT-account set** (2100 + every configured tax-code output/input account) rather than only 2100, so the ภ.พ.30 tie stays exact (no tax codes ⇒ set is `{2100}` ⇒ unchanged). No new table/migration; RCM GL-21 + TAX-04 activity refreshed (181). ToE: `taxdocs` (+7: distinct-account VAT code; AP input VAT → 2102; AR output VAT → 2101 via item vat_code; unknown-code reject; PP30 spans the set). `basics` 234 / `worldclass` 59 / `compliance` 134 / parity `writeflow` 36 green (parity: FinanceService without the resolver is byte-identical). UAT `06-tax-uat.md` UAT-TAX-031/032/033. |
| 0.9 | 2026-07-04 | Platform / Tax | **Scheduled tax automation — WHT 50-ทวิ auto-cert + filing drafts (docs/33 PR4, TAX-03/TAX-05).** New `TaxJobsModule` (`tax/tax-jobs.service.ts`) adds idempotent BI scheduler action jobs. **tax_wht_cert_batch** closes the TAX-03 un-certificated-WHT gap: for a period it finds every approved AP-payment that withheld tax (labour/service withholding — ค่าจ้างทำของ `40(7-8)`, ค่าบริการ `3tre-service`) and has no 50-ทวิ yet, and issues one via `WhtService.issue` — linked by `payment_no`, so a re-run skips already-certificated payments and never duplicates; a payment whose vendor lacks a valid 13-digit tax ID is skipped (surfaced in the run count). **tax_pp30_draft / tax_pnd_draft** register the period's ภ.พ.30 / ภ.ง.ด.3/53 as a DRAFT filing (reusing `fileReturn` — idempotent, never overwriting a SUBMITTED/ACCEPTED period, TAX-05); **tax_remittance_reminder** returns the period's amounts due + statutory deadlines (ภ.พ.30 15th, ภ.ง.ด. 7th) for a proactive nudge — a human still submits. Read-mostly, safe to re-run; wired into the BI scheduler (`bi.service.ts` REPORT_TYPES + `@Optional` `TaxJobsService`). No new table, no migration; RCM TAX-03/TAX-05 activity refreshed (xlsx regenerated, 181 controls). ToE: `taxdocs` (+6: the batch issues one linked 50-ทวิ, is idempotent on re-run with no duplicate, and the PP30 draft job runs). UAT `06-tax-uat.md` UAT-TAX-028/029/030. |
