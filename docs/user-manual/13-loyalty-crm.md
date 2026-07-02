# Members & Points CRM (สมาชิก & แต้ม)

**Status: DRAFT v0.1** · Last updated: 2026-06-24 · For: Sales, Marketing, Loyalty Admin, Managers

This guide covers the loyalty CRM — the **member directory**, the **360° member view**, the **PDPA
consent register**, and the **points-liability** report. Configuring earn/redeem rates is in
*Loyalty settings* (**ตั้งค่าแต้ม**, `/loyalty`).

> **Required permission:** `loyalty` or `marketing` (the member directory and 360 view also accept
> `crm`). The points-liability figure also accepts `exec`. If you don't have one of these, the
> **สมาชิก & แต้ม** menu item is hidden.

---

## 1. Open the member directory

Go to **สมาชิก & แต้ม** (`/loyalty/members`). You will see:

- **Active members** (**สมาชิกที่ใช้งาน**) — count of active members.
- **Points outstanding** (**แต้มคงค้าง**) — total unredeemed points, with the value per point.
- **Points liability** (**หนี้สินแต้ม**, account `2250`) — the money value the business owes members in
  points (see §4).
- **Redeemed to date** (**แลกแล้ว**) — points members have already used.

Below the cards is the searchable member list.

## 2. Find a member

1. Type into **Search** (**ค้นหา**) — name, phone, card number, or member code (e.g. `M-000123`).
2. Optionally pick an **RFM group** (**กลุ่ม RFM**): *Champions*, *Loyal*, *At Risk*, *Lost*, *New*.
3. Press **Search** (**ค้นหา**).

Each row shows the member code (a link), name, phone, RFM group, tier, points balance, and whether the
member has agreed to receive news (**รับข่าวสาร** — *ยินยอม* / *ปฏิเสธ*).

## 3. View a member 360 (มุมมอง 360 องศา)

Click a member code to open `/loyalty/members/:id`. The 360 view shows:

- **Header cards** — RFM segment, points balance, lifetime points, total spend / order count.
- **Consent (PDPA)** (**ความยินยอม**) — see §5.
- **Points history** (**ประวัติแต้ม**) — every earn / redeem / adjust with the running balance and the
  reference document (e.g. `SALE-…`).

## 4. Points liability (หนี้สินแต้ม — account 2250)

Loyalty points are money the business **owes** its members — a liability, not a free giveaway. The figure
on the directory is the **outstanding points × value per point** (the redeem rate from *Loyalty
settings*), carried in general-ledger control account **2250 — Loyalty Points Liability**. The directory
also shows how much has already been **posted** to the GL and any **unposted** gap.

**Posting the accrual to the books.** Finance records the liability in the GL with the accrual run
(`POST /api/loyalty/liability/post`, permission `gl_post` / `exec`). It books a balanced journal entry —
`Dr 5700 Loyalty Points Expense / Cr 2250 Loyalty Points Liability` when points are net granted, and the
reverse when net redeemed — so account 2250 always equals the outstanding points at fair value.

- The run is **safe to repeat** (idempotent): running it twice never double-counts.
- It is **per shop** (tenant): an HQ/Admin user must say which shop (`tenant_id`).
- It posts into the **current open period**; a closed period is rejected.
- It also runs **automatically when finance closes a period** (and at year-end close) — so the liability is
  always booked before the books lock, and no one has to remember to run it.

**Points expiry (breakage).** Points expire after the number of days in *Loyalty settings* (`expiry_days`).
Running the expiry job (`POST /api/loyalty/expire`, permission `loyalty` / `exec`) writes off points older
than that window (an **Expire** line appears in the member's points history) and the next accrual releases
the matching liability (`Dr 2250 / Cr 5700`). It's safe to repeat and runs per shop — schedule it (e.g.
monthly) so expired points don't sit on the books. Set `expiry_days` to `0` to disable expiry.

**Hands-off automation.** You don't have to run any of this by hand. `POST /api/loyalty/maintenance/run`
does the whole cycle for every shop in one call (expire, then accrue), and the repository ships a daily
**scheduled job** (`.github/workflows/loyalty-maintenance.yml`) that calls it — turn it on by setting
`PROD_API_URL`, `SWEEP_USER`, and `SWEEP_PASS` (a dedicated service account with `exec`/`gl_post`). The
accrual *also* runs automatically whenever a period is closed, so the books are never left stale.

**Warn members before their points die (เตือนแต้มใกล้หมดอายุ).** The same daily sweep also *looks ahead*:
any member whose points will expire **within the next 30 days** fires a **`loyalty.points_expiring`** event
(with the points at risk and the days left) into **Automation** (`/automation`) and **Webhooks** — wire a
rule like *when `loyalty.points_expiring` → send a message / enrol in a journey* ("แต้ม 500 จะหมดอายุใน
30 วัน") and the member gets one nudge per expiring batch (**never a daily re-nag**), always through the
normal consent checks.

- **Who uses it:** Managers / Finance (`exec` / `gl_post`) reconcile account 2250 at each period close.
- **What it means:** 2250 ties to the sum of all members' point balances at their fair value (you owe the
  points whether or not a member is marked active — to forfeit points, adjust the member's balance).
- This is required for accurate financial statements under **TFRS 15 / IFRS 15** — the obligation to honour
  outstanding points is recognised as a liability, released when points are redeemed (and, in a future
  release, recognised as breakage income when points expire).

## 5. Manage consent (PDPA) (ความยินยอม)

Each member has a consent switch per **purpose**: *General marketing* (**การตลาดทั่วไป**), *LINE*, *SMS*,
*Email*, and *Profiling* (**วิเคราะห์พฤติกรรม**).

To change consent: open the member 360 and toggle the purpose. The change is saved immediately and dated.

> **Note (control):** turning **General marketing** off stops **all** marketing messages to that member
> at once — the message blast (**ส่งข้อความหากลุ่มลูกค้า**) skips opted-out members and records them as
> *skipped*, never contacted. This enforces PDPA consent and leaves an audit trail in the message log.

---

## 6. Rewards & coupons (ของรางวัล & คูปอง)

Members spend their points on **rewards** you define, and redeem **coupons** at the till.

**Manage the catalog.** Go to **ของรางวัล & คูปอง** (`/loyalty/rewards`, role `marketing`/`exec`). Add a
reward: a name, a type (e-voucher / discount / product / privilege), how many **points** it costs, its
**value** in baht, and optionally a **stock** cap, a **per-person** limit, and a minimum tier. Toggle a
reward on/off with the status chip. The catalog has a **search** (name / code / type) and **ทั้งหมด /
เปิด / ปิด** status filter to find a reward in a long list; the same search + status filter is on the
**ภารกิจ & แสตมป์** (`/loyalty/missions`) list.

**A member redeems a reward.** `POST /api/loyalty/rewards/:id/redeem` (role `loyalty`/`pos`) burns the
member's points and issues a **single-use code** (`RDM-…`, scannable). It checks the member has enough
points, the reward is in stock, and the per-person limit isn't exceeded. Points come off immediately; the
loyalty liability is released at the next accrual.

**Use the code at the till.** `POST /api/loyalty/redemptions/:code/use` (role `pos_sell`) marks the code
**used** — it can be used only **once** (a second scan is rejected). The cashier applies the reward
(discount / free item) and records the sale number. Configuring rewards (marketing) and redeeming them at
the till (cashier) are deliberately **different roles**.

**Coupons & wallet.** Issue a discount coupon to a member with `POST /api/loyalty/coupons/issue` (`CPN-…`);
it's used once at the till like a redemption. See everything a member holds — redeemed rewards and coupons
— on their **360 page** under *ของรางวัล & คูปอง (Wallet)*.

## 7. Tiers & missions (ระดับ & ภารกิจ)

**Tiers.** Members climb tiers (e.g. Silver → Gold) as their **lifetime points** grow, set by the tier
ladder in *Loyalty settings*. Tiers recompute **automatically** (the daily maintenance sweep, or
`POST /api/loyalty/tiers/recompute`), and every change is recorded. A member's **tier journey** — current
tier, the next tier up, and points to go — shows on their 360 page.

**Tier earn multipliers (ตัวคูณแต้มตามระดับ).** On **ตั้งค่าระบบสะสมแต้ม** (`/loyalty`, role `loyalty`/
`marketing`) the tier-ladder card sets each tier's **×earn** multiplier — e.g. Gold ×2 means a Gold member
earns **double points on every sale** (the multiplier applies at the till, and the ledger row records
`tier Gold ×2` so you can always see why a member earned more). The points liability accrues the multiplied
points automatically — no extra accounting step. Leave the ladder empty and everyone earns ×1 as before.

**Missions & stamp cards.** Go to **ภารกิจ & แสตมป์** (`/loyalty/missions`, role `marketing`/`exec`) and
create a mission: a name, a goal (e.g. 10 stamps), and a reward (bonus points or a coupon). At the till,
add a **stamp** to a member (the `+ แสตมป์` button on their 360, or `POST /api/loyalty/missions/:id/progress`).
When the goal is reached the member **claims** the reward (`รับรางวัล`) — **once only** (a second claim is
rejected). Bonus points land on the member's balance and count toward their tier.

## 7b. Coalition network (เครือข่ายพันธมิตรแต้ม — สะสม/แลกได้ทุกร้านในเครือ)

Run **one points economy across several shops** (a franchise or multi-brand group) — a member of shop A
earns and redeems at partner shop B, and the accounting between the shops settles itself.

1. **Set up (HQ only).** On **ตั้งค่าระบบสะสมแต้ม** (`/loyalty`) the *เครือข่ายพันธมิตรแต้ม* card lets an
   HQ admin create a network (code + name) and add shops to it. Shop staff cannot change the network
   (`COALITION_HQ_ONLY`).
2. **At the partner till.** Staff look the member up **by phone** (the resolve box on the card, or
   `GET /api/coalition/resolve?phone=`). A member of any shop in the same network resolves with the
   **เครือข่ายพันธมิตรแต้ม badge** — code, name, tier, points and home shop only (no phone/email/birthday:
   partner shops never see another shop's contact data). A shop outside the network simply gets *not found*.
3. **Earn / redeem.** `POST /api/coalition/earn` (`{member_id, net_spend}`) and `POST /api/coalition/redeem`
   (`{member_id, points}`) — the points always move on the member's **home-shop ledger** (same rules as a
   home sale: tier multipliers, balance checks), so each shop's points liability stays exactly its own.
4. **The money sorts itself out.** Every cross-shop movement books a balanced **intercompany clearing
   entry** at fair value — the shop that made the other shop's liability grow owes it (and a redeem
   reverses it). HQ settles the running balances on the intercompany screen; the group reconciliation
   nets to zero. If the partner shop's accounting period is closed, the whole movement is rejected —
   points never move without the matching entry.

## 7c. NPS & messaging governance (เสียงลูกค้า & กติกาการส่งข้อความ)

**NPS — ทุกบิลกลายเป็นผู้แนะนำได้ (W3).** ส่งแบบสอบถาม 0–10 หลังการขายให้สมาชิก:
กดส่งรายคน (`POST /api/nps/send`), กวาดบิลล่าสุด (`POST /api/nps/send-due`), หรือ**ตั้งเวลาอัตโนมัติ**ด้วย
งานรายงาน `nps_post_purchase` (หน้าสมัครรายงาน BI). สมาชิกได้รับ**ลิงก์เฉพาะตัวแบบใช้ครั้งเดียว**
(`/nps/<token>` — ไม่มีข้อมูลส่วนตัวใน URL, หมดอายุใน 7 วัน) ตอบซ้ำไม่ได้ ระบบส่งลิงก์ผ่านช่องทางปกติ
และเคารพความยินยอมเสมอ. **คะแนน ≤ 6 (detractor)** ยิงเหตุการณ์ `loyalty.nps_detractor` เข้า
**Automation/Webhooks** — ผูกกฎ *เมื่อคะแนนต่ำ → แจ้งเตือนทีม / ดึงเข้า journey กู้คืนบริการ* ได้ทันที.
ดูภาพรวมที่ `GET /api/nps/summary` (NPS = %ผู้แนะนำ − %ผู้ตำหนิ + แนวโน้มรายเดือน) และหน้า 360 ของสมาชิก
จะติดธง detractor ให้เห็นทันที.

**กู้คืนบริการ (Service recovery — `/loyalty/recovery`).** ทุกคะแนน ≤ 6 เปิด**เคส**ให้อัตโนมัติหนึ่งเคส
พร้อมกำหนด**ติดต่อกลับภายใน 24 ชม.** — ทีมกด **📞 ติดต่อแล้ว** เมื่อโทรหาลูกค้า และ**ปิดเคส**ได้ต่อเมื่อกรอก
บันทึกการแก้ไข (ระบบประทับชื่อผู้ทำทุกขั้น). เคสที่เปิดค้างเกินกำหนดขึ้นป้าย**เกิน SLA** สีแดงทั้งบน worklist,
สรุป NPS และหน้า 360 ของสมาชิก — ไม่มีเคสหายเงียบ. (สิทธิ์ `crm`/`loyalty`/`marketing`; control LYL-20)

**กติกาการส่งข้อความ (governance).** ที่ **ตั้งค่า → ผู้ให้บริการข้อความ** (`/settings/messaging`) การ์ด
*กติกาการส่ง* กำหนด (เปิดใช้เมื่อบันทึกครั้งแรก — ค่าแนะนำ 21:00–09:00 และ 4 ข้อความ/สมาชิก/7วัน):
- **ช่วงเงียบ (quiet hours):** ข้อความ**การตลาด**ที่ถึงกำหนดในช่วงเงียบจะไม่ถูกส่ง — journey จะ**เลื่อนขั้นเดิม
  ไปส่งหลังสิ้นสุดช่วง** (ไม่ข้ามข้อความ) ส่วนบรอดแคสต์จะข้ามพร้อมบันทึกเหตุผล `quiet hours` ในบันทึกการส่ง
- **เพดานรวมทุกช่องทาง:** จำกัดจำนวนข้อความการตลาดต่อสมาชิกต่อ 7 วัน — นับรวม LINE/SMS/อีเมลจากทุกเครื่องมือ
  ส่วนที่เกินถูกข้ามพร้อมบันทึก `global cap`
- **ข้อความธุรกรรมส่งได้เสมอ:** OTP ใบเสร็จ แจ้งคิว/จัดส่ง ทวงหนี้ รายงาน และ NPS ไม่ติดกติกานี้ (แต่ยังเคารพ
  ความยินยอมของสมาชิก)

## 7d. Paid VIP membership (สมาชิก VIP แบบเสียเงิน)

ขายแพ็กเกจระดับสมาชิก (เช่น "บัตรทองรายปี ฿1,200") ที่การ์ด *สมาชิก VIP แบบเสียเงิน* บน `/loyalty`:

1. **สร้างแผน** (สิทธิ์ `marketing`/`exec`) — รหัส, ชื่อ, **ระดับที่ได้** (เช่น Platinum), ราคา, จำนวนเดือน.
2. **ขาย** (สิทธิ์ `pos`/`loyalty`) — ใส่ id สมาชิก + id แผน → ระบบเก็บเงิน (Dr เงินสด / Cr **2410 รายได้รอรับรู้**
   ตาม TFRS 15 — ไม่รับรู้รายได้ทันที), อัปเกรดระดับให้พร้อมบันทึกประวัติ `vip`, และสมาชิกเห็น "👑 สมาชิก … ถึง
   {วันหมดอายุ}" บนการ์ดในแอป `/m`. สมาชิกมีแพ็กเกจ Active ได้ครั้งละหนึ่ง (`MEMBERSHIP_ACTIVE`).
3. **รับรู้รายได้รายเดือน** — อัตโนมัติผ่านงานรายงาน `membership_revenue_recognize` (หรือ
   `POST /api/loyalty/memberships/recognize`, สิทธิ์ `gl_post`/`exec`): ตัด 2410 → 4300 เดือนละ
   ราคา÷จำนวนเดือน แบบ idempotent — รันซ้ำไม่ลงซ้ำ.
4. **หมดอายุเอง** — sweep รายคืนปิดแพ็กเกจที่เลยวันสิ้นสุด (ประวัติ `vip-expired`) แล้วระดับ**ถอยกลับ**ไปตาม
   แต้มสะสมจริงโดยอัตโนมัติ — ไม่มี VIP ฟรีตลอดชีพ. (control LYL-21)

## 8. Refer a friend (แนะนำเพื่อน)

Members bring in new members and both get rewarded. On a member's **360 page** under *แนะนำเพื่อน
(Referrals)*, enter the **member id** of the person they referred and press **แนะนำ**. When you're ready to
reward it, press **ให้รางวัล** — both the referrer and the referred member receive bonus points (**once
only**; a member can be referred only once, and a member can't refer themselves).

## 9. Member self-service app (แอปสมาชิก — เข้าด้วย OTP)

Members get their **own** app — a phone, no staff login. Open **`/m`** on the phone (this is a separate
consumer page, not the staff app; LINE LIFF is a future wrapper on the same login).

1. **Log in** — enter the **shop code** (e.g. `T1`) and the **phone number** registered with the shop, press
   **ขอรหัส OTP**. A 6-digit code is sent by SMS (valid **5 minutes**, single use). Enter it → **เข้าสู่ระบบ**.
   The login stays valid for 7 days on that device. The session is held in a secure browser cookie (the
   sign-in token is **not** readable by page scripts), so leave cookies enabled for `/m`.
   **เปิดจาก LINE (LIFF):** ถ้าร้านตั้งค่า LIFF แล้ว (`NEXT_PUBLIC_LIFF_ID`) การเปิด `/m` จากใน LINE จะ
   **เข้าสู่ระบบแบบแตะเดียว** — ครั้งแรกระบบให้ยืนยัน OTP หนึ่งครั้งเพื่อผูกบัญชี LINE กับสมาชิก
   (ขึ้นข้อความสีเขียวบอก) หลังจากนั้นเปิดจาก LINE เมื่อไหร่ก็เข้าเลยไม่ต้องกรอกอะไร · ลิงก์ LIFF ควรพก
   รหัสร้านมาด้วย (`?shop=T1`) ไม่งั้นระบบใช้ร้านล่าสุดที่เคยเข้าบนเครื่องนั้น · เปิดในเบราว์เซอร์ปกติ =
   OTP ตามเดิม ไม่มีอะไรเปลี่ยน
2. **What the member sees** — a digital **card** (name, code, tier, points balance) with a **tier-ladder
   strip** (current level, its **×earn multiplier**, and a progress bar to the next rung), an
   **expiring-points warning chip** ("แต้ม 500 จะหมดอายุใน 20 วัน — ใช้ก่อนหมดนะ!") when the daily sweep has
   flagged an upcoming batch, **ของรางวัล** (browse and **แลก/redeem** rewards with points → the code lands
   in *คูปองของฉัน*), **ภารกิจ** (mission progress + **รับรางวัล**), **ส่งแต้มให้เพื่อน** (the P2P transfer form —
   friend's phone + points + a note; all the guards in §9's transfer bullet apply and the app shows the
   reason verbatim when a transfer is rejected), **ประวัติแต้ม** (สะสม/แลก/โอนออก/รับโอน/หมดอายุ with the
   running balance), **ชวนเพื่อน** (refer a friend by phone), and their referral history.
   **โอนแต้มให้เพื่อน (send points to a friend):** `POST /api/member/points/transfer` with the friend's
   **phone number** and the points — both must be members of the **same shop**. The move is instant and
   all-or-nothing (both sides recorded, or neither); a member can send at most **the daily cap** set in
   *Loyalty settings* (`เพดานโอนแต้มต่อวัน`; `0` switches the feature off), can't send more than their
   balance, and can't send to themselves. Staff can assist a transfer from the back office
   (`POST /api/loyalty/members/:id/transfer`, role `crm_points_adjust`/`loyalty`/`exec`).
   **บัตรใน Wallet ของมือถือ (V5):** กด **"เพิ่มลงใน Wallet"** บนการ์ด `/m` เพื่อเก็บบัตรสมาชิกไว้ใน
   Apple Wallet / Google Wallet (`POST /api/member/wallet-pass`) — บัตรแสดง ชื่อร้าน รหัสสมาชิก (QR) ระดับ
   และแต้ม **เท่านั้น** (ไม่มีเบอร์โทร/วันเกิด — PDPA) และแต้มบนบัตรจะอัปเดตตามการสะสม/แลกโดยอัตโนมัติ
   กดซ้ำได้ ไม่สร้างบัตรซ้ำ (หนึ่งใบต่อแพลตฟอร์ม) พนักงานดูสถานะบัตรของสมาชิกได้ที่หน้า Member 360.
   > **Ops note:** จนกว่าจะตั้งค่า certificate/service-account จริง (`WALLET_APPLE_*` / `WALLET_GOOGLE_*`
   > หรือ per-tenant ในตั้งค่า) ระบบใช้ **mock provider** — ลิงก์ติดตั้งเป็นลิงก์ทดสอบ ไม่มีอะไรออกนอกระบบ
   > ตั้งค่า creds เมื่อไหร่ โค้ดเดิมออกบัตรจริงทันที (แบบเดียวกับ SMS/LINE ก่อนมี credentials) —
> ขั้นตอนตั้งค่าจริงทีละสเต็ป: `docs/ops/wallet-pass-certs-runbook.md`.
3. **Log out** — press **ออกจากระบบ** on the card. This ends the session on the server and clears the
   secure cookie, so the device can't be reused without logging in again.
4. **Safety** — a member can only ever see and act on **their own** account; the app cannot reach any
   staff/back-office screen. If a wrong code is entered too many times, the code is locked — request a new one.

> Staff note: the member app reuses the same rewards/missions/referrals engine as the back-office, so a reward
> redeemed in the app is the same single-use `RDM-…` code staff scan at the till.

## 10. Spin-the-wheel / lucky draw (วงล้อนำโชค)

Turn points into a game. On **วงล้อนำโชค** (`/loyalty/wheels`) create a wheel:

1. Set **ใช้แต้ม/ครั้ง** (points to spin; `0` = free) and **ฟรี/วัน** (free spins per member per day).
2. Add **ช่องรางวัล** (prize segments): each has a **ป้าย** (label), a prize (**แต้ม** / **คูปอง** / **ไม่ได้**), a
   **น้ำหนัก** (weight = relative chance) and an optional **สต๊อก** (leave blank for unlimited). The chance a
   segment is drawn is *its weight ÷ the total weight of segments that still have stock*.
3. Members spin from the **member app** (`/m`) — or staff spin at the till. Each spin burns the points (or uses
   a free spin), the **server** picks one prize at random by weight (the member can't influence it — *provably
   fair*; every spin is recorded), and a points/coupon prize lands instantly.

> Controls: the draw is server-side and audited (each spin → a `loyalty_spins` row); the point cost is burned
> under the member lock with a balance check; a **limited-stock** prize can never be oversold. *(MKT-09.)*

## 11. Campaigns (แคมเปญ — ส่งข่าวสารหากลุ่มสมาชิก)

Reach the right members with the right message. On **แคมเปญ** (`/loyalty/campaigns`):

1. **Create** a campaign — a **ชื่อ**, a **ช่องทาง** (SMS / Email / LINE), a **กลุ่มเป้าหมาย** (all members, an
   **RFM segment**, a **tier**, or **today's birthdays**), and the **ข้อความ**.
2. **Send now** (**ส่งเลย**) or set **ตั้งเวลาส่ง** — a scheduled campaign fires automatically when its time comes
   (on the daily maintenance run).
3. Track results on each row: **ส่ง / ข้าม / พลาด** (sent / skipped / failed).

> Controls: members who **opted out of marketing** are automatically **skipped** (PDPA) — never messaged; each
> send is **idempotent** (a campaign can't be sent twice — a second send is rejected); and every recipient is
> recorded in the message log. *(MKT-10.)*

> **LINE OA broadcast (ประกาศถึงผู้ติดตามทั้งหมด).** To announce something to **everyone who follows your LINE
> Official Account** — not just enrolled members — use the OA broadcast (`POST /api/messaging/broadcast-oa`,
> permission `marketing`/`exec`). It sends one message to all followers at once. Note: because it targets your
> OA's followers (not member records), it does **not** apply the per-member marketing opt-out — a follower
> opts out by unfollowing the OA. Every broadcast is recorded in the message log for audit.

> **Auto-enrol from LINE (follow webhook).** Point your LINE Official Account's webhook at
> `…/api/line/webhook/<your-shop-code>` and set the **Channel secret** on the Messaging providers screen. Then
> when someone **adds your OA**, they are automatically enrolled as a member (reachable over LINE); if they
> unfollow, it's logged but their membership and points are kept. The webhook is authenticated by your channel
> secret, so only genuine LINE events are accepted.

> **Rich LINE messages (flex).** Both the broadcast and a targeted send can carry a **rich card / carousel**
> (image + text + buttons) instead of plain text — pass a LINE *flex* layout with an `alt_text` (broadcast:
> `flex`+`alt_text`; targeted: `POST /api/messaging/line/flex` to a member or LINE userId). Great for promo
> cards, reward vouchers, and receipts.

> **Channel delivery:** LINE, SMS, and Email all deliver for real once the workspace has that channel's
> provider configured (LINE Official Account token, an SMS provider key, or an SMTP mailbox — set by your
> administrator; see `docs/ops/secrets.md`). Until a channel is configured it runs in **demo mode**: the send
> is logged as *sent* but no message actually leaves — check the message log's **provider** column (`mock` =
> demo, the channel name = live).
>
> **Delivery receipts.** The message log keeps each message's **provider reference** (the id the SMS/LINE/email
> provider returned). If your provider supports delivery callbacks, point it at
> `POST /api/messaging/delivery-callback/<your-shop-code>` with the per-channel **callback token** you set in
> your provider credentials (sent as the `X-Callback-Token` header) — the matching log row then advances from
> *sent* to **delivered** or **undelivered**, so you can see which messages actually reached the customer. This
> is optional; without it, a message stays *sent*.
>
> **Use your own provider.** An admin can connect this shop's **own** LINE Official Account / SMS sender /
> email mailbox on the **ผู้ให้บริการข้อความ** screen (**Settings → Integrations → Messaging providers**,
> `/settings/messaging`, permission `users`/`exec`) so messages go out under your brand. Enter the credentials,
> press **บันทึก**, then use **ส่งทดสอบ** to send a test message and confirm delivery. Credentials are stored
> encrypted and are write-only — the screen shows only which channels are connected, never the keys. If you set
> nothing, the platform's shared provider (or demo mode) is used. Once your **SMS** sender is connected, the
> member-app login OTP also goes out from **your** sender id (not the shared platform number).
>
> **Go-live readiness at a glance.** Each channel card carries a status badge — 🟢 **พร้อมใช้งาน** (your own
> provider), 🟡 **ค่ากลางแพลตฟอร์ม** (shared platform provider), ⚪ **โหมดเดโม** (nothing actually leaves the
> system) — plus the channel's **last delivery** (status / provider / time) and a *รับ delivery receipt* chip
> when a callback token is set. If a channel shows ⚪ demo mode but has been "sending", the card warns you:
> those messages were logged as *sent* but never reached a customer — connect a provider, then use **ส่งทดสอบ**
> to confirm the badge flips to 🟢 and the last delivery shows the real provider name.

## 12. Partner privileges (พันธมิตร & สิทธิพิเศษ)

Give members perks at partner shops. On **พันธมิตร & สิทธิพิเศษ** (`/loyalty/partners`):

1. Add a **partner** (a shop/brand) and one or more **privileges** — a discount %, a baht discount, a freebie,
   or access. Each privilege can require a **minimum lifetime-points** level (tier gate), a **stock** cap, and a
   **per-member limit**.
2. A member **claims** a privilege (from the member app, or staff claim at the counter) → they get a **single-use
   code** to show at the partner. The partner marks it used once.

> Controls: tier eligibility + stock + per-member limit are all enforced atomically; the claim code works **once**
> only; one tenant can't redeem another's code. *(MKT-11.)*

## 13. Loyalty analytics (วิเคราะห์ลอยัลตี้)

For managers — **วิเคราะห์ลอยัลตี้** (`/loyalty/analytics`) shows the loyalty programme at a glance:
**points-liability fair value** (and the posted GL 2250), the **redemption funnel** (issued vs used), the
**breakage rate** (points that expired), the **tier mix**, the **active rate**, and **churn risk** — members who
have been dormant for 90+ days but still hold points, ready for a **win-back** campaign. Read-only; HQ users pick
a shop.

**Live points feed.** Every time a member earns or redeems points (at the till, online, or on an approved
receipt), it appears in real time — both on the executive **live dashboard** (`/bi`) and in the **แต้มสด
(Live)** card on this Loyalty analytics page (updates every few seconds, with a live/offline dot). It's a
monitoring signal only; the authoritative record stays the member's points ledger.

**Export to a CDP (Customer Data Platform).** To load your customer base into an external marketing/CDP tool,
use the data export (`GET /api/crm/export`, permission `marketing`/`exec`). It returns the active members with
their identity, RFM segment/traits, points, and **consent flags** (marketing/LINE/SMS/email) — paginated
(`limit`/`offset`). The consent flags travel with each record so the receiving system can respect opt-outs; the
export only reads data, it never sends messages. For a single customer's data request or erasure (PDPA/DSAR),
use the privacy tools instead — this bulk export is for analytics/CDP integration.

To keep a CDP **continuously in sync** (rather than exporting by hand), schedule the **ซิงก์ข้อมูลลูกค้าไป CDP**
report (`cdp_export_sync`) from Scheduled reports (`/scheduled-reports`): each run pushes the whole member
snapshot to your CDP endpoint in batches (set `CDP_WEBHOOK_URL` — your administrator). It's safe to run daily
(a full snapshot, so re-runs just refresh) and carries the same consent flags.

**Saved custom segments.** Beyond the fixed RFM buckets you can define your **own** reusable segments — a
named set of rules over member fields (points balance, lifetime, tier, marketing opt-in) and RFM traits
(segment, total orders/spend, recency/frequency, preferred channel, …) combined with **all** (AND) or **any**
(OR). Build them on the **เซกเมนต์ลูกค้า** screen (`/loyalty/segments`, permission `marketing`/`exec`):

1. Press **สร้างเซกเมนต์**, name it, pick **ทุกข้อ (AND)** or **ข้อใดข้อหนึ่ง (OR)**, and add rule rows —
   choose a field, an operator, and a value (the field list and operators come from the server's whitelist,
   so only safe rules can be built). Leave the rules empty to mean *all active members*.
2. Press **ดูสมาชิก** on any saved segment to preview the live member count and a sample of who matches
   **right now** (membership is evaluated fresh every time — it is a rule, not a frozen list).
3. Use the segment as a campaign audience: on **แคมเปญ** pick กลุ่มเป้าหมาย → **เซกเมนต์ที่บันทึกไว้** and
   choose the segment (or send an ad-hoc blast with `audience: saved_segment`). Consent still applies —
   opted-out members are skipped, never contacted.

The API remains available for integrations: `GET`/`POST`/`PUT`/`DELETE /api/loyalty/saved-segments`,
`GET /api/loyalty/saved-segments/:id/members`. Only whitelisted fields are allowed, so a bad rule is
rejected safely.

**Journeys (เจอร์นีย์ลูกค้า).** Design a message *sequence* once and let it run per member — e.g. a welcome
series (*enrol → send now → wait 7 days → follow-up*) or a win-back drip. On **เจอร์นีย์ลูกค้า**
(`/loyalty/journeys`, permission `marketing`/`exec`):

1. Name the journey, pick the **entry** — *manual/Automation* (enrol from the API or an Automation rule's
   **enroll_journey** action, e.g. "when a member enrols → start the welcome series") or *เข้าเซกเมนต์*
   (members who match a saved segment are enrolled automatically) — and optionally a **frequency cap**
   (at most N journey messages per member per window).
2. Add **steps**: each waits N days, then sends an SMS / Email / LINE message. Press **เปิดใช้** to activate
   (pause before editing).
3. Steps are driven by the daily **รันเจอร์นีย์ลูกค้า** job (`journey_runner` BI subscription) or
   `POST /api/loyalty/journeys/run-due`. The funnel column shows members in-flight vs completed.

> **Controls (MKT-12):** a member can enrol in a journey only **once**; every step fires **at most once**
> (safe against re-runs and crashes); opted-out members are **skipped, never contacted**; over-cap messages
> are skipped — every outcome is audited in the message log under `journey:<code>:<step>`.

**Customer segments (RFM).** The **กลุ่มลูกค้า RFM** panel shows how your members split across the five RFM
segments — **Champions, Loyal, New, At Risk, Lost** — with the member count and average spend per segment (members
without a computed profile yet appear under **Unsegmented**). Click a segment to open it in **CRM 360**
(`/crm`) pre-filtered, where you can fire a targeted campaign at exactly that group. Segments are computed from
each member's recency/frequency/monetary behaviour — and stay **fresh automatically**: schedule the
**รีเฟรชโปรไฟล์ลูกค้า (RFM)** job (`crm_profile_refresh`, a daily BI subscription) to re-profile the whole
active member base overnight, so a customer who lapses moves segment without anyone clicking anything. To
force-refresh right now (e.g. before a big campaign), use `POST /api/crm/profiles/refresh`
(`marketing`/`exec`) — safe to repeat.

## 14. Receipt upload for points (อัปโหลดใบเสร็จ — ขอแต้ม)

For a purchase made **outside our own POS** (e.g. a partner store, a cash sale with no till), a member can still
claim points by uploading a photo of the receipt.

**Member (app, `/m`):**
1. Open the **อัปโหลดใบเสร็จ — ขอแต้ม** section, enter the **ยอดซื้อ (purchase amount)** and, optionally, the
   store name.
2. Choose a photo of the receipt (from the camera or the photo library) and press **ส่งขอแต้ม**.
3. The submission shows as **รอตรวจสอบ (Pending)** in the member's own list until staff review it.

**Staff (`/loyalty/receipt-approvals`, requires `crm_points_adjust` — or `loyalty`/`exec`):**
1. Review the queue of pending submissions — the receipt photo, claimed amount, and an estimated points preview
   are shown together.
2. Press **อนุมัติ (Approve)** to grant the points (posted the same way as a POS sale — no separate step needed),
   or **ปฏิเสธ (Reject)** with an optional reason. Both are final — a reviewed submission cannot be reviewed again.

> Controls: a member can never approve their own submission (the member app token carries no approval
> permission); the same receipt (same member, date, and amount) cannot be claimed twice while a submission is
> pending or approved — a rejected one can be resubmitted (e.g. with a clearer photo). *(LYL-17.)*

> **Where the photos are stored.** By default receipt photos are kept in the database. For a large programme,
> your administrator can connect **object storage** (an S3-compatible bucket; `OBJECT_STORE_URL`, see
> `docs/ops/secrets.md`) — new photos are then stored there and only a reference is kept in the database, which
> keeps the system fast as volume grows. Nothing changes for the member or reviewer. If a customer exercises
> their right to be forgotten (PDPA), the stored photo is deleted along with their other personal data.

## Errors you might see

| Code | Meaning | What to do |
|---|---|---|
| `MEMBER_NOT_FOUND` | The member id does not exist | Check the member code / re-search. |
| `NO_TENANT` | Your login has no shop context | Sign in to the correct tenant. |
| `INSUFFICIENT_POINTS` | Member doesn't have enough points for the reward | Choose a cheaper reward or earn more. |
| `OUT_OF_STOCK` / `LIMIT_REACHED` | Reward sold out, or per-person limit reached | Pick another reward. |
| `ALREADY_USED` | Redemption/coupon code was already redeemed | Each code works once only. |
| `REDEMPTION_EXPIRED` / `COUPON_EXPIRED` | The code passed its expiry date | Issue a new reward/coupon. |
| `SELF_REFERRAL` / `ALREADY_REFERRED` | Referring yourself, or a member already referred | Refer a different friend. |
| `OTP_INVALID` (member app) | Wrong, expired, or already-used login code | Press *ขอรหัส OTP* again for a fresh code. |
| `MEMBER_ONLY` (member app) | A staff/non-member token hit a member route | Log in via the member app (`/m`). |
| `PRIZE_OUT_OF_STOCK` / `NO_PRIZES` (wheel) | A wheel prize just ran out, or no prizes remain | Top up the prize stock, or the member spins again. |
| `TIER_TOO_LOW` / `OUT_OF_STOCK` / `LIMIT_REACHED` (privilege) | Member's tier too low, privilege sold out, or per-person limit reached | Choose another privilege or raise the limits. |
| `LINE_NOT_LINKED` / `LINE_ALREADY_LINKED` (member app) | No member linked to that LINE account, or the LINE account is already linked to someone else | Link LINE while signed in via OTP first; one LINE per member. |
| `BAD_IMAGE` / `IMAGE_TOO_LARGE` (receipt upload) | The photo isn't a valid image, or is too large (~2MB max) | Choose a smaller/clearer photo. |
| `DUPLICATE_RECEIPT` | The same date + amount was already submitted by this member | Check the member's existing submissions before resubmitting. |
| `RECEIPT_ALREADY_REVIEWED` | The submission was already approved/rejected | Refresh the queue — nothing more to do on this one. |
| `SELF_TRANSFER` (point transfer) | A member tried to send points to themselves | Choose a different recipient. |
| `RECIPIENT_NOT_FOUND` (point transfer) | The recipient phone/id isn't an active member of **this shop** | Check the phone number; transfers never cross shops. |
| `TRANSFER_CAP` (point transfer) | The sender hit the daily transfer limit | Wait until tomorrow, or raise `เพดานโอนแต้มต่อวัน` in Loyalty settings. |
| `TRANSFER_DISABLED` (point transfer) | Transfers are switched off (`เพดานโอนแต้มต่อวัน = 0`) | Set a positive daily cap in Loyalty settings to enable. |
| `NOT_IN_COALITION` (coalition) | This shop isn't in a points network | HQ adds the shop on the `/loyalty` coalition card. |
| `COALITION_HQ_ONLY` (coalition) | Only an HQ admin can configure the network | Ask HQ to create the network / add shops. |
| `PERIOD_CLOSED` (coalition earn/redeem) | The partner shop's accounting period is closed, so the clearing entry can't post | Reopen/advance the period — the points movement is rejected as a whole until it can settle. |
| `NPS_ALREADY_SENT` | A survey for this member × sale already exists | The trigger is idempotent — nothing more to send. |
| `NPS_ALREADY_ANSWERED` / `NPS_EXPIRED` | The survey link was already used, or passed its 7-day expiry | Answers are single-use; send a fresh survey for a new purchase. |

## Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-06-24 | Platform | Initial guide — CRM Phase 1: member directory, 360 view, points-liability report (acct 2250), PDPA consent register. |
| 0.2 | 2026-06-24 | Platform | Added §4 points-liability **GL accrual** (`POST /api/loyalty/liability/post`, Dr 5700 / Cr 2250, idempotent, per-shop, period-locked). |
| 0.3 | 2026-06-24 | Platform | §4: accrual now runs **automatically at period close**; added **points expiry (breakage)** job (`POST /api/loyalty/expire`, `expiry_days`, releases Dr 2250 / Cr 5700). |
| 0.4 | 2026-06-24 | Platform | §4: added the hands-off **scheduled maintenance sweep** (`POST /api/loyalty/maintenance/run` + daily GitHub Actions workflow) that expires + accrues for every shop automatically. |
| 0.5 | 2026-06-24 | Platform | Added §6 **Rewards & coupons** — rewards catalog (`/loyalty/rewards`), point-burn redemption (single-use `RDM-…` codes), POS use, coupon wallet on the Member 360. |
| 0.6 | 2026-06-24 | Platform | Added §7 **Tiers & missions** — auto tier recompute + tier journey, and missions/stamp cards (`/loyalty/missions`) with single-claim rewards. |
| 0.7 | 2026-06-24 | Platform | Added §8 **Refer a friend** — member-get-member referrals (reward both once) on the Member 360. |
| 0.8 | 2026-06-24 | Platform | Added §9 **Member self-service app** (`/m`) — phone-OTP login (5-min single-use code), digital card, rewards/redeem, missions/claim, refer-by-phone, coupon wallet; self-scoped, staff routes blocked. New error codes `OTP_INVALID`, `MEMBER_ONLY`, `SELF_REFERRAL`/`ALREADY_REFERRED`. |
| 0.9 | 2026-06-24 | Platform | Added §10 **Spin-the-wheel / lucky draw** (`/loyalty/wheels` + `/m`) — weighted prize segments, points-cost or daily free spins, provably-fair server-side draw, per-prize stock. New error codes `PRIZE_OUT_OF_STOCK`, `NO_PRIZES`. |
| 1.0 | 2026-06-24 | Platform | Added §11 **Campaigns** (`/loyalty/campaigns`) — segmented (all/RFM/tier/birthday) + scheduled broadcasts; PDPA opt-out auto-skipped, idempotent send, per-recipient audit. |
| 1.1 | 2026-06-24 | Platform | Added §12 **Partner privileges** (`/loyalty/partners`) — tier-gated single-use member perks at partner merchants; §13 **Loyalty analytics** (`/loyalty/analytics`) — liability, redemption funnel, breakage, churn/win-back; **LINE login** in the member app. New error codes `TIER_TOO_LOW`/`OUT_OF_STOCK`/`LIMIT_REACHED`, `LINE_NOT_LINKED`/`LINE_ALREADY_LINKED`. |
| 1.2 | 2026-06-29 | Security hardening | §9 **Member app — secure session.** The `/m` sign-in token now lives in a secure browser cookie (not readable by page scripts; session 7 days), and a new **ออกจากระบบ / Log out** ends the session server-side and clears the cookie. No change to how a member logs in (shop code + phone OTP). (ITGC-AC-07.) |
| 1.3 | 2026-07-01 | Platform | Added §14 **Receipt upload for points** (`/m` upload, `/loyalty/receipt-approvals` staff review) — a member claims points for a purchase made outside our POS by submitting a photo + amount; staff approve (grants points the same way a POS sale does) or reject. New error codes `BAD_IMAGE`/`IMAGE_TOO_LARGE`, `DUPLICATE_RECEIPT`, `RECEIPT_ALREADY_REVIEWED`. (LYL-17.) |
| 1.4 | 2026-07-01 | Platform | §11 **Campaigns — real SMS/Email delivery.** Documented that LINE/SMS/Email now deliver for real once the workspace has that channel's provider configured (admin sets the LINE token / SMS key / SMTP mailbox); until then a channel runs in **demo mode** (logged as *sent*, provider `mock`). No change to campaign steps or consent controls. |
| 1.5 | 2026-07-01 | Platform | §13 **Customer segments (RFM) panel** on Loyalty analytics — member count + average spend per RFM segment (Champions/Loyal/New/At Risk/Lost, plus Unsegmented), click-through to a pre-filtered CRM 360 campaign. New read-only endpoint `GET /api/loyalty/analytics/segments` (perms `loyalty`/`marketing`/`exec`, tenant-scoped). |
| 1.6 | 2026-07-01 | Platform | §13 **Live points feed** — earn/redeem now push a real-time `loyalty_points` signal to the exec live dashboard (`/bi`); monitoring only, ledger remains authoritative. |
| 1.7 | 2026-07-01 | Platform | §11 **LINE OA broadcast** — announce to all OA followers via `POST /api/messaging/broadcast-oa` (`marketing`/`exec`); targets the OA follower set (opt-out = unfollow), audit-logged in the message log. |
| 1.8 | 2026-07-01 | Platform | §13 **CDP data export** — bulk member export (`GET /api/crm/export`, `marketing`/`exec`) with identity + RFM + consent flags for external CDP integration; paginated, tenant-scoped, read-only. DSAR stays separate. |
| 1.9 | 2026-07-01 | Platform | §11 **Own messaging provider** — admins can connect the shop's own LINE OA / SMS sender / SMTP mailbox (`GET`/`PUT /api/messaging/providers/:channel`, `users`/`exec`); credentials encrypted + write-only, overriding the shared platform provider. |
| 1.10 | 2026-07-01 | Platform | §14 **Receipt photos in object storage** — when an S3-compatible store is configured (`OBJECT_STORE_URL`), receipt photos are offloaded there (a reference is kept in the DB); transparent to member/reviewer; PDPA erasure deletes the object. |
| 1.11 | 2026-07-01 | Platform | §11 **Messaging providers screen** (`/settings/messaging`) — admin UI to connect the shop's own LINE OA / SMS / SMTP credentials with a **ส่งทดสอบ** (send-test) button; new nav item under Settings → Integrations. |
| 1.12 | 2026-07-01 | Platform | §13 **แต้มสด (Live) card** on Loyalty analytics — real-time earn/redeem feed (polls `GET /api/loyalty/analytics/live` every 5 s), so loyalty managers see activity without the exec dashboard. |
| 1.13 | 2026-07-01 | Platform | §11 **Rich LINE messages (flex)** — broadcast and targeted sends can carry a card/carousel (image+buttons) via a LINE flex layout + `alt_text` (`POST /api/messaging/line/flex` for a targeted push). |
| 1.14 | 2026-07-01 | Platform | §11 **LINE follow webhook** — point the OA webhook at `/api/line/webhook/<shop-code>` (+ set the Channel secret) so following the OA auto-enrols a member; unfollow is logged, membership/points kept. Signature-verified. |
| 1.15 | 2026-07-01 | Platform | §13 **Scheduled CDP sync** — schedule `cdp_export_sync` to push the member snapshot to your CDP endpoint in batches (daily, idempotent, consent-carrying; `CDP_WEBHOOK_URL`). |
| 1.16 | 2026-07-01 | Platform | §11 **Loyalty write API + webhooks** — integrations can enrol/earn/redeem via API key (`POST /api/v1/loyalty/enroll|earn|redeem`, scope `loyalty:write`; `GET /api/v1/loyalty/member`, `loyalty:read`); each point movement fires a `loyalty.*` webhook. |
| 1.17 | 2026-07-02 | Platform | §11 **Loyalty automation triggers** — build no-code rules on Automation (`/automation`): *when a member earns/redeems (optionally over a threshold) → send a notification / message / log*. Loyalty events `loyalty.enrolled/earned/redeemed` are in the event catalog. |
| 1.18 | 2026-07-02 | Platform | §13 **Saved custom segments** — define reusable audiences from rules over member/RFM fields (all/any) via `/api/loyalty/saved-segments`; resolve to matching members. Whitelisted fields only (safe). Rule-builder UI is a follow-up. |
| 1.19 | 2026-07-02 | Platform | §11 **Own-provider OTP + delivery receipts** — once your **SMS** provider is connected, member-login OTPs go out from your own sender. The message log now keeps each message's provider reference, and a provider can call back `POST /api/messaging/delivery-callback/<shop-code>` (with your per-channel callback token) to mark a message *delivered*/*undelivered*. |
| 1.20 | 2026-07-02 | Platform | §13 **Segment-builder screen** (`/loyalty/segments`) — visual rule-builder over the saved-segments whitelist with live member preview; saved segments are now selectable as a **campaign / blast audience** (เซกเมนต์ที่บันทึกไว้). Consent unchanged. |
| 1.21 | 2026-07-02 | Platform | §13 **Segments stay fresh automatically** — schedule the `crm_profile_refresh` daily BI job to re-profile the whole member base (RFM); on-demand full refresh via `POST /api/crm/profiles/refresh`. |
| 1.22 | 2026-07-02 | Platform | §11 **Go-live readiness badges** on the messaging-providers screen — per-channel 🟢/🟡/⚪ resolved provider, last delivery, delivery-receipt chip, and a demo-mode warning when sends silently no-op. |
| 1.23 | 2026-07-02 | Platform | §13 **Journeys** — multi-step drips on `/loyalty/journeys` (entry manual/Automation/segment, wait→send steps, frequency cap); consent + at-most-once per step enforced (MKT-12); runs via the `journey_runner` daily job. |
| 1.24 | 2026-07-02 | Platform | §11 **A/B + holdout** — campaign forms gain *ข้อความแบบ B (%)* and *กลุ่มควบคุม holdout (%)*: holdout members get no message/coupon (the baseline that proves lift), assignment is fixed per member (deterministic), and the automation-campaign report shows per-group sent/redeemed/revenue with a lift figure (holdout redeems 0 by definition — the note explains what the figure does and doesn't prove). |
| 1.25 | 2026-07-02 | Platform | §13 **Churn risk & predicted LTV** — every profiled member now carries ความเสี่ยงหาย (0–100, เทียบกับจังหวะซื้อของตัวเอง) และ LTV คาดการณ์ 12 เดือน (ค่าประมาณ, มีเวอร์ชันสูตรกำกับ — ดู docs/ops/predictive-scoring.md): ใช้เป็นฟิลด์สร้างเซกเมนต์ (`churn_risk`, `predicted_ltv`) ต่อเข้า journey ดึงลูกค้ากลับได้ทันที; แผง analytics แสดง *มูลค่าเสี่ยงหาย*; หน้า 360 แสดง badge + ค่าประมาณ |
| 1.26 | 2026-07-02 | Platform | §13 **Journey ทางแยก (branching)** — แต่ละขั้นตั้ง *ทางแยก* ได้: เลือกขั้นปลายทาง (ต้องเป็นขั้นถัด ๆ ไปเท่านั้น — ระบบบังคับ จึงวนลูปไม่ได้) + เงื่อนไขจาก catalog เดียวกับ segment builder เช่น *ถ้า recency ≤ 5 ข้ามไปขั้นขอบคุณ*; consent/frequency cap/ส่งครั้งเดียวต่อขั้น (MKT-12) เหมือนเดิมทุกประการ |
| 1.27 | 2026-07-02 | Platform | §11 **อ่าน lift ให้เป็น (organic baseline)** — รายงานแคมเปญเพิ่มบล็อก *ยอดซื้อจริง* ต่อกลุ่ม A/B/holdout ในหน้าต่าง attribution (ตั้งได้ต่อแคมเปญ, ค่าเริ่มต้น 30 วัน): ยอดซื้อของกลุ่ม holdout คือฐาน "ถ้าไม่ส่งเลย" — lift = อัตราซื้อกลุ่มที่ถูกส่งข้อความ − holdout (pp) + รายได้ส่วนเพิ่มถ่วงขนาดกลุ่ม; ตัวเลขมาพร้อมขนาดกลุ่มเสมอ (holdout เล็ก = ฐานแกว่ง) |
| 1.28 | 2026-07-02 | Platform | §13 **ส่งถูกเวลา (right-time sends)** — สมาชิกที่มีออเดอร์ ≥3 ครั้งจะได้ *ชั่วโมงที่ชอบซื้อ* (โหมดของฮิสโตแกรมเวลาออเดอร์, เวลาไทย); ขั้น journey ที่มีการรอจะเลื่อนไปส่ง **ตรงชั่วโมงนั้น** (เลื่อนไปข้างหน้าเท่านั้น <24 ชม.; ขั้นส่งทันทียังส่งทันที) — ตั้งชั่วโมง fallback ต่อ journey ได้ (ค่าเริ่มต้น 10:00) |
| 1.37 | 2026-07-02 | Platform | **LIFF wrapper + wallet-certs runbook:** §9 gains the เปิดจาก LINE one-tap flow (`NEXT_PUBLIC_LIFF_ID`; OTP ครั้งแรกเพื่อผูกบัญชี แล้ว auto-link); the §9 wallet ops note now links `docs/ops/wallet-pass-certs-runbook.md` (Apple .p12/WWDR + Google Wallet SA setup, rotation, troubleshooting). |
| 1.36 | 2026-07-02 | Platform | **V5 (docs/29) บัตรสมาชิกใน Apple/Google Wallet:** §9 gains the เพิ่มลงใน Wallet flow (`POST /api/member/wallet-pass`, idempotent ต่อ member×platform, แต้มบนบัตรอัปเดตอัตโนมัติ, payload เป็นข้อมูลขั้นต่ำตาม PDPA) + ops note ว่า mock จนกว่าจะตั้งค่า WALLET_* creds. |
| 1.35 | 2026-07-02 | Platform | **V4 (docs/29) สมาชิก VIP แบบเสียเงิน:** new §7d — สร้างแผน/ขาย/รับรู้รายได้รายเดือน (TFRS 15: เงินเข้า 2410 ก่อน ตัดเป็นรายได้ 4300 ตามงวด, idempotent)/หมดอายุถอยระดับอัตโนมัติ; การ์ดขายบน `/loyalty`, บรรทัด 👑 บน `/m`. New error `MEMBERSHIP_ACTIVE`, `PLAN_EXISTS`/`PLAN_NOT_FOUND` (LYL-21). |
| 1.34 | 2026-07-02 | Platform | **V3 (docs/29) อ่านผล A/B อย่างมั่นใจ:** รายงานแคมเปญ (§11) แสดง **verdict** ต่อการเปรียบเทียบ — `real` (ผลต่างจริง, ช่วงเชื่อมั่น 95% ไม่คร่อมศูนย์), `underpowered — grow the groups` (กลุ่มเล็กกว่า 30 ระบบไม่ตัดสินให้), `no detectable effect` (กลุ่มใหญ่พอแต่ไม่ต่างกัน — อย่าประกาศผู้ชนะ) พร้อม p-value และช่วงเชื่อมั่นเป็น percentage points · สูตรอ้างอิง `docs/ops/ab-significance.md`. |
| 1.33 | 2026-07-02 | Platform | **V2 (docs/29) service recovery:** §7c — ทุก NPS ≤6 เปิดเคสกู้คืนบริการอัตโนมัติ (SLA ติดต่อกลับ 24 ชม., ประทับชื่อผู้ติดต่อ/ผู้ปิด, ปิดเคสต้องมีบันทึก, เกิน SLA ขึ้นป้ายแดงทุกหน้าจอ) — worklist ใหม่ `/loyalty/recovery` (LYL-20). |
| 1.32 | 2026-07-02 | Platform | **V1 (docs/29) member-app completion:** §9 — the /m app now shows the tier-ladder strip (level + ×earn + progress), an expiring-points warning chip (new self-scoped `GET /api/member/points/expiring`, read-only over the W1 register), the **ส่งแต้มให้เพื่อน** transfer form (W1 API, guards surfaced verbatim), and the full points history (สะสม/แลก/โอน/หมดอายุ). No new permissions or controls. |
| 1.31 | 2026-07-02 | Platform | **W3 (docs/27) NPS + governance:** new §7c — post-purchase NPS micro-survey (single-use tokenized link, no PII; detractor ≤6 fires `loyalty.nps_detractor` into Automation/Webhooks; summary + 360 flag; schedulable `nps_post_purchase` job) and the *กติกาการส่ง* governance card on `/settings/messaging` (opt-in quiet hours + global weekly marketing cap, transactional exempt, audited skips). New error codes `NPS_ALREADY_SENT`, `NPS_ALREADY_ANSWERED`/`NPS_EXPIRED`. |
| 1.30 | 2026-07-02 | Platform | **W2 (docs/27) coalition network:** new §7b **เครือข่ายพันธมิตรแต้ม** — HQ creates a points network and adds shops (`/loyalty` card); partner tills resolve members by phone (badge shows code/name/tier/points/home shop only — no contact data crosses shops); earn/redeem at any shop in the network lands on the member's home-shop ledger, and every cross-shop movement books a balanced intercompany clearing entry that HQ settles. New error codes `NOT_IN_COALITION`, `COALITION_HQ_ONLY` (+ `PERIOD_CLOSED` on coalition moves). |
| 1.29 | 2026-07-02 | Platform | **W1 (docs/27) tier economics + points liquidity:** §7 **ตัวคูณแต้มตามระดับ** — tier-ladder card on `/loyalty` sets ×earn per tier (Gold ×2 earns double **at the till**, audited in the ledger; liability accrues the multiplied points automatically); §9 **โอนแต้มให้เพื่อน** — member-to-member point transfer by phone (same shop, all-or-nothing, daily cap `เพดานโอนแต้มต่อวัน`, 0 = off; staff-assist route for the back office; LYL-18); §4 **เตือนแต้มใกล้หมดอายุ** — the daily sweep fires `loyalty.points_expiring` into Automation/Webhooks 30 days ahead, one nudge per expiring batch. New error codes `SELF_TRANSFER`, `RECIPIENT_NOT_FOUND`, `TRANSFER_CAP`, `TRANSFER_DISABLED`. |
