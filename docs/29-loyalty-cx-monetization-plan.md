# 29 — Loyalty CX & Monetization: Close the Loops, Charge for the Club — Design & Roadmap

> **Date:** 2026-07-02 · **Status:** v1.0 — **PLANNING** · **Owner:** ERP / Product (CMO + SVP-IT review)
> **Scope:** The five follow-ups after docs/27 (Loyalty World-Class, DELIVERED): **V1 member-app completion**
> (ship the consumer UI the W1–W3 APIs already have), **V2 NPS → service-recovery cases** (a detractor
> becomes an owned, SLA-tracked task — not just a notification), **V3 statistical rigor for A/B + holdout**
> (close the docs/26 §5 honesty gap), **V4 paid VIP membership** (recurring club fee → tier grant, with
> TFRS-15-correct deferred revenue), **V5 digital wallet passes** (Apple/Google — the member card in the
> phone wallet, mock-first provider seam).
> Build on, don't duplicate: /m rides the existing member token + self-scoped APIs; recovery cases ride
> `modules/service`'s SLA machinery (`sla_events` response/resolution due); VIP rides the tier ladder +
> `loyaltyTierHistory` + the GL/revrec spine; passes ride the provider-seam pattern (tenant creds → env →
> mock) proven by messaging/e-tax; stats extend the G2/H2 report in place.

## 0. Why (state after docs/27, verified in code 2026-07-02)

| Loop | Built | Still open |
|---|---|---|
| W1 P2P transfer | API `POST /api/member/points/transfer` ✅ | **No UI in `/m`** — a member cannot actually send points from the app | 
| W1 tier ×earn | earn path + staff ladder card ✅ | `/m` card shows points only — the member never sees their multiplier or ladder progress |
| W3 NPS detractor | fires `loyalty.nps_detractor` → notification/journey ✅ | **Nobody owns the recovery** — no case, no SLA, no "was the member called back?" evidence |
| H2/G2 A/B + holdout | per-group rates + size-scaled lift, sizes rendered ✅ | docs/26 §5 punted significance — the report can't say *"real or noise"* |
| Tiers | ladder + auto-recompute ✅ | Tier standing is earn-only — no **paid** membership revenue (docs/27 §5 parked) |
| Member card | `/m` digital card ✅ | Not in the phone wallet (docs/27 §5 parked — needs signing certs; mock-first is buildable now) |

Five sequential doc-synced PRs (**V1 → V2 → V3 → V4 → V5**), delivery discipline unchanged (one PR per
phase; narrative + user manual + UAT + harness + RCM-when-a-control-changes; merge on all-green CI; branch
restarts from `main` after each merge; migrations take the next free 4-digit id at PR time).

## 1. Phase V1 — Member-app completion (ship the UI the APIs already have) 🏃 fast, consumer-visible

**Goal:** everything W1–W3 promised the *member* is actually tappable in `/m`.

- **โอนแต้มให้เพื่อน:** a "ส่งแต้ม" section on `/m` (recipient phone + points + optional note) →
  `POST /api/member/points/transfer` (already self-scoped + CSRF-cookied). Surface the API's guard errors
  verbatim (`SELF_TRANSFER`, `TRANSFER_CAP`, `TRANSFER_DISABLED`, `RECIPIENT_NOT_FOUND`, `INSUFFICIENT_POINTS`).
- **ระดับของฉัน:** the card gains the member's tier ladder strip — current tier, **×earn multiplier**, and
  progress to the next rung — from the existing `GET /api/member/tier` (`tierJourney` already returns
  `earn_mult`/`progress_pct`; render only).
- **ประวัติแต้มแบบเต็ม:** the `GET /api/member/history` list (Earn/Redeem/**Transfer**/Expire rows with
  balance-after) — today the app shows balance only; transfers make history essential.
- **แต้มใกล้หมดอายุ:** a warning chip when the member has an unexpired `loyalty_expiry_notices` row — new
  read-only self-scoped `GET /api/member/points/expiring` (reads the W1 register; no new logic).
- **No schema, no new API surface except the one read-only endpoint; no control changes.**
- **Verify:** web build + the `cookie-auth`/member-app harness checks still green; extend `loyalty` harness
  +1 (member-token transfer via the /m flow path already covered — add the expiring read endpoint check).
  **Docs:** manual 13 §9 rewrite (what the member sees), narrative 19 rev (step 21 surface note), UAT +1.

## 2. Phase V2 — NPS → service-recovery cases (a detractor becomes an owned task)

**Goal:** "detractor ที่ถูกติดต่อกลับภายใน SLA" is a number a manager can be held to.

- **Spine:** `modules/service` already has SLA machinery (`SLA_TIERS` → response/resolution due,
  `sla_events`). Add **`recovery_cases`** (one migration + RLS + tenant-leading index): member_id, source
  (`nps`), source_ref (nps_responses.id), score, status `Open → Contacted → Resolved` (maker = assignee),
  response_due_at (default now + 24h, tenant-configurable), contacted_at, resolved_at, resolution_note,
  assignee.
- **Auto-open:** `NpsService.submit` (detractor branch) opens a case in the same best-effort block that
  fires the event — idempotent per nps_response (unique source_ref). The automation event stays (journeys/
  notifications unchanged); the case is the *accountable* record.
- **Worklist:** `GET /api/recovery/cases?status=` (perm `crm`/`loyalty`/`marketing`), `POST /api/recovery/
  cases/:id/contact` + `/resolve` (stamp actor + timestamps; resolve requires a note). **Overdue cases**
  (past response_due_at, still Open) surface in the existing alerts/action-center style: a `recovery_overdue`
  read block on `GET /api/nps/summary` + a member-360 open-case flag.
- **Control:** new **LYL-20** — *every detractor response opens exactly one recovery case; contact/resolution
  are actor-stamped and SLA-timed; overdue cases are surfaced, never silently dropped* (Detective) → RCM 174.
- **Web:** `/loyalty/recovery` worklist (status chips, overdue highlight, contact/resolve actions);
  member-360 shows the open case.
- **Verify:** harness `crm` +3 (detractor auto-opens exactly one case — a second submit can't (single-use);
  contact→resolve stamps actors; overdue query returns the aged case); compliance +1 (LYL-20 ToE).
  **Docs:** narrative 19 (step 31 extension + matrix row), manual 13 (§7c recovery worklist), UAT +2,
  RCM regen (LYL-20).

## 3. Phase V3 — Statistical rigor for A/B + holdout (docs/26 §5 debt) 🧮 small, pure-read

**Goal:** the campaign report says *"this lift is real (95% CI excludes zero)"* — or honestly says it can't.

- **Method (explainable, SOX posture like `docs/ops/predictive-scoring.md`):** two-proportion z-test +
  **Wilson 95% CI** on redemption-rate and purchase-rate deltas (A vs B, messaged vs holdout). Closed-form,
  no RNG, no library — documented constants in one reviewed place. Report gains per-comparison:
  `delta_pp`, `ci95_pp: [lo, hi]`, `p_value`, `significant` (p < .05 AND both groups ≥ 30), and a
  `verdict` string (`"real"` / `"underpowered — grow the groups"` / `"no detectable effect"`).
- Applies to `GET /api/marketing/automation/campaigns/:id` (A/B block + `organic` block) — computation
  only; **no schema, no new control** (monitoring). A new formula doc
  `docs/ops/ab-significance.md` (rev-controlled like predictive-scoring, versioned `AB_STATS_VERSION`).
- **Verify:** harness `line-automation` +2 (a seeded strong effect reports `significant: true` with CI
  excluding 0; a tiny-group campaign reports `underpowered`, never `significant`). **Docs:** narrative 19
  (step 12 rev), manual 13 (§reading true lift — what the verdict means), UAT +1, new ops doc.

## 4. Phase V4 — Paid VIP membership (recurring club fee → tier grant) 💰 the monetization piece

**Goal:** ร้านขาย "บัตรทอง" ได้จริง — เก็บเงินจริง ลงบัญชีถูกต้อง และระดับหมดอายุเองเมื่อไม่ต่อ.

- **Master (one migration + RLS):** `membership_plans` (tenant-scoped: code, name, tier granted, price,
  period months, active) + `member_memberships` (member_id, plan_id, status `Active/Expired/Cancelled`,
  start/end, sale_ref). One active paid membership per member (partial unique).
- **Sell:** `POST /api/loyalty/memberships/sell` (perm `pos`/`loyalty`) — payment recorded like a sale;
  **GL: Dr 1000 cash / Cr 2260 deferred membership revenue**, then **monthly recognition** amortizes
  2260 → 4xxx membership revenue over the period, riding the **existing deferred-revenue machinery**
  (`modules/revenue` revrec schedules if its API fits — decided at implementation after reading
  `revrec.service`; else a self-contained idempotent monthly job on the BI scheduler, same pattern as
  `gl_prepaid_amortize`). TFRS 15 honest from day one.
- **Tier grant/revoke:** on sell → set member tier to the plan's tier + `loyaltyTierHistory` reason
  `'vip'`; the nightly maintenance sweep **expires lapsed memberships** (status → Expired, tier falls back
  to the earned ladder via the existing recompute — no special-case tier math). Renewal extends `end`.
- **Control:** new **LYL-21** — *membership revenue is deferred and recognized over the service period;
  a lapsed membership auto-revokes the granted tier (no perpetual free VIP)* (Preventive+Automated) →
  RCM 175. SoD: plan config `marketing`/`exec`; selling `pos`/`loyalty`.
- **Web:** plans card on `/loyalty` (HQ/marketing), sell action on member-360, "สมาชิก VIP ถึง {date}"
  on the /m card.
- **Verify:** new checks in `loyalty` harness (+4: sell posts Dr1000/Cr2260 and grants the tier with a
  'vip' history row; month-1 recognition moves 2260→revenue exactly price/periodMonths, idempotent re-run;
  sweep expires a lapsed membership and the tier falls back to the earned rung; liability/TB balanced);
  compliance +1 (LYL-21 ToE). **Docs:** narrative 19 (new step + matrix row), manual 13 (§VIP), UAT +2,
  RCM regen (175).

## 5. Phase V5 — Digital wallet passes (Apple/Google) 📲 the visible "เหนือกว่า" — external certs, mock-first

**Goal:** บัตรสมาชิกอยู่ใน Apple/Google Wallet และแต้ม/ระดับบนบัตรอัปเดตเองหลังสะสม-แลก.

- **Provider seam (the messaging/e-tax pattern):** `modules/wallet-pass` with a resolver
  tenant creds → platform env → **mock** (mock returns a deterministic pass payload + fake install URL —
  fully harness-testable, nothing leaves the building). Real providers behind env: Apple PKPass (signing
  cert `WALLET_APPLE_CERT_*` — .p12 + WWDR; generates the signed .pkpass zip) and Google Wallet Objects
  (service-account JWT `WALLET_GOOGLE_SA_*`; "Save to Google Wallet" link). Certs are an ops prerequisite —
  the phase ships DONE in mock + env-activated, like SMS/LINE before their credentials existed.
- **Surface:** `POST /api/member/wallet-pass` (member self-scoped; returns install link/payload for the
  member's platform) + staff `GET /api/loyalty/members/:id/wallet-pass`. **Pass fields:** shop branding,
  member code (QR/barcode = the existing `member_code`), tier, points.
- **Auto-update:** the existing `BiLiveService` loyalty tick (`earn/redeem`) already fires per movement —
  a small subscriber pushes a pass update (Apple push-token registry table `wallet_pass_registrations`,
  one migration; Google objects update in place). Best-effort like the SSE bus — never a control.
- **PDPA:** the pass carries code/name/tier/points only (the resolve-payload discipline from LYL-19).
- **Verify:** new `wallet-pass` harness slice or `loyalty` +3 (mock pass issue returns the member's
  code/tier/points; a second issue is idempotent per member; an earn triggers a registered pass update
  record). No new control (presentation layer; flag for sign-off if audit disagrees). **Docs:** narrative
  19 (step rev), manual 13 (§wallet pass + the ops-certs note), UAT +1, `.env.example` keys.

## 6. Delivery discipline

- Five PRs, **V1 → V2 → V3 → V4 → V5** (small→big; the external-cert dependency last). Merge only on
  all-green CI; branch restarts from `main` after each merge; migrations take the next free id at PR time
  (expected: V2 `recovery_cases`, V4 `membership_plans` + `member_memberships`, V5 `wallet_pass_registrations`).
- **New controls:** V2 **LYL-20** (RCM 174), V4 **LYL-21** (RCM 175) — `build_rcm.py` + census-tag bump +
  xlsx regen in those PRs; V1/V3/V5 ride existing controls.
- Parallel-work rule (learned in docs/27): another session lands consolidation PRs on `main` — before every
  push, fetch + merge `main`, renumber migrations to the next free id, and re-run the #306 guard set
  (ts-debt ratchet, tenant-idx, migration-parity, rcm-census).

## 7. Explicitly out of scope

Coalition federation across separate legal entities/DBs, marketplace coupon exchange, blockchain points,
multi-armed bandits / trained ML (per docs/26), full CRM ticketing suite (V2 is the NPS recovery loop only,
riding the service module — not a generic helpdesk).

## Revision history

| Ver | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-07-02 | Platform | Initial plan: V1 member-app completion (transfer/tier/history/expiry UI), V2 NPS→recovery cases (LYL-20), V3 A/B significance (Wilson CI + z-test, explainable), V4 paid VIP membership with deferred-revenue recognition (LYL-21), V5 Apple/Google wallet passes (mock-first provider seam). |
