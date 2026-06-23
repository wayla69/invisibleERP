# 01 · Sales & Point of Sale (POS)

**Status: DRAFT v0.1**

This chapter is for **Cashiers, Sales staff, POS Supervisors and Returns Clerks**.
It covers ringing up sales, taking orders, credit checks, returns and refunds,
and opening / closing the cash drawer with the Z-report.

---

## 0. The POS home (store overview)

**Screen:** `/pos-home` · **Required permission:** `pos`, `pos_sell`, `pos_till`, or `dashboard`

When you are in the **POS workspace** (see *Getting Started → Workspaces*), your landing screen is the
**store overview**. It shows, for **today**:

- **Sales today**, **bill count**, **average bill**, **VAT**, and **discounts**.
- **Top-selling items** and **sales by payment method**.
- **Open tills** (by cashier) and the **most recent bills**.
- Quick buttons to **open the POS till**, **POS control**, **card terminals**, and **branches**.

> **Note:** Cashiers and POS Supervisors (single-duty roles holding `pos_sell` / `pos_till`) can view this
> overview for their own shop — the figures are read-only. To ring up a sale, use **POS** (`/pos`).

[screenshot: POS home / store overview]

---

## 1. Ringing up a sale at the till

**Screen:** `/pos` (list) → `/pos/new` (new sale) · **Required permission:**
`pos_sell` (held by *Cashier*, *Sales*, *Admin*)

1. Go to **POS** (`/pos`) and click **Create Order** (**สร้างออเดอร์**) to open
   `/pos/new`.
2. (Optional) Enter the **customer code** if the sale is for a known customer.
3. Add each product: enter **Item ID** (**รหัสสินค้า**), **Quantity**
   (**จำนวน**) and **Unit Price** (**ราคา**). Repeat for every line.
4. Review the subtotal.
5. Click **Confirm Order** (**ยืนยันออเดอร์**).

**Expected result:** A sale is created with an order number (e.g. `SO-…`), the
total is shown, and any loyalty points earned are recorded.

[screenshot: /pos/new with line items and Confirm Order button]

### Taking payment

1. After confirming, choose the **payment method**: Cash (**เงินสด**), Card, QR /
   PromptPay, or Store Credit (gift card).
2. Enter the amount tendered and record the payment.

**Expected result:** The payment is captured and a receipt can be printed or
sent.

### Printing / sending the receipt

- Print or download the receipt from the sale (HTML, PDF or receipt-printer
  format).
- To email or SMS it, use **Send receipt** and enter the customer's contact.

### Cashier speed: quick-tender, change & hotkeys

On `/pos/new` the cart panel speeds up cash sales:

- **Quick-tender** (**รับเงินสด**): tap **พอดี** (exact), **฿100**, **฿500** or
  **฿1000** to fill the *cash received* field; the **change** (**เงินทอน**) is
  shown instantly (red if not enough).
- **Hotkeys:** **F2** adds a line, **F9** confirms the order — so a cashier can
  ring up without leaving the keyboard.

### Pricing rules, service charge & rounding (dine-in)

At dine-in checkout you can apply the shop's **pricing rules** automatically
(happy-hour %, buy-one-get-one, quantity breaks, item/category discounts) instead
of keying discounts by hand — turn on **apply pricing rules** at checkout. For
large parties an **auto service charge** is added, and the bill can be **satang-
rounded** to a cash-friendly total. Cashiers *apply* rules; only Pricing/Marketing
roles may *create* them (segregation of duties). See **Dine-in / restaurant** for
the full flow.

### QR self-ordering & the kitchen display (KDS)

Guests can order from their own phone — no app, no login:

1. **Open the table.** Each table has a **printed QR sticker** (print it from
   **โต๊ะ → QR ติดโต๊ะ**); when a guest scans it the session opens (or re-joins)
   automatically and their phone lands on the order page. Staff can also open the
   table from the floor plan (**เปิดโต๊ะ**).
2. The guest opens the **เมนู** tab, browses by category, picks options
   (size, spice, add-ons) where offered, reviews the **ตะกร้า** (cart) and taps
   **ส่งออเดอร์เข้าครัว** (send order to kitchen).
3. The order is sent **straight to the kitchen** — it appears on the **จอครัว
   (KDS)** screen automatically; no cashier re-keying. Guests can keep adding to
   the same bill during the visit.
4. On the **ออเดอร์ของฉัน** tab the guest sees live progress per dish
   (**รอคิว → กำลังปรุง → พร้อมเสิร์ฟ → เสิร์ฟแล้ว**) and the estimated wait,
   then **เรียกเก็บเงิน** and pay by **PromptPay**: a real QR appears, the guest
   scans it in their banking app, and the page confirms **automatically** once the
   bank notifies us — no staff step. (For this to settle automatically the
   business needs a PromptPay ID set and the payment webhook configured; without
   it, a simulate button completes the demo.)

**Buffet ordering.** If the shop offers buffet, the guest can tap **เริ่มบุฟเฟต์**,
pick a **tier** and the **number of diners**, and confirm. The table is charged a
single **per-head buffet price** and a **dining time limit** starts (a countdown
shows on the guest's screen). After that, every buffet dish the guest orders is
**฿0** but still goes to the kitchen as normal. A few rules keep it clean:

- A table is **either buffet or à la carte** — once à la carte ordering has
  started you can't switch it to buffet (start a fresh session instead).
- Only items that belong to the chosen tier can be ordered (others are hidden);
  ordering after the time is up is blocked.
- If the tier has an **overtime fee** and the guest runs over time, the surcharge
  is added automatically when the bill is requested.

Manage tiers in **บุฟเฟต์ (แพ็กเกจ)** (back office): set the code, per-head price,
time limit, optional overtime fee, and the menu SKUs included. Creating/editing
tiers is a master-data task (separate from front-of-house roles).

The **พฤติกรรมตามแพ็กเกจ** tab on the same page shows, for each tier, how guests
actually behave: the **most-ordered dishes**, number of **sessions and covers**,
**dishes per head**, **average bill per session**, and how often tables run into
**overtime** — so you can tune pricing, time limits and the dish line-up per tier.

**Kitchen (KDS).** Open **จอครัว (KDS)** (back-of-house). Tickets are grouped by
station and refresh automatically; tap a card to advance it
**เริ่มทำ → เสร็จแล้ว → เสิร์ฟแล้ว**. The colour border flags how long a ticket has
been waiting against its prep time, so late dishes stand out. Tickets that came
from a guest's phone show a **ลูกค้าสั่ง** badge, and buffet dishes show a
**บุฟเฟต์** badge, so the kitchen can tell them apart at a glance. Marking an item
**พร้อมเสิร์ฟ / เสิร์ฟแล้ว** is what updates the guest's screen.

> **Prices are protected.** Guests can only order real menu items; the system
> always prices them from the catalog, so a guest can never change a price. A
> sold-out item shows **หมด** and can't be added (**ITEM_UNAVAILABLE**). If a
> guest's link stops working they'll see *เซสชันโต๊ะนี้สิ้นสุดแล้ว*
> (**SESSION_ENDED**) — re-open the table to start a fresh session.

---

## 2. Credit checks (account customers)

When you sell **on credit** to an account customer, the system checks their
credit standing **before** confirming the order.

> **Note — order blocked by credit hold:** If the customer is on hold you'll see
> *Customer is blocked from ordering* (**ลูกค้าถูกระงับการสั่งซื้อ**, code
> `CREDIT_HOLD`). The sale cannot proceed until the hold is lifted by a manager /
> credit controller.

> **Note — order blocked by credit limit:** If this order would push the
> customer's outstanding balance over their limit, you'll see *Credit limit
> exceeded* (**เกินวงเงินเครดิต**, code `CREDIT_LIMIT`). Take payment now, reduce
> the order, or ask a credit manager to raise the limit.

See [Troubleshooting & FAQ](./99-troubleshooting-faq.md) for how to resolve these.

---

## 3. Sales orders (order management)

**Screen:** `/orders` · **Required permission:** `order_mgt` (held by *ArClerk*,
*Sales*, *Admin*)

Orders move through these stages:
**Pending → Processing → Shipped → Completed** (or *Claimed* / *Cancelled*).

### To update an order's status

1. Go to **Orders** (`/orders`) and open the order.
2. Choose the new **Status** (**สถานะ**), e.g. *Processing*.
3. For *Processing* or *Shipped*, set an **estimated delivery** date if needed.
4. Save.

**Expected result:** All lines on the order move to the new status.

[screenshot: order detail with status selector]

---

## 4. Parking a bill & manager overrides

**Screen:** `/pos-control` · **Required permission:** `pos` / `order_mgt`

### Park (hold) a bill — "พักบิล"

1. On `/pos-control`, open the **Bill Parking** tab.
2. With a cart in progress, click **Park / Hold**, add a label and (optionally) a
   customer name.
3. **Expected result:** A held ticket is created (e.g. `HOLD-…`).
4. To bring it back, open the held list and click **Recall**; to remove it, click
   **Discard**.

### Manager overrides — "การอนุมัติ"

Voids, discounts, price overrides and "no sale" drawer opens are recorded for
audit. A **void** requires a reason and a manager's confirmation.

1. Open the **Manager Overrides** tab.
2. Choose the action (*void*, *discount*, *price override*, *no sale*).
3. Enter the **reason** and the approving manager.
4. **Expected result:** An override record is created (e.g. `OVR-…`) in the audit
   trail.

> **Note:** All POS audit activity is viewable under the **Audit Log** tab.

---

## 5. Returns & refunds

**Required permission:** `returns` to process the return; `pos_refund` to issue
the refund (held by *ReturnsClerk*, *PosSupervisor*, *Admin*).

> **Note — separation of duties:** The person who **rang up** the sale should not
> be the one who issues the refund. POS Supervisors hold the refund right
> (`pos_refund`); cashiers (`pos_sell`) do not.

### To process a return

1. Locate the original sale (e.g. `S-…`).
2. Select the item(s) and **quantity** to return.
3. Enter a **reason** (e.g. *Defective*).
4. Choose the **Refund Method** (**วิธีคืนเงิน**): Cash, Card, QR / PromptPay, or
   Store Credit (issues a gift card instead of cash).
5. Confirm the return.

**Expected result:** A return record is created (e.g. `RTN-…`) with a refund
reference, the stock is restocked, and the accounting reversal is posted
automatically. The system shows the subtotal, VAT and total returned.

> **Note — over-return guard:** You cannot return more than was originally sold.
> Attempting to do so is blocked (`OVER_RETURN`).

[screenshot: return dialog with item lines and refund method]

---

## 6. Opening & closing the till (cash drawer) + Z-report

**Screen:** `/pos-control` / POS terminal · **Required permission:** `pos_till`
(held by *PosSupervisor*, *Admin*)

### Open the till at the start of a shift

1. Click **Open Till** (**เปิดรอบเงิน**).
2. Enter the **opening float** (starting cash), if any.
3. **Expected result:** A till session is opened (e.g. `TILL-…`).

### Cash movements during the shift

Record any cash added or removed:
- **Paid in** (**ใส่เงิน**) — cash added to the drawer.
- **Paid out** (**ถอนเงิน**) — cash removed (e.g. petty cash).
- **Drop** (**หยุด**) — cash moved to the safe.

### Close the till & get the Z-report

1. Count the cash in the drawer.
2. Click **Close Till** (**ปิดรอบเงิน**) and enter the **closing count** (and
   denomination breakdown if asked).
3. **Expected result:** The till closes and a **Z-report** (**รายงาน Z**) is
   produced, showing:
   - Gross sales and a breakdown by payment method
   - Cash sales and refunds, paid-in / paid-out / drops, opening float
   - **Expected cash** (**เงินสดคาดหวัง**) vs **counted cash**
   - The **variance** (**ส่วนต่าง**) — over or short
   - Transaction count and number of voids

> **Note:** Use the **X-report** during a shift for an interim total without
> closing the drawer. The **Z-report** is the final, end-of-shift report.

[screenshot: Z-report showing expected vs counted cash and variance]

---

## 7. Claims (sales claims)

**Screen:** `/claims` · **Required permission:** `claim_mgt`

1. Go to **Claims** (`/claims`) → **Sales Claims** tab.
2. Open a claim that is **Waiting**.
3. Choose **Approve** or **Reject** (add a reason if rejecting).

**Expected result:** The claim status changes to *Approved* or *Rejected*.

(Supplier / goods-receipt claims are covered in [Procurement](./03-procurement.md).)

---

**Next:** [Customer Portal](./02-customer-portal.md) ·
[Finance — AR & AP](./05-finance-ar-ap.md)
