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
| Related RCM controls | TAX-01, TAX-02, TAX-03, TAX-04, REV-10, PAY-02 |
| Related policy | `compliance/policies/11-financial-close-policy.md` |

## 2. Purpose

To control the computation, documentation, transmission, and reconciliation of Thai indirect and withholding taxes — VAT 7% (output/input), withholding tax (WHT), and e-Tax invoicing — so that taxes are **accurately computed, legally documented, timely filed, and reconciled to the general ledger**.

## 3. Scope

**In scope:** VAT 7% output/input computation, WHT computation and ภ.ง.ด. reporting, e-Tax invoice generation (ETDA UBL 2.1 XML) and transmission, legal tax-invoice numbering (per ม.86/4(4)), and tax-account-to-GL reconciliation.

**Out of scope:** the underlying sales/purchase transactions (see `01-order-to-cash.md`, `02-procure-to-pay.md`), payroll PIT/PND1 (see `05-payroll.md`).

## 4. References

- ISO 9001:2015 cl. 4.4, cl. 8.6, cl. 9.1.
- `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx` — TAX-01..03.
- Thai law: Revenue Code VAT 7%, ม.86/4(4) (tax-invoice particulars), ETDA e-Tax UBL 2.1; ภ.ง.ด. WHT returns.
- Code: `apps/api/src/modules/tax/tax-providers.ts` + `tax.service.ts`, `apps/api/src/modules/tax-docs/etax-xml.ts` + `etax-sign.ts` (XAdES signature) + `etax-email.service.ts`, `apps/api/src/modules/pos-fiscal/etax.service.ts` (provider submission), `apps/api/src/modules/tax-reports/`, `apps/api/src/common/doc-number.service.ts`.
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

1. **Rate configuration.** VAT is computed via a pluggable provider (TH 7%) with no hard-coded rate; the provider is unit-tested (**TAX-01**). Rate config changes are master-data-controlled and audited.
2. **VAT computation.** On each sale/purchase, output/input VAT is computed by the provider and carried into the revenue/expense journal (sales VAT posts with the automatic revenue JE, **REV-10**). Re-computation on a sample ties to the filed return (**TAX-01**).
3. **Tax-invoice numbering (decision point).** A legally compliant, monthly per-seller sequential tax-invoice number is allocated atomically (doc numbering), satisfying ม.86/4(4) — gapless and unique.
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
| 7 | WHT remittance diverges from GL | WHT-account-to-GL reconciliation before filing | Det / Hybrid | TAX-03 | Reconciliation evidence |

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
| 0.1 DRAFT | 2026-06-22 | `<<author>>` | Initial draft. |
| 0.2 DRAFT | 2026-06-24 | `<<author>>` | e-Tax invoices: added XAdES digital signing (`etax-sign.ts`, configurable cert) and idempotent provider submission (mock + generic `http` SP). Updated step 4, control TAX-02 matrix, and code refs. New harness `tools/cutover/src/etax-sign.ts`; `etax.ts` extended (submit + signed-fallback). |
| 0.3 | 2026-06-26 | Platform | **Registered the VAT-return ↔ GL reconciliation as a named control (TAX-04).** The ภ.พ.30 report (`GET /api/tax-reports/pp30`) already computes net VAT (output − input) and ties it to the **GL 2100 (Tax Payable)** net movement for the period with a `reconciliation.tied` verdict — but the §9 control matrix mis-attributed this VAT reconciliation to TAX-03 (WHT). Split step 6/7 into **TAX-04** (VAT ภ.พ.30 ↔ GL-2100, detective, pre-filing) vs TAX-03 (WHT remittance ↔ GL); strengthened §7. No app-code change (capability pre-existed: output VAT posts Cr 2100 on sale, Dr on return; input VAT Dr 2100 on AP). ToE: `taxdocs` harness adds an explicit reconciliation-block assertion. RCM 94 → 95. |
