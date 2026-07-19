# 04 · Warehouse & Inventory

**Status: DRAFT v0.1**

This chapter is for **Warehouse** staff — *WarehouseOperator*, *StockCounter*,
*InventoryController* and *Admin*. It covers viewing stock, managing lots and
expiry, locations / bins, mobile scanning, and cycle counts / stocktakes.

---

## 1. Viewing stock

**Screen:** `/inventory` · **Required permission:** `warehouse` (also `dashboard`
/ `planner` for read access)

> **Goods vs. service items (universal POS).** On the item setup screen
> (`/setup/items`) an item can be marked **ประเภทอุปทาน (supply type)** = *goods*
> (the default — a stocked product) or *service* (a haircut, a consultation, a
> service fee). A **service item is not stocked**: selling it at the POS records
> the sale and the revenue but **does not reduce inventory** and posts **no cost
> of goods** — its revenue books to the service-revenue account. A regular
> **goods** item is unchanged (selling it reduces stock as before).

> **Variants / matrix items (size × color).** On `/setup/items`, load an item and
> use the **ตัวเลือกสินค้า (Variants)** panel to generate a matrix: type the axes
> (e.g. *Size* = `S, M, L` and *Color* = `Red, Blue`) and press **สร้างตัวเลือก
> (Generate)**. Each combination becomes its **own product** (`PARENT-S-RED`, …)
> with its own barcode, price and stock — so you can **scan a specific size/color
> barcode** at the till and count it separately. Re-generating after adding a new
> colour only creates the new cells (nothing is duplicated).

> **Kits / bundles (sell one, deduct many).** On `/setup/items`, load the bundle
> item (e.g. a gift set) and use the **ชุดสินค้า / ส่วนประกอบ (Kit / bundle
> components)** panel to list what it contains: enter each **component item ID**
> and its **quantity per kit**, then **เพิ่ม (Add)**. Selling the bundle at the
> POS charges the **bundle's own price** as one line, but **reduces the stock of
> each component** (and books their cost of goods) — the bundle item itself is not
> stocked. Selling two bundles deducts twice the components, and so on. An item
> with **no** components listed sells normally (its own stock is reduced).

> **Non-inventory items (fees & charges).** Mark an item's **supply type** as
> *non-inventory* for a line that isn't a physical product — a **delivery fee**,
> **gift-wrap** or a **printed-on-demand** charge. It sells and posts revenue like
> a normal sale line but **moves no stock and books no cost of goods** (its
> revenue books to the sales-revenue account, not the service account).

1. Go to **Inventory** (`/inventory`).
2. Search for an item (**ค้นหา** by Item ID or name — typing is debounced, and the
   list stays on screen while it refreshes), or toggle **เฉพาะสต๊อกต่ำ** to show
   only low stock.
3. Click an item to see its detail and stock by location.

A **summary band** sits above the list: the data **snapshot date**, the **total
item count**, the **low-stock** count, and a **หมดอายุ / ใกล้หมด (≤30 วัน)** count
(expired or expiring within 30 days, among the rows shown). In the table, an
on-hand of **0 or less** shows in red, an **expired** date shows in red and an
**expiring-soon** date in amber. On a phone the band stacks and the table scrolls
sideways.

**Expected result:** You see current on-hand quantities, low-stock highlights,
near-expiry flags, and recent movements.

[screenshot: inventory list with summary band, search and low-stock filter]

---

## 2. Locations / bins

**Screen:** `/locations` · **Required permission:** `locations`

1. Go to **Locations** (`/locations`).
2. Click **Create bin** and give it a code and description.
3. View stock held in any bin.

**Expected result:** Bins are available for put-away, picking and counting.

### Bin capacity, layout & the 3D warehouse view

**Screen:** `/wms` → tabs **ช่องเก็บ (Bins)** and **ผังคลัง 3D** · **Required permission:** `warehouse` / `locations`

Give each bin a **capacity** (max units) and a **position** (X = aisle, Y = depth, Z = shelf
level) when you create it on the **Bins** tab, or adjust it later. Capacity drives two things:

- **Over-fill protection (control INV-08):** a put-away that would push a bin past its capacity
  is **rejected** (`เกินความจุของช่องเก็บ`, `BIN_CAPACITY_EXCEEDED`) and nothing is stored — so
  stock never silently overflows into an unrecorded spot. Bins left without a capacity are
  unlimited (unchanged behaviour).
- **The 3D view (`ผังคลัง 3D` tab):** the warehouse is drawn as a 3-D model — each bin is a box at
  its X/Y/Z position, **coloured by how full it is** (green = empty → red = full; grey = no
  capacity set; **over-capacity bins show red**). Drag to orbit, scroll to zoom, **click a bin** to
  see what's inside.

**Find where a product is:** on the **ผังคลัง 3D** tab type an **Item ID** in *ค้นหาตำแหน่งสินค้า* and
press **ค้นหา** — every bin holding it is **highlighted in purple** with the quantity, and the panel
shows the total on hand across bins.

**Expected result:** the warehouse layout is visible at a glance, full bins stand out, and any item
can be located to its exact bin(s).

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

### Lot recall / genealogy trace & lot hold (control INV-18)

**Screen:** `/lots` → **สืบย้อน / ระงับล็อต (Trace / Hold)** tab
· **Required permission:** trace `lots` / `warehouse`; hold & release `lots` / `warehouse` / `wh_adjust`

Use this when a supplier issues a recall, a lot is suspected of a quality
problem, or you need to know exactly where a batch came from and where it went.

1. Open the **Trace / Hold** tab and enter a **lot number**.
2. The trace shows the lot's two-way **genealogy**:
   - **Backward** — the **goods receipt(s)** the lot arrived on, the **PO**, and
     the **supplier** (so a recall can be scoped back to its source).
   - **Forward** — the **issue/pick documents** and the **sales / customers** the
     lot was shipped into (so you know who received the affected batch).
3. To **quarantine** a suspect/recalled lot, type a reason and click
   **ระงับล็อต (Hold lot)**. The lot is immediately marked **On hold** and is
   **excluded from picking** — it will no longer be suggested by FEFO and the WMS
   wave will not allocate it, so recalled stock cannot be picked, shipped or sold.
4. When the lot is cleared, click **ปลดระงับ (Release)** with a reason to return
   it to normal picking. The hold/release history is retained for audit.

**Expected result:** A held lot never appears in a FEFO suggestion or a WMS pick;
releasing it makes it pickable again. Trace gives the full source→destination
genealogy for recall evidence.

> **Control note (INV-18):** the hold IS the block — there is no separate step to
> stop picking. Only a user with the inventory-control duty can hold or release a
> lot; anyone with `lots`/`warehouse` can run the trace.

**Error messages:**

- **LOT_NOT_HELD** — you tried to release a lot that is not currently on hold.
- **LOT_NOT_FOUND** — the lot number has no ledger records (check for typos).

---

## 4. Mobile scanning

**Screen:** `/mobile-scan` · **Required permission:** `mobile`

Use a phone or handheld to scan barcodes / QR codes for receiving, issuing,
transferring and counting.

1. Go to **Mobile Scan** (`/mobile-scan`).
2. Start a **scan session** and choose its purpose: Goods Receipt, Issue,
   Transfer or Count.
3. Scan each item / location; lines are added to the session. You can capture a
   tag three ways off the same label:
   - **Camera scan** — tap **สแกน QR / Scan QR** (the camera button next to the
     scan box) and point your phone/tablet at the label. Works on **any modern
     browser with a camera** (Chrome, Edge, Safari/iPhone, Firefox, Android) — it
     uses the device's built-in scanner where available and otherwise a built-in
     fallback, so no app install is needed. It reads **both QR codes and common 1D
     barcodes** (EAN/UPC, Code-128, Code-39, ITF), so an existing product barcode
     scans too, not just our printed QR tags. On a successful read you get a short
     **beep + vibrate**; if your phone has a camera light, a **torch** button
     appears to toggle it for dim aisles, and on cameras that support it a **zoom
     slider** (bottom-left of the preview) helps resolve small or far-away labels —
     the scanner also automatically retries at full camera resolution when a code
     isn't found after a moment. In a scan session the camera stays open
     for **continuous scanning** — rattle through many items, each added
     automatically — with a running count and a **Done** button to close.
   - **Hardware scanner** — a USB/Bluetooth wedge scanner types the code into the
     scan box automatically.
   - **Manual** — type or paste the code.
4. **Close** the session to finalise it.

The same camera-scan button is available on the **Stocktake** (`/stocktake`) and
**Goods Issue / Transfer** (`/goods-issue`) scan boxes (single-scan there — it
fills the item field for you to confirm the quantity).

**Expected result:** The scanned movements are recorded and stock is updated.

> **Print QR labels** for items from **Master Data → QR labels** (an A4 label
> sheet). If your deployment sets a public web address, a label also works with a
> phone's **native camera** — scanning it opens a resolver page (`/q`) that shows
> the item and links into the app. Otherwise use the in-app camera scanner above.

---

## 5. Goods receipt & put-away

**Required permission:** `wh_receive` (held by *WarehouseOperator*)

1. Receive against a PO (see [Procurement](./03-procurement.md)).
2. **Put away** the received stock into its bin location (via `/mobile-scan` or
   the put-away screen), confirming bin and quantity.

**Expected result:** Received stock is placed and available to pick.

**Outbound: wave → pick → pack → ship.** On `/wms`:
1. **Wave** batches one or more orders into pick lists.
2. **Pick** — open the **หยิบ (Pick)** tab, choose a pick list still to be picked, and
   confirm the counted quantity per line (each line is pre-filled with the requested
   quantity and its suggested bin; adjust down to record a short). Submitting decrements
   bin stock and, once every line is picked, the list becomes packable.
3. **Pack** turns a fully-picked list into a shipment.
4. **Ship** dispatches the packed shipment with a carrier + tracking number.

> **Outbound tabs pick documents from pending lists — no typed numbers.** On `/wms`:
> the **Wave** tab's order-ref field is a dropdown of orders **not yet waved**
> (`GET /api/wms/wave-candidates` — POS/SO sales and open dine-in orders); the **Pick**
> tab lists pick lists still **open or partially picked**
> (`GET /api/wms/picks?status=Open,Picking`) and loads a list's lines via
> `GET /api/wms/picks/:pickNo`; the **Pack** tab lists only **fully-picked** pick lists
> (`GET /api/wms/picks?status=Picked`); the **Ship** tab lists only **packed** shipments
> (`GET /api/wms/shipments?status=Packed`). Completing an action removes the document from
> its list automatically, so the dropdown doubles as the team's to-do list. All reads are
> tenant-scoped and read-only.

---

## 6. Goods issue & transfers

**Required permission:** `wh_custody`

- **Issue** stock out (e.g. for production or write-off): record item, quantity
  and reason.
- **Transfer** stock between locations: choose source and destination bins and
  quantity.

**Expected result:** Stock balances at each location are updated and a movement is
logged.

> The transfer above is an **instant** location-to-location move (value-neutral, no
> GL). For stock that physically **travels between warehouses or branches** — and is
> therefore in transit for a period — use the two-step **transfer order** below.

---

## 6a. Inter-warehouse / branch transfer orders (ship → receive) — control INV-16

**Screen:** `/stock-ops/transfer-orders` · **Required permission:** `wh_custody`
(the in-transit aging report also opens to `dashboard` / `exec` reviewers)

When goods move between sites they belong at **neither** end while in transit, so a
transfer order splits the move into **two steps** and parks the value in a **Goods-in-Transit**
account (**1255**) in between — it is never double-counted at both ends nor lost.

### Create the order (`wh_custody`)
1. On the **สร้างใบโอน (New order)** tab, enter the **From** and **To** locations and add
   item lines (item + quantity). Click **สร้างใบโอน**.
2. The order is created as **Draft** — a document only. **No** stock or GL has moved yet.
   (From and To must differ, or you get `SAME_LOCATION`.)

### Ship the goods (`wh_custody`)
1. On the **ใบโอนทั้งหมด (Orders)** tab, click **ส่งของ (Ship)** on the Draft order.
2. The source location's valued stock is relieved at its current cost and the value moves
   into Goods-in-Transit: **Dr 1255 Goods-in-Transit / Cr 1200 Inventory**. Status → **Shipped**;
   each line's cost is pinned as a snapshot.

### Receive the goods — a *different* person (`wh_custody`)
1. On arrival, an **independent custodian** (not the shipper) clicks **รับของ (Receive)**.
2. The stock lands at the destination and the in-transit value is relieved back to inventory:
   **Dr 1200 Inventory / Cr 1255**. Status → **Received**.

> **Custody segregation (SoD):** the person who **shipped** an order **cannot** receive it —
> the app returns `SOD_SELF_APPROVAL`. Someone else must confirm arrival.

### Period-end in-transit aging / cutoff report
The **สินค้าระหว่างทาง (In-transit aging)** tab lists every order still **Shipped** (not yet
received) with its **days-in-transit** and value, bucketed **0-7 / 8-30 / 31+**. At period end
this is the cutoff check for inventory existence — a long-outstanding in-transit line is an
exception to investigate (goods lost, or a receipt not recorded).

**Expected result:** the perpetual sub-ledger stays tied to GL 1200 across the round-trip;
between ship and receive the value is visible in 1255 and on the aging report.

**Troubleshooting**

| Message | Meaning | What to do |
|---|---|---|
| `SAME_LOCATION` | From and To are the same location | Choose a different destination |
| `NOT_DRAFT` | Tried to ship an order that is not a Draft | It is already shipped/received — check its status |
| `NOT_SHIPPED` | Tried to receive an order that is not Shipped | Ship it first (or it is already received) |
| `SOD_SELF_APPROVAL` | The shipper tried to receive their own transfer | An independent custodian (≠ shipper) must receive it |
| `NEG_STOCK` | Shipping more than the source location has on hand | Recount / receive at the source before shipping |

---

## 7. Cycle counts & stocktake

**Screen:** `/stocktake` · **Required permission:** `wh_count` (StockCounter), `warehouse`, or `mobile`

> **SoD rule R11 — two-screen design:** The `/stocktake` screen is for
> **counting only** (`wh_count`). The **Inventory Controller** (`wh_adjust`)
> posts variance adjustments and approves write-offs on a *separate* screen:
> **อนุมัติปรับสต๊อก** at `/stock-adjustment`. This prevents a counter from
> adjusting their own count to conceal shrinkage.

### To run a cycle count (StockCounter — `wh_count`)

1. Go to **ตรวจนับสต๊อก** (`/stocktake`).
2. Select the items / location to count. Scan items via QR if available.
3. Enter the **counted quantity** for each line.
4. Click **บันทึกใบนับ** (Save count).

**Expected result:** A stocktake document is saved with status "Counted" and the
counter sees a note directing an Inventory Controller to post the variance at
`/stock-adjustment`.

### To post the variance (InventoryController — `wh_adjust`)

1. Go to **อนุมัติปรับสต๊อก** (`/stock-adjustment`).
2. The "ใบนับรอลงบัญชี" tab shows all counts with status "Counted".
3. Review the variance lines and click **ลงบัญชีผลต่าง** for the relevant count.

**Expected result:** Stock is corrected and the variance JE is posted to the
general ledger (Dr 5810 / Cr 1200 for shrinkage, reversed for a gain).

### Direct adjustment and write-off approval (InventoryController — `wh_adjust`)

- **Direct adjustment:** click "ปรับสต๊อกโดยตรง" on `/stock-adjustment` to post an
  immediate ±adjustment (must provide reason).
- **Write-off approval:** the "ตัดสต๊อกรออนุมัติ" tab shows pending write-off
  requests from warehouse staff. The controller approves or rejects each one.
  A write-off request posts **nothing** until approved by a *different* `wh_adjust`
  user; self-approval returns `SOD_VIOLATION` (control INV-07).

---

## 7b. Cycle-count program — ABC classification & blind counts (control INV-17)

**Screen:** `/stock-ops/cycle-counts` · **Required permission:** `wh_count` (StockCounter) or
`warehouse` to count; `wh_adjust` (InventoryController) to recompute ABC and post variances.

Instead of counting everything at once (or at random), the cycle-count program counts the
**right items at the right frequency**. It ranks each item by **how much value flows through it**
(ABC) and counts the fast/valuable **A** items often and the slow **C** items rarely. Counts are
**blind** — the counter never sees the system (book) quantity, so a shortage can't be hidden by just
writing the book number down.

### Recompute ABC (InventoryController — `wh_adjust`)

1. Open **ตรวจนับตามรอบ (Cycle counts)** (`/stock-ops/cycle-counts`) → the **ABC** tab.
2. Click **คำนวณ ABC ใหม่ (Recompute ABC)**.

**Expected result:** every item is classified **A / B / C** by its annual consumption value
(A ≈ top 80% of value, B ≈ next 15%, C ≈ last 5%). The count **cadence** per class is seeded the
first time — **A = every 30 days, B = 90, C = 180** — and can be tuned.

### Work the due worklist & count (StockCounter — `wh_count`)

1. Open the **ครบกำหนด (Due)** tab — it lists items whose next count is due, **A items first**.
2. Click **สร้างใบตรวจนับ (Generate count)** for the items you'll count. This creates a **blind**
   task: the item list is shown **without** any system quantity.
3. Count the shelf and enter the **physical quantity** for each line, then submit.

**Expected result:** a cycle-count task (`CC-…`) and a linked stocktake (`ST-…`) are created; the
task moves to **Counted**. The variance is **not** posted yet.

### Post the variance (InventoryController — `wh_adjust`)

Posting reuses the normal stocktake path — go to **อนุมัติปรับสต๊อก** (`/stock-adjustment`) or post
the linked `ST-…` directly. The person who **counted** cannot post their own count
(`SOD_SELF_APPROVAL`, SoD R11); a different `wh_adjust` reviewer posts it, correcting the on-hand and
booking the valued GL adjustment (Dr 5810 / Cr 1200 for shrinkage). Once posted, the item drops off
the due worklist until its class cadence comes round again (control INV-17).

---

## 7a. Logging waste & spoilage

**Screen:** `/waste` (**ของเสีย / ทิ้ง**) · **Required permission:** `warehouse`,
`pos`, or `order_mgt`.

When ingredients are thrown away — spoiled, expired, damaged, over-prepped — log
it so you can see **how much food cost you're losing and why**.

1. Enter the **item code**, **quantity**, and pick a **reason** (เน่าเสีย / หมดอายุ /
   ชำรุด / ทำเกิน / เตรียมผิด / ยกเลิกจานที่ปรุงแล้ว / อื่น ๆ) — *why* it was wasted.
2. Pick a **disposition** — *what happened to it*: ทิ้ง (discard), หมัก (compost),
   บริจาค (donate), อาหารพนักงาน (staff meal), นำกลับมาใช้ (rework), or คืนผู้ขาย
   (return to supplier). Defaults to **discard**.
3. Optionally enter the **cost per unit**. If you do, the loss is **posted to the
   accounts** (Dr 5810 ของเสีย / Cr 1200 สินค้าคงคลัง); if you leave it blank, it's
   recorded for tracking only.
4. **บันทึก** — the ingredient stock drops and the entry appears in the list, with a
   **by-reason** and **by-disposition** breakdown at the top showing where your waste
   cost is going. Filter the list by disposition to answer "how much did we donate?".

> **Voided a dish that was already cooked?** Use **ยกเลิกจานที่ปรุงแล้ว (void-fire)**:
> enter the **menu SKU** and how many dishes were voided, and the system writes off
> *all* the recipe ingredients in one go (one accounting entry Dr 5810 / Cr 1200),
> tagging the voided ticket number — so a cancelled fired order doesn't silently lose
> its ingredient cost.

> **Usage variance (theoretical vs actual).** The **ส่วนต่างการใช้วัตถุดิบ** report
> compares what the recipes *say* should have been used (recipe COGS) against what
> actually left stock (recipe use **+** logged waste), per ingredient and valued at
> cost. A high waste % (flagged **High** ≥10% / **Medium** ≥5%) tells a manager which
> ingredient the kitchen is losing money on. (Control **INV-15**.)

> **Note:** This is for **ingredients/consumables**. For **stock-controlled
> products** (those on the perpetual valued ledger), use the proper **write-off**
> (which needs a manager's approval) — the waste screen will tell you to switch
> (*USE_WRITEOFF*). This stops shrinkage being hidden as "waste". (Control **INV-10**.)

[screenshot: waste log with by-reason cost breakdown]

---

## 8. Returns to stock (RMA)

When returned goods come back, receive the RMA and restock saleable items.

1. Open the RMA.
2. **Receive** the returned goods.
3. **Restock** the items that are fit for resale.

**Expected result:** Saleable returns are added back to inventory.

---

## 9. Inventory valuation & GL reconciliation (perpetual sub-ledger)

**Screen:** `/inventory-ledger` (**บัญชีสต๊อก & มูลค่า**) · **Required permission:** `warehouse`
/ `dashboard` to view; the write actions are gated per tab (`wh_receive` / `wh_custody` /
`wh_adjust`).

The **perpetual valued sub-ledger** keeps the *cost* of stock — not just quantity —
and posts the matching accounting entry for every move, so the inventory balance in
the books always matches what is on the shelf. It runs alongside the operational
movements above and is the basis for **stock valuation** and the **month-end
inventory reconciliation**.

The screen has tabs: **มูลค่า & กระทบยอด** (valuation + the GL tie-out banner),
**รับเข้า / เบิก / ปรับปรุง** (the three write actions), **อนุมัติตัดสต๊อก** (write-off
approvals — see below), **ชั้นต้นทุน (Layers)** (open FIFO/FEFO cost layers), and
**ความเคลื่อนไหว** (the valued move ledger). The endpoints behind each are:

| Action | Endpoint | Required permission | What it posts |
|---|---|---|---|
| Goods receipt (at cost) | `POST /api/inventory/receipts` | `wh_receive` | Dr 1200 Inventory / Cr 2000 AP; updates moving-average cost |
| Goods issue | `POST /api/inventory/issues` | `wh_custody` | Dr 5000 COGS / Cr 1200 Inventory (at moving-average) |
| Stock adjustment | `POST /api/inventory/adjustments` | `wh_adjust` | Dr 5810 / Cr 1200 (shrinkage) — reversed for a gain |
| Stock valuation | `GET /api/inventory/valuation` | `wh_count` / `dashboard` | — (on-hand value + costing method) |
| Cost layers (FIFO/FEFO) | `GET /api/inventory/layers` | `wh_count` / `dashboard` | — (open layers: lot, expiry, remaining, cost) |
| Reconciliation | `GET /api/inventory/reconciliation` | `wh_count` / `dashboard` | — (sub-ledger value vs GL account 1200) |
| Movement ledger | `GET /api/inventory/moves` | `wh_count` / `dashboard` | — (audit trail of every valued move) |

**How costing works.** Each item uses one costing method, fixed on its first receipt:

- **Moving-average** (default) — each receipt recomputes a weighted-average unit cost;
  issues relieve stock at that average. A receipt of 100 @ ฿10 then 100 @ ฿12 gives an
  average of ฿11, so issuing 50 books ฿550 to COGS.
- **FIFO / FEFO** (set `costing_method` to `fifo` or `fefo` on the first receipt) — each
  receipt opens a **cost layer** carrying its lot and expiry. An issue consumes layers in
  order — **FEFO** takes the **soonest-to-expire** lot first (best for perishables), **FIFO**
  the oldest receipt — and books COGS at the **actual** cost of the layers consumed. Use
  `GET /api/inventory/layers` to see the open layers and their values.

> **Example (FEFO):** receive 10 @ ฿12 (expires Jul 1) then 10 @ ฿15 (expires Jun 20);
> issuing 12 consumes the 10 @ ฿15 (sooner expiry) + 2 @ ฿12 = **฿174** COGS, leaving 8 @ ฿12.

**Built-in controls**

- **No oversell.** Issuing or adjusting below zero on-hand is rejected with
  `NEG_STOCK` — you cannot drive stock negative (control **INV-01**).
- **No double-counting.** A goods-receipt carrying a source reference (e.g. a GR
  number) is **idempotent**: re-posting the same reference returns `deduped: true`
  and changes nothing (control **INV-02**).
- **Justified adjustments.** Every adjustment must carry a **reason**, or it is
  rejected with `REASON_REQUIRED`; adjustment authority (`wh_adjust`) is segregated
  from counting (`wh_count`) under rule **R11** (control **INV-04**).
- **Write-offs need a second person (INV-07).** Writing stock **down** (a negative
  adjustment — spoilage, shrinkage) is **theft-sensitive**, so it uses **maker-checker**:
  your write-off is a **request** that changes **nothing** until a *different* `wh_adjust`
  holder opens the **อนุมัติตัดสต๊อก (Write-off approvals)** tab and clicks **อนุมัติ
  (Approve)** — only then does the stock move and `Dr 5810 / Cr 1200` post. You **cannot
  approve your own** write-off (`SOD_VIOLATION`, binds even Admin); **ปฏิเสธ (Reject)**
  leaves stock untouched. A **gain** (positive adjustment) and a **stocktake** posting are
  immediate — only ad-hoc write-offs wait for approval.
- **Reconciliation (INV-06).** `GET /api/inventory/reconciliation` returns
  `sub_ledger_value`, `gl_inventory` and `reconciled`. When `reconciled` is `true`
  the perpetual stock value equals the GL inventory control account (1200); a
  non-zero `difference` is a control exception for the **Controller** to investigate.

> **Note:** This sub-ledger does **not** re-book COGS on the POS sale path — restaurant
> sales already relieve recipe COGS — so consumption is never costed twice.

> **Yield/waste factors on recipes.** A recipe (BoM) line records the **edible** quantity per
> serving plus a **yield factor** (usable portion after trimming, e.g. 0.85 for onion) and an
> optional **waste factor** (expected extra shrink). When a dish sells, the system issues the
> **gross** raw quantity — `edible ÷ (yield − waste)` — from stock and costs the COGS on that
> gross amount, so trim/cook loss is reflected in food cost instead of being silently absorbed.
> Set these on the recipe (menu API); leaving them at the defaults (yield 1.0, waste 0.0) keeps a
> recipe at the historic 100%-yield behaviour.

**Bridge with everyday warehouse moves.** Once an item is **perpetual-tracked** (it has had a
valued receipt), the ordinary operations above are automatically costed too: a **goods issue**
(§6) relieves valued stock and books COGS, a **transfer** (§6) moves value between locations, and
**posting a stocktake** (§7) corrects the valued on-hand to the count and books the variance to the
GL. Each response carries a `valued_lines` count so you can see how many lines were costed. Items
that have never had a valued receipt are unaffected — they keep the simple audit movement.

**Troubleshooting**

| Message / code | Meaning | What to do |
|---|---|---|
| `NEG_STOCK` | Issue/adjustment exceeds on-hand | Recount or receive stock first |
| `REASON_REQUIRED` | Adjustment submitted with no reason | Re-submit with a justification |
| `deduped: true` | Receipt reference already posted | Expected — no action needed |
| `difference ≠ 0` on reconciliation | Sub-ledger ≠ GL 1200 | Controller reviews moves vs GL postings |

---

## 9a. Landed cost — load freight/duty into inventory unit cost (control COST-01)

**Screen:** `/costing` → **ต้นทุนแฝง (Landed Cost)** (`/costing/landed-cost`)
**Required permission:** create/preview — `procurement` / `wh_receive` / `exec`; post — `gl_post` / `exec`

When you import or freight-in goods, the extra charges — **freight, import duty, insurance, broker/customs
fees** — are part of the true cost of the stock, not a period expense. A **landed-cost voucher** spreads
those charges over the received items so the inventory unit cost (and therefore future COGS) reflects what
the goods really cost to land.

### How it works

1. **Create the voucher.** Enter the four charge amounts, pick an **allocation basis** — *by value*, *by
   quantity* or *by weight* — and add the received item lines (item, received qty, and for weight-basis the
   weight; base value defaults to qty × current average cost). The items must already be tracked in the
   perpetual stock ledger (received via *Goods receipt* / §5–9); an untracked item is rejected
   (`LANDED_UNTRACKED`).
2. **Preview the allocation.** *Preview allocation* shows each line's share; the shares always sum to
   **100%** of the total charges.
3. **Post (maker-checker).** Posting must be done by **someone other than the preparer** (`SOD_SELF_APPROVAL`
   if you try to post your own) who holds the GL-posting duty. On post:
   - the part of each line still **on hand** is **capitalised into inventory** — it raises the item's
     moving-average cost (and open FIFO/FEFO cost layers), so the **next issue carries the loaded cost**
     (`Dr 1200 Inventory`);
   - the part already **issued/sold** is **not** re-costed — that residual is charged to the costing
     variance account (`Dr 5500`, the same account STD-costing uses for purchase price variance);
   - the total charges are credited to the **landed-cost accrual** liability (`Cr 2010`).

The capitalisation posts inside the same reconciliation scope as ordinary receipts/issues, so
**Inventory valuation & GL reconciliation** (§9) still ties after a voucher posts.

### Messages you may see

| Message / code | Meaning | What to do |
|---|---|---|
| `SOD_SELF_APPROVAL` | You tried to post a voucher you prepared | A different `gl_post`/`exec` user posts it |
| `LANDED_UNTRACKED` | The item has no perpetual stock balance | Receive it (Goods receipt) first, then post |
| `ALLOC_BASIS_ZERO` | The chosen basis sums to zero across the lines | Enter base values / qty / weight, or change the basis |
| `ALREADY_POSTED` / `NOT_DRAFT` | The voucher is already posted | A posted voucher is final; create a new one for further charges |

*(APIs: `POST /api/costing/landed-cost`, `GET /api/costing/landed-cost[/{no}]`,
`POST /api/costing/landed-cost/{no}/allocate`, `POST /api/costing/landed-cost/{no}/post`.)*

---

## 10. Branch replenishment — transfer first, then buy

**Screen:** `/replenishment` · **Required permission:** `planner` or `procurement`
to view and recompute; `wh_custody` (warehouse) to execute transfers; `procurement`
to raise the purchase requisition.

Each branch (outlet) keeps its own stock balance. When a branch's on-hand for an
item falls to or below its **reorder point**, the system proposes how to refill it —
**transferring from another branch that has spare stock first**, and only **buying**
from a supplier for whatever the transfers can't cover. This avoids buying new stock
while a sister branch is sitting on a surplus.

The screen has two lists:

- **โอนระหว่างสาขา (Transfers)** — each row shows the branch that is short, the
  branch to transfer **from**, the item, and the quantity to move.
- **สั่งซื้อจากซัพพลายเออร์ (Purchases)** — each row shows the branch, the item, the
  quantity to buy, and the preferred supplier.

### To replenish

1. Go to **เติมสต๊อกอัตโนมัติ** (`/replenishment`).
2. Click **คำนวณใหม่** to recompute suggestions from current per-branch stock.
3. Review the two lists. Critical (out-of-stock) rows are flagged in red.
4. Click **โอนสต๊อก** to execute the inter-branch transfers (warehouse custody).
   Stock moves from the source branch to the short branch and both sides are logged.
5. Click **สร้างใบขอซื้อ (PR)** to raise one consolidated purchase requisition for the
   remaining quantity. The PR then follows the normal approval workflow before a PO is
   issued (see [Procurement](./03-procurement.md)).

> **Note — separation of duties:** Moving stock between branches (**โอนสต๊อก**,
> `wh_custody`) and raising the purchase (**สร้าง PR**, `procurement`) are deliberately
> separate actions for different roles, so the person who moves stock is not the person
> who authorises the spend (control INV-05).

**Expected result:** Transferred suggestions are marked *Transfer_Done* and the branch
balances update; bought suggestions are marked *PR_Created* and linked to the new PR.

---

## 11. Available-to-promise & stock reservations (order-promising) — control INV-09

**Screen:** `/costing` → **พร้อมส่งมอบ & จองสินค้า (ATP)** tab.
**Required permission:** `planner` / `pos` / `procurement` to check & list; `planner` /
`pos` to reserve, release, fulfil.

Before you promise a customer a delivery date, check what you can actually commit —
**available-to-promise (ATP)** — and **reserve** that stock against the order so a second
order can't sell the same units.

> **ATP = on-hand − already-reserved − safety stock + scheduled receipts** (open purchase
> orders arriving on/before the need-by date).

### Check what you can promise

1. On the **ATP** tab, enter the **item code**, the **quantity** the customer wants, and the
   **need-by** date, then press **ตรวจสอบ (Check)**.
2. The result shows a green **พร้อมส่งมอบได้ (Can promise)** or a red **ไม่พอส่งมอบ (Cannot
   promise)** badge, the **ATP** figure and its components (on-hand / reserved / safety), and —
   when short — the **shortfall** and the **first available** date (the soonest scheduled PO
   receipt). Any scheduled receipts inside the horizon are listed with their PO and expected date.

### Reserve the stock

3. With a promising result on screen, enter a **reference doc** (e.g. the sales-order number)
   and press **จองสินค้า (Reserve)**. The reservation lowers ATP immediately so it can't be
   sold twice. Reserving the **same reference** again **adjusts** that reservation rather than
   stacking a duplicate (no float leak), and you can never reserve **beyond** ATP —
   over-reserving is rejected with `INSUFFICIENT_ATP`.

### Work the reservation register

4. The **รายการจอง (Reservations)** list shows every reservation with its open quantity. On an
   **Open** row: **ยกเลิกจอง (Release)** cancels it and frees the stock back to ATP (order
   cancelled); **ส่งมอบแล้ว (Fulfil)** retires it when the goods physically ship — fulfilment is
   ATP-neutral (the on-hand drop from the issue already accounts for it, so the reservation isn't
   double-counted).

*(APIs: `GET /api/costing/atp`, `POST /api/costing/atp/check`, `POST /api/costing/allocate`,
`POST /api/costing/allocations/{ref}/release|fulfill`, `GET /api/costing/allocations`.)*

**Errors:** `INSUFFICIENT_ATP` (the reserve/adjust exceeds available-to-promise — reduce the
quantity or wait for a scheduled receipt).

## 11a. Standard-cost roll & inventory revaluation — control COST-02

**Screen:** `/costing` → **ปรับปรุงต้นทุนมาตรฐาน (Standard-cost roll)** — required role: **`masterdata`**
to propose, **`exec`** to approve (`planner` may view).

For **standard-cost (STD)** items the standard is set once on the `/costing` costing-method screen and
otherwise never changes. As real cost drifts, on-hand inventory (valued at the stale standard) becomes
mis-stated. The standard-cost roll revises the standard **under maker-checker** and revalues the on-hand
stock in one governed, audited step.

### Propose a revision (CostAccountant — `masterdata`)
1. Open **ปรับปรุงต้นทุนมาตรฐาน**. In **เสนอปรับปรุงต้นทุนมาตรฐาน**, add one line per item: the **รหัสสินค้า**
   (must be a STD-costed item) and the **ต้นทุนมาตรฐานใหม่** (new standard). Add a **เหตุผล**.
2. Click **ส่งคำขอ**. The system records a **Draft** revision, **snapshots the current on-hand**, and shows the
   **revalue impact** = on-hand × (new − old) per line. **Nothing posts to the GL yet.**
3. A non-STD (FIFO/AVG) item is rejected — set its method to STD first.

### Review & approve (FinancialController — `exec`, a *different* user)
1. Click the revision in the register to see **proposed vs current** and the impact per item.
2. Click **อนุมัติ & ตีราคาใหม่**. The approver **must be a different user than the preparer**. On approval the
   stored standard **rolls forward** (subsequent issues cost at the new standard) and a **balanced revaluation
   journal** posts: a standard **rise** → **Dr 1200 Inventory / Cr 5500** (favourable); a standard **drop** →
   **Cr 1200 / Dr 5500** (unfavourable). The posted **JE** number appears on the detail panel.

*(APIs: `POST /api/costing/std-cost/revise`, `GET /api/costing/std-cost[/{no}]`,
`POST /api/costing/std-cost/{no}/approve`.)*

**Errors:** `STD_ITEM_REQUIRED` (the item is not standard-costed), `SOD_SELF_APPROVAL` (the preparer cannot
approve their own revision — ask a different user with `exec`), `NOT_DRAFT` (the revision is already approved —
no double posting), `NO_LINES` (add at least one item line).

## 12. CAPA — corrective & preventive actions with effectiveness sign-off (control QC-02)

**Route:** *Production → การแก้ไข & ป้องกัน (CAPA)* — `/quality/capa`.
**Required role/permission:** view — `quality`, `quality_approve` or `exec`; open/own a CAPA and its
actions — `quality` (or `exec`); **verify / close** — `quality_approve` (or `exec`).

Where **waste & spoilage** (§7a) or a supplier **claim** dispositions a *single* defect, a **CAPA**
manages the *loop* that stops it recurring: root cause → action plan → **independent** effectiveness
verification → closure.

1. **Open a CAPA.** On the **ทะเบียน CAPA** tab fill the title, problem statement, root cause, the
   *action type* (corrective / preventive / both) and a *target date*. Optionally link its origin with a
   *source* (NCR, supplier claim, complaint, audit or manual) + a free-text reference — this is just a
   pointer, so a CAPA can be raised even before the source module exists. Saving mints a **CAPA-#####**
   number; you are recorded as the owner.
2. **Plan the actions.** Click a CAPA row to open it, then add **action items** (description + due date).
   Adding the first action moves the CAPA **open → in_progress**. Tick **ทำเสร็จ (mark done)** as each is
   completed.
3. **Submit for verification.** When the plan is complete press **ส่งตรวจสอบ** — the CAPA moves to
   **pending_verification**. (A CAPA with no action plan is refused — add at least one action first.)
4. **Independent effectiveness sign-off (the control, QC-02).** A **different** person holding
   `quality_approve`/`exec` opens the CAPA, picks a result and presses **ยืนยันประสิทธิผล (Verify)**:
   - **effective** → the CAPA **closes** (the result + your name are stamped on it). This is allowed
     **only** when every action is done and you are **not** the owner/creator.
   - **ineffective** → the CAPA **reopens** to *in_progress* — the root cause was not resolved; the loop
     continues.
   The verifier may instead **ตีกลับ (Reject)** the verification with a reason to send it back.
5. **Detective — overdue.** The **เกินกำหนด** tab lists open CAPAs whose target date has passed, so a
   slipping corrective-action loop is caught (`GET /api/quality/capa/overdue?days=N`).

**Why the split?** One person cannot both own a corrective action and sign off that it worked — that would
let a case be closed with the underlying problem still live. The owner/creator and the effectiveness
verifier **must be different people** (segregation of duties, rule **R21**).

**Errors:**
- `SOD_SELF_APPROVAL` — you tried to verify/reject a CAPA you own or created; route it to an independent
  reviewer.
- `ACTIONS_INCOMPLETE` — an action item is still pending; complete them all before verifying.
- `NO_ACTIONS` — you submitted a CAPA with no action plan; add at least one action.
- `NOT_PENDING_VERIFICATION` — the CAPA is not awaiting verification (submit it first; closed/cancelled is
  terminal).
- `REASON_REQUIRED` — a rejection needs a reason.

---

## 12. Certificate of Analysis & out-of-spec release — control QC-03

**Screen:** `/quality/coa` · **Required permission:** `quality` (record) / `quality_approve` (approve
an out-of-spec release) / `exec`

A **Certificate of Analysis (CoA)** evidences the quality of a received or produced **lot** against the
item's **quality spec** (an acceptable min–max range per measured characteristic). An **out-of-spec** lot
— one whose measured value falls outside its range — can be released into stock/production **only** as a
documented **deviation approved by a second person** (maker-checker, **QC-03**).

### Set up a quality spec (`quality`)

1. Go to **Certificate of Analysis** (`/quality/coa`) → the **สเปกคุณภาพ (Quality specs)** tab.
2. Enter the **item**, the **characteristic** (e.g. Moisture %, pH, Purity %), unit, and the acceptable
   **Min / Max** (and an optional target). Click **บันทึกสเปก (Add spec)**.

### Record a CoA against a lot (`quality`)

3. On the **ใบรับรอง (Certificates)** tab, click **เปิดใบรับรอง (Create CoA)**: enter the **lot no.**,
   **item**, and **source** (Incoming / Production).
4. Open the CoA and **add measured results** — one row per characteristic with its spec Min/Max and the
   **actual** value. Each row shows **pass / fail** against its range.
5. Click **ประเมินผล (Evaluate)**. The CoA's overall result becomes **pass** if every characteristic is in
   range, or **fail (out of spec)** if **any** actual is outside its range.

### Release the lot

6. **In-spec (pass):** the recorder can **ปล่อยล็อต (Release lot)** directly — routine.
7. **Out-of-spec (fail):** release is a **deviation approval** and must be done by a **different** person
   who holds `quality_approve`/`exec`. They enter a mandatory **deviation reason** and click
   **อนุมัติปล่อยแบบเบี่ยงเบน (Approve deviation release)**. Alternatively **ปฏิเสธ (Reject)** holds the
   lot (never released).

### Review deviations (audit)

8. The **ทะเบียนเบี่ยงเบน (Deviation register)** tab lists every out-of-spec lot that was **released** —
   the recorder, the approver, and the reason — the population an auditor samples.

*(APIs: `GET/POST /api/quality/specs`, `POST /api/quality/coa`, `POST /api/quality/coa/{id}/results`,
`POST /api/quality/coa/{id}/evaluate|release|reject`, `GET /api/quality/coa/out-of-spec`.)*

**Errors:** `COA_NOT_EVALUATED` (release before evaluating — evaluate first); `SOD_SELF_APPROVAL` (the
recorder tried to release their own out-of-spec lot — a different approver must); `DEVIATION_APPROVER_REQUIRED`
(a `quality`-only user tried to release a fail — needs `quality_approve`/`exec`); `DEVIATION_REASON_REQUIRED`
(out-of-spec release with no reason); `COA_NOT_HELD` (the CoA is already released/rejected);
`SPEC_RANGE_INVALID` (spec min greater than max).

---

**Next:** [Procurement](./03-procurement.md) ·
[Reports & Analytics](./09-reports-and-analytics.md) (forecasting & replenishment)
