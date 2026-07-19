# 01 · Sales & Point of Sale (POS)

**Status: DRAFT v0.72 · 2026-07-19** · *v0.72 (2026-07-19): **Age-restricted items (alcohol / tobacco).** An item can carry a **minimum buyer age** (set on `/setup/items` — e.g. **20** for alcohol/tobacco; 0 = none). When such an item is in the cart, completing the sale pops a **confirm-age prompt** — the cashier confirms they checked the buyer’s ID and the buyer meets the minimum age before the sale goes through; declining cancels it. The sale is recorded as age-verified. An item with no minimum age sells exactly as before. UAT-O2C-571.* · *v0.71 (2026-07-19): **Split payment — pay one bill with several tenders (Phase 6a).** At checkout, tick **แยกชำระหลายช่องทาง (Split payment)** to settle a bill across more than one tender — e.g. part **เงินสด**, part **บัตร**, part **QR พร้อมเพย์**. Add a row per tender, key each amount, and the **คงเหลือ (remaining)** must reach **0** before you can complete the sale; a cash row may take more than its share (the change is returned). Each tender is recorded separately, so the drawer count and the awaiting-confirmation list stay correct. Leave the box unticked to pay the whole bill one way as before. UAT-O2C-570.* · *v0.70 (2026-07-19): **The register now adapts to all 17 business types.** The business-type register profile (Phase 1a) now recognises every business type you can pick at signup, not just the original five: a **โรงแรม/ที่พัก (hospitality)** gets the full **restaurant** register (tables/kitchen — for the hotel's F&B outlet); **การผลิต / อีคอมเมิร์ซ / เกษตร / ยานยนต์ / องค์กรไม่แสวงหากำไร** get the **clean goods register**; and **ก่อสร้าง / สุขภาพ / บริการวิชาชีพ / โลจิสติกส์ / การศึกษา / อสังหาริมทรัพย์** get the **service register**. Nothing to set at the till — it follows your business type. UAT-O2C-569.* · *v0.69 (2026-07-18): **Retail/services register rings a plain sale (universal POS, Phase 1b).** On a **non-restaurant** register, pressing **ชำระเงิน** now completes a **plain retail sale** — it does **not** open a kitchen ticket or a table order, just records the sale, takes payment, and updates stock. (A restaurant register is unchanged — it still opens/fires the order.) It follows your business type automatically; nothing to set at the till. UAT-O2C-564.* · *v0.68 (2026-07-18): **The register adapts to your business type (universal POS, Phase 1a).** The touch **register** now reads your company's **business type** (ประเภทกิจการ, set at onboarding — restaurant / retail / distribution / services / general). A **non-restaurant** business gets a **clean retail register**: the table-service controls (**แนบโต๊ะ / attach table**, the floor-plan link, the dine-in / takeaway / delivery + guest-count + service-charge options) are **hidden** — you just ring items and take payment. A **restaurant** keeps all of it unchanged. Nothing to configure at the till; it follows the business type. UAT-O2C-563.* · *v0.67 (2026-07-18): **Credit note on a return (#2).** When you record a return (`/returns`) against a sale that has a **tax invoice**, the system now automatically issues the matching **ใบลดหนี้ (credit note)** so the return is reflected in your **ภ.พ.30 output-VAT** — no extra step, and it does **not** double-post to the ledger (the return's own reversal is the accounting entry). Nothing changes for a sale with only a receipt/abbreviated slip and no full invoice. UAT-O2C-561.* · *v0.66 (2026-07-18): **Unconfirmed-tender worklist (#3).** A new **รอยืนยันการชำระ (pending settlement)** list shows every **QR / PromptPay / card-authorization / transfer** tender that has **not been confirmed received** yet — oldest first, with how long it's been waiting and the total value — so a QR sale that looks paid but whose confirmation never arrived never gets lost. Confirm it (ยืนยันรับชำระ) or void it to clear it from the list. `GET /api/payments/pending-settlement`. UAT-O2C-560.* · *v0.65 (2026-07-18): **Cash tendering / change recorded (#1).** A cash tender now records the **cash the customer handed over** and the **change given back** on the sale (`payments.cash_tendered`/`change_given`) — the **เงินทอน** the register already shows the cashier is now saved as an audit trail for the drawer count and change disputes, and a cash tender that is **less than the amount due is refused** (`INSUFFICIENT_TENDER`). No change to how you ring a sale. UAT-O2C-562.* · 2026-07-18** · *v0.64 (2026-07-18): **Prep-time report screen (F5 — no new control).** The **จอครัว (KDS)** view switcher gains a fourth tab **เวลาทำเฉลี่ย** — the learned **actual average cook time** (fired→served, last 14 days) per dish with its **จำนวนครั้ง** (sample count) and an updated-at stamp, sorted slowest first. This is the same figure the board uses to time each ticket's ETA/SLA colour; a dish needs ≥3 served tickets to appear. Surfaces `GET /api/restaurant/kds/prep-times` (was API-only). Read-only, gated pos/order_mgt/exec. UAT-O2C-559.*  · *v0.63 (2026-07-18): **QR & kitchen impact wave (F1–F8).** Diners can now **เรียกพนักงาน** (call staff / water / cutlery / bill — pops on the floor board to acknowledge), **แยกจ่าย (จ่ายส่วนของฉัน)** so each guest pays their PromptPay share (the bill finalises once fully covered), **ผูกสมาชิก** at the table to earn points on the bill, and see **สั่งคู่กับ…** upsell suggestions in the basket. On **จอครัว**, a screen can be **scoped to one station**, a cook can **ยกเลิกรายการ (with a reason)** or see a **fire-the-next-course** nudge, and dish prep-time estimates **learn from actual cook times** automatically. UAT-O2C-546..558.* · *v0.62 (2026-07-18): **Kitchen-display ergonomics (no new control).** The **จอครัว (KDS)** header adds a **🔔 sound alert** toggle (a chime when a new ticket arrives, a louder alarm when something is stuck), a **big-text** mode and a **fullscreen** button for a wall-mounted screen, a live **summary** (กำลังทำ / รอเฉลี่ย / เฉลี่ย-ต่อจาน-วันนี้ / เสิร์ฟวันนี้), and a per-dish **ของหมด (86)** button so the kitchen can mark a dish out of stock without leaving the screen. UAT-O2C-544..545.* · *v0.61 (2026-07-18): **Diner menu photos/zoom/grid, order lots & recommendation strategies (migration `0435`).** The guest QR menu now shows **dish photos** you can **tap to zoom full-screen**, and a **list ⇄ grid** view toggle (grid = big image tiles). **ออเดอร์ของฉัน** groups the guest's dishes by the **time each batch was sent to the kitchen (hh:mm)** with a live wait, and each dish flips from its wait to **เสิร์ฟแล้ว** once served. Back office: **ตั้งค่า QR** adds a **วิธีเลือกเมนูแนะนำ** — *เลือกเอง* (per-dish flag), *ตามพฤติกรรมการกินของสมาชิก* (what members order most), or *เมนูนิยม + ต้นทุนต่ำ*. On **จอครัว** a whole ticket can be started in one tap (**เริ่มทำทั้งออเดอร์**) and just-arrived dishes show a **มาใหม่** badge. UAT-O2C-539..543.* · *v0.60 (2026-07-18): **Dynamic QR ordering + food-priority kitchen display (migration `0434`).** The **จอครัว (KDS)** board can now be **grouped four ways** (ตามสถานี / ตามโต๊ะ / ตามเวลา / ตามลำดับความสำคัญ); a menu item's new **ลำดับความสำคัญครัว (KDS priority)** makes it plate out **ahead of others fired in the same batch**; any dish stuck on the pass **over 10 minutes** raises a red **ค้างเกินเวลา** alarm; and a runner can clear a finished ticket by **scanning the order or tapping เสิร์ฟทั้งออเดอร์**. On the **เมนูอาหาร** screen a dish can be flagged **เมนูแนะนำ** (shown first with a ⭐ on the guest QR menu) and given its kitchen priority. On the **โต๊ะ** screen a new **ตั้งค่า QR** dialog adds **QR แบบไดนามิก** (a scan only orders once staff open the table, and stops at the closing bill — otherwise **QR_TABLE_NOT_OPEN**) and **ปิดโต๊ะทันทีเมื่อชำระเงิน** (a paid table is freed at once). The guest QR menu gains a **category-filter chip bar** and a **แนะนำ** row, tuned for mobile. UAT-O2C-533..538.* · *v0.59 (2026-07-16): **Card-terminal depth (C5, docs/50 Wave 5).** The card terminal (`/payments/terminals`) now takes a **tip** with the charge (total = amount + tip) and supports the classic **bar-tab gratuity**: a pre-authorised tab can be captured **above the auth by the tip** (the base amount is still capped at the authorisation). For back office: the settlement screen gains **นำเข้ารายงานสรุปยอดจากผู้ให้บริการบัตร** — import the acquirer's settlement report and the system matches it **per transaction** (ตรง / ยอดไม่ตรง / ไม่มีรายการในระบบ / ไม่อยู่ในรายงาน); the batch auto-reconciles only when everything matches, otherwise the discrepancy lines are the follow-up worklist. A payment callback that the acquirer redelivers is now ignored safely (each event id processes exactly once). UAT-O2C-522..525.* · *v0.58 (2026-07-16): **Full tax invoice at the counter (ขอใบกำกับเต็มรูป — C2, docs/50 Wave 2).** A business buyer can ask for a **full tax invoice (ม.86/4)** right at the POS: on the **POS home → บิลล่าสุด** list, tap the document icon on the bill, enter the buyer's **name / 13-digit tax ID / branch (00000 = สำนักงานใหญ่) / address** and press **ออกใบกำกับเต็มรูป**. The system converts the bill's abbreviated slip (same amounts, same VAT, same tax period — the supply is never counted twice) and only ONE full invoice can ever exist per bill: asking again just returns the same document. Print/e-Tax it from **Tax → Invoices** as usual. UAT-TAX-063..064.* · *v0.57 (2026-07-16): **Blind drawer close (นับเงินแบบไม่เห็นยอด — P1c, docs/50 Wave 1).** `/pos/till` gains a **ปิดกะ / นับเงิน** close dialog and a manager-only policy toggle **ปิดกะแบบไม่เห็นยอด**: when the policy is on, the cashier counts the physical drawer **without** seeing the expected cash (the X/Z reports on an open session hide it — server-side), and the expected figure + variance are revealed only after the count is submitted; the session records that it was closed blind. Changing the policy needs a manager duty (`ar`/`exec`) — a till-only user gets ไม่สำเร็จ (403). UAT-O2C-492..497.* · *v0.56 (2026-07-14): **CPQ pricebooks (CRM-14, new control CRM-15).** New **Pricebooks** tab on `/cpq` (master-data, `masterdata` duty): create a governed, effective-dated price list (code, currency, effective from/to) and maintain its per-item prices (`item code → unit price`). A quote created against a pricebook prices each covered line from the book's entry (config + free-line paths) — the quoted price gets an auditable basis (`quotes.pricebook_id`); an inactive or out-of-window book is refused at quote time (`PRICEBOOK_INACTIVE` / `PRICEBOOK_NOT_EFFECTIVE`), and the CPQ-01 discount/margin floor still governs the result. UAT-O2C-439..444.* · *v0.55 (2026-07-13): **CPQ bundles, tiered discount authority & guided selling (CRM-14, new control CRM-12).** New **Bundles** tab on `/cpq`: define a bundle from existing configs (each with qty + cost) and add it to a Draft quote as a set of lines in one action — the existing CPQ-01 discount/margin floor governs the bundle unchanged. An optional second, higher discount ceiling (**Settings → CPQ**, `exec_discount_pct`) requires an **exec**-authority approver specifically past that point (`TIER_APPROVAL_REQUIRED` blocks a lesser approver). New `GET /api/cpq/recommendations` co-purchase suggestion read. UAT-O2C-391..397.* · *v0.54 (2026-07-11): **CPQ discount-approval & margin-floor control (SVC-1, new control CPQ-01).** New callout under order status: a quote whose **discount %** exceeds the ceiling or whose **margin %** is below the floor (**Settings → CPQ**, defaults 20 %/15 %) is held **รออนุมัติส่วนลด** on send and cannot be accepted until a **different** approver (`cpq_approve`/`exec`) presses **อนุมัติ**; the author cannot self-approve (**SOD_SELF_APPROVAL**), **ปฏิเสธ** returns it to Draft. The `/cpq` Quotes table shows discount %/margin % + a Pending-approval badge. UAT-O2C-349..353.* · *v0.53 (2026-07-10): **Menu-screen 86 toggle + item edit (UI-only, no new control).** The **เมนูอาหาร → รายการเมนู** table gains per-row **86 ปิดขาย / เปิดขาย** (manual availability toggle, `PATCH /api/menu/items/:sku/availability`) and **แก้ไข** (edit name/EN/price/cost/category/tax in place, `PATCH /api/menu/items/:sku`) — surfacing endpoints that existed but had no UI. New §"86 a dish mid-service" + "Edit a dish after it's created". Restaurant harness extended (item-edit assertion). UAT-O2C-347..348.* · *v0.52 (2026-07-10): **Bulk import/export on the Menu screen.** The **เมนูอาหาร** menu-catalog screen (`/menu`) gains a **นำเข้า/ส่งออกแบบกลุ่ม (Excel/CSV)** section — export the catalog, download a blank template, or upload menu items in bulk (registry entity `menu_items`); gated to the `masterdata` setup duty (see the menu section → Bulk import/export).* · *v0.51 (2026-07-10): **card tip-adjust-after-auth (POS-10, new control).** New §1 subsection *"Card tip after the card is authorized"* — the US-restaurant flow: **authorize** the card for the bill, key the **tip from the slip** (pre-capture, capped at 25% of the auth by default), then **capture** bill + tip; the tip books to the 2300 tip liability and feeds the tip pool unchanged. Every adjustment is logged. New error codes `TIP_ADJUST_CLOSED` / `TIP_OVER_LIMIT` / `CANNOT_CAPTURE`. UAT-O2C-343..345.* · *v0.16 (2026-07-10): * · **Status: DRAFT v0.17 · *v0.17 (2026-07-10): **PromptPay day-end reconciliation (POS-8, control POS-08).** New §6 subsection — a QR taking is now tied out to the shop's bank statement per day: map the settlement account, import the statement, run `/api/pos/promptpay-recon/run`, and any QR sale with no matching bank inflow is raised as a **till/cash exception** a manager clears (a late-arriving inflow auto-clears it on the next run). Reuses the bank auto-match engine; detective only (no GL). Run/clear = `recon_prep`/`pos_close`/`exec`; a sell-only cashier is denied.* · *v0.15 (2026-07-10): **auto-86 out-of-stock sync to delivery apps (POS-7, control INV-14).** When a recipe ingredient runs out, the POS now not only marks the dish หมด (86) locally but **pauses it on every connected delivery aggregator** (Grab / LINE MAN / Foodpanda / Robinhood) and **resumes it on restock** — so the apps stop accepting orders you can't cook. Automatic (rides the availability sweep), quiet (an app is told only when the status actually changes), and audited (review per-app status + history at ช่องทางเดลิเวอรี → Auto-86, `GET /api/channels/auto-86`).* · *v0.14 (2026-07-10): **voucher/coupon code at checkout (POS-3, control REV-20).** The register checkout gains a โค้ดคูปอง / บัตรกำนัล field — one field redeems a campaign voucher code (created + independently approved on `/loyalty/campaigns`) or a member wallet coupon; server-validated preview, atomic single-use redemption at settle, best-discount-wins vs the bill %, offline settle with a voucher blocked. New error codes VOUCHER_NOT_ACTIVE / VOUCHER_EXPIRED / VOUCHER_MIN_SPEND / VOUCHER_ALREADY_REDEEMED / VOUCHER_VOID.* · *v0.13 (2026-07-10): **LINE e-receipt to the sale's member (POS-2).** The register sale-complete screen and the dine-in checkout dialog gain **ส่งใบเสร็จเข้า LINE สมาชิก** — `POST /api/pos/sales/:saleNo/receipt/send` channel `line` resolves the loyalty member **from the sale** and pushes a flex receipt card with a **ดูใบเสร็จฉบับเต็ม** secure-link button (opaque token, `GET /api/pos/receipt/public/:token`); the recipient box now targets **email or SMS**. New error codes `LINE_NOT_LINKED` / `LINE_NOT_CONFIGURED`.* · *v0.12 (2026-07-10): **offline register hardening (LAN-first Phase 0, docs/41).** The register now survives a **reload/reboot mid-outage** — the menu is snapshotted on-device (localStorage) and served when `/api/menu` is unreachable — and a quick sale whose network dies **mid-checkout** (router up, internet down — the browser still shows ออนไลน์) is **queued offline automatically** instead of erroring at the cashier. Dine-in still requires the connection. Control BRANCH-03 unchanged (same idempotent replay). UAT-O2C-284..285; e2e `register-offline.spec.ts`.* · *v0.11 (2026-07-09): **doc-reference dropdowns on the POS screens (UI-only, no new control).** Everywhere a POS screen asked you to TYPE a bill/session number it now offers a pending-list dropdown with a **พิมพ์เลขเอกสารเอง…** manual escape: `/returns` create-return (recent sales), `/pos-control` override bill, `/pos-ops` house-account bill, `/payments/terminals` charge bill, `/print` reprint/send bill (all from `GET /api/pos/orders`), and `/pos/close-of-day` Z-report signing picks the **closed till session** from the new read-only `GET /api/payments/till/sessions?status=Closed`.* · *v0.10 (2026-07-06): documented **where the G14 void/refund exception report is surfaced in the app**: a read-only **"Voids / refunds"** review card on the **Pending Approvals** screen (`/approvals`) for periodic independent review. UI surfacing of an already-shipped report — no new endpoint, no new numbered control.* · *v0.9 (2026-07-06): **void / refund exception report (G14)** — new detective report `GET /api/payments/exceptions/voids-refunds` (`exec`/`ar`/`fin_report`, optional `from`/`to`) lists every voided payment + every refund in a window (no./amount/who/when + counts & totals) for independent periodic review; voids and sub-threshold refunds stay single-user by design (till speed), large refunds still gated by REV-16. Detective control — no new numbered control.* · *v0.8 (2026-07-06): **quote-accept distinct-actor guard (G12)** — accepting a **billable** quote (`POST /api/cpq/quotes/:id/accept`, revenue Dr AR / Cr Sales) now requires the acceptor to be **different** from the quote's creator (revenue recognised by a second person); a self-accept is blocked with **SOD_VIOLATION** and posts no revenue. Strengthens SoD **R07/R10** / **CPQ-03** — no new control, no migration.* · *v0.7 (2026-07-05): **gift-card issuance maker-checker** — issuing a gift card **above ฿5,000** now creates a **pending** card that a finance approver (`creditors`/`exec`, a different person from the issuer) must approve before it holds value or can be redeemed; cards **฿5,000 or less** still issue instantly; **self-approval is blocked**. Controls GC-01 / SoD R14.* · *v0.6 (2026-06-29): added **PIN quick-login at the till** (numeric keypad on `/login`), the combined **"เข้าสู่ระบบ / เปิดกะ"** (login + open shift) action, the self-service **ตั้ง PIN หน้าร้าน** page (`/pos-pin`), and the **ตั้ง PIN** action on the admin Users page; privileged/finance accounts must still use password + MFA (cannot use a PIN). Control ITGC-AC-17.* · *v0.5 (2026-06-27): SoD screen split — new dedicated screens `/pos/refunds` (refund authorization queue, `pos_refund`) and `/pos/till` (till management, `pos_till`); `/pos/register` now shows as `pos_sell` primary perm; "บันทึกคืนสินค้า" button on `/returns` hidden from `pos_sell`-only cashiers (requires `pos_refund`). Controls R08/R12.* · *v0.4 (2026-06-26): B4 — pricing engine wired into the **retail portal POS** (`POST /api/portal/pos/sales`): `apply_pricing` now also triggers **auto service charge** (→ acct 4400, VATable) and **satang rounding** (→ acct 4900); three new optional fields `service_charge_pct`, `service_min_party`, `rounding`; response includes `service_charge` and `rounding_adjustment`.* · *v0.3 (2026-06-26): added **POS Favourites quick-access grid** (★ star-toggle + "รายการโปรด" chip tab, persisted per user) and the **"บันทึกคืนสินค้า" create-return flow** on the Returns Register (sale search → qty picker → refund method → `RTN-` confirmation).* · *v0.2 (2026-06-25): added the touch **register** (`/pos/register`) — menu-grid selling, modifier picker, keypad/quick-tender checkout, hold/recall — and connecting the **receipt printer / cash drawer / customer display** from the register's **⚙ ตั้งค่าเครื่อง**.* · 2026-07-10** · *v0.16 (2026-07-10): **offline dine-in + installable PWA register (POS-6, control BRANCH-03 widened).** Table (dine-in) orders now work offline — tapping ชำระเงิน while offline **sends the order to the kitchen offline** (ส่งครัวออฟไลน์) and replays it on reconnect; **settlement stays online** (settle the bill from บริการโต๊ะ once back). Re-sending never duplicates the order or double-fires a dish. The register is now an installable app (PWA) and the menu is cached by the service worker, so a reload while offline keeps a sellable menu and never loses the till. See §1 → Selling when the internet is down. UAT-O2C-320..322.* · *v0.15 (2026-07-10): **auto-86 out-of-stock sync to delivery apps (POS-7, control INV-14).** When a recipe ingredient runs out, the POS now not only marks the dish หมด (86) locally but **pauses it on every connected delivery aggregator** (Grab / LINE MAN / Foodpanda / Robinhood) and **resumes it on restock** — so the apps stop accepting orders you can't cook. Automatic (rides the availability sweep), quiet (an app is told only when the status actually changes), and audited (review per-app status + history at ช่องทางเดลิเวอรี → Auto-86, `GET /api/channels/auto-86`).* · *v0.14 (2026-07-10): **voucher/coupon code at checkout (POS-3, control REV-20).** The register checkout gains a โค้ดคูปอง / บัตรกำนัล field — one field redeems a campaign voucher code (created + independently approved on `/loyalty/campaigns`) or a member wallet coupon; server-validated preview, atomic single-use redemption at settle, best-discount-wins vs the bill %, offline settle with a voucher blocked. New error codes VOUCHER_NOT_ACTIVE / VOUCHER_EXPIRED / VOUCHER_MIN_SPEND / VOUCHER_ALREADY_REDEEMED / VOUCHER_VOID.* · *v0.13 (2026-07-10): **LINE e-receipt to the sale's member (POS-2).** The register sale-complete screen and the dine-in checkout dialog gain **ส่งใบเสร็จเข้า LINE สมาชิก** — `POST /api/pos/sales/:saleNo/receipt/send` channel `line` resolves the loyalty member **from the sale** and pushes a flex receipt card with a **ดูใบเสร็จฉบับเต็ม** secure-link button (opaque token, `GET /api/pos/receipt/public/:token`); the recipient box now targets **email or SMS**. New error codes `LINE_NOT_LINKED` / `LINE_NOT_CONFIGURED`.* · *v0.12 (2026-07-10): **offline register hardening (LAN-first Phase 0, docs/41).** The register now survives a **reload/reboot mid-outage** — the menu is snapshotted on-device (localStorage) and served when `/api/menu` is unreachable — and a quick sale whose network dies **mid-checkout** (router up, internet down — the browser still shows ออนไลน์) is **queued offline automatically** instead of erroring at the cashier. Dine-in still requires the connection. Control BRANCH-03 unchanged (same idempotent replay). UAT-O2C-284..285; e2e `register-offline.spec.ts`.* · *v0.11 (2026-07-09): **doc-reference dropdowns on the POS screens (UI-only, no new control).** Everywhere a POS screen asked you to TYPE a bill/session number it now offers a pending-list dropdown with a **พิมพ์เลขเอกสารเอง…** manual escape: `/returns` create-return (recent sales), `/pos-control` override bill, `/pos-ops` house-account bill, `/payments/terminals` charge bill, `/print` reprint/send bill (all from `GET /api/pos/orders`), and `/pos/close-of-day` Z-report signing picks the **closed till session** from the new read-only `GET /api/payments/till/sessions?status=Closed`.* · *v0.10 (2026-07-06): documented **where the G14 void/refund exception report is surfaced in the app**: a read-only **"Voids / refunds"** review card on the **Pending Approvals** screen (`/approvals`) for periodic independent review. UI surfacing of an already-shipped report — no new endpoint, no new numbered control.* · *v0.9 (2026-07-06): **void / refund exception report (G14)** — new detective report `GET /api/payments/exceptions/voids-refunds` (`exec`/`ar`/`fin_report`, optional `from`/`to`) lists every voided payment + every refund in a window (no./amount/who/when + counts & totals) for independent periodic review; voids and sub-threshold refunds stay single-user by design (till speed), large refunds still gated by REV-16. Detective control — no new numbered control.* · *v0.8 (2026-07-06): **quote-accept distinct-actor guard (G12)** — accepting a **billable** quote (`POST /api/cpq/quotes/:id/accept`, revenue Dr AR / Cr Sales) now requires the acceptor to be **different** from the quote's creator (revenue recognised by a second person); a self-accept is blocked with **SOD_VIOLATION** and posts no revenue. Strengthens SoD **R07/R10** / **CPQ-03** — no new control, no migration.* · *v0.7 (2026-07-05): **gift-card issuance maker-checker** — issuing a gift card **above ฿5,000** now creates a **pending** card that a finance approver (`creditors`/`exec`, a different person from the issuer) must approve before it holds value or can be redeemed; cards **฿5,000 or less** still issue instantly; **self-approval is blocked**. Controls GC-01 / SoD R14.* · *v0.6 (2026-06-29): added **PIN quick-login at the till** (numeric keypad on `/login`), the combined **"เข้าสู่ระบบ / เปิดกะ"** (login + open shift) action, the self-service **ตั้ง PIN หน้าร้าน** page (`/pos-pin`), and the **ตั้ง PIN** action on the admin Users page; privileged/finance accounts must still use password + MFA (cannot use a PIN). Control ITGC-AC-17.* · *v0.5 (2026-06-27): SoD screen split — new dedicated screens `/pos/refunds` (refund authorization queue, `pos_refund`) and `/pos/till` (till management, `pos_till`); `/pos/register` now shows as `pos_sell` primary perm; "บันทึกคืนสินค้า" button on `/returns` hidden from `pos_sell`-only cashiers (requires `pos_refund`). Controls R08/R12.* · *v0.4 (2026-06-26): B4 — pricing engine wired into the **retail portal POS** (`POST /api/portal/pos/sales`): `apply_pricing` now also triggers **auto service charge** (→ acct 4400, VATable) and **satang rounding** (→ acct 4900); three new optional fields `service_charge_pct`, `service_min_party`, `rounding`; response includes `service_charge` and `rounding_adjustment`.* · *v0.3 (2026-06-26): added **POS Favourites quick-access grid** (★ star-toggle + "รายการโปรด" chip tab, persisted per user) and the **"บันทึกคืนสินค้า" create-return flow** on the Returns Register (sale search → qty picker → refund method → `RTN-` confirmation).* · *v0.2 (2026-06-25): added the touch **register** (`/pos/register`) — menu-grid selling, modifier picker, keypad/quick-tender checkout, hold/recall — and connecting the **receipt printer / cash drawer / customer display** from the register's **⚙ ตั้งค่าเครื่อง**.*

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
   (red if the amount is short). The cash you key in (the amount handed over) and
   the change are now **recorded on the sale** — an audit trail for the drawer
   count and any later change dispute. Keying **less than the amount due** is
   refused (*เงินที่รับมาน้อยกว่ายอดที่ต้องชำระ*, `INSUFFICIENT_TENDER`).
3. **QR พร้อมเพย์** shows a **scannable PromptPay QR for the exact amount** — the
   customer scans it in their banking app; press **ยืนยันชำระเงิน** once paid.
   *(Needs a PromptPay ID configured for the business; otherwise the screen
   explains it isn't set.)* A QR tender stays **รอยืนยันการชำระ (awaiting
   confirmation)** until it's confirmed — automatically by the bank's settlement
   callback, or by you pressing **ยืนยันรับชำระ**. Any tender still awaiting
   confirmation appears on the **pending-settlement worklist** (`GET
   /api/payments/pending-settlement`) with how long it's been waiting, so a QR sale
   that never confirmed is never lost — confirm it or void it to clear it.
4. An optional **ส่วนลดบิล %** discounts the whole bill before VAT.
5. An optional **โค้ดคูปอง / บัตรกำนัล** (voucher/coupon code) field accepts a
   **campaign voucher code** (from `/loyalty/campaigns` → คูปองส่วนลด) *or* a member's
   **wallet coupon** (`CPN-…`) — one field for both. Press **ตรวจสอบ** to preview the
   discount before settling; the code is **actually redeemed** (single-use, atomically)
   only when the sale settles. The voucher competes with the bill-discount % — the
   **better discount wins**, they don't stack; a voucher that loses is **not** consumed.
   Common rejections: `VOUCHER_EXPIRED` (past its validity), `VOUCHER_MIN_SPEND`
   (bill under the campaign's minimum), `VOUCHER_ALREADY_REDEEMED` / `ALREADY_USED`
   (code already spent — no double redemption, even from two tills at once),
   `VOUCHER_NOT_ACTIVE` (campaign not yet approved by a second user). Vouchers can't
   be redeemed **offline** (the code must be checked and burned server-side). *(REV-20.)*
6. **ยืนยันชำระเงิน** settles the sale.

> **Split payment (แยกชำระหลายช่องทาง).** Tick **แยกชำระหลายช่องทาง** to settle one
> bill across **several tenders** at once — e.g. ฿300 **เงินสด** + ฿200 **บัตร** +
> the rest **QR พร้อมเพย์**. Add a row per tender, key each amount, and watch
> **คงเหลือ (remaining)** — it must reach **0** before **ยืนยันชำระเงิน** enables.
> A **cash** row may take more than its share (the change is returned to the
> customer); a card/QR row must be its exact amount. Each tender is **recorded
> separately**, so the drawer count and the awaiting-confirmation list stay
> accurate for every method. Leave the box unticked to pay the whole bill one way,
> exactly as before. *(Generic retail register; strengthens the till reconciliation.)*

> **Age-restricted items (แจ้งเตือนจำกัดอายุ).** Some products may only be sold to
> customers over a minimum age — alcohol and tobacco are **20+** in Thailand. Set
> the **อายุขั้นต่ำผู้ซื้อ (Min buyer age)** on the item (`/setup/items`); leave it
> **0** for everything else. When such an item is in the basket, pressing
> **ชำระเงิน** pops a **confirm-age prompt** — the cashier confirms they **checked
> the buyer's ID** and the buyer meets the age before the sale completes; choosing
> cancel stops the sale. The completed sale is flagged **age-verified** for the
> record. Nothing changes for items with no minimum age.

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

### Card tip after the card is authorized (POS-10)

For the US-restaurant *"run the card first, add the tip after"* flow, a card can be
**authorized for the bill amount only** at checkout — the funds are **held, not
charged**. Staff then key the **tip the guest wrote on the slip** and **capture**
the card for **bill + tip**:

1. Take the card as usual but choose **อนุมัติวงเงิน (authorize)** — the tender comes
   back **Authorized** (a hold; no money captured yet).
2. When the guest writes the tip on the slip, open the tender and enter the tip
   (**ปรับทิป**). The tip must be entered **before you capture** and may not exceed
   **25% of the authorized amount** (the pre-auth cushion; a store can change the
   ceiling via `POS_TIP_ADJUST_MAX_PCT`). Every change is **logged** (who, when, old
   → new tip) so the charged tip always ties back to the slip.
3. **เก็บเงิน (capture)** charges the card for bill + tip. The tip is booked to the
   staff **tip liability (2300)** and flows into the normal **tip pool / payout**
   (see the Tips section) — cash tips are unchanged (they already post at checkout).

> **Why it can be refused.** *ปรับทิปไม่ได้แล้ว* (`TIP_ADJUST_CLOSED`) — the tender is
> already captured; a settled charge can't be re-tipped (refund and re-tender to
> correct). *ทิปเกินเพดานที่กำหนด* (`TIP_OVER_LIMIT`) — the tip is over the % ceiling;
> cap it or re-authorize a higher amount. *รายการนี้เก็บเงินไม่ได้* (`CANNOT_CAPTURE`)
> — only an Authorized hold can be captured.

### Selling when the internet is down (offline)

The register keeps working if the network drops. A badge in the top bar shows
**ออนไลน์** or **ออฟไลน์ — บันทึกในเครื่อง**.

- While **offline**, ring up a **quick cash sale** as usual. On payment the screen
  confirms **บันทึกออฟไลน์แล้ว** — the bill is stored safely on the device. (It does
  not yet have a sale number or a printed receipt; those are issued when it syncs.)
- **The menu keeps working after a reload.** The register keeps a copy of the menu
  on the device, so refreshing the page — or restarting the till — during an outage
  still shows the full menu and you can keep selling.
- **If the internet dies mid-payment**, you don't have to do anything: when the badge
  still says **ออนไลน์** but the connection is actually dead (e.g. the WiFi router is
  up but the internet line is down), a quick sale is **saved offline automatically**
  instead of showing an error.
- A **รอซิงค์ N** button shows how many bills are waiting.
- When the connection returns, the register **automatically sends the waiting bills**
  to the server (you can also tap **รอซิงค์** to sync now). Each bill is posted
  **exactly once** — re-sending never creates a duplicate. The synced sale then
  appears in **รายการออเดอร์** with its real sale number.

**Dine-in (table orders) now work offline too.** If the internet drops while you have a
table attached, tapping **ชำระเงิน** no longer errors — the register **sends the order to
the kitchen offline** and shows **ส่งครัวออฟไลน์ — ชำระเงินเมื่อกลับมาออนไลน์**. The open
table + its items are queued (counted in **รอซิงค์ N** with the quick sales) and replayed
when the connection returns, so the kitchen isn't blocked by an outage.

> **Payment (settlement) still happens online.** Offline the register captures and fires
> the dine-in order but does **not** take the electronic payment — collect the cash at the
> table and **settle the bill from บริการโต๊ะ (Tables) once you're back online**. Re-sending
> never duplicates the order or double-fires a dish. *(Control BRANCH-03 — no offline
> transaction, quick sale or dine-in, is lost or double-counted.)*

**Install the register as an app.** The register is an installable app (PWA): use your
browser's **Install / Add to Home screen** to pin it. Installed, a reload while offline
never loses the till, and the menu opens straight away.

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
- **LINE e-receipt to the member (ส่งใบเสร็จเข้า LINE สมาชิก).** On the register's
  sale-complete screen (`/pos/register`) and after settling in the dine-in dialog,
  click **ส่งใบเสร็จเข้า LINE สมาชิก** — no typing needed: the system finds the
  **loyalty member on that sale** and pushes a **receipt card** (shop, doc no,
  items, VAT, total) to their linked LINE, with a **ดูใบเสร็จฉบับเต็ม** button that
  opens the full receipt via a secure one-off link. The recipient box next to it
  still sends by **email** (input contains `@`) or **SMS** (a phone number).
  If the sale has no member — or the member never linked LINE — the send is
  refused with **`LINE_NOT_LINKED`**; if the shop's LINE channel isn't configured
  in production you get **`LINE_NOT_CONFIGURED`** instead of a silent failure.
- **Service charge line.** A receipt **itemises a ค่าบริการ (service charge) line**
  whenever the sale carries one (large-party dine-in); retail sales show none.

**Expected result:** The customer gets a printed or electronic receipt; the
receipt always **ties out** to the fiscal sale (line total − discount + service
charge + VAT + tip = total).

> **Troubleshooting:** “SALE_NOT_FOUND” — the sale number is mistyped or belongs
> to another branch/tenant. If a job stays **queued**, the printer/agent isn't
> pulling — check it is online and pointed at this outlet.
> “LINE_NOT_LINKED” — attach a member to the sale at checkout and make sure that
> member has linked their LINE (via the shop's OA / member portal) before sending
> a LINE e-receipt. “LINE_NOT_CONFIGURED” — set the shop's LINE Messaging API
> token (Settings › ช่องทางข้อความ, or `LINE_CHANNEL_TOKEN`).

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
*create* them (segregation of duties). Creating or changing a rule does **not**
put it live immediately — see **Approving a price/promotion rule** below.

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

**Approving a price/promotion rule (maker-checker — segregation of duties).**
Creating or changing a pricing/promotion rule now creates a **pending** rule: it
is saved **inactive** and shows a **รออนุมัติ (PendingApproval)** status on the
**/pricing** screen, so it applies to **no** sale or quote until it is approved.
The create toast now confirms the rule was **submitted for approval**. A **second
authorised user** — one with the **exec** or **approvals** duty, and who is **not
the person who created/edited the rule** — activates it with the **Approve**
action on the pending rule (or rejects it with **Reject**). Only on approval does
the rule become active. The author cannot approve their own rule; attempting to
self-approve is blocked (**SOD_VIOLATION**). Editing a rule that is already live
sends it **back to pending** (it goes inactive) until it is approved again.
(Combo component prices are not yet part of this approval flow — a planned
follow-up.)

### QR self-ordering & the kitchen display (KDS)

Guests can order from their own phone — no app, no login:

1. **Open the table.** Each table has a **printed QR sticker** (print it from
   **โต๊ะ → QR ติดโต๊ะ**); when a guest scans it the session opens (or re-joins)
   automatically and their phone lands on the order page. Staff can also open the
   table from the floor plan (**เปิดโต๊ะ**). *With **QR แบบไดนามิก** on (see
   **ตั้งค่า QR** below), the sticker only works once staff have opened the table —
   a scan on an un-opened table shows "โต๊ะยังไม่เปิด" — and stops the moment the
   bill is closed.*
2. The guest opens the **เมนู** tab, browses by category, picks options
   (size, spice, add-ons) where offered, reviews the **ตะกร้า** (cart) and taps
   **ส่งออเดอร์เข้าครัว** (send order to kitchen). At the top of the menu a
   **filter bar** (ทั้งหมด / ⭐ แนะนำ / each category) narrows the list, and any
   recommended dish shows first in a highlighted **Recommended** row. Each dish
   shows a **photo** — tap it to **zoom full-screen** (tap again to zoom in/out) —
   and the **⊞ / ☰ toggle** switches between a **grid** of image tiles and a **list**.
3. The order is sent **straight to the kitchen** — it appears on the **จอครัว
   (KDS)** screen automatically; no cashier re-keying. Guests can keep adding to
   the same bill during the visit.
4. On the **ออเดอร์ของฉัน** tab the guest's dishes are grouped by the **time each
   batch was sent to the kitchen** (e.g. *สั่งเมื่อ 18:42 น.*) with the live wait for
   that batch; each dish shows its status (**รอคิว → กำลังปรุง → พร้อมเสิร์ฟ**) and,
   once served, the wait is replaced with **เสิร์ฟแล้ว** (✓). From here the guest taps
   **เรียกเก็บเงิน** and pays by **PromptPay**: a real QR appears, the guest scans it
   in their banking app, and the page confirms **automatically** once the bank
   notifies us — no staff step. (For this to settle automatically the business needs a
   PromptPay ID set and the payment webhook configured; without it, a simulate button
   completes the demo.)

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

**ตั้งค่า QR (QR ordering settings).** On the **โต๊ะ** screen a manager (order/exec
duty) can open **ตั้งค่า QR** to control self-ordering shop-wide:

- **QR แบบไดนามิก (เปิดใช้เมื่อเปิดโต๊ะ)** — the printed QR only becomes an ordering
  session **after staff open the table**, and it stops working when the bill is
  closed. A scan on a table that isn't open shows "โต๊ะยังไม่เปิด" (the guest asks
  staff to seat them). Leave it **off** to let a scan self-open the table (the
  classic behaviour).
- **ปิดโต๊ะทันทีเมื่อชำระเงิน** — when a bill is fully paid the table is **freed
  immediately** (available again) instead of waiting in the **cleaning** state for
  staff to clear it. Applies to both guest PromptPay payment and staff cash checkout.
- **ให้พนักงานยืนยันก่อนส่งครัว** — guest QR orders are **held** until staff release
  them to the kitchen (the anti-abuse gate).

**Diners can call you, split the bill, and link membership (F1–F3, F6).** On the guest
QR page the top row now has **เรียกพนักงาน** (call staff — pick *เรียกพนักงาน / ขอน้ำ /
ขอช้อนส้อม / ขอเช็คบิล*) and **ผูกสมาชิก** (enter a member code/phone to earn points on
this bill). A **call** pops up on the **โต๊ะ** floor board — a **ลูกค้าเรียกพนักงาน**
card lists the table and how long they've waited, with **รับเรื่อง** (acknowledge) and
**เสร็จ** (clear). At payment the guest can tap **แยกจ่าย (จ่ายส่วนของฉัน)** to pay a
share via PromptPay — each person pays their part and the bill closes once the whole
total is covered. When the basket has items, a **สั่งคู่กับเมนูนี้** row suggests
popular pairings for one-tap add.

**Kitchen extras (F4, F5, F7, F8).** On **จอครัว**: the **สถานี** dropdown scopes a
screen to a single station (remembered on that device) — ideal for a screen at each
line; **ยกเลิกรายการ** (the ✕ on a card) voids a dropped/spoiled dish after asking for a
reason; a blue **ส่งคอร์ส N ได้** banner nudges you to fire the next held course once the
current one is plated; and each dish's expected cook time **learns from actual
fire→served times**, so the colour warnings and the guest's "ready in N min" get more
accurate automatically.

- **วิธีเลือกเมนูแนะนำ** — how the guest menu picks its **เมนูแนะนำ** set:
  - *เลือกเอง* — you flag dishes on the **เมนูอาหาร** screen (the default).
  - *ตามพฤติกรรมการกินของสมาชิก* — the dishes your **members order the most**
    (from their dining history and saved favourites) are recommended automatically.
  - *เมนูนิยม + ต้นทุนต่ำ* — best-sellers that also carry a **healthy margin**
    (popular **and** low food-cost) are recommended automatically.
  For the two automatic modes you also set **how many** dishes to feature.

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

### Auto-86 out-of-stock sync to delivery apps (Grab / LINE MAN / Foodpanda / Robinhood)

When a dish has a **recipe** (BOM) and one of its ingredients runs out, the POS
automatically marks the dish **หมด (86)** so it can no longer be rung up — and it
now **also pauses that dish on every delivery app you've connected**, so the
aggregators stop taking orders you can't cook (the #1 cause of delivery
cancellations and bad ratings). When you **restock** the ingredient and the item
becomes makeable again, it is **un-paused (resumed)** on the apps automatically.

You don't have to do anything for this — it rides the existing availability sweep
(it runs after each sale, and you can force it from **การตั้งค่าเครื่อง → คำนวณของหมดใหม่**
/ `POST /api/pos/scale/availability/recompute`). It only touches apps you've set up
under **ช่องทางเดลิเวอรี** (`/channels`), and it's **quiet** — an app is only told
when the status actually changes, never repeatedly. Every pause / resume it sends is
logged (with the reason and whether the app accepted it) and you can review the
current per-app status and the recent history at **ช่องทางเดลิเวอรี → Auto-86**
(`GET /api/channels/auto-86`). If a delivery app is briefly unreachable the sale
still completes normally; the sync is best-effort and retried on the next sweep.

### Reservations & walk-in waitlist

**Screen:** `/reservations` (**จองโต๊ะ & รอคิว**) · **Required permission:** `pos` /
`order_mgt`.

Take **bookings** for a future time and manage a **walk-in queue** in one place,
and let the system **text the guest when their table is ready**.

- **Book a table (จองล่วงหน้า).** Choose **จองล่วงหน้า**, fill in the guest's name,
  phone, party size and **time** (optionally a specific table), then **จองโต๊ะ**. If
  you pick a table it's held as **reserved** so no one else seats it.
- **Pick the service mode (fine-casual).** Every booking/queue entry carries a
  **บุฟเฟ่ต์ / A la carte** toggle so a house that serves both plans the floor up
  front. On a **buffet** booking you may pre-pick the **แพ็กเกจบุฟเฟ่ต์** (tier) —
  or leave it as **เลือกที่โต๊ะ**; the buffet timer still starts at the table as
  usual. Picking a package on an à-la-carte booking (or a retired package) is
  rejected with **`BAD_PACKAGE`**. Add an optional **โอกาสพิเศษ** (birthday /
  anniversary / business) so the team can prepare. The **ที่นั่งค้างรับ** card
  splits pending covers **per mode** so the kitchen sees buffet-station load vs
  à-la-carte load at a glance.
- **Add a walk-in (รับเข้าคิว).** Choose **รับเข้าคิว**, enter the name, phone, party
  size and an optional **estimated wait** (minutes), then **เข้าคิว**.
- **Link a member & open the guest profile.** Type the phone and tap the
  **member-lookup** button — a matching loyalty member is linked to the booking and
  their **โปรไฟล์แขก (Guest Profile)** card opens (also available per row via
  **โปรไฟล์**). See the next section.
- **Tell the guest it's ready.** Tap **แจ้งโต๊ะพร้อม** — the guest gets a **LINE or SMS**
  "your table is ready" message (LINE if they're a linked member, otherwise SMS to
  the phone). The entry turns **พร้อมแล้ว**.
- **Seat them.** Tap **รับเข้านั่ง** — the assigned table becomes **occupied**; ring the
  order on the register/table as usual. For a **buffet booking with a pre-picked
  package on an assigned table**, the system offers to **start the buffet right
  away** (opens the table and starts the tier's clock) — decline to start it at
  the table later as usual.
- **No-show / left the queue.** Tap **ไม่มา** (reservation) or **ออกคิว** (walk-in) to
  close it — any table you were holding is freed back to **available**.

The top cards show how many guests are **waiting**, how many tables are **booked**,
and the total **covers** you still have to seat (split buffet vs à la carte) — a
quick read on how busy the next hour will be.

### Guest dining profile (โปรไฟล์แขก) — Michelin-grade service, PDPA-first

**Screen:** the **โปรไฟล์แขก** card on `/reservations` · **Required permission:**
`pos` / `order_mgt` / `crm` · the guest must be a **loyalty member**.

Remember what makes each regular feel at home: **เมนูโปรด** (favourite dishes),
**วัตถุดิบที่ชอบ** (favourite ingredients), **แพ้อาหาร** (allergies), dietary
restrictions, **ที่นั่งที่ชอบ**, the **จำนวนคนที่มาปกติ**, free-form **service
notes** ("น้ำเปล่าไม่ใส่น้ำแข็ง"), and the **ผู้ร่วมโต๊ะประจำ** — the people they
usually dine with, each with their own preferences and allergies. The card also
shows **ทานบ่อย** (their most-ordered dishes computed from order history) and how
often they visit with how many guests.

> **PDPA — consent first, always.** The profile is preference/profiling data, so
> the system will **neither show nor save anything** until the guest has granted
> the **`dining_profile`** consent. The first save requires ticking the consent
> checkbox after asking the guest — this is recorded in the consent ledger (who,
> when, source POS). Saving without consent is refused (**`CONSENT_REQUIRED`**).
> The guest can **withdraw** at any time (staff: member consents screen; or the
> member's own self-service portal) — the data immediately disappears from every
> screen. A PDPA **erasure request (DSAR)** or the retention sweep **permanently
> deletes** the profile and companions, and a data-access request exports them to
> the guest. Collect only what serves the guest — this is a service tool, not a
> marketing list (marketing consent is separate).

- **Ask the guest to consent themselves (recommended).** When the profile shows
  *no consent yet*, tap **ส่งคำขอความยินยอม (LINE/SMS)** — the guest receives a
  message linking to the **member app (`/m`) → ความยินยอม (PDPA)** where they
  grant (or later withdraw) the consent **themselves**; this is the strongest
  PDPA evidence. If they've already consented, nothing is sent.
- **Edit & save.** Fill the fields (comma-separate multiple entries), tick the
  consent box on first save, then **บันทึกโปรไฟล์**. Saving updates exactly the
  fields on screen — details recorded elsewhere are never wiped by a save.
- **Extended details (ข้อมูลเพิ่มเติม).** Free-form extras, one per line as
  **หัวข้อ: ค่า** (e.g. `ไวน์ที่ชอบ: Pinot Noir`) — for anything the fixed
  fields don't cover. Collect only what serves the guest (PDPA minimization).
- **Companions.** Add name / relationship / **allergies** / preferences / notes
  with **เพิ่มผู้ร่วมโต๊ะ**; removing one **hard-deletes** it.
- **At service time.** Open the profile from the reservation row before the party
  arrives — allergies and seating preference first, then delight with the
  favourites.
- **Automatic flags on the floor & in the kitchen.** While a consented guest's
  party is seated (via their reservation), the **โต๊ะ** floor board shows a red
  **⚠️ แพ้อาหาร** line on their table and every **KDS ticket** for that table
  carries the same allergy/dietary flag — the kitchen sees "แพ้กุ้ง" on the
  ticket itself. The flags are computed live from the consented profile and are
  never copied onto the order: withdrawing consent (or a PDPA erasure) removes
  them from every screen immediately.

**Day-parting (time-limited menus).** When adding a menu item in **เมนูอาหาร**
you can set a **ช่วงเวลาขาย** (selling window) — a start/end time and which days
of the week — for breakfast, lunch or happy-hour items. Outside that window the
item shows **ยังไม่ถึงเวลาขาย** and can't be ordered (by staff or guests); leave
the window blank to sell it all day. Times follow shop time (Asia/Bangkok).

**86 a dish mid-service (mark it sold out).** On **เมนูอาหาร → รายการเมนู** every
row has an **86 ปิดขาย** button — one tap takes the dish off sale everywhere the
menu is read (the register grid, dine-in entry and the diner QR menu all block it
with *ITEM_UNAVAILABLE*), and the status badge flips to **ปิดขาย**. When you're
stocked again tap **เปิดขาย** on the same row to bring it straight back. It's a
quick, reversible toggle — no confirmation and no form — so the kitchen can pull a
dish the moment it runs out. (This is the manual counterpart to the automatic
recipe-driven 86 that also pauses the dish on connected delivery apps — POS-7.)

**Edit a dish after it's created.** The **แก้ไข** button on each row opens a dialog
to change the item's **name / ชื่อ (EN) / price / cost / category / tax** in place;
saving updates the catalog immediately, so the next order the register or QR menu
resolves uses the new price. Use it to correct a typo, reprice for a promotion, or
fill in a cost so the dish is included in the food-cost/menu-engineering report.

**Bulk import/export of the menu (Excel/CSV).** At the bottom of the **เมนูอาหาร** (`/menu`)
items tab a **นำเข้า/ส่งออกแบบกลุ่ม (Excel/CSV)** section lets you export the whole catalog,
download a blank **template**, and **import** many menu items at once (validate-then-commit, with a
per-row error preview). It reuses the shared master-data import engine (registry entity `menu_items`)
and is shown only to users holding the `masterdata` setup duty. Required columns: `SKU`, `Name`,
`Price`.

**Courses (serve in stages).** When taking an order you can set a **คอร์ส**
number for the dishes you add (e.g. 1 = appetisers, 2 = mains, 3 = dessert). On
the table you can then **ส่งเข้าครัว (ทั้งหมด)** to fire everything, or type a
course number and tap **ส่งคอร์ส** to fire just that course — the rest stay held
until you fire them. The KDS shows each ticket's course and lists them in course
order, so the kitchen cooks in the right sequence.

**Seats (who ordered what).** Alongside the course you can set a **ที่นั่ง (seat)**
number for the dishes you add — the guest at the table who ordered them (leave it
blank for a shared dish). Each line then carries its seat, so you can:
- **Order per seat** — ring seat 1's dishes, switch the ที่นั่ง box to 2, ring
  seat 2's, and so on;
- **Fire per seat** — the kitchen can send out one guest at a time (the fire action
  accepts a seat as well as a course);
- **Split the bill by who ordered** — at settlement pick **แยกตามที่นั่ง** (split
  by seat) and each seat's items become its own check (its own sale, receipt and
  GL entry), reusing the same split engine. Every line must have a seat first — if
  one is still shared you'll be asked to assign it (**SEAT_UNASSIGNED**). This is
  the fair way to split when each guest pays for what they had, rather than by an
  equal share. The order page also shows a per-seat subtotal so you can see each
  guest's running total.

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

**Order the board however the kitchen works.** The row of buttons at the top of the
Board switches how tickets are grouped: **ตามสถานี** (by station, the default),
**ตามโต๊ะ** (by table), **ตามเวลา** (oldest order first), or **ตามลำดับความสำคัญ**
(highest kitchen priority first). Give a dish a **ลำดับความสำคัญครัว** on the
**เมนูอาหาร** screen and, when several dishes are fired **at the same time**, the
higher-priority one is listed to be plated **first** (a **ลำดับ N** badge shows on
its card). Across different orders the **older** order still leads.

**ค้างเกินเวลา alarm (over 10 minutes).** Any dish still cooking **more than 10
minutes** after it was fired turns **red with a ⏰ pulse**, and a banner at the top
counts how many are stuck — so a forgotten ticket can't sit unnoticed. (The
threshold is configurable via `KDS_STUCK_MINUTES`.)

**Start or clear a whole ticket.** Grouping the Board **ตามโต๊ะ** gives each ticket
two one-tap actions: **เริ่มทำทั้งออเดอร์** accepts every waiting line at once
(รอคิว → กำลังปรุง), and **เสิร์ฟทั้งออเดอร์** marks every ready line served. You can
also **scan the order number** into the box at the top of the Board to serve a whole
ticket. A dish that has just arrived shows a **มาใหม่** badge so the line cook spots
new work at a glance.

**Kitchen-friendly extras (top-right of จอครัว).** Tap **🔔** to turn on a **sound
alert** — a short chime when a new order lands, and a louder alarm the moment a dish
goes over the stuck threshold (handy when the screen isn't always in view). **🔍
ตัวอักษรใหญ่** enlarges everything for a screen mounted across the kitchen, and **⛶**
switches to **fullscreen**. A live **summary bar** shows how many dishes are in
progress, the average current wait, today's **average time per dish** (fire → served)
and how many were served today. When an ingredient runs out, tap **ของหมด (86)** on
the dish's card to mark it sold out immediately — it stops being orderable on the
register, dine-in entry and the guest QR menu at once (re-enable it from **เมนูอาหาร**).

**Prep-time colour (SLA).** Every card is coloured by how long it has waited
against its prep target: **green** on time, **amber** when it is slipping (past the
target), **red** when it is well over (1.5× the target). The target comes from the
menu item's prep minutes, or the station's default. This lets the line cook see at a
glance which dish to pick up next.

**Recall (เรียกคืน).** If a dish was marked ready or served too early — or needs
re-firing — tap the **เรียกคืน** (undo) button on the card to pull it back onto the
board as *queued*. Each recall is counted per station (see **ภาระสถานี** below) so
re-fires are visible, not silent.

**Four KDS views** (switch with the tabs at the top of **จอครัว**):
- **จอครัว (Board)** — the classic station board above.
- **จุดส่งอาหาร (Expo)** — the **order-ready pass**: dishes grouped **by table/order**
  so the expeditor runs a whole order together. A ticket shows **พร้อมเสิร์ฟทั้งออเดอร์**
  (order ready) once nothing is still cooking, otherwise **ยังทำอยู่ N**; ready orders
  float to the top, then the longest-waiting.
- **ภาระสถานี (Station load)** — per-station workload: how many dishes are **ค้าง**
  (active) and **เกินเวลา** (overdue), the oldest/average wait, an **all-day** count
  of each dish still to cook, and today's **เสิร์ฟวันนี้** (bumped) and **เรียกคืนวันนี้**
  (recalls) totals — for balancing cooks across stations. On a phone this view stacks
  as cards; on a tablet/desktop it is a table.
- **เวลาทำเฉลี่ย (Prep times)** — the manager report behind the **prep-time auto-learn**
  (F5): the **actual average cook time** (fired → served) for each dish over the last
  **14 days**, with the **จำนวนครั้ง** (sample count) it was measured from and an
  *updated-at* stamp, sorted slowest first. This is the same learned figure the board
  uses to set each ticket's ETA and SLA colour, so the report is how you *see and sanity-
  check* what the kitchen display is timing against. A dish needs **≥3 served tickets**
  before it appears (until then the board falls back to the station default). Read-only;
  gated to **pos / order_mgt / exec**. Cards on a phone, a table on a tablet/desktop.

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

> **Accepting a customer quote that books revenue needs a second person.** When a
> **billable** quote (a value above zero, `POST /api/cpq/quotes/:id/accept`) is
> accepted, the system recognises revenue (Dr Accounts Receivable / Cr Sales). The
> person who **accepts** the quote must be **different** from the person who
> **created** it — the quote's author can't accept their own quote — so revenue is
> recognised by a second person. A self-accept is blocked with **SOD_VIOLATION** and
> **no revenue is posted**. (A zero-value quote with no ledger is just a status
> change and isn't gated.)

> **A quote below the margin floor / over the discount ceiling needs approval before it can go out (CPQ-01).**
> Every quote line now carries a **unit cost**, so when you **send** a quote the system works out its
> **discount %** and **margin %** and checks them against your company's floor (**Settings → CPQ**,
> `GET`/`PUT /api/cpq/settings`; defaults **20 % minimum margin / 15 % maximum discount**). A quote **within**
> the floor sends normally. A quote that **breaches** it (too much discount, or margin below the floor) is held
> in **รออนุมัติส่วนลด (Pending approval)** — it **cannot be accepted** until a **different** authorised person
> (a `cpq_approve`/`exec` approver) presses **อนุมัติ (Approve)** on the `/cpq` Quotes tab. The quote's author
> **cannot approve their own quote** (**SOD_SELF_APPROVAL**). Pressing **ปฏิเสธ (Reject)** on a pending quote
> sends it **back to Draft** for re-pricing. The `/cpq` Quotes table shows the discount %/margin % and a
> **Pending approval** badge so you can see at a glance which quotes are held.

> **Bundles, a higher exec discount tier, and recommendations (CRM-12).** On `/cpq`'s new **Bundles** tab you
> can define a **bundle** — a named SKU made of existing configs, each with its own quantity and cost — then,
> from a **Draft** quote, add the bundle as a set of lines in one action (`POST /api/cpq/quotes/:id/lines/bundle`).
> Because a bundle expands into ordinary priced lines, the **same** discount/margin floor above still governs it
> — there's no separate bundle pricing rule to bypass. Your company can also set a **second, higher discount
> ceiling** (**Settings → CPQ**, `exec_discount_pct`) above the normal floor: a breach past that higher ceiling
> can only be approved by someone holding **exec** authority specifically — a regular discount-approver is
> blocked with **TIER_APPROVAL_REQUIRED**. Finally, `GET /api/cpq/recommendations?config_code=` suggests other
> products worth quoting alongside a given one, based on what other customers actually bought together — a
> plain historical count, not a black-box model.

> **Pricebooks — quote from a governed price list (CRM-14, control CRM-15).** On `/cpq`'s new **Pricebooks**
> tab (a master-data screen, `masterdata` duty) you can create a **pricebook** — a named, currency-scoped price
> list with an optional **effective window** (from/to; leave blank = always effective) — and fill in its
> **per-item prices** (`item code → unit price`). When a quote is created **against a pricebook**, each line
> whose item/config code has an entry takes the **pricebook price** instead of a typed one, so the quoted price
> has a governed, auditable basis (the quote records which pricebook priced it). A pricebook that is **inactive**
> or **outside its effective window** is refused at quote time (`PRICEBOOK_INACTIVE` / `PRICEBOOK_NOT_EFFECTIVE`)
> — a superseded list can't be used. The **discount/margin floor above still governs** the result: a below-cost
> pricebook price is held **รออนุมัติส่วนลด** just the same. (Quotes are created via the API / the deal
> workspace; the `/cpq` Pricebooks tab is where the price lists are maintained.)

### To update an order's status

1. Go to **Orders** (`/orders`) and open the order.
2. Choose the new **Status** (**สถานะ**), e.g. *Processing*.
3. For *Processing* or *Shipped*, set an **estimated delivery** date if needed.
4. Save.

**Expected result:** All lines on the order move to the new status.

[screenshot: order detail with status selector]

### Print or email a delivery note (ใบส่งของ)

**Screen:** `/delivery` · **Required permission:** `delivery`

> **Creating a delivery order:** the **เลขที่ออเดอร์ (SO)** field is a **dropdown of open
> sales orders** (status Pending/Processing, from `GET /api/delivery/open-orders`) — pick the
> order to derive the delivery lines instead of typing `SO-…`.

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

> **Reviewing voids & refunds after the fact (exception report).** Voids and small
> (under-฿1,000) refunds go through with a single user to keep the till fast, so a
> reviewer independent of the till should look over that activity periodically. The
> **void / refund exception report** (`GET /api/payments/exceptions/voids-refunds`,
> permission `exec` / `ar` / `fin_report`) lists **every voided payment and every
> refund** for a chosen window (add optional `from`/`to` dates as `YYYY-MM-DD`), each
> with its number, amount, who did it and when, plus a count and total per type. It is
> read-only — nothing is posted — and store-scoped. Use it monthly (or per shift) to spot
> unusual void/refund patterns. This is the recommended **detective** control for POS
> voids and sub-threshold refunds (gap **G14**); large refunds are already gated by
> REV-16 above.
>
> **Where to find it in the app.** This report is surfaced as a read-only **"Voids / refunds"**
> review card on the **Pending Approvals** screen (`/approvals`) — a reviewer independent of the
> till scans it periodically. Nothing is approved from the card; it is a detective, review-only view.

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
- **How "เงินที่ควรมี" (expected cash) is worked out:** opening float **+ cash sales, including any tip
  paid in cash** (a cash tip physically sits in the drawer) **+ paid-in − paid-out − drops − cash refunds**.
  Tips paid on a **card** are *not* drawer cash and are excluded. So if the drawer counts exactly what the
  screen expects, the variance is **0** — you should not see a phantom "เกิน" equal to the day's tips.
- **Variance approval** (POS-01): sessions closed with a large cash over/short appear as **"ผลต่าง"** — the Supervisor reviews and approves/rejects (a different person from the cashier who closed, enforced by the API).
- **ปิดกะ / นับเงิน (close till).** When a till is open, the **ปิดกะ / นับเงิน** button opens the close
  dialog: enter the **counted** cash and submit — the API computes the variance and (if it's material)
  parks it for a different approver as above.
- **ปิดกะแบบไม่เห็นยอด (blind drawer close).** The toggle in the header turns on a per-shop policy:
  the cashier must count the drawer **without seeing เงินที่ควรมี** — the close dialog hides the expected
  figure and the X/Z reports on an open session hide it too (enforced by the server, not just the screen).
  The expected cash and the variance appear **after** you submit the count, and the session records that
  it was closed blind. Only a manager (`ar`/`exec`) can change the policy; a till-only user gets a 403.
  This stops "counting to the number" — a short drawer can't be masked by keying the expected amount.
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
**tamper-evident** record. Pick the closed session (**TILL-…**) from the **dropdown of closed till
sessions** (`GET /api/payments/till/sessions?status=Closed`; choose **พิมพ์เลขเอกสารเอง…** to key an
older id) and click **ลงนาม Z-Report**.
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

#### PromptPay day-end reconciliation — did the QR money actually arrive?

**Endpoints:** `/api/pos/promptpay-recon/*` · **Required permission:** map the account `recon_prep`/`exec`;
run + clear exceptions `recon_prep` / `pos_close` / `exec` (a sell-only cashier cannot run it).

A **PromptPay QR** sale is taken at the till before the money has actually settled — the customer scans
and pays, and the funds land in the shop's bank account a little later. This check makes sure **every QR
taking really arrived in the bank**, per shop, per day, so a QR payment that failed, was skimmed, or
settled short is caught instead of being assumed good.

1. **Map the settlement account (once).** Tell the system which house-bank account your PromptPay
   collections land in (`PUT /api/pos/promptpay-recon/settlement-account`).
2. **Import the bank statement** for the day on that account (the same **นำเข้าไฟล์ statement** used for
   bank reconciliation — see the finance manual).
3. **Run the reconciliation** for the business day (`POST /api/pos/promptpay-recon/run`). The system
   matches the day's PromptPay tenders to the **incoming** bank lines using the **same auto-match** the
   bank reconciliation uses (amount, date, and the payer reference). Every QR taking that ties out to a
   bank inflow is marked reconciled.
4. **Review the exceptions.** A QR taking with **no matching bank inflow** is raised as a **till/cash
   exception** (just like a cash over/short) and stays on the open worklist
   (`GET /api/pos/promptpay-recon/exceptions?status=Open`) until a manager clears it
   (`…/exceptions/:id/clear`). If the money simply arrived **late**, re-running the check the next day
   **auto-clears** the exception once its bank line appears.

> This ties every store's QR sales back to the bank statement so unsettled or short e-payments don't slip
> through. It **posts nothing to the accounts** — it's a detective check only. (Control **POS-08**.)

---

## 7. Claims (sales claims)

**Screen:** `/claims` · **Required permission:** `claim_mgt`

1. Go to **Claims** (`/claims`) → **Sales Claims** tab.
2. Open a claim that is **Waiting**.
3. Choose **Approve** or **Reject** (add a reason if rejecting).

**Expected result:** The claim status changes to *Approved* or *Rejected*.

> **On a phone.** The Sales Claims list shows one **card per claim** (order, item, qty,
> status, and the approve / reject-reason / reject controls) instead of the wide desktop
> table, so you can clear waiting claims from a phone without sideways scrolling.

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
