# 07 · Tax

**Status: DRAFT v0.1**

This chapter is for **accountants** and **finance** staff. It covers VAT, tax
invoices (full and abbreviated), e-Tax submission, withholding tax (WHT)
certificates, and the statutory tax reports.

---

## 1. VAT basics

- Standard **VAT rate is 7%**, calculated automatically on taxable sales and
  purchases.
- Each bill / sale carries a VAT treatment: **standard (7%)**, **exempt** or
  **zero-rated**.
- **Output VAT** is the VAT you charge customers; **input VAT** is the VAT you pay
  suppliers. The difference is reported on the monthly VAT return.

---

## 2. Tax invoices (ใบกำกับภาษี)

**Screen:** `/tax/invoices` · **Required permission:** `ar` / `pos`

Tabs: **Full** invoices (Section 86/4) and **Abbreviated** invoices (Section 86/6,
for retail POS).

### Issue a full tax invoice

1. Go to **Tax Invoices** (`/tax/invoices`) → **Full** tab.
2. Click **Issue full invoice** (**ออกใบเต็มรูป**).
3. Choose the source (an AR invoice or POS sale) and enter the **buyer's** name,
   tax ID and address.
4. Confirm. VAT at 7% is calculated automatically.

**Expected result:** A sequentially-numbered tax invoice is created (numbers are
never reused).

### Issue an abbreviated tax invoice (from a POS sale)

1. Go to the **Abbreviated** tab.
2. Select the POS sale and issue — no buyer details are required.

**Expected result:** An abbreviated tax invoice is issued for the retail sale.

### View, download or void

- **View / list** invoices (filter by full or abbreviated).
- **Download PDF** — add a copy watermark when issuing a duplicate.
- **Void** an invoice with a reason if it was issued in error.

[screenshot: tax invoice list with full/abbreviated tabs]

---

## 3. e-Tax invoices (electronic submission)

From the tax-invoice detail you can submit electronically:

- **Send by e-Tax email** — for the *e-Tax by Email* scheme (smaller businesses):
  enter the recipient email; a copy is time-stamped by ETDA.
- **Download e-Tax XML** — the standard ETDA UBL 2.1 file. Add `?signed=1` to the
  download to get the **digitally signed** document (XAdES) — provided your signing
  certificate is configured (see below). Without a certificate the unsigned instance
  document is returned, which you can still sign separately before filing.
- **Submit to provider** — `POST /api/tax/etax/submit/{docNo}` builds, signs (if a
  certificate is configured), and transmits the document to your e-Tax service
  provider. Full tax invoices are also submitted automatically when issued.

> **Note:** Submission is idempotent — submitting the same document twice will not
> create duplicates. Check the status (Pending → Accepted / Rejected) afterwards.

### Configuring the digital certificate & provider (administrator)

Set these environment variables (see `.env.example`) so signing and real submission
are active — when unset, the system runs unsigned against the `mock` sandbox:

| Variable | Purpose |
|---|---|
| `ETAX_SIGNING_CERT_PEM` / `_B64` | Your CA-issued certificate (PEM, or base64 for one-line env) |
| `ETAX_SIGNING_KEY_PEM` / `_B64` | The matching private key |
| `ETAX_PROVIDER` | `mock` (default sandbox) or `http` (real service provider) |
| `ETAX_PROVIDER_URL` / `ETAX_PROVIDER_TOKEN` | The SP endpoint + bearer token (for `http`) |

The signature is XAdES (RSA-SHA256) with the signing time and certificate digest
embedded, so any later edit to the document invalidates it (tamper-evident).

---

## 4. Withholding tax (WHT) certificates

**Screen:** `/tax/wht` · **Required permission:** `creditors` / `ar`

When you pay certain suppliers or staff, you withhold tax and issue a certificate.

### To issue a WHT certificate

1. Go to **WHT** (`/tax/wht`).
2. Click **Issue WHT certificate** (**ออกใบ WHT**).
3. Enter the recipient, the gross amount, the **type** (salary, contractor, or
   other) and the rate. The amount withheld is calculated.
4. Save.

**Expected result:** A WHT certificate is created. Download the **PDF** (copies
1/2/3) for the recipient and your filing.

> **Note:** Void a certificate with a reason if it was issued incorrectly.

---

## 5. Tax reports

**Screen:** `/tax/reports` · **Required permission:** `exec` / `ar` / `creditors`

| Report | Tab | What it is |
|--------|-----|-----------|
| **Output VAT** (ภาษีขาย) | Output VAT | Monthly list of VAT charged on sales |
| **Input VAT** (ภาษีซื้อ) | Input VAT | Monthly list of VAT paid on purchases (excludes exempt / zero-rated) |
| **PP30** (ภ.พ.30) | PP30 | The monthly VAT return: net of output − input |
| **PND** (ภ.ง.ด.) | PND | Withholding tax report (PND1 salary, PND3 contractor, PND53 other) |

### To run a report

1. Go to **Tax Reports** (`/tax/reports`) and open the tab you need.
2. Choose the **month** and **year**.
3. View on screen, then **export to PDF** for filing.

**Expected result:** The report lists each document, the tax amounts and the
period totals.

[screenshot: PP30 VAT return summary]

---

## Deferred tax (TAS 12) — control TAX-06

Beyond current VAT/WHT, the system recognises **deferred tax** on book-vs-tax temporary
differences (the AR allowance, accelerated depreciation) at the 20% CIT rate. Run it from
the General Ledger close: `POST /api/ledger/deferred-tax/run` then a **different** user
posts `POST /api/ledger/deferred-tax/{id}/post` (maker-checker) → **Dr 1700 / Cr 5950**
for a deferred tax benefit. Full steps: [General Ledger](./06-general-ledger.md) ▸
*Deferred tax*. Errors: `SELF_POST`, `ALREADY_POSTED`.

---

**Next:** [Payroll](./08-payroll.md) · [General Ledger](./06-general-ledger.md) ·
[Finance — AR & AP](./05-finance-ar-ap.md)
