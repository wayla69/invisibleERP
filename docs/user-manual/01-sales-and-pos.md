# 01 · Sales & Point of Sale (POS)

**Status: DRAFT v0.7** · *v0.7 (2026-07-05): **gift-card issuance maker-checker** — issuing a gift card **above ฿5,000** now creates a **pending** card that a finance approver (`creditors`/`exec`, a different person from the issuer) must approve before it holds value or can be redeemed; cards **฿5,000 or less** still issue instantly; **self-approval is blocked**. Controls GC-01 / SoD R14.* · *v0.6 (2026-06-29): added **PIN quick-login at the till** (numeric keypad on `/login`), the combined **"เข้าสู่ระบบ / เปิดกะ"** (login + open shift) action, the self-service **ตั้ง PIN หน้าร้าน** page (`/pos-pin`), and the **ตั้ง PIN** action on the admin Users page; privileged/finance accounts must still use password + MFA (cannot use a PIN). Control ITGC-AC-17.* · *v0.5 (2026-06-27): SoD screen split — new dedicated screens `/pos/refunds` (refund authorization queue, `pos_refund`) and `/pos/till` (till management, `pos_till`); `/pos/register` now shows as `pos_sell` primary perm; "บันทึกคืนสินค้า" button on `/returns` hidden from `pos_sell`-only cashiers (requires `pos_refund`). Controls R08/R12.* · *v0.4 (2026-06-26): B4 — pricing engine wired into the **retail portal POS** (`POST /api/portal/pos/sales`): `apply_pricing` now also triggers **auto service charge** (→ acct 4400, VATable) and **satang rounding** (→ acct 4900); three new optional fields `service_charge_pct`, `service_min_party`, `rounding`; response includes `service_charge` and `rounding_adjustment`.* · *v0.3 (2026-06-26): added **POS Favourites quick-access grid** (★ star-toggle + "รายการโปรด" chip tab, persisted per user) and the **"บันทึกคืนสินค้า" create-return flow** on the Returns Register (sale search → qty picker → refund method → `RTN-` confirmation).* · *v0.2 (2026-06-25): added the touch **register** (`/pos/register`) — menu-grid selling, modifier picker, keypad/quick-tender checkout, hold/recall — and connecting the **receipt printer / cash drawer / customer display** from the register's **⚙ ตั้งค่าเครื่อง**.*

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
> overview for their own shop — the figures are read-only. To ring up a sale, use **ขายหน้าร้าน**
> (`/pos/register`).

[screenshot: POS home / store overview]

---

## 1. Ringing up a sale — the touch register

**Screen:** `/pos/register` (**ขายหน้าร้าน**) · **Required permission:** `pos` /
`order_mgt` (held by *Cashier*, *Sales*, *PosSupervisor*, *Admin*)

The **register** is the everyday sell screen — a touch layout with the **menu on
the left** and a **running cart on the right**, built for speed (it replaces the
old keyed "create order" form for day-to-day selling):

1. **Add items by tapping.** The menu is grouped into **category chips** (tap a
   chip to filter) with a **search / barcode** box at the top — type part of a name
   or SKU, or **scan a barcode**, to add an item instantly. Sold-out (86) and
   out-of-hours items are greyed out and can't be added.
2. **Options (modifiers).** Items that carry choices (size, spice, add-ons) show a
   **ตัวเลือก** badge; tapping one opens a picker — choose options, the live price
   updates, then **เพิ่มลงตะกร้า**. Prices (incl. option add-ons) are always taken
   from the catalog, so a cashier can't change a price. Each option can also carry a
   **standard COGS delta** (set on the modifier via the menu API, e.g. "extra patty" =
   ฿12) so choosing it raises the sold line's cost of goods at checkout — keeping
   food-cost reporting honest. This is back-office only; cashiers and diners never see it.
3. **The cart & order options.** Adjust quantity with **− / +** and remove a line
   with the bin icon. At the top of the cart pick the **order type** —
   **ทานที่ร้าน / กลับบ้าน / เดลิเวอรี** (choosing *takeaway* or *delivery* drops any
   attached table and still fires the order to the kitchen at checkout), and set the
   **จำนวนลูกค้า (guest count)** for dine-in. Tick **ค่าบริการ** to add a manual
   **service charge** (default 10%, editable) — it shows live on the cart and the
   receipt, is **VATable** (posts to service income), and is force-applied at the
   entered rate regardless of party size. Read **ยอดรวม / ค่าบริการ / VAT / สุทธิ** at
   the bottom. **พักบิล** parks the cart and **ล้างตะกร้า** clears it.
4. **Attach a table / buffet (optional).** Tap **แนบโต๊ะ** to tag the sale to a
   table — the order is then **fired to the kitchen (KDS)** at checkout and counts
   toward that table's room revenue. For full table-by-table service and buffet
   packages, open **บริการโต๊ะ/บุฟเฟต์ →** (the floor plan).
5. **Checkout.** Tap **ชำระเงิน** to open the payment screen (next section).

**Expected result:** A sale is settled with a sale number (e.g. `SALE-…`), the
receipt prints, the cash drawer opens for a cash sale, and any loyalty points are
recorded.

> **Manual keying (fallback).** `/pos/new` still offers a plain keyed form (Item
> ID / quantity / price) for unusual cases, and **รายการออเดอร์** (`/pos`) lists
> recent sales — but the register above is the day-to-day sell screen.

> **The orders list (`/pos`).** Above the list a quick **summary band** shows the
> **orders displayed**, **total sales**, **average per order**, and how many are
> still **awaiting / unpaid** — figured from the recent orders on screen (not an
> all-time total; the **Dashboard** carries those). Use the **search box** to find
> an order by number or customer name, and the **status chips** (**ทั้งหมด** /
> *Completed* / *Pending* …) to filter the list. These are view-only aids — they
> never change a sale. On a phone the band stacks and the table scrolls sideways.

[screenshot: /pos with summary band, search and status filter]

[screenshot: /pos/new with line items and Confirm Order button]

### Taking payment

On the register, **ชำระเงิน** opens a full payment screen:

1. Pick the **payment method**: **เงินสด** (cash), **QR พร้อมเพย์**, **บัตร**
   (card), or **โอน** (transfer).
2. **Cash** shows a **numeric keypad** and **quick-tender** buttons (**พอดี** /
   **฿100** / **฿500** / **฿1000**); the **เงินทอน** (change) is shown instantly
   (red if the amount is short).
3. **QR พร้อมเพย์** shows a **scannable PromptPay QR for the exact amount** — the
   customer scans it in their banking app; press **ยืนยันชำระเงิน** once paid.
   *(Needs a PromptPay ID configured for the business; otherwise the screen
   explains it isn't set.)*
4. An optional **ส่วนลดบิล %** discounts the whole bill before VAT.
5. **ยืนยันชำระเงิน** settles the sale.

> The legacy keyed form (`/pos/new`) records a sale without this screen; choose
> the method and amount there instead.

> **Card payments:** when a payment provider is configured (Opn/Omise or Stripe —
> see `OPN_SECRET_KEY` / `STRIPE_SECRET_KEY`), a Card tender is charged for real
> through the card terminal. If the card is **declined** the tender comes back as
> **Failed** (the sale is not marked paid) and the declined attempt is recorded —
> ask for another card or payment method. Without a provider configured the system
> uses a safe test gateway (no real money moves), so card tenders in a demo
> environment always succeed.

**Expected result:** The payment is captured and a receipt can be printed or
sent.

### Selling when the internet is down (offline)

The register keeps working if the network drops. A badge in the top bar shows
**ออนไลน์** or **ออฟไลน์ — บันทึกในเครื่อง**.

- While **offline**, ring up a **quick cash sale** as usual. On payment the screen
  confirms **บันทึกออฟไลน์แล้ว** — the bill is stored safely on the device. (It does
  not yet have a sale number or a printed receipt; those are issued when it syncs.)
- A **รอซิงค์ N** button shows how many bills are waiting.
- When the connection returns, the register **automatically sends the waiting bills**
  to the server (you can also tap **รอซิงค์** to sync now). Each bill is posted
  **exactly once** — re-sending never creates a duplicate. The synced sale then
  appears in **รายการออเดอร์** with its real sale number.

> **Table (dine-in) sales need the internet** (the kitchen display and table state
> are live), so offline selling is limited to **quick sales**. If you're offline with
> a table attached, remove the table and ring it as a quick sale. *(Control BRANCH-03 —
> no offline sale is lost or double-counted.)*

[screenshot: register offline badge + รอซิงค์ pending bills]

### Printing / sending the receipt

**Screen:** `/print` (**ใบเสร็จ & งานพิมพ์**) · **Required permission:** `pos` /
`order_mgt`.

When a sale is settled the **customer receipt is queued for printing
automatically**. A receipt is a courtesy document over the sale — the
**abbreviated tax invoice** is the official fiscal record — so reprinting a
receipt never changes the accounts.

How printing works:

- **Automatic print.** A receipt-printer or a small in-store print agent **pulls
  the next queued job**, prints it, and reports back. Failed jobs are retried
  (up to 5 times) before being marked **failed**. The queue and each job's
  status (queued / sent / printed / failed) are visible on the **ใบเสร็จ &
  งานพิมพ์** screen.
- **View / print on screen.** Enter the sale number (SALE-…) and click **เปิดดู /
  พิมพ์** to open the receipt in a window and print it from the browser.
- **Reprint.** Click **พิมพ์ซ้ำ (สำเนา)** to re-queue the receipt. The first
  issuance is the original; **every later copy is marked สำเนา / COPY**.
- **Send electronically.** Pick a **channel** (**LINE / SMS / อีเมล**), enter the
  customer's contact (LINE User ID, phone, or email) and click **ส่ง** to deliver
  the receipt out-of-band. LINE delivery uses the shop's LINE Official Account when
  it is configured; otherwise the message is logged for the demo. Every send is
  recorded in the message log.
- **Service charge line.** A receipt **itemises a ค่าบริการ (service charge) line**
  whenever the sale carries one (large-party dine-in); retail sales show none.

**Expected result:** The customer gets a printed or electronic receipt; the
receipt always **ties out** to the fiscal sale (line total − discount + service
charge + VAT + tip = total).

> **Troubleshooting:** “SALE_NOT_FOUND” — the sale number is mistyped or belongs
> to another branch/tenant. If a job stays **queued**, the printer/agent isn't
> pulling — check it is online and pointed at this outlet.

### Favourites quick-access grid (★ รายการโปรด)

Star any menu item to pin it to your personal **Favourites** tab for one-tap access
during a busy shift.

**To add an item to Favourites:**
- Hover over the item card in the menu grid — a ★ icon appears in the top-left corner.
- Click / tap the ★ to star it (it turns gold). Tap again to unstar.

**To browse your Favourites:**
- Click the **"★ รายการโปรด"** chip at the left of the category bar.
- Only your starred items appear. If the grid is empty, no items are starred yet.

Your favourites are **saved to your account** (via `PUT /api/user-prefs`) and sync
across devices — a barista who stars espresso drinks on tablet sees the same list
on the counter POS. Up to 200 items can be starred.

---

### Cashier speed: quick-tender, change & hotkeys

- **Register checkout** (`/pos/register`): the cash screen has a **numeric keypad**
  and **quick-tender** buttons (**พอดี** / **฿100** / **฿500** / **฿1000**), with
  the **change** (**เงินทอน**) shown instantly (red if not enough), plus a
  **scan-to-add** box and **barcode** support for adding items hands-free.
- **Keyed form** (`/pos/new`): **F2** adds a line and **F9** confirms — so a
  cashier can ring up a manual sale without leaving the keyboard.

### Pricing rules, service charge & rounding

At checkout you can apply the shop's **pricing rules** automatically
(happy-hour %, buy-one-get-one, quantity breaks, item/category discounts) instead
of keying discounts by hand — turn on **apply pricing rules** at checkout. For
large parties an **auto service charge** is added (a VATable ค่าบริการ that the
receipt lists as its own line), and the bill can be **satang-rounded** to a
cash-friendly total. Cashiers *apply* rules; only Pricing/Marketing roles may
*create* them (segregation of duties).

This applies to **both** the **dine-in** checkout and the **retail portal POS**
(`POST /api/portal/pos/sales`). For the retail path, pass the following optional
fields alongside `apply_pricing: true`:

| Field | Purpose |
|---|---|
| `service_charge_pct` | Service charge rate (e.g. `10` for 10%). Added to the VAT base (→ acct 4400). |
| `service_min_party` | Minimum party size to trigger the charge (default 6). |
| `rounding` | Round the total to the nearest step (e.g. `1` for whole baht; 0 = disabled) → acct 4900. |

The response includes `service_charge` and `rounding_adjustment` alongside the existing
`pricing_discount` field. Without `apply_pricing`, the path is unchanged (backward-compatible).

**Building rules (`/pricing` — กฎราคา & โปรโมชั่น).** Pricing/Marketing roles define
rules on the **กฎราคา** tab: a labelled form for the **rule name**, **type** (ส่วนลด
% / บาท, ราคาตายตัว, ซื้อ 1 แถม 1, ลดตามจำนวน), **scope** (รายสินค้า / หมวด / ทั้งบิล)
and target, **channel**, **value**, **minimum quantity**, an optional **day-of-week**
and **time window** (e.g. happy hour), a **priority**, and whether it **stacks** with
other rules. The **ทดลองคำนวณ** tab prices a sample basket so you can see which rules
apply before going live, and **ชุดเซ็ต (Combo)** defines set-menu components. The
forms reflow to a single column on phones.

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

Staff can also start a buffet for guests from the floor: on the **โต๊ะ** screen
pick **เริ่มบุฟเฟต์**, choose the tier and number of diners, and confirm — the
per-head charge and time window start just as with QR self-start.

**Moving a table.** If guests change seats, open the table and tap **ย้ายโต๊ะ**,
pick a free table, and confirm — the whole tab (order + bill) moves across, the
old table is freed and the new one becomes occupied.

**Merging tables.** To combine two tabs onto one bill (e.g. two tables join up),
open the table you want to keep and tap **รวมโต๊ะ**, then pick the other table —
its items move onto this table's order, the other table is freed, and you settle
one combined bill. (Buffet tables can't be merged.)

**Transferring items.** To move individual dishes between tabs (e.g. an item
rung on the wrong table), open the table and tap **ย้ายรายการ**, tick the
dishes, pick a table that has guests, and confirm — the chosen items and their
charges move to that table's bill.

**Arranging the floor plan (เพิ่ม / ย้ายตำแหน่ง / ลบโต๊ะ).** On the **โต๊ะ** screen
open the **ผังร้าน** tab. Type a table number (e.g. *A1*) and tap **เพิ่มโต๊ะ** to
add it. Tap **แก้ไขผัง** to enter edit mode, then **drag** any table to lay the plan
out like your real dining room, and tap the **🗑 (ถังขยะ)** badge on a table to
remove it; tap **เสร็จสิ้น** when you're done. (This *ย้ายตำแหน่ง* — moving the table
icon on the plan — is different from **ย้ายโต๊ะ** above, which moves a guest's whole
tab to another table.) Deleting is safe: the table is hidden from the plan but its
past orders, bills and tax records stay intact. You **can't delete a table while
guests are seated** (*โต๊ะมีลูกค้าอยู่* — clear or check it out first); you can also
delete from the table panel with **ลบโต๊ะนี้** when the table is free. Made a wrong
move? Tap **เลิกทำ** to undo your last layout changes. And when you drag a table
**into a room**, it joins that room automatically (no need to set it by hand).

**Rooms & VIP areas.** Still in **แก้ไขผัง**, you can group tables into **rooms**.
Type a room name (e.g. *VIP*, *ระเบียง*, *ชั้น 2*), pick an accent colour and tap
**เพิ่มห้อง**. Drag a room by its **title bar** to move it and drag its **corner**
to resize it, so the plan matches your real dining room. Each room has small
buttons: **🎨** changes its colour (a **gold** room reads as a VIP area), **✎**
renames it, and **🗑** removes it. **Deleting a room never deletes its tables** —
they simply stop belonging to a room. To put a table in a room, tap the table (in
edit mode) and choose the room under **ห้อง:** in the small panel that appears
(pick **ไม่มีห้อง** to take it out again).

**Table shapes & sizes.** Tap a table in **แก้ไขผัง** to open its panel and make it
match the real one: pick a **รูปทรง** (**วงกลม** round / **สี่เหลี่ยมผืนผ้า** / **จัตุรัส**),
set the **ที่นั่ง** count, **หมุน** it left/right (handy for corner or wall tables),
and drag its **corner** to resize — so a small 2-seater and a long 8-seater look
different at a glance on the plan.

**Watching tables by room.** Once tables are in rooms, the **สถานะโต๊ะ** tab groups
them by room — each room shows how many tables are busy (e.g. *VIP · 2/4*), and you
can tap a room chip at the top to watch just that area. (Tip: the floor plan now
**snaps to a grid** as you drag, so rows of tables line up neatly.)

**Faster setup & shortcuts.** To copy a table you've already styled, select it and
tap **ทำซ้ำ** — you get an identical table (same shape, size, seats and room) to
drop into place. With a table selected you can also nudge it with the **arrow keys**
(hold **Shift** for fine 1-pixel steps) or remove it with **Delete**. For a big
restaurant the plan **scrolls** as you add more tables, so there's always room.

**Revenue by room.** The **รายได้ต่อห้อง** tab shows how much each room earned over a
date range (defaults to today). Pick **ตั้งแต่ / ถึง** and you'll see total takings,
the number of bills and the average per bill for every room (and for tables in no
room), ranked by revenue — handy for checking whether the VIP room pulls its weight.
These figures **stick to the room where each sale actually happened**: if you move a
table to a different room later, past takings stay put (and a room you delete still
shows its earlier sales, marked *(ลบแล้ว)*).

Manage tiers in **บุฟเฟต์ (แพ็กเกจ)** (back office): set the code, per-head price,
time limit, optional overtime fee, and the menu SKUs included. Creating/editing
tiers is a master-data task (separate from front-of-house roles).

The **พฤติกรรมตามแพ็กเกจ** tab on the same page shows, for each tier, how guests
actually behave: the **most-ordered dishes**, number of **sessions and covers**,
**dishes per head**, **average bill per session**, and how often tables run into
**overtime** — so you can tune pricing, time limits and the dish line-up per tier.

### Reservations & walk-in waitlist

**Screen:** `/reservations` (**จองโต๊ะ & รอคิว**) · **Required permission:** `pos` /
`order_mgt`.

Take **bookings** for a future time and manage a **walk-in queue** in one place,
and let the system **text the guest when their table is ready**.

- **Book a table (จองล่วงหน้า).** Choose **จองล่วงหน้า**, fill in the guest's name,
  phone, party size and **time** (optionally a specific table), then **จองโต๊ะ**. If
  you pick a table it's held as **reserved** so no one else seats it.
- **Add a walk-in (รับเข้าคิว).** Choose **รับเข้าคิว**, enter the name, phone, party
  size and an optional **estimated wait** (minutes), then **เข้าคิว**.
- **Tell the guest it's ready.** Tap **แจ้งโต๊ะพร้อม** — the guest gets a **LINE or SMS**
  "your table is ready" message (LINE if they're a linked member, otherwise SMS to
  the phone). The entry turns **พร้อมแล้ว**.
- **Seat them.** Tap **รับเข้านั่ง** — the assigned table becomes **occupied**; ring the
  order on the register/table as usual.
- **No-show / left the queue.** Tap **ไม่มา** (reservation) or **ออกคิว** (walk-in) to
  close it — any table you were holding is freed back to **available**.

The top cards show how many guests are **waiting**, how many tables are **booked**,
and the total **covers** you still have to seat — a quick read on how busy the next
hour will be.

**Day-parting (time-limited menus).** When adding a menu item in **เมนูอาหาร**
you can set a **ช่วงเวลาขาย** (selling window) — a start/end time and which days
of the week — for breakfast, lunch or happy-hour items. Outside that window the
item shows **ยังไม่ถึงเวลาขาย** and can't be ordered (by staff or guests); leave
the window blank to sell it all day. Times follow shop time (Asia/Bangkok).

**Courses (serve in stages).** When taking an order you can set a **คอร์ส**
number for the dishes you add (e.g. 1 = appetisers, 2 = mains, 3 = dessert). On
the table you can then **ส่งเข้าครัว (ทั้งหมด)** to fire everything, or type a
course number and tap **ส่งคอร์ส** to fire just that course — the rest stay held
until you fire them. The KDS shows each ticket's course and lists them in course
order, so the kitchen cooks in the right sequence.

**Live across every screen.** The KDS and the **โต๊ะ (tables)** board update in
**real time** — when one terminal advances a dish (เริ่มทำ → เสร็จ → เสิร์ฟ) or a
table is seated/cleared, every other screen reflects it at once, without waiting for
a refresh. A small **เรียลไทม์ / กำลังเชื่อมต่อ…** badge shows the live status; if the
connection drops it falls back to a periodic refresh automatically.

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

### Print or email a delivery note (ใบส่งของ)

**Screen:** `/delivery` · **Required permission:** `delivery`

On the **การจัดส่ง** (`/delivery`) list, each delivery order (`DO-…`) has two actions in
the **เอกสาร** column:

- **🖨️ พิมพ์ / เปิด PDF** — opens the delivery note (a packing slip with the ship-to
  address, driver/vehicle and the item lines — no prices) as a PDF in a new tab.
- **✉️ ส่งอีเมล** — prompts for the customer's email and sends it **as a PDF attachment**
  (needs the shop's mail account configured, same as the other documents).

> The delivery note is for goods movement and the customer's receiving signature — it
> carries no prices and posts nothing to the ledger.

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

**Required permission:** `returns` to view/process the return; `pos_refund` to
issue the refund or authorize a pending request (held by *ReturnsClerk*,
*PosSupervisor*, *Admin*).

> **Note — separation of duties (R08/R12):** The person who **rang up** the sale
> should not be the one who issues the refund. POS Supervisors hold the refund
> right (`pos_refund`); cashiers (`pos_sell`) do not. The **"บันทึกคืนสินค้า"**
> button on `/returns` is hidden from `pos_sell`-only cashiers. For the **refund
> authorization queue** (large refunds routed for supervisor approval), use the
> dedicated **อนุมัติการคืนเงิน** screen (`/pos/refunds`) — see §5.1 below.

### To process a return

1. Open the **Returns Register** (`/returns` — **คืนสินค้า & คืนเงิน**).
2. Click **"บันทึกคืนสินค้า"** (top right).
3. Enter the **Sale No.** (e.g. `SALE-0001-…`) and click **ค้นหา**. The original
   sale lines appear.
4. Set the **return quantity** for each item you want to return (0 = keep; up to
   the quantity sold).
5. Choose the **Refund Method** (**วิธีคืนเงิน**): เงินสด (Cash) / บัตร (Card) /
   QR / พร้อมเพย์ (PromptPay) / เครดิตร้าน (Store Credit) / ไม่คืนเงิน (None).
6. Optionally enter a **reason**.
7. Click **บันทึกคืนสินค้า** to confirm.

**Expected result:** A return record is created (`RTN-…`) with a refund
reference, the stock is restocked, and the accounting reversal is posted
automatically. The dialog shows the RTN number, total returned and refund method.

> **Note — over-return guard:** You cannot return more than was originally sold.
> The server enforces this — entering a qty above the sold qty is capped in the UI
> and rejected server-side (`OVER_RETURN`).

> **Big refunds need a manager's OK.** A **standalone refund** (refunding a payment
> directly, not as part of a product return) of **฿1,000 or more** doesn't go through
> straight away — it's **held for approval**. A **different** person (a manager) opens
> **รายการรออนุมัติ** (`/approvals`) and taps **อนุมัติ** to release it (or **ปฏิเสธ**).
> The person who asked for the refund **can't approve their own** — this stops refund
> fraud. Refunds under ฿1,000, and refunds that come with a **product return**, go
> through immediately as before. (Control **REV-16**.)

[screenshot: return dialog with item lines and refund method]

### Returns register (all returns)

**Screen:** `/returns` (**คืนสินค้า & คืนเงิน**) · **Required permission:** `returns` /
`pos` / `order_mgt`.

To review **all** returns across the store — not just one sale — open the **Returns
Register**. It lists every return with its date, original sale, **refund method**,
**amount returned**, **restock status**, and the linked **journal entry / credit note**,
with KPI cards (count · total refunded · how many were restocked). Search by return or
sale number, filter by refund method, and click any return to see its line items and the
full breakdown (subtotal / VAT / total). The register is **store-scoped** — each tenant
sees only its own returns. Use it for daily reconciliation and to watch refund volume for
leakage.

The **"บันทึกคืนสินค้า"** button (top right) opens the create-return dialog directly
from this screen — enter the sale number, pick items and quantities, choose the refund
method, and submit. See "To process a return" above for the full flow. **Cashiers
(`pos_sell` only) do not see this button** — creating a return requires `pos_refund`
(POS Supervisor or Returns Clerk).

### 5.1 Refund authorization queue

**Screen:** `/pos/refunds` (**อนุมัติการคืนเงิน**) · **Required permission:** `pos_refund`
(held by *PosSupervisor*, *Admin*) — **not** accessible to `pos_sell`-only cashiers (SoD R08/R12).

Large standalone refunds (฿1,000 +) are routed to a **pending queue** instead of
processing immediately. The **Refund Authorization** screen shows all pending requests
by default (filter to Approved / Rejected / All). For each pending request:

1. Review the **sale number**, **payment number**, **amount**, and **reason**.
2. Click **อนุมัติ** (approve) — the refund is issued immediately.
3. Or click **ปฏิเสธ** (reject) — enter a reason; the request is closed without issuing.

The maker-checker rule still applies: **the person who submitted the refund request
cannot approve their own request** (the API blocks it with `SOD_VIOLATION`).

### Gift-card / store-credit register

**Screen:** `/giftcards` (**บัตรของขวัญ / เครดิตร้าน**) · **Required permission:**
`pos` / `creditors` / `exec`.

Cards are **issued at the register** (sold for cash, or minted as store-credit on a
return) — this screen is where you **see them all**. The **Gift-card Register** lists
every card with its initial value, **current balance**, status (**ใช้งานได้** Active /
**ใช้หมดแล้ว** Redeemed / **ยกเลิก** Void), who issued it and when. The KPI cards show
the card count, how many are still Active, and — most important for finance — the
**ยอดคงค้างรวม (outstanding liability)**: the sum of all Active balances, which is the
store's unredeemed obligation carried in GL account **2200 (เงินรับล่วงหน้า)**. Filter by
status or search a card number, and click **ประวัติ** on any card to see its full
transaction history (issue / redeem / store-credit top-up) with the running balance and
the linked sale. The register is **store-scoped**. Use it to look a customer's card up,
and to tie the outstanding balance out to the GL at period close.

> **Big gift cards need a finance approver's OK (maker-checker).** Because a gift card is
> cash-equivalent stored value, issuing one **above ฿5,000** doesn't go live at the till
> straight away — the card is created **รออนุมัติ (pending approval)** and holds **no value**
> yet (it **can't be redeemed** — a redemption attempt is refused with **GIFT_CARD_INACTIVE**).
> A **different** person with finance oversight of the liability (a *creditors* or *exec*
> holder, **not** the cashier who issued it) approves it — this posts the accounting
> (Dr 1000 Cash / Cr 2200 Customer Deposits) and turns the card **active** and spendable. The
> person who issued the card **can't approve their own** (the system blocks it with
> **SOD_VIOLATION**), and approving a card that isn't pending returns **NOT_PENDING**. Cards
> of **฿5,000 or less** still issue **instantly** as before, so everyday sales stay fast.
> Store credit minted from a **return** is unaffected — it's already controlled by the return
> flow. (Control **GC-01**; SoD **R14**.)

---

## 6. Opening & closing the till (cash drawer) + Z-report

**Screen:** `/pos/till` (**จัดการลิ้นชัก**) · **Required permission:** `pos_till`
(held by *PosSupervisor*, *Admin*) — **not** accessible to `pos_sell`-only cashiers (SoD R08).

The **Till Management** screen is the POS Supervisor's central view for live cash drawer management:
- **เปิดลิ้นชักใหม่** — open a new till session with an opening float.
- View all open/closed sessions with gross sales, expected cash, counted cash, and variance.
- **Variance approval** (POS-01): sessions closed with a large cash over/short appear as **"ผลต่าง"** — the Supervisor reviews and approves/rejects (a different person from the cashier who closed, enforced by the API).
- Close-of-day Z-report signing is on the separate `/pos/close-of-day` screen (`pos_close` permission).

> **Banking the safe cash.** When you move cash from the drawer to the safe during a
> shift (a **drop**), it's tracked as **cash in the safe** until it's banked. The
> finance/treasury team opens **นำเงินสดฝากธนาคาร** (`/cash-banking`), where the top card
> shows how much cash is sitting in the safe; they pick a bank account and tap
> **นำฝากทั้งหมด** to record the deposit (the books move the cash from on-hand to the
> bank), then **กระทบยอด** once it shows on the bank statement. The person who drops the
> cash **can't** bank it — that's a separate finance role (control **REC-05**).

### Signing in at the till — PIN quick-login & "เข้าสู่ระบบ / เปิดกะ"

**Screen:** `/login` (tab **"PIN หน้าร้าน"**)

On a shared front-of-house terminal you don't have to type a full password each
time. The login page has a **"PIN หน้าร้าน"** tab with a **numeric keypad**:

1. Enter your **username** and tap your **4–6 digit PIN** on the keypad.
2. To open your drawer in the same step, tick **"เปิดกะเมื่อเข้าสู่ระบบ"** and enter
   the **opening float**.
3. Tap **"เข้าสู่ระบบ / เปิดกะ"** — you're signed in, and (if you ticked the box and
   you hold the till right) a new till session opens.

> **Note — opening the shift needs the till right (R08).** A plain cashier
> (`pos_sell`) is **signed in** but the drawer is **not** opened — a **POS Supervisor**
> (`pos_till`) is the one who opens the shift. If a shift is already open for your
> shop, signing in with the box ticked **won't open a second one** — you join the
> existing till.

> **Note — privileged & finance accounts can't use a PIN.** For security, anyone
> whose role needs **MFA** (Admin and finance/access-admin roles) must sign in with
> their **password + MFA** and cannot set or use a PIN. The PIN is only for
> front-of-house roles (Cashier, POS Supervisor).

#### Setting your own PIN — "ตั้ง PIN หน้าร้าน"

**Screen:** `/pos-pin` (**ตั้ง PIN หน้าร้าน**, under **POS** in the menu).

Set or change your own till PIN at any time:

1. Open **ตั้ง PIN หน้าร้าน**.
2. Enter your **current password** (to prove it's you), then your new **4–6 digit PIN**.
3. Save — the PIN is stored securely (scrambled, never in plain text) and works at the
   next sign-in.

> Managers and admins can also set or clear a staff member's PIN from the **Users**
> page (`/admin/users`) using the **"ตั้ง PIN"** action next to each user (requires
> the `users` permission). Clearing a PIN turns off PIN sign-in for that person until
> a new one is set.

> **Troubleshooting — PIN sign-in:**
> - **"PIN ไม่ถูกต้อง" (wrong PIN)** — the username/PIN didn't match. The message is
>   deliberately generic; check the PIN and try again.
> - **"บัญชีถูกล็อกชั่วคราว" (account locked)** — too many wrong PINs in a row locked the
>   account for a short while (the **same** lockout as wrong-password login). Wait and
>   retry, or have a manager reset the password/PIN.
> - **"บัญชีนี้ต้องเข้าสู่ระบบด้วยรหัสผ่าน" (`PIN_NOT_ALLOWED`)** — this is a
>   privileged/finance account; it can't use a PIN. Sign in with **password + MFA** on
>   the normal login tab instead.
> - **Setting your PIN fails with a current-password error (`BAD_CURRENT_PASSWORD`)** —
>   the current password you typed on **ตั้ง PIN หน้าร้าน** is wrong; re-enter it.

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

#### Signing the Z-report (close-of-day archive)

**Screen:** `/pos/close-of-day` (**ปิดกะ (Z-Report)**) · **Required permission:** `pos_close`
(manager) — separate from the cashier's `pos_till`.

After a till is **closed**, a manager **signs** the Z-report to lock it into a permanent,
**tamper-evident** record. Enter the closed session's id (**TILL-…**) and click **ลงนาม Z-Report**.
The signed report snapshots the shift's totals and the denomination count and stamps a
**content-hash**. Re-signing the same session just returns the existing record (you can't create a
second Z-tape). The archive list shows every signed Z with a **ความถูกต้อง** badge — **ถูกต้อง**
(hash matches) or **ถูกแก้ไข** (the stored figures were altered after signing), so an auditor can
prove the day's takings as originally counted. You can only sign a **closed** till, and a sell-only
cashier cannot sign.

#### Cash over/short — what happens to a variance

When you close the till, the **over or short is automatically booked to the
accounts** (GL account **5830 Cash Over/Short**) so the books match the cash you
actually counted — you don't post anything by hand.

- A **small** variance (under **฿100**) is recorded straight away; the shift is done.
- A **large** variance (**฿100 or more**) still closes the drawer, but the
  over/short is held as **"รออนุมัติ" (pending approval)**. It then appears in the
  **รายการรออนุมัติ** screen (**`/approvals`**), where a **manager — a different
  person from the one who closed** — reviews it and taps **อนุมัติ** (approve) or
  **ปฏิเสธ** (reject). The cashier **cannot approve their own** big discrepancy
  (the system blocks it — *แบ่งแยกหน้าที่ / segregation of duties*). Rejecting
  leaves the discrepancy flagged for follow-up.

> This protects against a shortage being quietly written off by the same person
> who caused it. (Control **REV-13**; the held item also rolls up in the
> system-wide pending-approvals monitor, **GOV-01**.)

[screenshot: Z-report showing expected vs counted cash and variance]
[screenshot: /approvals — manager approving a large cash variance (รออนุมัติ → อนุมัติ)]

---

## 7. Claims (sales claims)

**Screen:** `/claims` · **Required permission:** `claim_mgt`

1. Go to **Claims** (`/claims`) → **Sales Claims** tab.
2. Open a claim that is **Waiting**.
3. Choose **Approve** or **Reject** (add a reason if rejecting).

**Expected result:** The claim status changes to *Approved* or *Rejected*.

> **Finding a claim.** Each claim list (sales and supplier/GR) has a **search** box
> (order / GR number, item or reason) and **status filter chips** to narrow a long
> list before you act. They reflow for mobile.

(Supplier / goods-receipt claims are covered in [Procurement](./03-procurement.md).)

---

## 8. Customer messaging & birthdays (CRM)

On the **CRM 360** screen you can reach out to members:

- **Birthdays:** see who has a birthday today / this month, for a "happy
  birthday" offer.
- **Send a message** to a group — **วันเกิดวันนี้** (today's birthdays), an
  **RFM segment** (Champions, Loyal, At Risk, …), or **all members** — over
  **SMS / LINE / email**, then read the delivery log.
- **LINE members:** a customer can become a member by signing in with **LINE**
  (LIFF / LINE Login). The shop links their LINE account to their membership, and
  from then on **LINE messages reach them directly in LINE** (not their phone), and
  you can look a member up by their LINE account. One LINE account links to one
  member.

Two things to know: a member must have **opted in** to marketing (set when you
enrol or edit them) — anyone opted out is automatically skipped and never
contacted; and the channel sends for real only when its provider is configured —
**LINE** delivers via the LINE Messaging API once a channel token is set, while
SMS/email stay **mock** until their provider is added. The log shows the provider
(`line` vs `mock`) on each row, so you can rehearse campaigns safely and confirm
which sends were live.

### Automated LINE campaigns (with redemption tracking)

The **แคมเปญ LINE (Automation)** screen (`/campaigns`) goes one step further: pick a
**target group** — ลูกค้าห่างหาย (haven't visited in a while), วันเกิดวันนี้, or
**ดึงกลับ (win-back)** the at-risk/lost segment — set a discount, and press send. Each
chosen member gets their **own coupon code** pushed to LINE (opted-out members are
skipped automatically). When a customer later **uses that code at the till**, the
system records the redemption against the campaign — so the list shows each campaign's
**redemption rate and the revenue it brought back**, closing the loop from message to
sale. You can also ask the AI assistant *"ลูกค้าห่างหายมีกี่คน?"* to size a group
before sending.

---

## 9. Hardware peripherals (cash drawer, customer display, scale)

**Screen:** `/peripherals` (**อุปกรณ์ฮาร์ดแวร์**) · **Required permission:** `pos` /
`order_mgt`.

Register each outlet's hardware once (printers, cash drawers, customer displays,
scales) under **ทะเบียนอุปกรณ์**, tagging the **terminal** each belongs to and —
for a cash drawer — the **printer** that opens it.

### Connecting hardware to the register (⚙ ตั้งค่าเครื่อง)

For a **Windows PC + USB receipt printer** setup, pair the hardware straight from
the register: on `/pos/register` (Chrome or Edge) open **⚙ ตั้งค่าเครื่อง**:

- **รหัสเครื่อง (Terminal).** Set this terminal's code (e.g. `T01`). It pairs the
  **customer display** and tags every **cash-drawer open** to this terminal for the
  Z-report.
- **Receipt printer.** Choose how receipts print:
  - **ผ่านไดรเวอร์ (recommended)** — prints the 80 mm slip through the Windows
    print driver. Thai text always renders correctly; works with any installed
    thermal printer (no extra setup).
  - **ตรง USB (ESC/POS)** — sends raw bytes straight to a USB-connected printer
    (fast, no print dialog). Click **ต่อเครื่องพิมพ์ USB** and pick the printer
    once; the browser remembers it. *(Thai rendering on this mode depends on the
    printer's code page.)*
  - **ทดสอบพิมพ์** prints a short self-test.
- **Cash drawer.** The drawer **opens automatically on a cash sale** when a USB
  printer is connected (it pulses the drawer wired to the printer). **ทดสอบเปิด
  ลิ้นชัก** opens it on demand; every open is logged for reconciliation.
- **Customer display.** **เปิดจอลูกค้า** opens the second-screen page for this
  terminal; during a sale it mirrors the cart, total and change in real time.

> WebUSB (the **ตรง USB** mode and the drawer pulse) works on **Chrome / Edge on a
> computer**; on a browser without it, the register hides those controls and uses
> **print-through-driver** instead.

- **Cash drawer (ลิ้นชักเก็บเงิน).** A cash sale **opens the drawer
  automatically**. To open it without a sale (e.g. to make change), use
  **เปิดลิ้นชัก (No-sale)** — this is **always logged**. The drawer tab shows
  every open by reason and counts **no-sale** opens, which managers reconcile
  against the **Z-report** at close. *(Control: every drawer open is recorded
  with who/when/why and the till session.)*
- **Customer-facing display (จอลูกค้า).** Open **เปิดจอลูกค้า** on the screen
  that faces the customer; it shows the live cart, total, amount due and change
  as you ring up. It refreshes by itself.
- **Weighing scale (เครื่องชั่ง).** First mark an item **sold by weight** (its
  price becomes the price per kg/100 g). At the counter, enter the weight on the
  **เครื่องชั่ง** tab (or read it from a connected scale) and the system computes
  the line price from the catalog — staff can't override the per-kg price.

**Expected result:** Drawers open at the right moments and are fully audited;
the customer sees their order on a second screen; weighed items are priced
accurately from the scale.

> **Troubleshooting:** “NOT_WEIGHED” — the item isn't flagged sold-by-weight;
> “DEVICE_NOT_FOUND” — register the device (or send a heartbeat from the agent)
> first. If the drawer doesn't open, check the linked printer is online (the
> open is still logged either way).

---

## 10. Tips — pooling & paying out staff

**Screen:** `/tips` (**ทิปพนักงาน**) · **Required permission:** `pos` /
`order_mgt` to view; **only a manager** (`order_mgt` / `exec`) can pay tips out.

Tips a guest adds at checkout are **kept aside for staff** (they're not the
shop's income). They build up as **ทิปค้างจ่าย** (a balance the shop owes staff);
the top card shows how much is currently held.

To **pay tips out**:

1. Pick the **period** (ตั้งแต่ / ถึง) — the screen shows the **ยอดแบ่งได้**
   (how much is available to share for that period).
2. Choose how to split: **เท่ากันทุกคน** (equal), **ตามชั่วโมงทำงาน** (by hours),
   or **ตามน้ำหนัก** (by weight).
3. List the staff — one per line; for hours/weight add the number after the
   name (e.g. *สมชาย 6*). Tap **แบ่งจ่ายทิป**.

The system records who got how much, **pays it from the cash drawer**, and clears
that much from the held balance. You **can't pay out more than was collected**,
so the held figure always matches what's still owed.

> **Why only a manager?** The person who rings sales can't also pay out the tips
> (so they can't quietly pay tips to themselves). That separation is a control
> (**TIP-01**).

## 11. Deposits, house accounts & card surcharge

**Screen:** `/payments/accounts` (**มัดจำ & บัญชีเครดิต**) · **Required
permission:** `pos` / `order_mgt` (opening a credit account needs a
manager — `order_mgt` / `exec`).

- **Deposits (มัดจำ).** Take a prepayment for a booking or open tab — it's held
  as a liability, not yet income. Later **ใช้ (apply)** it to the sale (income is
  recognised then) or **คืน (refund)** the unused balance. You can never apply or
  refund more than what remains.
- **House / charge accounts (บัญชีเครดิต).** Open a running credit account for a
  regular/B2B customer with a **credit limit**. **Charge** a sale to it (it
  becomes a receivable) — a charge that would exceed the limit is **blocked**.
  **Settle** the account when they pay; you can take payment in a **foreign
  currency** (enter the currency, rate and amount tendered) and the system books
  the **FX gain/loss** automatically. **รายการ (statement)** shows every charge
  and payment with the running balance and remaining credit.
- **Card surcharge (ค่าธรรมเนียมบัตร).** Set a percentage per payment method;
  **quote** shows the surcharge for an amount, and charging it records VATable
  surcharge income.

**Expected result:** Prepayments and customer credit are tracked with correct
accounting; the credit limit is enforced; foreign-currency settlement is
converted and any FX difference is recorded.

> **Troubleshooting:** “CREDIT_LIMIT_EXCEEDED” — the charge exceeds the account's
> limit (raise the limit or take part-payment first); “OVER_APPLY” / “OVER_REFUND”
> / “OVER_SETTLE” — the amount is more than what remains/owed.

---

## 12. Language (Thai / English)

The system can present customer-facing output in **Thai or English**.

- **Default language.** Set your shop's default under company settings
  (`default_language`). It drives receipts and other customer-facing output.
- **Receipts.** On the **ใบเสร็จ & งานพิมพ์** screen, pick the **receipt
  language** — *tenant default*, **ไทย**, **English**, or **ไทย / English**
  (bilingual) — before viewing, printing, or reprinting.
- **Diner QR menu.** Diners can tap **EN / ไทย** on the QR ordering page to switch
  the menu language (English names fall back to Thai when not set).
- **Web app.** Use the **language toggle** in the top bar to switch the app
  between Thai and English; your choice is remembered on that device.

**Expected result:** Thai and foreign customers each see receipts and menus in a
language they can read.

---

**Next:** [Customer Portal](./02-customer-portal.md) ·
[Finance — AR & AP](./05-finance-ar-ap.md)
