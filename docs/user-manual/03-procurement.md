# 03 · Procurement

**Status: DRAFT v0.1**

This chapter is for **Procurement** staff and **Buyers**. It covers the full
buying cycle — purchase requisition (PR) → purchase order (PO) → goods receipt
(GR) → 3-way match — plus managing vendors.

**Main screen:** `/procurement` · **Required permission:** `procurement`

The procurement screen is organised as tabs: **Request** (PR) → **Order** (PO) →
**Receive** (GR).

---

## 1. Raise a purchase requisition (PR)

A PR is an internal *request to buy* before a real order is placed.

**Required permission:** `procurement` (also available to *Planner*)

1. Go to **Procurement** (`/procurement`) → **Request** tab.
2. Click **Create PR** (**สร้างใบขอซื้อ (PR)**).
3. Add the items and quantities you want to buy, and the reason / cost centre.
4. Submit.

**Expected result:** A purchase requisition is created, awaiting approval.

### Approve a PR

1. Open the PR.
2. Click **Approve**.

**Expected result:** The PR is approved and can be turned into a PO.

> **Note:** Depending on configuration, large PRs may route through the
> [approval workflow](./10-approvals.md). You cannot approve a PR you raised
> yourself (`SOD_VIOLATION`).

---

## 2. Create a purchase order (PO)

**Required permission:** `procurement`

1. Go to **Procurement** → **Order** tab.
2. Click **Create PO** (**สร้างใบสั่งซื้อ (PO)**).
3. Select the **vendor**, add items, quantities and agreed prices, and a delivery
   date.
4. Submit.

**Expected result:** A purchase order is created with a PO number.

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

When stock physically arrives, record a goods receipt against the PO.

**Required permission:** `procurement` and/or `warehouse` (warehouse staff
typically receive; see [Warehouse & Inventory](./04-warehouse-inventory.md)).

1. Go to **Procurement** → **Receive** tab.
2. Click **Goods Receipt** (**รับสินค้า (GR)**) and select the PO.
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

> **Note — separation of duties:** The person who **orders** goods should not be
> the one who **pays** the invoice. The system flags this conflict (rule R03/R04).

[screenshot: 3-way match result with variances]

---

## 5. Managing vendors

**Required permission:** `md_vendor` (vendor master) — held by *MasterDataAdmin* /
*Admin*. Buyers can view and score vendors.

- **Screen** the vendor (approve / block) before transacting.
- **Scorecard** — recompute a vendor's performance score (delivery, quality).

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

**Next:** [Warehouse & Inventory](./04-warehouse-inventory.md) ·
[Finance — AR & AP](./05-finance-ar-ap.md) · [Approvals](./10-approvals.md)
