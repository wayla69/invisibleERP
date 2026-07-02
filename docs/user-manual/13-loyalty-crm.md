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

**Missions & stamp cards.** Go to **ภารกิจ & แสตมป์** (`/loyalty/missions`, role `marketing`/`exec`) and
create a mission: a name, a goal (e.g. 10 stamps), and a reward (bonus points or a coupon). At the till,
add a **stamp** to a member (the `+ แสตมป์` button on their 360, or `POST /api/loyalty/missions/:id/progress`).
When the goal is reached the member **claims** the reward (`รับรางวัล`) — **once only** (a second claim is
rejected). Bonus points land on the member's balance and count toward their tier.

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
2. **What the member sees** — a digital **card** (name, code, tier, points balance), **ของรางวัล** (browse and
   **แลก/redeem** rewards with points → the code lands in *คูปองของฉัน*), **ภารกิจ** (mission progress + **รับรางวัล**),
   **ชวนเพื่อน** (refer a friend by phone), and their referral history.
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
> **Use your own provider.** An admin can connect this shop's **own** LINE Official Account / SMS sender /
> email mailbox on the **ผู้ให้บริการข้อความ** screen (**Settings → Integrations → Messaging providers**,
> `/settings/messaging`, permission `users`/`exec`) so messages go out under your brand. Enter the credentials,
> press **บันทึก**, then use **ส่งทดสอบ** to send a test message and confirm delivery. Credentials are stored
> encrypted and are write-only — the screen shows only which channels are connected, never the keys. If you set
> nothing, the platform's shared provider (or demo mode) is used.

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

**Customer segments (RFM).** The **กลุ่มลูกค้า RFM** panel shows how your members split across the five RFM
segments — **Champions, Loyal, New, At Risk, Lost** — with the member count and average spend per segment (members
without a computed profile yet appear under **Unsegmented**). Click a segment to open it in **CRM 360**
(`/crm`) pre-filtered, where you can fire a targeted campaign at exactly that group. Segments are computed from
each member's recency/frequency/monetary behaviour (refreshed as orders post).

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
