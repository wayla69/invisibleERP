# 45 — ERP × POS Data-Driven Marketing Strategy (internal + external, combined)

> **Date:** 2026-07-12 · **Status:** v0.5 — ALL FOUR GAPS (G1–G4) DELIVERED · **Owner:** ERP / Product
> **Question answered:** *"Can we use the data in ERP and POS to make a marketing strategy by combining
> both internally and externally together?"* — **Yes**, and most of the plumbing already exists. This doc
> inventories what we already collect, maps it into one closed marketing loop, and lists the four thin
> gaps that stand between "we have the data" and "the data runs the marketing".
> **Discipline (same as docs/25/26/44):** each roadmap phase below is an independently-shippable,
> doc-synced PR (migration + module + permissions/SoD + RCM control + narrative + user-manual + UAT +
> cutover-harness), merged only on a fully-green CI matrix.

---

## 0. Read this first — the short answer

Yes. The system already holds a **member-keyed, transaction-level, margin-aware** dataset that most
retailers pay a CDP vendor to assemble, plus **activation channels** (LINE / SMS / email / wallet passes)
and **closed-loop attribution** (per-member coupon → redeeming sale). What is *missing* is thin and
well-defined: marketplace customers are anonymous, there is no basket-affinity analytic, the
`cdp_export_sync` hook has no real external target, and marketing ROI is not yet assembled into one view.

Strategy in one sentence: **use the ERP (margin, inventory, demand) to decide *what* is worth promoting,
the POS+CRM (identity, RFM, preferences) to decide *who* and *when*, the existing channels to activate,
and the coupon-redemption loop to prove lift — then enrich the loop with external data (marketplaces,
LINE, ads platforms, weather/holidays) at the four gap points below.**

---

## 1. Internal data we already collect (the supply side)

| Asset | Where it lives | Marketing use |
| --- | --- | --- |
| **Member identity spine** | `pos_members` (phone, email, **lineUserId**, birthday, **marketingOptIn**, tier, lifetime) + `pos_member_ledger` (points ↔ `refDoc` = saleNo) | One customer key joining POS sales ↔ LINE ↔ wallet pass ↔ consents |
| **Transaction detail** | `custPosSales` / `custPosItems` (line items, daypart, branch, tender, tip, points earned/used) | Recency/frequency/monetary, item preferences, daypart targeting |
| **Customer profile (scored)** | `crm.customer_profiles` — RFM segment, **churnRisk**, **predictedLtv**, favoriteItemIds, preferredChannel, preferredHour (refresh = BI job `crm_profile_refresh`) | Segmentation, win-back triggers, send-time optimization (docs/26 H3) |
| **Hospitality depth** | `member_dining_profiles` (allergies, dietary, seating, party size) + `member_companions` | Personalization no marketplace competitor has |
| **Loyalty engagement** | tiers/missions/wheels/referrals/coupons (`loyalty_*`), paid memberships, gift cards, coalition earn-anywhere | Retention mechanics + engagement signals |
| **Voice of customer** | `nps_responses` + `recovery_cases` (detractor → service recovery) | Suppress promos to open detractors; testimonial sourcing from promoters |
| **ERP margin & supply** | item costing / menu engineering (Kasavana–Smith quadrants in `analytics/menu-engineering.service.ts`), inventory, **demand-ml** per-item forecasts (Thai-holiday aware), `modules/budget` | Promote *Puzzles* (high margin, low popularity), never discount *Stars* blindly; time promos to forecast troughs; cap spend vs budget |
| **B2B pipeline** | `crm_leads/accounts/opportunities`, source-ROI (`crm_source_roi`) | Same loop for the B2B side (catering, corporate) |

## 2. External surfaces already wired (the demand side)

- **LINE OA** — push/reply/Flex, OA broadcast, inbound webhook + chat workbench (docs/30/31), member
  linking (`line-auth.ts`, `line-link.service.ts`). Our primary owned external channel.
- **Delivery marketplaces** — `channel-adapter` ingests orders from **Grab, LINE MAN, foodpanda,
  Robinhood** (+ menu-sync out, auto-86). Today these customers are **anonymous** (gap G1).
- **Shopee + LINE connectors** — `modules/connectors` framework (stub transports, real adapters swap in).
- **Wallet passes** — Apple/Google Wallet membership cards (`wallet-pass`).
- **CDP hook** — BI report type **`cdp_export_sync`** ("Sync customer data to CDP") exists but has no
  production external target yet (gap G3).
- **Consent & privacy rails** — `pos_members.marketingOptIn`, `member_consents`, PDPA module (DSAR,
  ROPA, retention sweep `pii_retention_sweep`). All existing senders already filter on opt-in.

## 3. The strategy loop (all five steps map to existing modules)

1. **Identify** — enroll every buyer onto the member spine (POS enroll, LINE link, receipt-submission,
   wallet pass). *Gap G1 extends this to marketplace buyers.*
2. **Segment** — `crm_profile_refresh` RFM + `saved_segments` rule engine + `promo_audience_rules`;
   audiences by RFM segment / tier / saved segment.
3. **Activate** — `marketing-automation` (lapsed/birthday/winback triggers, per-member coupons, A/B +
   holdout), `campaigns` (scheduled broadcast), `journeys` (multi-step lifecycle, docs/25/26) over
   LINE / SMS / email / wallet.
4. **Measure** — closed-loop: `campaign_sends.redeemedSaleNo/redeemedValue` ties send → sale;
   organic-holdout baseline (docs/26 H2); `crm_source_roi` for B2B; `docs/ops/ab-significance.md` for
   the stats discipline. *Gap G4 assembles this into one ROI view.*
5. **Enrich** — feed ERP-side signals (margin quadrant, stock position, demand forecast, Thai holidays)
   into offer selection, and external signals back into profiles. *Gaps G2/G3.*

**Worked example (all-internal, shippable today):** demand-ml forecasts a Tuesday-afternoon trough →
menu engineering says items X, Y are *Puzzles* (high margin, under-sold) → saved segment "At Risk ∧
favorite category = X's category ∧ marketingOptIn" → journey sends a LINE Flex coupon at each member's
`preferredHour` with a 10% holdout → redemption lands on `campaign_sends`, lift is read against the
holdout, cost is checked against `budget`. Every step is an existing endpoint.

## 4. Roadmap — the four thin gaps (each = one doc-synced PR)

- **G1 — Marketplace-to-member identity capture. ✅ DELIVERED (migration `0366`, control MKT-13, PN-19 rev 1.45, UAT-LOY-076..079).** Grab/LINE MAN/foodpanda/Robinhood orders ingest with
  no member key. Add package-insert QR / post-order LINE-link flow (reuse `receipt-submissions` +
  `line-link`) + a `channel_customer_refs` mapping so repeat marketplace buyers accrue to one profile.
  New detective control (mkt-consent-scoped); PDPA: consent captured at link time.
- **G2 — Market-basket affinity. ✅ DELIVERED (`GET /api/analytics/menu-affinity` + BI type `menu_affinity`, PN-20 rev 3.19, UAT-RPT-055..056; no new control — read-only aggregator).** Only menu-engineering quadrants exist today; no co-purchase/affinity
  analytic. Add an affinity computation over `custPosItems` (support/confidence/lift, per branch +
  daypart) surfaced in `analytics` and consumable by `promo_audience_rules` (cross-sell offers).
  Read-only aggregator — build on `analytics`, don't fork it.
- **G3 — External activation & enrichment via `cdp_export_sync`. ✅ DELIVERED (BI job `audience_export_sync`, control PDPA-05, migration `0379`, PN-19 rev 1.47, UAT-LOY-081..082). G3b: DIRECT Meta Custom Audiences + Google Customer Match adapters delivered (`common/audience-providers.ts`, env-gated — live the moment creds land, mock until then; per-recipient register rows; PN-19 rev 1.48, UAT-LOY-083). Remaining residual: the weather overlay needs a data-vendor decision — the Thai-holiday overlay already ships in demand-ml (`th_holiday`).** Give the existing hook a real
  target: start with **ads-platform custom audiences** (hashed phone/email export, consent-filtered) and
  a weather/holiday overlay for demand-ml-timed promos. Strictly opt-in-only export + ROPA entry;
  fail-closed if consent basis missing (mirrors the security-review posture).
- **G4 — Unified marketing ROI report. ✅ DELIVERED (BI report type `marketing_roi`, PN-19 rev 1.46, UAT-LOY-080; no new control — read-only aggregator).** New BI report type `marketing_roi` joining
  `campaign_sends` attribution + voucher redemptions + `crm_source_roi` + campaign cost vs
  `modules/budget` — one exec view of spend → lift → margin (menu-engineering-aware, so a "successful"
  campaign that only discounted *Stars* reads as the margin loss it is).

Suggested order G1 → G4 → G2 → G3 (identity first — everything downstream keys on it; ROI view second so
later phases are measured from day one).

## 5. Explicitly not rebuilding

RFM/segments (`customer_profiles`, `saved_segments`), campaign/journey/automation engines, A/B +
holdout + significance, NPS/recovery, LINE stack, channel-adapter, wallet passes, coalition/giftcards/
memberships, demand-ml, menu engineering, PDPA/consent rails — all delivered (docs/14/24/25/26/27/29/30/31).
Extend them per the module map above.

## Revision history

| Version | Date | Change |
| --- | --- | --- |
| v0.6 | 2026-07-13 | G3b — direct Meta/Google audience adapters (env-gated, platform-exact hashed wire formats, per-recipient register rows). No new control, no migration. |
| v0.5 | 2026-07-12 | G3 DELIVERED — `audience_export_sync`: consent-gated (live `member_consents` rows only), sha256-hashed audiences, fail-closed ROPA gate + append-only `audience_exports` register (0371, PDPA-05), SSRF-gated push. Weather overlay = stated residual; Thai-holiday overlay already in demand-ml. **Roadmap complete.** |
| v0.4 | 2026-07-12 | G2 DELIVERED — menu-affinity analytic (support/confidence/lift per daypart, `min_pair_count` gate), web tab on /restaurant-analytics, schedulable `menu_affinity` BI type. No new control. |
| v0.3 | 2026-07-12 | G4 DELIVERED — `marketing_roi` BI report: spend (discount given) → attributed revenue/margin (food-cost layer) → organic holdout lift, + voucher/B2B/budget legs. No new control. |
| v0.2 | 2026-07-12 | G1 DELIVERED — `channel_customer_refs` (0366), hash-only capture on both ingest paths, consent-gated QR/staff linking, auto-attach `dine_in_orders.member_id`, control MKT-13 (RCM 268). |
| v0.1 | 2026-07-12 | Initial assessment + strategy + G1–G4 roadmap (planning only, no feature code). |
