# CRM — สมาชิก & แต้ม (Members & Points): World-Class Design

> **Status: DESIGN v0.1 (proposal)** — not yet implemented. This is a design blueprint for upgrading
> the existing loyalty/CRM foundation into a Buzzebees-class members & points experience.
> Author: platform. Date: 2026-06-24. Owner (proposed): Marketing / Revenue Controller.

## 1. Goal & benchmark

Build a **world-class, usable loyalty CRM** for the Invisible ERP/POS — on par with Thailand's
**Buzzebees** — centred on **สมาชิก (members)** and **แต้ม (points)**. "World-class" here means three
things, in priority order:

1. **Usable** — a member can join in 10 seconds at the till, see their card + points + tier on their
   phone, and *burn* points for something they actually want. Staff can find a member and apply value in
   two taps. This is the bar the request set ("world class usable… like buzzy bee").
2. **Engaging** — points are not a dead balance; they unlock a **rewards catalog**, **e-coupons**,
   **gamified missions/stamps**, **tier privileges**, and **referrals** that drive repeat visits.
3. **Audit-grade** — because this codebase targets a NASDAQ listing under SOX/ICFR, loyalty points are
   treated as a **contract liability under TFRS 15 / IFRS 15** with real GL postings and ICFR controls —
   not a cosmetic counter. This is the differentiator over a generic loyalty app.

### Buzzebees feature benchmark → our gap

| Capability | Buzzebees has | We have today | Gap |
|---|---|---|---|
| Member roster, digital card, tiers | ✅ | `pos_members` (code/phone/card/email/birthday/balance/lifetime/tier/opt-in) | **Card UX + tier journey** |
| Points earn/burn engine, expiry | ✅ | `loyalty_config`, `pos_member_ledger`, `loyalty_tiers` (earn/redeem mult) | **Flexible earn rules** |
| Rewards / privilege catalog (burn points) | ✅ | — | **Missing (core)** |
| e-Voucher / coupon wallet | ✅ | `promotions` (cart-level only) | **Missing (per-member codes)** |
| Gamification (stamps, missions, spin) | ✅ | **missions/stamps + spin-the-wheel (weighted, provably-fair)** shipped | **Done (P3+P4)** |
| Member self-service app (LINE LIFF / PWA) | ✅ | **`/m` app — phone-OTP + LINE login; card, points, tier, rewards, missions, spin, privileges, refer, wallet** (shipped) | **Done** |
| Campaigns / segmented broadcast | ✅ | **`loyalty_campaigns` — segmented (all/RFM/tier/birthday) + scheduled, idempotent, PDPA-aware, audited** (shipped) | **Done** |
| Referral (member-get-member) | ✅ | — | **Missing** |
| Analytics: growth, active, **points liability**, redemption | ✅ | **`/loyalty/analytics` — liability fair-value, redemption funnel, breakage, tier mix, churn/win-back** (shipped) | **Done** |
| Consent / PDPA | partial | single `marketing_opt_in` boolean | **Per-purpose consent + DSAR** |

**Conclusion:** the foundation (members, points ledger, tiers, RFM, messaging) is solid and must be
*reused, not rebuilt*. The world-class gap is the **value & engagement layer** (rewards, vouchers,
gamification, member app, referrals) plus the **financial-control layer** (points liability GL + ICFR).

## 2. Information architecture

Today the experience is fragmented across `/loyalty` (config form), `/crm` (branch KPI + 360 lookup),
and `/marketing`. We unify it into one **Loyalty CRM** area, keeping the existing `สมาชิก & แต้ม` nav
entry as the hub. Two surfaces:

### A. Back-office console (ERP + POS workspaces) — `/loyalty/*`
| Route | Screen | Primary role |
|---|---|---|
| `/loyalty` | **Overview** — members, active rate, points liability, redemption funnel, tier mix | `loyalty`, `marketing`, `exec` |
| `/loyalty/members` | **Members** — searchable list + filters (segment, tier, channel), bulk actions | `crm_member` |
| `/loyalty/members/[id]` | **Member 360** — profile, points history, coupons, missions, timeline, consent | `crm_member` |
| `/loyalty/points` | **Points & tiers** — earn rules, tier ladder, expiry, **controlled manual adjust** | `loyalty` / `crm_points_adjust` |
| `/loyalty/rewards` | **Rewards catalog** — create/manage redeemable rewards & privileges | `crm_reward` |
| `/loyalty/coupons` | **Coupons & vouchers** — issue, track, expire e-vouchers | `crm_reward` |
| `/loyalty/missions` | **Missions & stamps** — gamification campaigns | `crm_campaign` |
| `/loyalty/campaigns` | **Campaigns** — segmented broadcasts, schedule, metrics (absorbs `/crm` messaging) | `crm_campaign` |
| `/loyalty/analytics` | **Analytics** — growth, churn, RFM, liability, redemption, breakage | `marketing`, `exec` |

Member 360 at the till: the existing POS `/pos-ops` and POS checkout gain a **member chip** (lookup by
phone/card/QR → card, balance, tier, eligible rewards) so cashiers act without leaving the sale.

### B. Member self-service app (customer portal / LINE LIFF / PWA) — `/portal/loyalty/*`
A mobile-first experience (the hero of "usable"):
- **Card** — digital membership card with a scannable QR (member code), tier badge, points balance.
- **Tier journey** — progress ring to the next tier + the privileges it unlocks.
- **Rewards** — browse the catalog, redeem points → get a redemption QR/code.
- **My coupons** — wallet of issued e-vouchers (use at POS or online).
- **Missions & stamps** — collect stamps, complete quests, spin the daily wheel.
- **Refer a friend** — share a referral code; track rewards.
- **Profile & privacy** — edit details, manage per-purpose consent (PDPA), download my data.

## 3. Data model (new tables)

All tables follow the house pattern: `bigserial` id, `tenant_id → tenants.id` (RLS), tz-aware
timestamps, `created_by`. New schema files under `apps/api/src/database/schema/`. **Reuse** `pos_members`
and `pos_member_ledger` as-is; extend, don't replace.

```
loyalty_earn_rules        generalises loyalty_config: trigger (spend|visit|signup|birthday|referral|action),
                          rate / bonus_points, multiplier, conditions (channel, category, min_spend),
                          start/end, priority, active
loyalty_rewards           catalog: reward_code, name, type (product|evoucher|discount|privilege|partner),
                          point_cost, cash_value, stock, per_member_limit, tier_min, image_key,
                          valid_from/to, active
loyalty_redemptions       member burns points→reward: member_id, reward_id, redemption_code (QR/barcode),
                          point_cost, status (issued|used|expired|void), issued_at, expires_at,
                          used_at, used_ref (sale_no)   ← append-only, mirrors a posMemberLedger Redeem row
member_coupons            per-member e-vouchers: code (unique), kind (percent|amount|free_item), value,
                          source (campaign|reward|referral|birthday|manual), status (active|used|expired),
                          issued_at, expires_at, used_ref
loyalty_missions          gamification: mission_code, name, type (stamp|quest|spin), goal_json,
                          reward_kind (points|coupon|reward_id), period, active
loyalty_mission_progress  member_id, mission_id, progress, completed_at, claimed_at  (unique per member×mission)
loyalty_tier_history      tier change audit: member_id, from_tier, to_tier, reason (earn|decay|manual),
                          effective_at, created_by
member_consents           PDPA per purpose: member_id, purpose (marketing|profiling|line|sms|email),
                          channel, granted (bool), source, granted_at, withdrawn_at   ← supersedes the
                          single marketing_opt_in boolean (kept in sync for back-compat)
referrals                 referrer_member_id, referred_member_id|phone, code, status
                          (pending|qualified|rewarded), reward_coupon_id, created_at, qualified_at
campaigns                 orchestration: campaign_code, name, segment_json, channel, schedule_at, status
                          (draft|scheduled|sent), audience_size, sent, failed, metrics_json
loyalty_liability_account snapshot/config for GL tie-out: period, opening, earned, redeemed, expired,
                          closing   (or derived on the fly from posMemberLedger + redemptions)
```

**Key reuse note:** every points movement — earn, reward redemption, coupon issue-from-points, mission
payout, manual adjust, expiry — writes a row to the existing **`pos_member_ledger`** (the append-only
points sub-ledger). New tables hold *what* was redeemed/issued; the ledger stays the single source of
truth for the balance, preserving the existing concurrency-safe `FOR UPDATE` earn/redeem invariants.

## 4. Points as a financial liability (TFRS 15 / IFRS 15)

This is the audit-grade layer Buzzebees doesn't expose but a NASDAQ filer must. Loyalty points are an
obligation to provide future value — a liability, not free marketing spend.

**As-built model (Phase 1.5 — shipped).** The codebase already settles a redemption as a *revenue
reduction* at checkout (the points discount lowers the `4000` credit). Re-deferring revenue at earn would
double-count and would mean editing the parity-locked checkout path, so the implemented model is a
**cost-accrual / provision** posted by a *separate watermarked batch* (`POST /api/loyalty/liability/post`),
which leaves the hot path untouched. New COA accounts: **2250 Loyalty Points Liability**, **5700 Loyalty
Points Expense**.

| Event | GL posting (as built) |
|---|---|
| Points **net granted** (per accrual run) | `Dr 5700 Loyalty Points Expense · Cr 2250 Loyalty Points Liability` at fair value |
| Points **net redeemed/forfeited** (per accrual run) | `Dr 2250 · Cr 5700` (release) — and checkout separately reduces `4000` revenue by the discount |
| Points **expired** (breakage) | expiry job (`POST /api/loyalty/expire`) writes an `Expire` ledger row ⇒ next accrual posts `Dr 2250 · Cr 5700` (provision released; **net-0 P&L** since revenue was never deferred) |
| Period close | `closePeriod`/`closeYear` auto-run the accrual to the period before locking (year-end `5700` closed to Retained Earnings) |
| Any time | Reconcile `2250` to `Σ pos_member_ledger` open points × fair value (the `/api/loyalty/liability` tie-out: `posted_liability` vs `unposted_value`) |

Over a redeemed point's life the `5700` grant-expense and its release cancel, leaving the checkout revenue
reduction as the single net P&L charge — **no double-count** (confirmed by adversarial review). The points
sub-ledger (`pos_member_ledger`) is the **subsidiary ledger** for control account `2250`; the accrual run
is **watermarked** on `pos_member_ledger.id`, **idempotent**, **tenant-scoped**, and **period-locked**, and
plugs into the existing `LedgerService.postEntry()`. Proven by the **LYL-03** ICFR harness (8 checks).
Breakage is de-recognised by the expiry job, and the accrual runs automatically at period close (the
accrual logic lives in `LedgerService.accrueLiability` so close can call it with no module cycle).
*Known limitation:* a `baht_per_point` re-measurement with no subsequent points activity is reflected only
at the next activity (the watermark gates on ledger movements).

## 5. Permissions & Segregation of Duties

Reuse the coarse `loyalty` / `marketing` / `crm` permissions; add **single-duty sub-permissions** so the
sensitive actions can be split (mirrors the existing `pos`→`pos_sell/refund/till` pattern in
`packages/shared/src/permissions.ts`):

```
crm_member          member master maintenance (enroll/edit/merge)
crm_points_adjust   manual points adjustment  ← sensitive, fraud-prone
crm_reward          reward catalog + voucher/coupon configuration & issuance
crm_campaign        campaign send / broadcast
```

**As-built (shipped).** The 4 perms are **standalone granular keys** (in `PERMISSIONS` + `SUB_PERMISSIONS`),
**NOT** implied by `loyalty`/`marketing`/`crm`. The original plan to wire `loyalty ⇒ [crm_*]` was **rejected**:
`loyalty` is held by the **Customer** (portal) role and `marketing` by **Sales** (which also has `pos_sell`), so
an implication would make those roles inherit CRM duties and trip R14–R16 — breaking the `unit.test.ts`
invariant that Customer has **0** SoD conflicts. Instead, backward compatibility is at the **endpoint gate**:
each config endpoint is `@Permissions('crm_*', …coarse)` (OR-semantics), so existing coarse roles keep working
while a **SoD-clean granular role** (e.g. a user holding only `crm_reward`) can be assigned with no conflict.
Only **Admin** (all perms) holds the crm_* set → Admin now violates **16** rules (was 13). Added SoD rules:

| New rule | Duty A | Duty B | Risk |
|---|---|---|---|
| **R14** | Reward catalog / voucher config (`crm_reward`) | POS redemption at till (`pos_sell`) | Create a reward + redeem it for self |
| **R15** | Manual points adjustment (`crm_points_adjust`) | Member master maintenance (`crm_member`) | Enroll a ghost member and credit points |
| **R16** | Campaign issuance of point-bearing coupons (`crm_campaign`) | Points adjustment (`crm_points_adjust`) | Self-issue value through two channels |

Sensitive actions (manual adjust above a threshold, voiding redemptions) route through the existing
**approval-workflow** (`approvals`) as a maker-checker, consistent with GL-05.

## 6. New ICFR controls (RCM additions — LYL series)

Extend `compliance/build_rcm.py` → regenerate `Invisible_ERP_SOX_RCM_v1.xlsx`, and add checks to
`tools/cutover/src/compliance.ts`.

| Control | Assertion | Description |
|---|---|---|
| **LYL-01** | Existence/Authorization | Member enrolment validates identity (unique phone/card per tenant); consent captured. |
| **LYL-02** | Accuracy/Completeness | Points earn/redeem are atomic under `FOR UPDATE`; every movement writes an append-only ledger row (no lost update, no double-spend). |
| **LYL-03** | Valuation | Points liability (acct **2250**) recognised at fair value via a watermarked, idempotent accrual (`Dr 5700 / Cr 2250`), released on net redemption; sub-ledger ties to the control account. **Shipped (Phase 1.5)** — proven by the LYL-03 compliance-harness check. |
| **LYL-04** | Authorization | Manual points adjustment requires `crm_points_adjust` and (over threshold) independent approval; maker ≠ checker. |
| **LYL-05** | Existence | Reward/coupon redemption codes are single-use; status transitions are one-way (issued→used/expired/void); SoD R14 enforced. |
| **LYL-06** | Rights/PDPA | Marketing sends respect per-purpose consent; opt-out honoured; DSAR export available. |

## 7. API surface (new endpoints, NestJS)

Mirror the existing module pattern (controller → service → repository, Zod DTOs in
`packages/shared/src/schemas.ts`, `@Permissions(...)` guards).

```
Members      GET  /api/crm/members?q&segment&tier&channel&limit       list/search        crm_member
             POST /api/crm/members                                    enroll             crm_member
             PATCH/api/crm/members/:id                                edit               crm_member
             GET  /api/crm/members/:id                                360 view           crm_member
             GET  /api/crm/members/:id/timeline                       unified activity   crm_member
             POST /api/crm/members/:id/consent                        PDPA consent       crm_member

Points       GET  /api/loyalty/earn-rules    POST/PATCH               earn rules         loyalty
             POST /api/loyalty/adjust                                 manual adjust      crm_points_adjust (+approval)
             GET  /api/loyalty/liability?tenant_id?                    acct 2250 tie-out  loyalty/marketing/exec/gl_post  [shipped]
             POST /api/loyalty/liability/post                         GL accrual run     gl_post / exec                  [shipped]
             POST /api/loyalty/expire                                 points expiry/breakage  loyalty / exec             [shipped]
             POST /api/loyalty/maintenance/run                        cron sweep (expire+accrue, all tenants)  exec/gl_post/masterdata  [shipped]

Rewards      GET/POST/PATCH /api/loyalty/rewards                      catalog            crm_reward
             POST /api/loyalty/rewards/:id/redeem                     burn→code          loyalty (member) / portal
             POST /api/loyalty/redemptions/:code/use                  redeem at POS      pos_sell

Coupons      GET  /api/crm/members/:id/coupons                        wallet             crm_member / portal
             POST /api/loyalty/coupons/issue                          issue              crm_reward
             POST /api/loyalty/coupons/:code/redeem                   use at POS         pos_sell

Missions     GET/POST/PATCH /api/loyalty/missions                     manage             marketing/exec                  [shipped]
             POST /api/loyalty/missions/:id/progress                  +1 stamp/step      pos_sell/loyalty                [shipped]
             POST /api/loyalty/missions/:id/claim                     claim reward       loyalty/pos                     [shipped]
             GET  /api/loyalty/members/:id/missions                   my progress        loyalty/marketing/crm/pos       [shipped]

Tiers        POST /api/loyalty/tiers/recompute                        auto-recompute     loyalty/marketing/exec          [shipped]
             GET  /api/loyalty/members/:id/tier                       tier journey       loyalty/marketing/crm/pos       [shipped]

Spin/draw    GET/POST/PATCH /api/loyalty/wheels                       config             marketing/exec                  [shipped]
             POST /api/loyalty/wheels/:id/spin                        weighted draw      pos_sell/pos/loyalty            [shipped]
             GET  /api/loyalty/members/:id/spins                      spin history       loyalty/marketing/crm/pos       [shipped]

Campaigns    GET/POST /api/loyalty/campaigns                          orchestrate        marketing/exec                  [shipped]
             POST /api/loyalty/campaigns/:id/send | :id/cancel        send / cancel      marketing/exec                  [shipped]
             POST /api/loyalty/campaigns/run-due  cron: fire due scheduled  marketing/exec (@NoTx)              [shipped]

Referral     POST /api/loyalty/referrals                              refer              loyalty/marketing/pos           [shipped]
             POST /api/loyalty/referrals/:id/reward                   reward both once   loyalty/marketing/exec          [shipped]
             GET  /api/loyalty/members/:id/referrals                  a member's refs    loyalty/marketing/crm/pos       [shipped]

Partners     GET/POST /api/loyalty/partners  POST/PATCH /api/loyalty/privileges   config   crm_reward/marketing/exec   [shipped]
             POST /api/loyalty/privileges/:id/claim                   claim (single-use) loyalty/pos/crm_member          [shipped]
             POST /api/loyalty/privilege-claims/:code/use             partner redeem     pos_sell/pos                    [shipped]
             GET  /api/loyalty/members/:id/privileges | /privilege-claims    available/claims   loyalty/marketing/crm/pos  [shipped]

Analytics    GET  /api/loyalty/analytics                              liability/funnel/churn  marketing/exec             [shipped]
             GET  /api/loyalty/analytics/churn                        at-risk (win-back)      marketing/exec             [shipped]

Member app   POST /api/member/auth/request-otp | /auth/verify-otp | /auth/line   login (OTP / LINE)   @Public        [shipped]
             POST /api/member/link-line                              link LINE account  MemberGuard (self)              [shipped]
             GET  /api/member/me | /tier | /history | /wallet | /rewards | /missions | /referrals | /wheels   MemberGuard  [shipped]
             GET  /api/member/privileges | /privilege-claims | /spins                          MemberGuard (self)        [shipped]
             POST /api/member/rewards/:id/redeem | /missions/:id/claim | /refer | /wheels/:id/spin | /privileges/:id/claim   MemberGuard (self)  [shipped]
```

The member app is a **standalone consumer surface** (web `/m`, mobile-first) authenticated by **phone OTP**,
NOT the staff app. Login mints a JWT `{ role:'Member', tenantId, memberId, permissions:[] }` (30-day) that can
reach **only** `/api/member/*` (a `MemberGuard`) and is rejected by every `@Permissions`-gated staff route
(empty permissions). Every member call derives the member from the token (`memberId`) — there is no member-id
input, so a member can only ever see/act on **themselves**. The OTP is single-use, 5-min-expiry,
attempt-bounded, scrypt-hashed, and rate-limited; it reuses the existing (reviewed) rewards/missions/referrals
services unchanged. **LINE LIFF (shipped):** `POST /api/member/auth/line` verifies the LIFF idToken against
LINE via the **shared `verifyLineIdToken`** (prod → LINE with `LINE_LOGIN_CHANNEL_ID`; dev/test → a `mock:<id>`
token) — and mints the **same** member token for the member whose `line_user_id` is linked (within the tenant;
the column ships with the staff LINE feature, migration `0105_member_line`); a logged-in member links their LINE
via `POST /api/member/link-line` (idToken-verified, one LINE ↔ one member per tenant). The `/m` web app offers
both OTP and LINE entry.

## 8. Phased roadmap

Each phase ships **code + docs together** per the documentation-sync policy (narrative 19 update, user
manual `01-sales-and-pos.md` / new loyalty guide, UAT cases, RCM LYL controls, compliance harness checks).

| Phase | Theme | Delivers | SOX impact |
|---|---|---|---|
| **P1** | Member 360 + points foundation | Unified members list & 360 page; flexible `loyalty_earn_rules`; **points-liability GL (acct 2250, Phase 1.5 — shipped)**; PDPA `member_consents`; LYL-01/02/03/06 + R15 | High — the audit base |
| **P2** | Rewards & vouchers | `loyalty_rewards` catalog; point-burn redemption with single-use `RDM-…` codes; `member_coupons` wallet — **shipped** (MKT-07 / LYL-07; R14 by endpoint gating, formal rule staged) | Medium |
| **P3** | Gamification & tiers | Missions/stamp cards + tier journey + auto tier recompute (`loyalty_tier_history`) — **shipped** (MKT-08 / LYL-08); spin-the-wheel + R16 staged | Low |
| **P4** | Member app & growth | **COMPLETE** — referrals (LYL-09), phone-OTP **+ LINE** member app `/m` (LYL-10/16), spin-the-wheel (MKT-09/LYL-11), campaigns (MKT-10/LYL-12), `crm_*`+SoD R14–R16 (LYL-13), **partner privileges** (MKT-11/LYL-14), **churn/redemption analytics** (LYL-15) | Low |

## 9. Why this is world-class (and beats a clone)

- **Usable first:** join-at-till in seconds, scannable digital card, two-tap redeem — the Buzzebees bar.
- **Engagement built in:** rewards, coupons, missions, tiers, referrals — points become desirable.
- **Reuses the strong base:** atomic points ledger, RFM, messaging, tiers, gift cards already exist.
- **Audit-grade:** points modelled as a TFRS-15 liability with GL postings and ICFR controls — the thing
  a NASDAQ filing demands and a consumer loyalty clone never has.
- **One coherent surface:** `/loyalty/*` unifies what is today scattered across three pages.

## 10. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-06-24 | platform | Initial design proposal — gap analysis vs Buzzebees, IA, data model, points-as-liability, permissions/SoD, LYL controls, phased roadmap. Not yet implemented. |
| 0.2 | 2026-06-24 | platform | **Phase 1 increment shipped (additive slice):** member directory + Member 360 web pages (`/loyalty/members[/:id]`, `GET /api/loyalty/members`); PDPA per-purpose consent register (`member_consents` table + migration `0101`, `GET`/`POST /api/loyalty/members/:id/consents`, syncs `marketing_opt_in`→ messaging opt-out); points-liability tie-out report (`GET /api/loyalty/liability`). Docs synced: narrative 19 (MKT-05/06, v0.4), user manual 13, UAT 11 (UAT-LOY). Verified: `@ierp/api` + `@ierp/web` build green; ICFR compliance harness 33/33. **Staged (not in this slice, to avoid hot-path/SoD churn):** flexible `loyalty_earn_rules` engine, automated JE posting, the `crm_member`/`crm_points_adjust` permission split + SoD R14–R16. |
| 0.3 | 2026-06-24 | platform | **Phase 1.5 shipped — points-liability GL posting (see §4 as-built):** `POST /api/loyalty/liability/post` watermarked idempotent **provision** accrual (`Dr 5700 Loyalty Points Expense / Cr 2250 Loyalty Points Liability`; new COA accounts 2250/5700; `loyalty_posting_runs` table, migration `0102`). Corrected control account to **2250** (2350 = Social Security Payable). **Adversarially reviewed** (3 skeptics): fixed an Admin RLS-bypass cross-tenant leak in the tie-out and an active-flag/watermark desync (basis is now all members) — both locked by new harness checks. Verified: `@ierp/api`+`@ierp/web` build green; ICFR compliance harness **41/41** (8 LYL-03 checks). Docs: narrative 19 v0.5 (step 13, MKT-06), user manual 13 v0.2, UAT 11 (UAT-LOY-008..010). Still staged: earn-rules engine, breakage/expiry job, permission split. |
| 0.4 | 2026-06-24 | platform | **Phase 1.5 cont. shipped:** accrual wired into **period close** (`closePeriod`/`closeYear`, year-end `5700`→Retained Earnings; logic moved to `LedgerService.accrueLiability`, no module cycle) and **points expiry/breakage** (`POST /api/loyalty/expire`, `txn_type='Expire'`, releases `Dr 2250 / Cr 5700`, net-0 P&L). Adversarially reviewed (close-hook + breakage). Verified: full ICFR harness **43/43** (LYL-04 expiry, LYL-05 close auto-accrual) + worldclass/restaurant/e2e/ext/taxdocs/parity all green. Still staged: flexible earn-rules engine, `crm_member`/`crm_points_adjust` permission split + SoD R14–R16, fair-value re-measurement on config change. |
| 0.5 | 2026-06-24 | platform | **Phase 1.5 cont. shipped — scheduled automation:** `POST /api/loyalty/maintenance/run` cron sweep (per tenant: expire → accrue; Admin ⇒ all via RLS bypass; best-effort) + a daily GitHub Actions trigger (`.github/workflows/loyalty-maintenance.yml`, opt-in). Closed adversarial-review nits (`Adjust` folded into expiry/redeemable net; `redeemable()` honours `expiry_days=0`; `Expire` in the movements breakdown). Verified: full ICFR harness **44/44** (LYL-06) + worldclass/restaurant/e2e/ext/taxdocs/parity all green; `@ierp/api`+`@ierp/web` build green. |
| 0.6 | 2026-06-24 | platform | **Phase 2 shipped — rewards & vouchers:** `loyalty_rewards` catalog + point-burn redemption (`POST /api/loyalty/rewards/:id/redeem` → `pos_member_ledger` Redeem → liability release) issuing single-use `loyalty_redemptions` codes (`RDM-…`); `POST /api/loyalty/redemptions/:code/use` (one-way `issued→used`); `member_coupons` wallet (`CPN-…`); new module `apps/api/src/modules/rewards`, migration `0103`; web `/loyalty/rewards` + Member-360 wallet. Control **MKT-07**; R14 by gating (`marketing`/`exec` config ≠ `pos_sell` use) — formal `crm_reward`+R14 staged (adding R14 would break the `unit.test.ts` "13 SoD rules" assertion). **Adversarially reviewed:** concurrency/single-use HOLDS; fixed a major Admin RLS-bypass cross-tenant leak (every reward read/write now explicitly tenant-scoped, locked by a harness guard) + the `redeemValue` basis mix. Verified: full ICFR harness **46/46** (LYL-07 ×2) + worldclass/restaurant/e2e/ext/taxdocs/pos-p2/parity all green; typecheck + `@ierp/api`/`@ierp/web` build green. |
| 0.7 | 2026-06-24 | platform | **Phase 3 shipped — gamification & tiers:** tier ladder auto-recompute (`POST /api/loyalty/tiers/recompute` + maintenance sweep; `loyalty_tier_history` audit; `GET /api/loyalty/members/:id/tier` journey) and missions/stamp cards (`loyalty_missions`/`loyalty_mission_progress`; progress + single-claim reward of bonus points (`Adjust`) or coupon). New module `apps/api/src/modules/gamification`, migration `0104`; web `/loyalty/missions` + Member-360 tier & mission panels. Control **MKT-08**; **explicitly tenant-scoped from the start** (applying the Phase-2 review lesson). Verified: full ICFR harness **47/47** (LYL-08) + worldclass/restaurant/e2e/ext/taxdocs/pos-p2/parity all green; typecheck + builds green. **Adversarially reviewed — both lenses HOLD** (no double-claim, race-free progress, liability-consistent, tenant-isolated); applied a tier-recompute audit-accuracy fix (recompute tier under the member lock) + a self-defensive tenant predicate on the mission-progress select. Staged: spin-the-wheel/lucky-draw, the `crm_campaign`+R16 permission split. |
| 0.8 | 2026-06-24 | platform | **Phase 4 (partial) shipped — referrals:** member-get-member (`loyalty_referrals`, migration `0105`, new module `apps/api/src/modules/referrals`): refer a member (refer-once partial unique + self-referral block) and reward both sides bonus points (`Adjust`) **once** (`status` under `FOR UPDATE`); web referrals panel on the Member 360. Control **MKT-08**; explicitly tenant-scoped from the start. New **LYL-09** harness check — full suite **48/48** + worldclass/restaurant/e2e/ext/taxdocs/pos-p2/parity all green; typecheck + builds green. **Adversarially reviewed:** accounting/tenant HOLD; fixed an **ABBA deadlock** in concurrent reward (the two member rows are now locked in deterministic ascending-id order before granting) + narrowed the duplicate-referral error mapping + dropped `exec` from the reward gate. P4 remaining: member self-service app (needs member auth — LINE LIFF/OTP), campaign orchestration, partner privileges, churn/redemption analytics. |
| 0.9 | 2026-06-24 | platform | **Phase 4 cont. shipped — member self-service app (phone-OTP):** a standalone consumer surface (web `/m`, mobile-first) with a **new MEMBER auth principal**. `POST /api/member/auth/request-otp` + `verify-otp` (@Public) mint a member JWT `{ role:'Member', tenantId, memberId, permissions:[] }` (30-day); `/api/member/*` (card/tier/history/wallet/rewards+redeem/missions+claim/referrals+refer) is gated by `MemberGuard` and **self-scoped** (the member is derived from the token — no member-id input). OTP is single-use, 5-min expiry, ≥5-attempt-bounded, **scrypt-hashed**, rate-limited (1/60s), and request-otp never leaks member existence; `dev_otp` returned only outside production. New `member_otps` table (migration `0106`, RLS-scoped) + `apps/api/src/modules/member` (reuses the reviewed loyalty/rewards/gamification/referrals services unchanged). Hardened `createReferral` to resolve `referred_phone`→member (enrolled friend links immediately) + block self-referral by phone. Control **LYL-10** (member token blocked from staff routes; wrong-code rejected; tenant-scoped). **Adversarially reviewed** (escalation / OTP-security / cross-tenant): **escalation HOLDS** (member token reaches no staff capability — `permissions:[]` + `MemberGuard` + self-scoping) and **cross-tenant HOLDS**; **OTP REFUTED → fixed a blocker:** the failed-attempt counter never accumulated (the wrong-code `throw` rolled back its increment in the per-request tx) so the ≥5 brute-force cap was inert — `verify-otp` is now `@NoTx` (auto-commit) with **atomic guarded UPDATEs** (DB-evaluated `attempts+1`, single-winner consume), so the cap persists and is concurrency-safe; also closed a phone-enumeration **timing oracle** (dummy scrypt on the no-member path) and added explicit tenant predicates. New **LYL-10b** harness check locks the cap (5 wrong guesses → the correct code is then rejected). Verified: full ICFR harness **50/50** + e2e/ext/worldclass/restaurant/taxdocs/pos-p2/writeflow/analytics all green; typecheck + `@ierp/api`/`@ierp/web` build green. Documented residual nits (defense-in-depth, not breaks): 30-day member token has no revocation / no `active` re-check; `member.balance/history` lean on RLS for the member path (the explicit-scope refactor would change the intentional HQ-admin 360 behavior). Remaining P4: campaign orchestration, partner privileges, churn/redemption analytics, spin-the-wheel, `crm_*`/SoD R14–R16. |
| 1.0 | 2026-06-24 | platform | **Phase 4 cont. shipped — spin-the-wheel / lucky draw:** weighted prize segments (`loyalty_wheels` / `loyalty_wheel_segments`), each spin an audited, **provably-fair** outcome (server-side `node:crypto` weighted RNG over in-stock segments) recorded in `loyalty_spins`; migration `0107`, new module `apps/api/src/modules/wheels`. A member spends points (a `Redeem` ledger row → liability releases) or a **daily free spin** to spin; a points prize is an `Adjust` row, a coupon prize a `member_coupons` row — all under one `FOR UPDATE` member lock with insufficient-balance + atomic per-segment **stock** guards. Endpoints: config (`marketing`/`exec`), `POST /api/loyalty/wheels/:id/spin` (`pos_sell`/`pos`/`loyalty`), member self-spin `POST /api/member/wheels/:id/spin`; web `/loyalty/wheels` config + a wheel section in the `/m` member app. Control **MKT-09**; explicitly tenant-scoped from the start. New **LYL-11** harness check (weighted draw + free→cost accounting + per-prize stock cap) — full ICFR harness **51/51** + e2e/ext/worldclass/restaurant/taxdocs/pos-p2/writeflow/analytics all green; typecheck + builds green. **Adversarially reviewed (fairness / accounting / stock-tenant) — all three lenses HOLD, no findings** (correct weight-proportional partition, atomic cost-burn + stock guard under the member lock, fully tenant- and self-scoped); the prior phases' discipline (explicit tenant scoping, `FOR UPDATE`, atomic guarded UPDATEs) applied from the start left nothing to fix. |
| 1.1 | 2026-06-24 | platform | **Phase 4 cont. shipped — campaign orchestration:** segmented + scheduled broadcasts (`loyalty_campaigns`, migration `0108`, new module `apps/api/src/modules/campaigns`). A campaign targets **all / an RFM segment / a tier / today's birthdays**, sends now or at a `schedule_at` (fired by the daily maintenance sweep via `runDue`), over the existing messaging gateways. Send is **idempotent** (status flips `draft|scheduled→sent` under `FOR UPDATE`; re-send → `ALREADY_SENT`), **PDPA-aware** (a `marketingOptIn===false` member is logged `skipped`, never delivered), and **audited** (one `message_log` row per recipient, `campaign = campaign_code`; the campaign keeps targeted/sent/skipped/failed tallies). **Explicitly tenant-scoped on every query** — unlike the pre-existing ad-hoc `/api/messaging/blast`, which leans on RLS. Endpoints `marketing`/`exec`; web `/loyalty/campaigns`. Control **MKT-10**. New **LYL-12** harness check (segmented send respects opt-out + idempotent) — full ICFR harness **52/52** + e2e/ext/worldclass/restaurant/taxdocs/pos-p2/writeflow/analytics all green; typecheck + builds green. **Adversarially reviewed:** opt-out-audit + cross-tenant **HOLD**; **fixed an at-most-once-durability major** — gateway delivery (irreversible) sat *inside* the request tx **before** the status flip, so a rollback (notably the cron, which ran the whole sweep in one tx) could re-fire the campaign and lose the audit. Now **claim-first under `@NoTx`** (the campaign is atomically flipped `draft|scheduled→sent` and **committed before** any delivery; each `message_log` row also auto-commits), and the **cron is decoupled** to a dedicated `@NoTx` `POST /api/loyalty/campaigns/run-due` (no longer folded into the sweep's transaction; the daily Action calls it). Also tenant-scoped the segment `customer_profiles` read (review nit). New **LYL-12b** harness check locks claim-first (a scheduled campaign fires exactly once across re-runs) — full harness **53/53** green. |
| 1.2 | 2026-06-24 | platform | **Phase 4 cont. shipped — formal `crm_*` permission split + SoD R14–R16 (the staged hardening, now landed):** added 4 standalone granular permissions (`crm_member`, `crm_points_adjust`, `crm_reward`, `crm_campaign`) and 3 SoD rules — **R14** `crm_reward ✗ pos_sell`, **R15** `crm_points_adjust ✗ crm_member`, **R16** `crm_campaign ✗ crm_points_adjust` — to `packages/shared/src/permissions.ts`. Re-gated the config endpoints `crm_* OR coarse` (member master → `crm_member`; rewards/coupons → `crm_reward`; expire/points → `crm_points_adjust`; campaigns/missions/wheels → `crm_campaign`), so existing coarse roles keep working and a single-duty CRM role is SoD-clean. **Deliberately NOT** wired via `PERMISSION_IMPLICATIONS` (would make Customer/Sales inherit CRM duties and break the 0-conflict invariant — see §5). Updated `unit.test.ts` (Admin now violates **16** rules; non-admin role counts unchanged at 18) and `compliance/build_sod.py` → **regenerated `Invisible_ERP_SoD_Matrix_v1.xlsx`** (16 rules; named-role conflicts unchanged). New **LYL-13** harness check (a `crm_reward + pos_sell` assignment is blocked as R14; a single-duty `crm_reward` role is clean) — full ICFR harness **54/54** + e2e/ext/worldclass/restaurant/taxdocs/pos-p2/writeflow/analytics + the 38 unit tests + typecheck + builds all green. Docs: ITGC narrative 08, SoD policy 13, UAT 08, readiness plan, issue note, narrative 19 all moved R01–R13 → **R01–R16**. |
| 1.3 | 2026-06-24 | platform | **Phase 4 COMPLETE — partner privileges + churn/redemption analytics + LINE login:** (a) **Partner privileges** (`loyalty_partners`/`loyalty_privileges`/`loyalty_privilege_claims`, migration `0109`, module `apps/api/src/modules/partners`): member perks at partner merchants, tier-gated (min-lifetime, like rewards), single-use `PRV-…` claim codes under `FOR UPDATE` with atomic stock + per-member-limit guards; partner-redeem; web `/loyalty/partners` + a `/m` privileges section. Control **MKT-11** / **LYL-14**. (b) **Loyalty analytics** (read-only, no new schema; module `loyalty-analytics`): liability fair-value, redemption funnel, breakage, tier mix, active rate, and **churn/at-risk** (dormant ≥90d with points) for win-back; web `/loyalty/analytics` dashboard. Every aggregate explicitly tenant-scoped; HQ/Admin must pass `?tenant_id`. **LYL-15**. (c) **LINE LIFF member login**: `POST /api/member/auth/line` (`@Public`, `@NoTx`) reuses the **shared `verifyLineIdToken`** (prod `LINE_LOGIN_CHANNEL_ID`; dev/test `mock:` token) + `pos_members.line_user_id`, minting the same member token; `POST /api/member/link-line`. **LYL-16**. **Adversarially reviewed** (privileges / analytics / LINE): **all three HOLD**; the review caught a **major prod-correctness blocker** — the loyalty migrations were **absent from `drizzle/meta/_journal.json`**, so prod's `drizzle-migrate` would have **silently skipped the entire loyalty CRM schema** (green CI / broken prod; the harness globs the SQL directly so it passed). **Fixed** by journaling them (CRLF preserved). Verified: full ICFR harness **57/57** (LYL-14/15/16) + e2e/ext/worldclass/restaurant/taxdocs/pos-p2/writeflow/analytics + 38 unit tests + typecheck + `@ierp/api`/`@ierp/web` build all green. **P4 (and the whole world-class roadmap) is now complete.** |
| 1.4 | 2026-06-24 | platform | **Merged latest `main` (#62–#68) and reconciled the overlap.** Main #68 independently shipped **staff-side LINE** (`loyalty/line-auth.ts` `verifyLineIdToken`, `pos_members.line_user_id` + `line_display_name`, migration `0105_member_line`, staff enrol/link routes). Reconciliation: (i) **dropped my redundant `0110_member_line_link`** and the duplicate `line_user_id` schema column — the member app now uses **main's** column + **shared `verifyLineIdToken`** (member LINE login `auth/line` and `link-line` are idToken-based, consistent with the staff flow); (ii) merged the loyalty-controller (main's LINE routes + my `crm_*` re-gating coexist); (iii) **reconciled the journal** = main's entries + my `0101`–`0109` (every `.sql` journaled — verified); my `0104`/`0105` and main's `0104_service_charge`/`0105_member_line` coexist as distinct tags (independent migrations); (iv) renumbered my SoD UAT case to **ADM-081** (main took ADM-079/080) and merged the coverage totals + the messaging step (LINE push + PDPA consent). Full re-verification after merge: ICFR **57/57**, 38 unit, e2e/ext/worldclass/restaurant/taxdocs/pos-p2/writeflow/analytics, typecheck, api+web build — all green. |
| 1.5 | 2026-07-01 | platform | **Receipt-upload-for-points shipped (closes the last real gap vs Buzzebees/Hato found in a competitor feature-comparison audit):** a member submits a photo of a receipt from a purchase made **outside our own POS** (self-service `/m` app, `POST /api/member/receipts`, data-URL image like `item-images.ts` — no S3 in this codebase) + the claimed amount; staff with `crm_points_adjust` review a queue (`GET/POST /api/loyalty/receipts...`, web `/loyalty/receipt-approvals`) and approve/reject. Approval grants points through the **same `earnInTx` path POS checkout uses** (no new GL/liability logic — the existing accrual sweep picks up the new `Earn` ledger rows) and rejects reuse the existing `crm_points_adjust` permission (no new permission/SoD rule needed — granting points off a reviewed receipt is the same duty as the existing manual-adjustment control, R15). New table `loyalty_receipt_submissions` (migration `0207`, module `apps/api/src/modules/loyalty/receipt-submissions.service.ts`) with a partial-unique duplicate-claim guard (same member/date/amount can't be claimed twice while live). Control **LYL-17**. Docs synced: narrative 19, user manual 13 §14, UAT 11 (UAT-LOY-025..027), RCM (`compliance/build_rcm.py`, 78 controls). |
