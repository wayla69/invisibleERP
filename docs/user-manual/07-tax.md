# 07 · Tax

**Status: DRAFT v0.7 · 2026-07-11** · *v0.7 (2026-07-11): **Income-Tax Provision + ETR reconciliation** (`/tax/provision`, control **TAX-11**) — computes the **current** income-tax provision (pretax book income → permanent + temporary adjustments → taxable income → current CIT @ statutory rate) with the effective-tax-rate reconciliation, reusing the deferred-tax (TAX-06) temporary difference; maker-checker post **Dr 5960 / Cr 2110** (`SOD_SELF_APPROVAL`, `ALREADY_POSTED`).* · *v0.6 (2026-07-10): **bulk actions on the tax-invoice register** (`/tax/invoices`) — multi-select checkboxes with **Download selected PDFs**, **Email selected (e-Tax)** (one recipient applied to all), and batch **Approve** for PendingApproval notes; each loops the existing per-row endpoint so per-document controls (note maker-checker, e-Tax email logging) are unchanged. UI-only, no new endpoint or control.* · *v0.5 (2026-07-10): **convert an abbreviated slip to a full tax invoice** (ม.86/4 on buyer request) — new card on `/tax/invoices`; buyer Tax ID required + validated, amounts copied from the slip (never recomputed), one full invoice per slip (control **TAX-10**).* · *v0.4 (2026-07-09): RD e-Filing downloads — ภ.ง.ด.3/53 ใบแนบ .txt on the filings tab + CSV working papers (ภาษีขาย/ภาษีซื้อ/ภ.พ.30) on each report tab; purchase-VAT CSV carries filing-readiness notes.* · *v0.3 (2026-07-06): documented **where the G16 voided-tax-invoice exception report is surfaced in the app**: a read-only **"Voided tax invoices"** review card on the **Pending Approvals** screen (`/approvals`) for periodic independent review. UI surfacing of an already-shipped report — no new endpoint, no new numbered control.* · *v0.2 (2026-07-06): added the **voided-tax-invoice exception report** (`GET /api/tax-invoices/exceptions/voided`, `exec`/`ar`/`fin_report`, optional `from`/`to` on issue date) — a detective control for periodic review of invoice voids (gap **G16**); the void itself stays single-user (RD requirement, numbers never reused). No new numbered control.*

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
3. Choose the source type (AR invoice or POS sale) and pick the document from the
   **dropdown of recent sales / AR invoices** (choose **พิมพ์เลขเอกสารเอง…** for an older
   document or if your role cannot read that list), then enter the **buyer's** name,
   tax ID and address. **Typing a name you've billed before shows a dropdown**
   of matching customers (with their tax ID/address) — pick one to fill in the
   whole buyer block instead of retyping it. A brand-new buyer is saved
   automatically once the invoice is issued, so it's searchable next time; a
   repeat buyer's address is kept up to date with whatever you enter.
4. Optionally set a **payment due date** and **paid by** (transfer / cash /
   cheque / other) — for a **POS** sale this is pre-filled from the sale's own
   payment method if you leave it blank; for an **AR** invoice you set it
   explicitly (or leave it blank if the invoice isn't paid yet). Choosing
   transfer or cheque shows bank/cheque-no/branch fields.
5. Confirm. VAT at 7% is calculated automatically.

**Expected result:** A sequentially-numbered tax invoice is created (numbers are
never reused). The printed PDF is a combined ใบเสร็จรับเงิน/ใบกำกับภาษี layout —
seller Tel/Fax, buyer details + due date, the item table, VAT-separated
totals, and a **"ชำระเงินโดย (Paid By)"** section showing the recorded payment
method (or blank checkboxes if none was recorded).

### Issue an abbreviated tax invoice (from a POS sale)

1. Go to the **Abbreviated** tab.
2. Select the POS sale and issue — no buyer details are required.

**Expected result:** An abbreviated tax invoice is issued for the retail sale.

### Convert an abbreviated slip into a full tax invoice (ม.86/4 on buyer request)

A VAT-registered customer may ask the counter to turn their abbreviated slip into a **full tax invoice**
so they can claim the input VAT. Do **not** re-key the sale or issue a new invoice by hand — use the
conversion, which copies the slip's amounts exactly and keeps the VAT counted once.

**Screen:** `/tax/invoices` → the **แปลงใบกำกับอย่างย่อเป็นเต็มรูป (ม.86/4)** card ·
**Required permission:** `cust_pos` / `pos` / `ar` (the same people who issue tax documents).

1. Pick the customer's **abbreviated invoice (ATV-…)** from the dropdown (or type the number from the slip).
2. Enter the buyer's details: **name**, **13-digit Tax ID** (required — it is checksum-validated),
   **branch code** (5 digits; leave blank for `00000` = สำนักงานใหญ่) and **address**.
3. Press **ออกใบกำกับภาษีเต็มรูป**, then open the **PDF** to print/hand over.

**Expected result:** a full tax invoice (`TIV-…`) is issued with the **same value, VAT and lines as the
slip** (nothing is recomputed) and the same issue date; the slip flips to status **Replaced** (its number
is kept — never reused) and the ภ.พ.30 sales-VAT report now shows the full invoice **instead of** the slip,
so the sale is counted **once**.

> **One full invoice per slip (control TAX-10).** Converting the same slip again returns the **same** full
> invoice — a second document is never created (enforced in the database). A **voided** slip cannot be
> converted (`ABB_VOIDED`), only an abbreviated invoice can (`NOT_ABBREVIATED` otherwise), and a wrong
> buyer Tax ID is rejected (`INVALID_BUYER_TAXID`). Every conversion is written to the tamper-evident
> audit log with both document numbers and the buyer's Tax ID.

### View, download or void

- **View / list** invoices (filter by full or abbreviated).
- **Download PDF** — add a copy watermark when issuing a duplicate.
- **Void** an invoice with a reason if it was issued in error. The voided number is **kept and never
  reused** (a Revenue Department requirement — the sequence stays gapless), so a single user may void; to
  change the **value** of a sale, issue a **credit / debit note** instead (dual-controlled — see §2 below).

**Bulk actions (multi-select).** Each row in the register has a **checkbox**; tick several documents (or
**เลือกทั้งหมด / Select all**) to reveal a small action bar above the list:

- **ดาวน์โหลด PDF ที่เลือก / Download selected PDFs** — saves each selected document's PDF in turn (one file
  per document), then reports how many succeeded and how many failed.
- **ส่งอีเมล (e-Tax) ที่เลือก / Email selected (e-Tax)** — opens the same e-Tax email dialog; enter **one**
  recipient email and it is sent to every selected document (see §3). A summary reports successes/failures.
- **อนุมัติ N รายการ / Approve N** — appears only when the selection includes credit/debit notes that are
  **PendingApproval**; it approves just those notes. Each note still fires its own approval endpoint, so the
  maker-checker rule (approver ≠ the person who raised the note) is enforced per note exactly as one-by-one.

Bulk actions are a convenience only — they loop each document's existing per-row endpoint and add no new
authority; a per-document failure (e.g. a self-approval block) fails only that document, not the batch.

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
2. Pick the **original tax invoice** from the dropdown of issued full tax invoices
   (buyer + amount shown; choose **พิมพ์เลขเอกสารเอง…** for an older number), the **reason** (required — ม.86/10(4)), the
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

> **Tip — the pluggable e-Invoicing screen (`/einvoice`):** its **doc-no** field is a
> dropdown of your issued tax invoices — picking one also pre-fills the total (choose
> **พิมพ์เลขเอกสารเอง…** to key another reference). The **POS fiscal screen's e-Tax submit box**
> (`/pos-fiscal`) offers the same issued-invoice dropdown.
>
> **What the status means.** A **real** provider (RD / MyInvois / Peppol) **prepares** the
> document and marks it **`pending`** — the file is built and hashed but **not actually
> transmitted** until your administrator wires that provider's live transport (authority
> credentials + endpoint). It is **never** shown as *accepted* until a genuine acknowledgement
> comes back. The **`stub`** provider is a **sandbox** for testing only — it shows
> *accepted (sandbox)*, which is **not** a real filing. So a `pending` row is expected until the
> live provider is configured; it does not mean the submission failed.

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
1/2/3) for the recipient and your filing. The printed layout follows the
Revenue Department's official 50-ทวิ template — boxed 13-digit Tax IDs for the
payer/payee, all 7 ภ.ง.ด. checkboxes, and the 6-row income table (with row 4
split into (ก) ดอกเบี้ย / (ข) เงินปันผล).

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

### Download the RD e-Filing files (ไฟล์สำหรับยื่นสรรพากร)

On **ภาษี › รายงานภาษี** (`/tax/reports`):

- Each report tab (ภาษีขาย / ภาษีซื้อ / ภ.พ.30) has a **ดาวน์โหลด CSV** button next to the PDF —
  a UTF-8 CSV that opens correctly in Excel, used as the working paper filed alongside the online
  ภ.พ.30 form. The purchase-VAT CSV marks rows that are **not filable as-is** (missing supplier Tax ID,
  estimated VAT) in the หมายเหตุ column — clear these before filing.
- On the **การยื่นแบบ & ปฏิทิน** tab, every ภ.ง.ด.3/53 period row has **ไฟล์แนบยื่น (.txt)** — the
  pipe-delimited attachment file for the RD e-Filing transfer program (TIS-620 encoding, Buddhist-Era
  dates, one row per certificate line, เงื่อนไข code 1/2/3).

> ⚠️ Before your first live filing, upload one test month into the RD program and verify the column
> mapping — the RD revises its transfer-program format periodically.

---

## 5. Tax reports

**Screen:** `/tax/reports` · **Required permission:** `exec` / `ar` / `creditors`

| Report | Tab | What it is |
|--------|-----|-----------|
| **Output VAT** (ภาษีขาย) | Output VAT | Monthly list of VAT charged on sales |
| **Input VAT** (ภาษีซื้อ) | Input VAT | Monthly list of VAT paid on purchases (excludes exempt / zero-rated) |
| **PP30** (ภ.พ.30) | PP30 | The monthly VAT return: net of output − input |
| **PP36** (ภ.พ.36) | PP36 | Self-assessed VAT on **imported services** (reverse charge, ม.83/6) |
| **PND** (ภ.ง.ด.) | PND | Withholding tax report (PND1 salary, PND3 contractor, PND53 other) |
| **PT40** (ภ.ธ.40) | *(API + filing register)* | Specific Business Tax on commercial real-estate sales (ม.91/2(6)) — see below |

### To run a report

1. Go to **Tax Reports** (`/tax/reports`) and open the tab you need.
2. Choose the **month** and **year**.
3. View on screen, then **export to PDF** for filing.

**Expected result:** The report lists each document, the tax amounts and the
period totals.

### Imported services — ภ.พ.36 (reverse charge, ม.83/6)

When you pay a **foreign / non-VAT-registered supplier for a service** (e.g. an
overseas SaaS subscription, a foreign consultant), the supplier's invoice has **no
Thai VAT** — but the law requires **you** to self-assess 7% VAT and remit it to the
Revenue Department on form **ภ.พ.36** by the **7th of the following month**. You may
then claim that amount as input VAT.

1. When you record the bill (**Finance → AP → New bill**), tick **"บริการนำเข้า / reverse charge (ภ.พ.36)"**.
   The bill is booked at its net value (no VAT is added to what you owe the supplier),
   and the system accrues the 7% you owe the RD to a dedicated account (2120).
2. At month-end, open the **PP36** tab, choose the period, and review the list of
   imported-service bills and the VAT to remit. The report shows a **reconciliation tie**
   to the GL so you can confirm the figure before filing.
3. **File it** from the Filing register (like ภ.พ.30) — it appears on the **remittance
   calendar** with its 7th-of-next-month deadline.

> **Control (TAX-08):** a reverse-charge bill claims **no** vendor VAT on ภ.พ.30 (there
> is none); the self-assessed 7% is what you report on ภ.พ.36. If you do **not** tick the
> box, the bill is treated as an ordinary domestic purchase.

### Real-estate sales — ภ.ธ.40 (Specific Business Tax, ม.91/2(6))

Selling immovable property **in a commercial manner** (the real-estate developer module) is subject to
**SBT at 3.3%** (3% + 10% local tax) **instead of VAT**, filed on **ภ.ธ.40 by the 15th** of the following month.

1. **Enable it per project**: set `sbt_rate` (e.g. `3.3`) when creating the development
   (`POST /api/realestate/developments`). Projects without a rate accrue nothing — existing books are
   untouched until you opt in.
2. At **ownership transfer**, the system accrues the SBT automatically in the same journal entry as the
   revenue recognition (expense 5840 / payable 2130) and stamps the contract.
3. At month-end, run **`GET /api/tax-reports/pt40`** for the period — it lists the transfers, totals the SBT
   to remit, and shows a **reconciliation tie** to the GL. File it from the Filing register (type `PT40`);
   it appears on the remittance calendar with its 15th deadline.

> **Control (TAX-09):** the ภ.ธ.40 figure must tie to GL account 2130 before filing — an untied amount means
> a manual entry touched the SBT payable outside the transfer process. Government transfer/land-office fees
> are not part of SBT and are handled separately.

[screenshot: PP30 VAT return summary]

---

## Deferred tax (TAS 12) — control TAX-06

Beyond current VAT/WHT, the system recognises **deferred tax** on book-vs-tax temporary
differences (the AR allowance, accelerated depreciation) at the 20% CIT rate. Run it from
the General Ledger close: `POST /api/ledger/deferred-tax/run` then a **different** user
posts `POST /api/ledger/deferred-tax/{id}/post` (maker-checker) → **Dr 1700 / Cr 5950**
for a deferred tax benefit. Full steps: [General Ledger](./06-general-ledger.md) ▸
*Deferred tax*. Errors: `SELF_POST`, `ALREADY_POSTED`.

## DTA valuation allowance & Uncertain Tax Positions (ASC 740) — control TAX-12

Two ASC 740 year-end/quarterly disclosures that sit on top of deferred tax. Open **Tax ▸
ค่าเผื่อภาษี & สถานะภาษีไม่แน่นอน** (`/tax/utp`, needs `gl_close`, `gl_post` or `exec`). Two tabs:

**Valuation allowance (ค่าเผื่อการด้อยค่า DTA).** Assess how much of the gross deferred tax
asset is *more likely than not* (MLTN) to be realised against future taxable income. On the
first tab enter the **period**, the **MLTN-recoverable amount**, and optionally an explicit
**gross DTA** (leave it blank to pull the latest figure from the deferred-tax run) and a
rationale, then press **คำนวณค่าเผื่อ**. The system stages an **Open** row with
**allowance = max(0, gross DTA − MLTN-recoverable)**. A **different** user then presses
**โพสต์** on the row (maker-checker) — the *change* vs the prior posted allowance posts to the
GL: an increase is a charge **Dr 5950 / Cr 1700**, a release reverses it, so the net DTA on the
balance sheet is only the recoverable portion. Errors: `SELF_POST` (poster ≠ runner),
`ALREADY_POSTED`, `INVALID_MLTN` / `INVALID_DTA` (negatives).

**Uncertain Tax Positions — FIN 48 (สถานะภาษีที่ไม่แน่นอน).** A register of tax positions whose
treatment might not be sustained on examination (e.g. transfer-pricing adjustments). On the
second tab enter the **tax year**, a **description**, the **gross exposure**, the **recognized
benefit** (the MLTN-sustainable amount) and any **interest/penalty**, then **บันทึกสถานะ**. The
**reserve** (unrecognized benefit) = gross exposure − recognized benefit is a **disclosure only**
(no GL posting). When a position is resolved a **different** user presses **ยุติ** (Settled) or
**พ้นอายุ** (Lapsed) — maker-checker. The register totals show gross exposure, recognized benefit
and the **open** reserve (settled/lapsed positions drop out). Errors: `BENEFIT_EXCEEDS_EXPOSURE`
(recognized > gross), `SELF_SETTLE` (settler ≠ creator), `NOT_OPEN`.
## Income-tax provision + ETR reconciliation — control TAX-11

Where deferred tax (above) is the *deferred* side, the **Income-Tax Provision** screen computes
the **current** side of the income-tax provision — the bridge from **pretax book income** to
**taxable income** to **current CIT payable** — plus the **effective-tax-rate (ETR)
reconciliation**. Open it at **Tax ▸ ประมาณการภาษีเงินได้** (`/tax/provision`), permissions
`gl_close` / `gl_post` / `exec`.

**To run a provision** (tab *คำนวณงวดใหม่*):
1. Enter the **period** (`YYYY-MM`), optionally the P&L **from/to** dates and the **statutory
   rate** (defaults to **20%** Thai CIT).
2. Add any **permanent differences** (M-1 items) — a **positive** amount is an add-back
   (non-deductible expense), a **negative** amount is a deduction (tax-exempt income).
3. Press **คำนวณ**. The screen reads pretax book income from the income statement (income-tax
   postings are excluded so the base is genuinely pre-tax), **reuses the temporary difference
   from the matching deferred-tax run (TAX-06)** — you never key it twice — and shows the
   **book → taxable-income bridge**, the **current CIT**, and the **ETR schedule** (statutory →
   permanent differences → rate changes → valuation allowance → prior deferred → effective rate).

**To post it** (tab *ทบทวน & โพสต์*): a **different** user presses **โพสต์เข้า GL** — maker-checker,
the runner cannot post their own provision. Posting books the current tax **Dr 5960 Corporate
Income Tax Expense (current) / Cr 2110 CIT Payable** through the period-lock gate (the deferred
leg is posted separately by the deferred-tax screen). Errors: `SOD_SELF_APPROVAL` (self-post),
`ALREADY_POSTED` (re-post).

---

**Next:** [Payroll](./08-payroll.md) · [General Ledger](./06-general-ledger.md) ·
[Finance — AR & AP](./05-finance-ar-ap.md)
