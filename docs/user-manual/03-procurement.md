# 03 · Procurement

**Status: DRAFT v0.1**

This chapter covers the full buying cycle — purchase requisition (PR) → purchase
order (PO) → goods receipt (GR) → 3-way match — plus managing vendors.

**Each step is on its own screen, because each belongs to a different user group.**
This is deliberate separation of duties (the person who *orders* must not also
*receive* or *pay*):

| Step | Screen | Who / required permission |
|---|---|---|
| Raise a requisition (PR) | `/requisitions` | **Anyone in the company** — `pr_raise` |
| Create / approve a PO | `/procurement` | **Procurement** — `procurement` |
| Receive goods (GR) | `/receiving` | **Warehouse** — `wh_receive` |
| 3-way match | `/procurement/match` | **Procurement / Accounting** — `procurement` |
| Scan invoice → PO match (AP intake) | `/procurement/ap-intake` | scan/map: `procurement`/`creditors`; **book the bill**: `creditors` |

> A PR only *requests* a purchase — it commits nothing, so anyone may raise one.
> Turning it into a real order (PO), and confirming receipt (GR), are restricted to
> the procurement and warehouse teams respectively.

---

## 1. Raise a purchase requisition (PR)

A PR is an internal *request to buy* before a real order is placed. Because it
commits nothing, **anyone in the company can raise one** — you don't need to be in
Procurement.

**Screen:** `/requisitions` (**คำขอซื้อ (PR)**, ERP nav → จัดซื้อ) ·
**Required permission:** `pr_raise` (held by every internal staff role; Procurement
and Planner have it automatically)

1. Go to **คำขอซื้อ (PR)** (`/requisitions`).
2. Add the items and quantities you want to buy, and the reason / cost centre.
3. Submit. Your request is sent to Procurement for approval automatically — track
   its status on the **Approvals** screen.

**Expected result:** A purchase requisition is created, awaiting approval.

### Raise a PR from LINE chat

You can also raise a PR by chatting with your shop's **LINE Official Account** —
handy on the floor or in the stockroom. One-time setup first:

**Link your LINE account (once):**

1. On **คำขอซื้อ (PR)** (`/requisitions`), find the card **สร้างคำขอซื้อผ่านแชท LINE**
   and click **สร้างรหัสเชื่อม LINE**. You get a 6-character code (valid **10 minutes**).
2. In the shop's LINE OA chat, type `link <code>` (e.g. `link KM7Q2X`).
3. The bot replies **เชื่อมบัญชีสำเร็จ ✔** — you are linked. A LINE account can be
   linked to only one ERP user; use **ยกเลิกการเชื่อมต่อ LINE** on the same card to unlink.

**Chat commands (after linking):**

| Command | What it does |
|---|---|
| `pr <item> <qty> [reason]` — several items separated by `,` (also `ขอซื้อ …`) | Raises a PR, e.g. `pr A4-PAPER 10 กระดาษหมด, TONER-85A 2` |
| `status <PR no>` (also `สถานะ <PR no>`) | Replies the PR's current approval state |
| `my prs` (also `รายการของฉัน`) | Lists your 5 most recent PRs with statuses |
| `find <keyword>` (also `ค้นหา`) | Searches the item master so you can use real item ids |
| `cancel <PR no>` (also `ยกเลิก`) | Withdraws **your own** still-Pending PR |
| `stock <item id>` (also `สต็อก`) | Read-only on-hand balance by location |
| `approve <PR no>` / `reject <PR no> <reason>` (also `อนุมัติ`/`ปฏิเสธ`) | **Procurement only** — decides a pending PR through the normal approval engine |

**LINE notifications:** if you've linked your account, the system messages you
automatically — approvers get a 🔔 when a PR enters their queue (with the
`approve <PR no>` hint), and the requester gets ✅/❌ when their PR is decided.
No setup beyond linking; if you unlink, the messages stop.

> **Approving from chat is exactly as strict as the web:** you need the
> `procurement` permission, you can never approve a PR you raised yourself
> (`SOD_VIOLATION`), and multi-level chains still require every step.

**One-tap approve (LC-1):** when a PR enters your queue, the LINE card now has
**[อนุมัติ] [ปฏิเสธ]** buttons. Tapping one asks for a **[ยืนยัน]** tap (valid
5 minutes) before anything happens — same permission and self-approval rules
as typing the command. `my prs` also replies as swipeable cards now.

**Expected result:** The bot replies the new PR number (e.g. `PR-20260702-001`).
The PR is **identical** to one raised on the web — same numbering, same status log,
and it enters the same Procurement approval workflow. The chat can only *raise*
requisitions; approval always happens in the ERP (and never by the requester —
`SOD_VIOLATION`).

> **Notes:** you need the same `pr_raise` permission as the web screen (the bot
> refuses otherwise); ordinary chat messages are ignored, so customers talking to
> the OA are unaffected; if the bot answers "ยังไม่ได้เชื่อมบัญชีพนักงาน", generate a
> fresh link code and link again.

### Approve a PR

1. Open the PR.
2. Click **Approve**.

**Expected result:** The PR is approved and can be turned into a PO.

> **Note:** Depending on configuration, large PRs may route through the
> [approval workflow](./10-approvals.md). You cannot approve a PR you raised
> yourself (`SOD_VIOLATION`).

---

## 2. Create a purchase order (PO)

**Screen:** `/procurement` (**ใบสั่งซื้อ (PO)**, ERP nav → จัดซื้อ) ·
**Required permission:** `procurement` (Procurement team only)

1. Go to **ใบสั่งซื้อ (PO)** (`/procurement`).
2. In **Create PO** (**สร้างใบสั่งซื้อ (PO)**), select the **vendor**, add items,
   quantities and agreed prices, and a delivery date.
3. (Optional) Set **currency** (ISO-4217, e.g. `USD`, `JPY`) and **FX rate** against
   THB. Defaults to `THB` / `1.0`. The goods receipt inherits these values automatically
   so every cost flow retains the booked exchange rate.
4. For a **capital purchase** (a fixed asset such as equipment or a vehicle), tick
   **ทุน (capital)** on that line. When received, capital lines are routed to the
   fixed-asset register instead of inventory — see *Register an asset from a goods
   receipt* in `06-general-ledger.md` (control **FA-10**). Items flagged
   **is_fixed_asset** on the item master are treated as capital automatically.
5. Submit.

**Expected result:** A purchase order is created with a PO number.

### Attach the invoice / receipt photo to a PO

Pin the paper evidence to the order so the 3-way match has its documentation in one place.

**From the web:** on **ใบสั่งซื้อ (PO)** (`/procurement`), open the **ไฟล์แนบใบสั่งซื้อ** card,
enter the PO number, and click **แนบรูป/ไฟล์** (photo or PDF, max ~2MB). Anyone who handles the
paper can upload — Procurement (`procurement`), AP (`creditors`), or Receiving (`wh_receive`).
Click a filename to preview. **Deleting** an attachment is restricted to the person who uploaded
it (or an Admin) — it is match evidence.

**From LINE chat (after linking):** type `attach <PO no>` (or `attach <PO no> receipt` for a
receipt), then send the photo within 10 minutes. The bot confirms with the attachment count; the
file appears on the web card immediately.

> If the bot replies "ไม่พบเอกสาร", check the PO number; if it replies about permissions, you need
> one of the three roles above.

### Approve (or cancel) a PO

1. Open the PO.
2. Click **Approve** to authorise it, or **Cancel** to void it.

**Expected result:** Approved POs can be received; cancelled POs are closed.

[screenshot: PO form with vendor and line items]

### Browsing POs & suppliers (lookup lists)

Two read-only lookup screens (under **จัดซื้อ** in the sidebar) help you find
records fast:

- **ใบสั่งซื้อ (PO)** (`/inventory/purchase-orders`) lists recent POs with a
  **summary band** (POs shown · total value · how many are still **awaiting /
  in-progress**), a **search** box (PO number or vendor) and **status filter
  chips**. It's view-only — create / approve POs from **Procurement → Order**.
- **ผู้ขาย (Suppliers)** (`/inventory/suppliers`) lists vendors with a **search**
  (name / code / contact / phone) and a live **count** of matches.

Both reflow to a single column on phones and the tables scroll sideways.

---

## 3. Receive goods (Goods Receipt / GR)

When stock physically arrives, the **warehouse** records a goods receipt against the
PO. This is a warehouse duty kept separate from buying: a Buyer with only the
`procurement` permission **cannot** record a receipt (they'd get a permission error),
so the person who ordered the goods can't also confirm they arrived. (Separation of
duties **R04** — it protects the 3-way match.)

**Screen:** `/receiving` (**รับสินค้า (GR)**, ERP nav → สินค้าคงคลัง) ·
**Required permission:** `wh_receive` (held by warehouse roles; the coarse
`warehouse` permission includes it). See [Warehouse & Inventory](./04-warehouse-inventory.md).

1. Go to **รับสินค้า (GR)** (`/receiving`). The list shows POs awaiting receipt — use
   it to look up the PO number.
2. In **Goods Receipt** (**รับสินค้า (GR)**), enter the PO number.
3. Enter the **quantity received** for each line (it may differ from ordered).
4. Record lot / expiry details if the item is batch-tracked.
5. Submit.

**Expected result:** A GR is created, stock is increased, and the receipt is
available for matching.

> **Note — short / damaged delivery:** Raise a **goods-receipt claim** against
> the supplier under **Claims** (`/claims` → GR Claims tab): enter the GR number,
> item, claim quantity and reason. Resolve or reject it once the supplier
> responds.

---

## 4. Three-way match (PO ↔ GR ↔ Invoice)

Before a supplier invoice can be paid, the system matches three documents:
the **purchase order**, the **goods receipt**, and the **invoice**. This stops
overpayment and fraud.

**Screen:** `/procurement/match` · **Required permission:** `procurement` /
`creditors`

1. Go to **Procurement** → **Match** (`/procurement/match`).
2. Select the supplier invoice (AP transaction).
3. Run the match. The system compares quantity, price and amount against the PO
   and GR, within configured tolerances (default ~2% quantity / price).
4. Review the **match status**: *matched*, *price variance*, *quantity variance*,
   *over-invoiced* or *unmatched*.

**Expected result:** A *matched* invoice becomes payable.

> **Note — payment blocked:** If the match fails, the invoice **cannot be paid**
> and you'll see `MATCH_BLOCKED` when attempting payment. A user with the right
> authority can **override** the failed match with a written reason; only then can
> AP pay it. See [Finance — AR & AP](./05-finance-ar-ap.md).

> **Note — who may override (separation of duties):** The person who **ran the
> match cannot override it** — the override must come from a **different** user with
> approval authority (otherwise you'll see `SOD_VIOLATION`, and this binds even an
> Admin). This stops one clerk from both matching and force-approving their own
> off-tolerance invoice. Re-running the match also **clears** any earlier override.
> (Control **EXP-01**.)

> **Note — separation of duties:** The person who **orders** goods should not be
> the one who **pays** the invoice. The system flags this conflict (rule R03/R04).

### Match worklist — which invoices are blocked

Open the **รายการ / ใบที่ถูกระงับ** tab on the Match screen to see **every** matched
invoice in one list — not just the one you just ran. It shows each invoice's match
result and **payment status** (*payable* / *blocked* / *overridden*), with KPI cards
(total matched · how many are **blocked from payment** · how many were overridden).
Toggle **เฉพาะใบที่ถูกระงับ** to show only invoices held by a variance, or search by
invoice / PO number. Use it to triage what needs investigation or an override before
AP can pay. The list is **store-scoped** (you see only your own).

[screenshot: 3-way match result with variances]

### Scan an invoice and let the system match it (AP intake)

Instead of keying a supplier invoice and running the match by hand, paste the
scanned text of the invoice and let the system do the mapping (control **EXP-10**).

**Screen:** `/procurement/ap-intake` · **Required permission:** `procurement` /
`creditors` to scan and map; **`creditors` only** to book the bill (posting a
payable is an accounting act).

1. Go to **Procurement** → **สแกนใบแจ้งหนี้จับคู่ PO** (`/procurement/ap-intake`).
2. Either **attach the invoice file directly** — press **แนบรูป / PDF** and pick a
   photo (PNG/JPEG/WebP) or a PDF — or paste the invoice text into the box.
   A digital PDF is read from its text layer immediately; a photo/scan is read by
   AI (if AI is not configured, the intake queues for review with the file attached
   so you can map and key it manually). The uploaded file is kept on the intake —
   open it any time from the **เอกสารต้นฉบับ** link on the result card.
3. Choose one of two buttons:
   - **ดึงข้อมูล + จับคู่ PO** — extracts the vendor, tax ID, invoice number, date,
     amount and any **PO number printed on the document**, then auto-maps the PO.
     You review the result before booking.
   - **อัตโนมัติทั้งหมด** — does all of the above **and** books the AP bill and runs
     the 3-way match in one step (needs `creditors`). It only auto-books a document
     whose PO mapping is **unambiguous** and which is **not a duplicate** — anything
     doubtful lands in the review worklist instead, unbooked.
4. If the document had no usable PO reference, the screen shows **scored PO
   candidates** (by vendor + amount). Click one, or type a PO number, to map it —
   then press **บันทึกบิล + จับคู่ 3 ทาง**.
5. Check the result: the intake shows the booked bill number (AP-), the match
   verdict and **พร้อมจ่าย / ระงับ** (payable / blocked).

**Expected result:** a *matched* intake is immediately **payment-ready** — AP can
request payment as usual. Payment itself is **never** automated: it still goes
through request → independent approval (see [Finance — AR & AP](./05-finance-ar-ap.md)).

> **Note — duplicates:** an invoice number that was already scanned or already
> booked is refused with `DUPLICATE_INVOICE` and is never auto-booked. If it is a
> genuine re-bill, an accountant can post it deliberately with the
> *allow duplicate* option (API `allow_duplicate`).

> **Note — invoice arrived before the goods:** the bill books but the match comes
> back *over_invoiced* and payment is **blocked**. You don't need to chase it: the
> scheduled **auto re-match** job (`ap_automatch_rerun` on the report scheduler)
> re-checks every blocked invoice and releases it automatically once the goods
> receipt catches up. (Or a different user can override, per EXP-01.)

> **Note — one PO, one bill:** invoices matched to a PO **consume** its received
> value. A second invoice against an already-fully-invoiced PO is blocked
> (*over_invoiced*) — one PO cannot be paid twice under two invoice numbers.

[screenshot: AP intake — scan, candidates and match verdict]

---

## 5. Managing vendors

**Required permission:** `md_vendor` (vendor master) — held by *MasterDataAdmin* /
*Admin*. Buyers can view and score vendors.

- **Screen** the vendor (approve / block) before transacting.
- **Scorecard** — recompute a vendor's performance score (delivery, quality).

> 🔒 **PII protection:** a vendor's tax ID (เลขผู้เสียภาษี) and bank account are
> **encrypted at rest** (AES-256-GCM) — a database snapshot never contains them in
> the clear. Screens, payment files and the duplicate/ghost-vendor monitor still
> work on the real values for authorized users. (Control ITGC-AC-19.)

### Supplier scorecards register

**Screen:** `/supplier-scorecards` (**คะแนนซัพพลายเออร์**, ERP nav → จัดซื้อ) ·
**Required permission:** `procurement` / `exec`.

To compare suppliers at a glance, open the **Supplier Scorecards** register. It
**ranks every vendor by score** (🏆 on the top performer), with KPI cards (how many
have a scorecard · the **average score** · how many are **underperforming**, below
70) and per-vendor metrics (on-time %, quality %, price-variance %, goods-receipts,
claims). Leave the **งวด (period)** box empty to see each vendor's **latest**
standing, or enter a `YYYY-MM` period to rank that month. Use it to decide which
suppliers to keep, coach, or drop. The list is store-scoped.

> **Note — separation of duties:** Maintaining the **vendor master** is kept
> separate from **paying** vendors (rule R02), to prevent creating a fictitious
> vendor and paying it.

---

## 6. Supplier portal (for your vendors)

This screen is for an external **vendor / supplier user** — they log in and see only
**their own** purchase orders and invoices, never anyone else's.

**Screen:** `/supplier` · **Where:** sidebar → **จัดซื้อ → พอร์ทัลซัพพลายเออร์
(Supplier)** · **Required permission:** `vendor_portal` (grant this to the vendor's
user account; the menu item is hidden from staff who don't have it).

Tabs: **ใบสั่งซื้อ (PO)** · **ใบแจ้งหนี้**.

1. **See & acknowledge a PO** — on the **ใบสั่งซื้อ (PO)** tab the vendor sees the
   POs you issued to them. Click a PO to view its lines and press **ยืนยันรับทราบ
   PO** to acknowledge it.
2. **Submit an invoice** — on the **ใบแจ้งหนี้** tab the vendor enters the invoice
   number, amount and VAT (optionally referencing a PO) and submits it. This creates
   a **pending (Unpaid) AP transaction** that your AP clerk then **3-way matches and
   pays** through the normal AP flow — the vendor cannot pay themselves.

**Expected result:** Vendors self-serve PO acknowledgement and invoice submission;
buyers keep full control of matching and payment (EXP-01..04 unchanged).

---

### Multi-currency purchasing (C1)

POs can be issued in any ISO-4217 currency (`currency` field, default `THB`) with the
exchange rate booked at the time of order (`fx_rate`, default `1.0`). The goods receipt
automatically inherits the PO's currency and rate so the cost basis is preserved for
inventory valuation and the AP 3-way match.

The vendor statement (`GET /api/finance/ap/statement`) reports in the requested currency
and uses ISO-4217-aware rounding — 0 decimal places for JPY, 2 for THB/USD/EUR/GBP/SGD.

---

**Next:** [Warehouse & Inventory](./04-warehouse-inventory.md) ·
[Finance — AR & AP](./05-finance-ar-ap.md) · [Approvals](./10-approvals.md)
