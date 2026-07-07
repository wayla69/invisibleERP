# 03 · Procurement

**Status: DRAFT v0.1**

This chapter covers the full buying cycle — purchase requisition (PR) → purchase
order (PO) → goods receipt (GR) → 3-way match — plus managing vendors.

> **The PR / PO / GR forms check your entries as you go.** When you press the
> create button, any problem is flagged **in place** — a red hint under the exact
> field or line: each line needs an **Item ID** and a **quantity greater than 0**,
> a **PO** additionally needs a vendor (name or code) and a non-negative unit
> price, and a **GR** needs the PO number. Fix the highlighted field and press
> again; a green toast confirms success.

**Each step is on its own screen, because each belongs to a different user group.**
This is deliberate separation of duties (the person who *orders* must not also
*receive* or *pay*):

| Step | Screen | Who / required permission |
|---|---|---|
| Raise a requisition (PR) | `/requisitions` | **Anyone in the company** — `pr_raise` |
| **Shop for items** (catalog → basket → checkout a PR) | `/shop` | **Anyone in the company** — `pr_raise` |
| Create / approve a PO | `/procurement` | **Procurement** — `procurement` |
| Print / send a PO (PDF) | `/procurement` (พิมพ์) | **Procurement / Planner / Exec / Warehouse** — view only |
| Receive goods (GR) | `/receiving` | **Warehouse** — `wh_receive` |
| 3-way match | `/procurement/match` | **Procurement / Accounting** — `procurement` |
| **Quick Capture a bill** (snap/upload → send to Accounting) | `/capture` | **Anyone in the company** — `pr_raise` |
| Scan invoice → PO match (AP intake) | `/procurement/ap-intake` | scan/map: `procurement`/`creditors`; **book the bill**: `creditors` |

> A PR only *requests* a purchase — it commits nothing, so anyone may raise one.
> Turning it into a real order (PO), and confirming receipt (GR), are restricted to
> the procurement and warehouse teams respectively.

> **Buying for a project (docs/32).** A requisition or PO can be raised **against a
> project** (and a specific **BoQ line**) so material spend is traceable to that
> project's budget — supply the project code on the PR/PO; an unknown code is
> rejected. The goods receipt inherits the PO's project. See
> [Project Management → BoQ](./14-project-management.md#bill-of-quantities-boq--materialworks-budget-docs32-m0).

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
| `pr <item> <qty>` — reason **optional**; several items separated by `,` (also `ขอซื้อ …`) | Raises a PR, e.g. `pr A4-PAPER 10` (no reason needed — most storefront orders are just "ran out"), or `pr A4-PAPER 10, TONER-85A 2`. **Multi-word names work** — `pr Iberico ham 2` (the quantity is the last number; everything before it is the item name). Add a reason only if you want: `pr A4-PAPER 10 ด่วน` |
| `status <PR no>` (also `สถานะ <PR no>`) | Replies the PR's current approval state |
| `my prs` (also `รายการของฉัน`) | Lists your 5 most recent PRs with statuses |
| `find <keyword>` (also `ค้นหา`) | Searches the item master so you can use real item ids |
| `cancel <PR no>` (also `ยกเลิก`) | Withdraws **your own** still-Pending PR |
| `stock <item id>` (also `สต็อก`) | Read-only on-hand balance by location |
| `low` (also `ใกล้หมด`/`สต็อกต่ำ`) | Lists items at/below their reorder point (on-hand vs `min_stock`) with a suggested top-up qty |
| `reorder` (also `เติมของ`/`เติมสต็อก`) | Raises **one** PR that tops up **all** low-stock items in a single tap (needs `pr_raise`) |
| `subscribe lowstock` / `unsubscribe lowstock` (also `รับแจ้งของใกล้หมด`) | Get a morning LINE alert whenever something is at/below its reorder point, with a one-tap **สั่งเติมทั้งหมด** button (needs `pr_raise`) |
| `spend [YYYY-MM]` (also `ยอดซื้อ`/`สรุปซื้อ`) | This-month purchase summary — total spend, top vendors, most-bought items (defaults to this month; add a month to look back). Needs `procurement`/`exec`/`dashboard` |
| `receive <PO no>` (also `รับของ`/`รับ`) | Receives **all** outstanding qty on an approved PO in one tap → creates the GR and closes the PO when fully received (needs `wh_receive`/`warehouse`/`procurement`; the PO must be Approved — EXP-03) |
| `receive <PO no> <item id> <qty>` | Receives a **partial** quantity of one item (qty is capped at what's still outstanding) — the rest stays open |
| `claim <PO/GR no> <qty> [เหตุผล]` (also `เคลม`) | Opens a **short/damaged goods claim** against the supplier (needs `procurement`/`wh_receive`); finish it on `/claims` |
| `expense <fund> <amount> [เหตุผล]` / `advance …` (also `เบิก`/`ยืมเงิน`) | Raises a petty-cash request — see [Finance](./05-finance-ar-ap.md) |
| `leave <from YYYY-MM-DD> <days> [เหตุผล]` (also `ลา`) | Raises an ESS leave request (needs `ess` + employee record) |
| `subscribe digest` / `unsubscribe digest` (also `รับสรุป`/`เลิกรับสรุป`) | Morning summary on LINE — see [Reports](./09-reports-and-analytics.md) |
| `ask <คำถาม>` (also `ถาม`) | Sales analytics answer (needs `dashboard`/`exec`/`masterdata`) |
| `บอท <ข้อความ>` (also `bot …`) | AI drafts a **PR, petty-cash expense/advance, or leave request** from free Thai (e.g. `บอท ขอเบิก 250 จาก PCF-01 ค่าน้ำแข็ง`, `บอท ขอลา 2 วัน ตั้งแต่ 2026-08-03`) — **always asks you to confirm before creating anything**; the confirmed draft runs the ordinary command with your own permissions |
| `approve <PR no>` / `reject <PR no> <reason>` (also `อนุมัติ`/`ปฏิเสธ`) | **Procurement only** — decides a pending PR through the normal approval engine |
| `help` (also `เมนู` / `ช่วยเหลือ` / `คำสั่ง`) | Shows the full command menu as a tidy grouped card |

> **Items without a code yet?** The `item id` in `pr` is free text — the PR line
> accepts anything, so you can order an un-coded item by its **name, spaces and all**
> (`pr Iberico ham 2`, `pr เก้าอี้บุนวมสำนักงาน 5`). The parser takes the **last number**
> as the quantity and everything before it as the item name (and anything after the
> number as an optional reason). Purchasing assigns the real item code when the PR
> becomes a PO.

### Shop for items — catalog → basket → checkout (`/shop`)

For an easier, shopping-style way to raise a requisition, use **เลือกซื้อสินค้า**
(`/shop`, ERP/POS nav → จัดซื้อ). It is the same requisition (a PR) as the form
above — just a friendlier front-end — so it needs only `pr_raise`, and what you
check out lands with Procurement for approval and PO conversion exactly like any
other PR.

**Screen:** `/shop` (**เลือกซื้อสินค้า**) · **Required permission:** `pr_raise`

1. **Browse the catalog (Grab/Shopee-style).** Products from the item register are
   shown as a **grid of picture cards** (with the item's photo, or a colour tile when
   it has none) — switch to a **list view** with the ⊞/☰ toggle (your choice is
   remembered). Tap a **category chip** along the top to filter, or use the **search
   box** (name or code). The grid **loads more as you scroll** — no page buttons.
   Each card also shows the item's **on-hand stock** (red **สินค้าหมด** when zero)
   and its **last purchase price**, so you can judge what to request at a glance.
   Tap the **⭐ star** on a product to save it as a **favourite**, then use the
   **รายการโปรด** chip to see just your favourites. Favourites now **follow you
   across devices** (synced to your account, like your sidebar pins) — star
   something on your phone and it's there on the desktop too.
2. **Add to basket.** Press **ใส่ตะกร้า** on a product to drop it in the basket;
   press it again (or use the **+ / −** steppers in the basket) to change the
   quantity.
3. **Flag urgent (priority).** Need it fast? Press the **⚡ ด่วน** button on the
   product (or on the basket line). Any urgent line makes the whole requisition go
   out as **priority "Urgent"** so Procurement can see it should be handled first.
4. **Can't find it? Ask for it in your own words.** If a product isn't in the
   register, use the **"ไม่มีสินค้าที่ต้องการ? พิมพ์ขอเพิ่มเองได้"** card to type the
   item you want (and a unit/quantity) — just like typing a request in LINE. It is
   added to the basket as a **ขอเพิ่ม (ไม่มีในทะเบียน)** line; Procurement assigns the
   real item code when it becomes a PO.
5. **Add a note (optional)** for Procurement — e.g. which branch, a preferred
   brand, or when you need it. You can also tag the request to a **project code**
   (an unknown code is rejected) and set a **ต้องการภายในวันที่ (needed-by)** date,
   both optional.
6. **Checkout.** Press **ส่งคำขอซื้อให้จัดซื้อ**. A green toast confirms the PR
   number; track its status on **คำขอซื้อ (PR)** (`/requisitions`) or the Approvals
   screen.

**Expected result:** One purchase requisition is created for every item in the
basket (urgent basket → PR priority **Urgent**), awaiting Procurement approval.

> **Top up what's running low.** When any item has fallen to/below its reorder
> point, a **สินค้าใกล้หมด** banner appears at the top of the catalog — expand it
> to see each low item (on-hand vs reorder point + a suggested top-up quantity),
> press **เติม** to add one at its suggested quantity, or **เติมทั้งหมด** to add
> them all to the basket at once.

> **Your basket is saved on this device** — if you refresh or navigate away
> mid-shop, the items are still there when you come back (it clears once you check
> out). On a phone, a **floating cart button** (bottom-right) shows how many lines
> you have and jumps straight to the basket.

> **Recurring order? Save it as a รายการประจำ.** In the **รายการประจำ** card, name
> the current basket and press **บันทึก** to save it; later press **โหลด** to drop
> that whole list back into the basket, or the bin icon to remove it. Handy for the
> monthly/weekly supplies you always request — saved templates (like your
> favourites) **sync to your account**, so they're available on any device you sign
> in from.

> **Got a barcode scanner? Just scan.** The **สแกนบาร์โค้ด** box beside the search
> field lets any USB/Bluetooth scanner (they type the code and press Enter) add an
> item hands-free. It first looks for an item whose **barcode** exactly matches the
> scan (set an item's barcode/GTIN in the item master), then falls back to matching
> the item code or name: an exact hit drops straight into the basket, an unknown
> code shows *ไม่พบสินค้า*, and if several items match the grid filters to them so
> you can pick. No app or camera setup needed.

> **Buying for a project? Shop into its budget.** If you work on projects, a
> **ซื้อเข้าโครงการ** picker appears in the shop header (and a *Shop for this project*
> button sits on the project page). Pick a project and you get a shop showing **only
> the items its approved budget (BoQ) allows**, each with its remaining budget. Add
> them and check out — this raises a **ใบขอเบิกวัสดุ (Project Material Requisition)**:
> if it's within budget it's fulfilled from stock or turned into a purchase
> requisition automatically; if it goes over a line's budget it's sent to an
> authorised person to approve first. **An item that isn't in the project's budget
> can't be added here.** This keeps project spend inside the approved budget by
> design (controls **PROJ-12/PROJ-13**).

> **Need something that isn't in the project's budget?** Use the
> **ขอเพิ่มวัสดุเข้างบ** button on the project-shop page to *request* it — fill in
> the item, quantity and expected price and submit. It doesn't add anything by
> itself: an authorised person (a **planner** or **exec**) must approve it into the
> budget first (you can't approve your own request — maker-checker). Once approved,
> the item appears on the project's shelf and you can shop it like any other
> (control **PROJ-15**). Track your requests' status right below the shop shelf.

> **Track your requests without leaving the page.** A **คำขอซื้อล่าสุดของฉัน** card
> (below the basket) lists your last few requisitions with their live approval
> **status** — tap one (or **ดูทั้งหมด**) to open the full requisitions page. Press
> the **↻ สั่งซ้ำ** button on a past requisition to drop its items straight back into
> the basket.

> **Where does the category grouping come from?** The cards are grouped by each
> item's category in the **item register** — the real *หมวดสินค้า* (`item_categories`,
> set per item via `category_id`), falling back to the free-text category, otherwise
> **"ไม่ระบุหมวด"**. To (re)group the catalog: define categories on **ตั้งค่า → ข้อมูลหลัก
> → หมวดสินค้า** (`/setup/item-categories`) and assign each item its category on
> **ผังบัญชีสินค้า** (`/setup/items`) or in bulk via **ข้อมูลหลัก** (`/master-data`,
> the *items* sheet). For convenience, a **จัดการหมวดหมู่** shortcut appears in the
> `/shop` header for users who hold the `md_item` master-data permission.

**Seeing your PRs on the web:** the requisitions page (`/requisitions`) now shows a
**คำขอซื้อล่าสุด** table listing every PR — raised here *or* from LINE chat — with its
lines and status. A plain requester sees their own PRs (with a **ยกเลิก** button for a
still-Pending one); a procurement/planner/exec holder sees **all** PRs and gets
**อนุมัติ / ปฏิเสธ** buttons on the Pending ones (self-approval is still blocked by the
engine). The table auto-refreshes; use **รีเฟรช** to pull the latest immediately.

**Turning an approved PR into a PO (➡️ สร้าง PO):** on an **Approved** PR, procurement
presses **➡️ สร้าง PO** to open the conversion panel — a **pop-up dialog** centred over the
screen (so it is clearly visible on a phone, not tucked below the register table). Close it
with **✕**, the ⎋ key, or by tapping outside. Each line shows the **item name** (not just the
code), and — because a PR line may be a free-text name (e.g. typed in LINE chat, possibly
misspelt or not yet coded) — each line can be **reconciled to a real item** before the PO is
raised:
- **เทียบทะเบียน** — type/adjust the name and press **ค้นหา/เทียบ** to search the item
  master; click a match to lock in its code (and pull its default UoM/price).
- **สินค้าใหม่** — tick this to **open a new item code** on the spot (enter the code +
  description) when the item isn't in the master yet.

**One purchase order is placed with one supplier — so the panel splits a PR across
suppliers for you.** When it opens, the system **suggests a supplier for each line** and
**groups the lines by supplier**, showing one **ใบสั่งซื้อ (PO) #** card per group. The
suggestion is chosen in this order: **① the item's ผู้ขายประจำ (preferred supplier) → ②
the cheapest supplier price on file → ③ the vendor you last bought that item from**; the
matching **unit price** is pre-filled too. A small tag on each group tells you where the
suggestion came from (**ผู้ขายประจำ / ราคาที่เคยตั้งไว้ / เคยซื้อล่าสุด**).

- **Change a supplier** — press **เปลี่ยน/เลือกผู้ขาย** on a group header (moves the whole
  group) or on a single line (splits just that item out to another supplier). Pick from the
  supplier master, or type a new name.
- **ผู้ขายที่ยังไม่ได้เลือก** — any line the system couldn't match sits in a **"ยังไม่ได้เลือกผู้ขาย"**
  box; assign it a supplier (or leave it — those lines simply stay on the PR to order later).
- **★ ตั้งเป็นผู้ขายประจำ** — tick this on a group to **remember that supplier as the default**
  for those items, so next time they're suggested automatically (and the price auto-fills).

Then press **สร้าง PO ทั้งหมด (N)**. The system opens any new item codes and raises **one PO
per supplier group** through the normal path (vendor screening + approval), linking each line
back to its own PO. The PR is marked **ออก PO แล้ว / Converted** when every line has been
ordered, or **ออก PO บางส่วน / Partially converted** when some lines were left for later — the
**➡️ สร้าง PO** button stays available so you can place the rest in another pass. Requires the
`procurement` permission.

> **Setting a "ผู้ขายประจำ" (preferred supplier) for an item** ties it to a supplier so future
> requisitions route to the right PO automatically. The quickest way is the **★** tick in the
> conversion panel above; it's the price-maintenance duty (`md_vendor`, also open to
> `procurement`/`planner`), kept separate from paying the bill.

**Reorder what's running out (สินค้าใกล้หมด):** when any item's on-hand has dropped
to/below its **reorder point** (`min_stock` on the item master), a **สินค้าใกล้หมด** card
appears on `/requisitions` listing those items with a **suggested order qty** (topping the
item back up to its `max_stock` level, or twice the reorder point when no max is set). Tick
the ones you want, adjust any quantity, and press **เปิด PR เติมของ** — it raises a **single**
requisition for the whole selection (which then goes through the normal approval flow). The
card hides itself when nothing is low. The same thing works from LINE chat: `low` lists the
low-stock items, and `reorder` raises the top-up PR for all of them in one tap.

**Get told before you run out (แจ้งเตือนอัตโนมัติ):** type `subscribe lowstock` in the
LINE chat and the bot will message you **every morning** whenever any item has hit its
reorder point — with the item list and a one-tap **สั่งเติมทั้งหมด** button that raises the
top-up PR right there. Quiet mornings (nothing low) stay silent. `unsubscribe lowstock`
turns it off. (You can also set it up as the `low_stock_reorder_alert` scheduled report on
the `/bi` page.)

**LINE notifications:** if you've linked your account, the system messages you
automatically — approvers get a 🔔 when a PR enters their queue (with the
`approve <PR no>` hint), and the requester gets ✅/❌ when their PR is decided.
**You're also kept in the loop afterwards:** whoever raised the PR gets a LINE
message when it's turned into a **PO** (🛒 ออกใบสั่งซื้อแล้ว), when that PO is
**approved** (✅), and when the **goods arrive** (📦 รับเข้าคลังแล้ว) — so you know
your order is moving without having to ask. No setup beyond linking; if you unlink,
the messages stop.

> **Approving from chat is exactly as strict as the web:** you need the
> `procurement` permission, you can never approve a PR you raised yourself
> (`SOD_VIOLATION`), and multi-level chains still require every step.

**One-tap approve (LC-1):** when a PR enters your queue, the LINE card now has
**[อนุมัติ] [ปฏิเสธ]** buttons. Tapping one asks for a **[ยืนยัน]** tap (valid
5 minutes) before anything happens — same permission and self-approval rules
as typing the command. `my prs` also replies as swipeable cards now.

**Welcome & help card:** linking your account now replies with a **grouped
command card** (icons per cycle: PR · search & stock · finance · leave · reports
& AI · approvals) instead of a wall of text, and you can reopen that menu any time
by typing **`help`** (or `เมนู`).

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

### Print / send a PO (PDF)

Once a PO exists you can print it or send it to the supplier as a proper A4 document.

**Screen:** `/procurement` (**ใบสั่งซื้อ (PO)** list) · **Required permission:** any of
`procurement` / `planner` / `exec` / `wh_receive` / `warehouse` (viewing only).

1. In the **ใบสั่งซื้อ** list, find the PO row.
2. Click the **พิมพ์** (printer) action at the end of the row.
3. The purchase order opens in a new tab as a PDF — use your browser's print/save to send or file it.

The document carries **your company** block (legal name, address, 13-digit Tax ID, branch), the
**supplier** block (name, address, Tax ID, contact, payment terms), the ordered lines, and the total
in baht text. When your company is **VAT-registered**, an *estimated* 7% VAT line is shown — this is
for the buyer's reference only; the actual **ใบกำกับภาษี** is issued by the supplier on delivery.

> The PO document is presentation-only — printing it changes nothing and posts nothing to the ledger.
> If your browser shows the page as HTML instead of a PDF, the print server is simply rendering in
> fallback mode; the content is identical and still prints correctly.

### Print / email a request for quotation (ใบขอเสนอราคา / RFQ)

**Screen:** `/procurement/rfqs` · **Required permission:** `procurement`.

On the **RFQ list**, each RFQ row has a **🖨️ พิมพ์** and **✉️ ส่งอีเมล** action:

- **พิมพ์** opens the RFQ as a PDF — the items to be quoted (with a blank price column for
  the supplier to fill), the required-by date and an invitation to quote.
- **ส่งอีเมล** prompts for the supplier's email and sends the RFQ as a PDF attachment (needs
  the shop's mail account configured).

### Print / email a goods receipt note (ใบรับสินค้า / GR)

After receiving goods, the GR note documents what arrived — for filing or to countersign back
to the supplier. The **รับสินค้าล่าสุด (GR)** list on the **รับสินค้า (GR)** screen (`/receiving`)
shows recent goods receipts, each with a **🖨️ พิมพ์** and **✉️ ส่งอีเมล** action — the email
recipient **defaults to the vendor's email on file** (from the vendor master) when you leave the
prompt blank. Or call `GET /api/procurement/grs/{GR-…}/pdf` for the PDF (the supplier, the
referenced PO, the received item lines with lot numbers and a receiver-signature block), or
`POST …/grs/{GR-…}/send-email` to email it (a recent-receipts list is at `GET …/grs`). Read-only
— printing posts nothing.

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

**One-tap รับครบ (receive all):** for a normal "everything arrived" delivery you don't
need the form — every receivable PO in the list carries a **รับครบ** button that
receives *all* outstanding quantity in one click (order − already received on each line)
and closes the PO once nothing is left. It only shows for Approved / part-received POs
(never for Pending, Closed or Cancelled). The same action is available from LINE chat by
typing `receive <PO no>` — see the [chat commands](#raise-a-pr-from-line-chat) above.

> **Note — short / damaged delivery:** Raise a **goods-receipt claim** against
> the supplier under **Claims** (`/claims` → GR Claims tab): enter the GR number,
> item, claim quantity and reason. Resolve or reject it once the supplier
> responds. **From LINE chat** you can open one on the spot: `claim <PO/GR no>
> <qty> [เหตุผล]` (e.g. `claim GR-20260101-001 2 ของแตก`) — procurement then
> follows up on `/claims`.

**Receiving only part of a delivery:** if only some of the order arrived, enter the
actual quantity per line in the GR form (leave the rest — the PO stays open for the
balance). From LINE chat, `receive <PO no> <item id> <qty>` does the same for one
item in a tap; the quantity is capped at what's still outstanding.

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

### Quick Capture — snap a bill from anywhere

Got a supplier bill in your hand and you're **not** in Accounting? You don't need
to key anything or find the right menu. **Quick Capture** lets *anyone in the
company* photograph or upload a bill and send it straight to Accounting's review
queue — the system reads it for you.

**Screen:** `/capture` · **Required permission:** `pr_raise` (every internal
staff role has it — the same one that lets you raise a requisition). Works great
on a phone.

1. Go to **Procurement** → **เก็บบิลเร็ว (ถ่ายรูป)** (`/capture`).
2. Press **ถ่ายรูปบิล** to snap it with your camera, or **เลือกไฟล์ / PDF** to
   upload an existing image (PNG/JPEG/WebP) or PDF.
3. That's it. The system reads the vendor, invoice number, date and amount and
   shows you what it found, then files the bill for Accounting under a document
   number. A digital PDF is read instantly; a photo is read by AI when it's
   configured — if it can't read it automatically, the bill is still filed with
   the photo attached so Accounting can key it by hand (it never guesses).
4. Your captured bills appear under **บิลที่คุณเพิ่งเก็บ** with their status:
   *รอตรวจสอบ* (waiting for Accounting), *จับคู่ PO แล้ว*, or *บันทึกบิลแล้ว*.

**Even faster — from LINE:** if your shop's LINE OA is linked to your account, just
type **`บิล`** in the chat and send the bill photo. The system reads it and files it
for Accounting exactly like the `/capture` screen — no app needed. (Same `pr_raise`
permission; it never books the bill.)

**Or forward it by email.** On `/capture`, in **รับบิลทางอีเมล**, verify the email
address you send bills *from* (press **ขอรหัสยืนยัน**, then type the 6-digit code we
mail you). After that, just **forward any supplier bill** (PDF or photo attachment) to
your shop's capture inbox — shown on the same card as `capture-<shop>@…`. The system
reads each attachment and files it for Accounting, credited to you. Bills sent from an
unverified address, or from someone without the `pr_raise` permission, are ignored —
so only your team's bills get in, and it never books the bill itself.

> **Quick Capture only *files* the bill — it never records a payable or posts to
> the ledger.** Booking the bill and paying it stay with Accounting/Finance
> (that separation of duties is a control, **EXP-06**). You'll see only the bills
> *you* captured, not the whole AP queue.

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

### Changing a vendor's bank account (dual control)

**Screen:** `/inventory/suppliers` · **Stage a change:** `md_vendor` · **Approve /
reject:** `exec` / `approvals` (must be a **different** person from whoever staged
it).

Because a mis-directed vendor payment is a common fraud pattern (a redirected
bank account is discovered only when the real supplier calls asking why they
were not paid), a supplier's bank name / account number **cannot be edited
directly**. Press the bank icon next to a supplier's bank-account column,
enter the new **ชื่อธนาคาร (bank name)** / **เลขที่บัญชี (account number)**, and
submit — this only **requests** the change.

The request appears in an amber **คำขอเปลี่ยนบัญชีธนาคารผู้ขายรออนุมัติ** card at the
top of the same screen for any `exec`/`approvals` user to **อนุมัติ (approve)** or
**ปฏิเสธ (reject)**. The person who staged the request **cannot approve their
own request** — the system rejects it. Only on approval does the vendor's bank
details actually change; a rejected request leaves them untouched. Staging a
new request while one is still pending **supersedes** the older one, so the
approval queue always shows only the latest ask. (Control EXP-11.)

### Editing other vendor details

**Screen:** `/inventory/suppliers` — press **แก้ไข (Edit)** on a supplier row ·
**Required permission:** `md_vendor`.

Contact person, phone, email, address, payment terms, lead time, rating,
category, currency, and notes can be updated **directly** — unlike the bank
account above, none of these carry a payment-redirection risk, so no second
approval is required. The same dialog also lets you set the supplier's
**vendor status** (approved / pending / **ระงับ — blocked**); blocking asks
for a reason and immediately prevents new POs/quotes against that vendor
(see "Screen the vendor" above). Tax ID and credit limit are **not** editable
here — they stay PII-encrypted / bulk-import-only pending a future dual-control
design of their own. The same dialog also has a **รหัสผู้ขายบริษัทแม่ (parent
vendor ID)** field — link this vendor to its group's parent vendor for
consolidated spend/reporting (a vendor cannot be its own parent).

### Vendor addresses & contacts

**Screen:** `/inventory/suppliers` — press **ที่อยู่/ผู้ติดต่อ** on a supplier row ·
**Required permission:** `md_vendor`.

A vendor can carry more than one address (billing / shipping / registered /
other, one marked **หลัก — primary**) and more than one contact (name, title,
phone, email), instead of the single scalar address/contact of before. Add or
delete either from this panel — both save immediately, with no second
approval (same reasoning as the direct-edit fields above). The **จังหวัด
(province)** field suggests from the standard 77-province list and is saved in
its official spelling; the **รหัสไปรษณีย์ (postal code)** must be 5 digits.

The same panel has a **ความสัมพันธ์ (relationships)** section — record links to
other vendors by type (**บุคคลที่เกี่ยวข้องกัน (related party)**, **บริษัทลูก
(subsidiary)**, **แฟรนไชส์**, **ผู้รับเหมาช่วง (subcontractor)**, **บริษัทแม่
(parent)**) by entering the other vendor's ID. The link shows on both vendors;
a vendor can't relate to itself and the same link can't be added twice.

The same panel has a **ประวัติการแก้ไข (Change history)** section: expand it to see
who changed what and when — the vendor's creation (onboarding), every field edit
(old → new), and address/contact changes. Sensitive fields (tax ID, bank account)
show that they changed but mask the value. The history is recorded automatically by
the database and cannot be edited or deleted, so it stands as audit evidence of every
vendor-master change.

### Find & merge duplicate vendors

**Screen:** `/inventory/suppliers` — press **ตรวจข้อมูลซ้ำ (Find duplicates)** ·
**Required permission:** `md_vendor`.

Opens a review queue of records that look like the same vendor — flagged when they
share a **tax ID / email / phone**, or have a **similar name** — each with the record
to *keep* and the probable duplicate(s) (match reason + confidence %). Press **รวม
(Merge)** to fold a duplicate into the kept vendor: all its POs, AP transactions,
price lists, addresses and contacts move over, blank fields on the kept record are
filled in from the duplicate, and the duplicate is retired (kept for audit, never
deleted). Merging asks for confirmation and **can't be undone**; if the two records
hold a conflicting entry the system stops so you can resolve it first. Keeping the
vendor master free of duplicates is what prevents duplicate payments to the "same"
supplier under two records.

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
