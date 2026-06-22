# 04 · Warehouse & Inventory

**Status: DRAFT v0.1**

This chapter is for **Warehouse** staff — *WarehouseOperator*, *StockCounter*,
*InventoryController* and *Admin*. It covers viewing stock, managing lots and
expiry, locations / bins, mobile scanning, and cycle counts / stocktakes.

---

## 1. Viewing stock

**Screen:** `/inventory` · **Required permission:** `warehouse` (also `dashboard`
/ `planner` for read access)

1. Go to **Inventory** (`/inventory`).
2. Search for an item, or filter to **low stock**.
3. Click an item to see its detail and stock by location.

**Expected result:** You see current on-hand quantities, low-stock highlights,
and recent movements.

[screenshot: inventory list with low-stock filter]

---

## 2. Locations / bins

**Screen:** `/locations` · **Required permission:** `locations`

1. Go to **Locations** (`/locations`).
2. Click **Create bin** and give it a code and description.
3. View stock held in any bin.

**Expected result:** Bins are available for put-away, picking and counting.

---

## 3. Lots & expiry tracking

**Screen:** `/lots` · **Required permission:** `lots`

1. Go to **Lots** (`/lots`).
2. Review the lot ledger and the **expiry alerts** grouped by urgency
   (0–7 days, 8–30 days, 31+ days).
3. Use the **FEFO** (First-Expiry-First-Out) recommendation to pick the
   soonest-to-expire lot first.

**Expected result:** You can identify and prioritise stock that is nearing
expiry.

> **Note:** FEFO picking helps reduce waste from expired goods. Follow the
> recommended pick sequence where shown.

[screenshot: lots ledger with expiry alert buckets]

---

## 4. Mobile scanning

**Screen:** `/mobile-scan` · **Required permission:** `mobile`

Use a phone or handheld to scan barcodes / QR codes for receiving, issuing,
transferring and counting.

1. Go to **Mobile Scan** (`/mobile-scan`).
2. Start a **scan session** and choose its purpose: Goods Receipt, Issue,
   Transfer or Count.
3. Scan each item / location; lines are added to the session.
4. **Close** the session to finalise it.

**Expected result:** The scanned movements are recorded and stock is updated.

---

## 5. Goods receipt & put-away

**Required permission:** `wh_receive` (held by *WarehouseOperator*)

1. Receive against a PO (see [Procurement](./03-procurement.md)).
2. **Put away** the received stock into its bin location (via `/mobile-scan` or
   the put-away screen), confirming bin and quantity.

**Expected result:** Received stock is placed and available to pick.

---

## 6. Goods issue & transfers

**Required permission:** `wh_custody`

- **Issue** stock out (e.g. for production or write-off): record item, quantity
  and reason.
- **Transfer** stock between locations: choose source and destination bins and
  quantity.

**Expected result:** Stock balances at each location are updated and a movement is
logged.

---

## 7. Cycle counts & stocktake

**Screen:** `/stocktake` · **Required permission:** `wh_count` to enter counts;
`wh_adjust` to post the variance.

> **Note — separation of duties:** The person who **counts** stock
> (`wh_count`, *StockCounter*) is deliberately different from the person who
> **posts the adjustment** (`wh_adjust`, *InventoryController*). This prevents
> someone hiding shrinkage by adjusting their own count (rule R11).

### To run a cycle count

1. Go to **Stocktake** (`/stocktake`).
2. Create a new count and select the items / location to count.
3. Enter the **counted quantity** for each line (you can scan via
   `/mobile-scan`).
4. Save the count.

**Expected result:** A stocktake document is created showing system vs counted
quantities and the variance.

### To post the variance (InventoryController)

1. Open the completed count.
2. Review the variances.
3. Click **Post** to write the adjustment to inventory and the general ledger.

**Expected result:** Stock is corrected and the variance is recorded in the
accounts.

[screenshot: stocktake variance review before posting]

---

## 8. Returns to stock (RMA)

When returned goods come back, receive the RMA and restock saleable items.

1. Open the RMA.
2. **Receive** the returned goods.
3. **Restock** the items that are fit for resale.

**Expected result:** Saleable returns are added back to inventory.

---

**Next:** [Procurement](./03-procurement.md) ·
[Reports & Analytics](./09-reports-and-analytics.md) (forecasting & replenishment)
