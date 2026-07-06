# 07 · Tax

**Status: DRAFT v0.3 · 2026-07-06** · *v0.3 (2026-07-06): documented **where the G16 voided-tax-invoice exception report is surfaced in the app**: a read-only **"Voided tax invoices"** review card on the **Pending Approvals** screen (`/approvals`) for periodic independent review. UI surfacing of an already-shipped report — no new endpoint, no new numbered control.* · *v0.2 (2026-07-06): added the **voided-tax-invoice exception report** (`GET /api/tax-invoices/exceptions/voided`, `exec`/`ar`/`fin_report`, optional `from`/`to` on issue date) — a detective control for periodic review of invoice voids (gap **G16**); the void itself stays single-user (RD requirement, numbers never reused). No new numbered control.*

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
- **Tax codes (advanced).** If you set up **รหัสภาษี (Tax Codes)** at
  *Settings → Master data* (`/setup/tax-codes`) with their own rate and GL
  accounts, those drive posting: a purchase bill can carry a **tax code** so its
  input VAT posts to that code's account, and a sale's output VAT follows the
  **VAT code on the item** (or its category). The **ภ.พ.30 report reconciles
  across all your VAT accounts**, so the tie to the ledger stays exact even when
  you route VAT to your own accounts. Leave tax codes unset and everything uses
  the standard 7% → single VAT-payable account, exactly as before.

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
- **Void** an invoice with a reason if it was issued in error. The voided number is **kept and never
  reused** (a Revenue Department requirement — the sequence stays gapless), so a single user may void; to
  change the **value** of a sale, issue a **credit / debit note** instead (dual-controlled — see §2 below).

[screenshot: tax invoice list with full/abbreviated tabs]

> **Reviewing voided invoices (exception report).** Because a void is a single-user action, an independent
> reviewer should periodically check void activity. The **voided-tax-invoice exception report**
> (`GET /api/tax-invoices/exceptions/voided`, permission `exec` / `ar` / `fin_report`) lists **every voided
> tax invoice** for a chosen window (add optional `from`/`to` on the **issue date**) — doc number, type,
> issue date, source, grand total, void **reason** and who created it — with a count and total. It is
> read-only and company-scoped. This is the recommended **detective** control for invoice voids (gap **G16**).
>
> **Where to find it in the app.** This report is surfaced as a read-only **"Voided tax invoices"**
> review card on the **Pending Approvals** screen (`/approvals`), where a reviewer independent of the
> person who voids invoices scans it periodically. Nothing is approved from the card — it is review-only.

> **Branding the full tax invoice.** The **full tax invoice (ใบกำกับภาษีเต็มรูป)** PDF now uses your
> company's active **document template** — set it up in **Settings → Document templates** (choose
> *ใบกำกับภาษีเต็มรูป*). You can adjust the accent colour, logo, an extra header note, footer terms,
> the signature captions, and whether the amount-in-words line prints. This is **presentation only** —
> for legal (ม.86/4) reasons the seller name, address and Tax ID **always print** even if you switch
> those toggles off, and the "ใบกำกับภาษี" heading, VAT line and total can never be hidden or changed.
> If no template is set, the standard brand layout is used. See *Platform customization → Document
> templates* (`12-platform-customization.md`).

> **Branding the abbreviated slip.** The **abbreviated tax invoice (ใบกำกับภาษีอย่างย่อ, ม.86/6)** is an
> 80mm thermal slip, so its template exposes only the two things that make sense on receipt paper: a
> **header note** (a slogan/branch line under your shop name) and **footer notes** (a bottom line + extra
> lines). Choose *ใบกำกับภาษีอย่างย่อ* in **Settings → Document templates** — the live preview shows the
> real slip. The seller name/Tax ID, the "ใบกำกับภาษีอย่างย่อ" title and the VAT-inclusive total always
> print (ม.86/6); accent colour, logo and signatures don't apply to a thermal slip.

### Issue a credit note / debit note (ใบลดหนี้ ม.86/10 / ใบเพิ่มหนี้ ม.86/9)

When a sale changes **after** its tax invoice was issued, adjust it with a note — never by editing or
re-issuing the original invoice.

- **ใบลดหนี้ (credit note)** reduces the sale + output VAT — returned goods, a price reduction, a defect, or
  a discount given after the sale.
- **ใบเพิ่มหนี้ (debit note)** increases it — an undercharge or extra goods delivered.

**Screen:** `/tax/invoices` → the **ออกใบลดหนี้ / ใบเพิ่มหนี้** card · **Required permission:** `ar` / `pos`.

1. Pick **ใบลดหนี้** or **ใบเพิ่มหนี้**.
2. Enter the **original tax invoice number** it references, the **reason** (required — ม.86/10(4)), the
   **adjustment value** (before VAT) and an optional line description.
3. Press **ออกเอกสาร (รออนุมัติ)**.

**Expected result:** a `CN-…` / `DN-…` document is issued with status **รออนุมัติ (PendingApproval)** and a
**Draft** GL entry — it does **not** yet affect output VAT or the ledger.

> **Maker-checker (control TAX-07).** A **different** person (finance — `approvals`/`gl_close`/`exec`) must
> press **อนุมัติ** on the note row. Approval posts the GL reversal (credit note: Dr revenue + Dr output VAT
> / Cr AR; debit note: the reverse) **and** flips the note to **Issued**, at which point it appears on the
> **ภ.พ.30** output-VAT report — a credit note **reduces** output VAT, a debit note **increases** it — in the
> note's issue month. The issuer **cannot** approve their own note (*ผู้ออกเอกสารอนุมัติเองไม่ได้*). A credit
> note cannot exceed the original invoice value. Print the note (ม.86/10 form) from the **PDF** action.

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

### Auto-issue certificates for withheld payments (scheduled)

When you pay a vendor for **labour or a service** and withhold tax at payment
(ค่าจ้างทำของ / ค่าบริการ), the system can **issue the 50-ทวิ certificate for you**
instead of keying each one by hand. Schedule the job **ออกหนังสือรับรองหัก ณ ที่จ่าย
(50 ทวิ) อัตโนมัติ** (`tax_wht_cert_batch`) from *Reports → scheduled reports* (or run it
on demand). Each run finds every withheld AP payment in the period that doesn't yet have a
certificate and issues one, linked to the payment. It is safe to re-run — a payment that
already has a certificate is skipped (no duplicates). A vendor without a valid 13-digit tax
ID is skipped and reported, so you can fix the vendor record and re-run.

Two companion jobs help you file on time: **จัดทำแบบ ภ.พ.30 / ภ.ง.ด.3/53 (ฉบับร่าง)**
(`tax_pp30_draft` / `tax_pnd_draft`) prepare the period's return as a **draft** (you still
review and submit), and **แจ้งเตือนกำหนดนำส่งภาษี** (`tax_remittance_reminder`) sends the
amounts due and the deadlines (ภ.พ.30 by the 15th, ภ.ง.ด. by the 7th).

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
