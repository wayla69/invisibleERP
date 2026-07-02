# 27 — Loyalty World-Class: Tier Economics, Coalition Network & the CX Loop — Design & Roadmap

> **Date:** 2026-07-02 · **Status:** v1.2 — **W1+W2 SHIPPED**, W3 pending · **Owner:** ERP / Product (CMO + SVP-IT review)
> **Scope:** The push from "BuzzeBees-parity" (docs/24–26, DELIVERED) to **above** the BuzzeBees/Hato bar —
> by shipping the three things a survey of that class shows we still lack, and by weaponising the one thing
> they cannot copy: **our GL**. **W1 tier economics + points liquidity** (per-tier earn multipliers, P2P
> transfer, expiry-reminder triggers), **W2 coalition network** (earn-anywhere / burn-anywhere across shops
> **with auditable inter-tenant GL settlement** — the above-BuzzeBees differentiator), **W3 the CX closed
> loop** (post-purchase NPS → detractor recovery journey) + **messaging governance** (quiet hours, global
> cross-channel frequency cap).
> Build on, don't duplicate: earn/redeem stay on the locked `earnInTx`/`redeemInTx` ledger path; settlement
> rides `modules/intercompany`; triggers ride the automation catalog + G1 journeys; sends stay inside
> `MessagingService` (MKT-04).

## 0. Why (the honest gap scan, 2026-07-02)

| Capability | BuzzeBees-class | Us today | Verdict |
|---|---|---|---|
| Per-tier earn multipliers (Gold earns 2×) | ✅ table stakes | ❌ flat `pointsPerBaht` for every tier | **W1** |
| Member-to-member point transfer | ✅ | ❌ absent | **W1** |
| Expiry-reminder nudges | ✅ | expiry job exists; **no member-facing warning** | **W1** |
| Coalition earn/burn across brands | ✅ (their core B2B pitch) | ❌ single-tenant rosters | **W2** |
| …with **GL-auditable inter-shop settlement** | ❌ **they don't have a GL** | we own `intercompany` + the 2250 liability spine | **W2 — above the bar** |
| Post-purchase NPS → service recovery | ✅ CX suites | ❌ absent | **W3** |
| Quiet hours + global frequency governance | ✅ | per-journey cap only (MKT-12) | **W3** |
| Points as tender / partial redeem at sale | ✅ | ✅ already (`redeemInTx`) | — |
| Segments/journeys/AB+holdout/scoring/receipts/wallet passes | ✅ | ✅ docs/24–26 (passes parked, §5) | — |

Three sequential doc-synced PRs (**W1 → W2 → W3**), the docs/24–26 delivery discipline unchanged
(one PR per phase; narrative + user manual + UAT + harness + RCM-when-a-control-changes; merge on all-green CI).

## 1. Phase W1 — Tier economics + points liquidity

**Goal:** tiers *mean* something (Gold earns 2×), points feel like money (send them to a friend), and
nobody's points die silently.

- **Per-tier earn multiplier:** `loyalty_tiers.earn_multiplier` (numeric, default 1.0 — one additive
  migration). `earnInTx` multiplies `netSpend × pointsPerBaht × member-tier multiplier` (floor unchanged).
  **GL stays honest for free** — the liability accrual (LYL-03) derives from the points *ledger*, so a 2×
  earn simply accrues 2× liability; no accrual-logic change. Config UI on `/loyalty` tier ladder.
- **P2P point transfer:** `POST /api/member/points/transfer` (member app, self-scoped + CSRF) and a staff
  counterpart — an **atomic two-row ledger move** (`Transfer-` out / `Transfer+` in, `FOR UPDATE` on both
  members in ascending-id order per the referral-deadlock lesson), same-tenant only, opt-in recipient
  (must be active), guards: min balance after, per-day cap, no self-transfer. **Net liability unchanged**
  (2250 untouched — the obligation just changes owner), so no GL posting; the ledger rows are the audit.
  New control **LYL-18** — *P2P transfers are atomic, capped, and net-zero on the liability* (Preventive,
  Application) — RCM census now includes it; ToE in the `compliance` harness.
- **Expiry-reminder trigger:** the maintenance sweep gains a *look-ahead*: members with points expiring
  within N days (default 30) fire `loyalty.points_expiring` into the automation catalog (`{expiring_points,
  days_left}`) — a marketer wires it to a journey/message ("แต้ม 500 จะหมดอายุใน 30 วัน") with the usual
  consent path. Idempotent per member×window (no daily re-nag).
- **Verify:** `loyalty`/`compliance` harness: Gold 2× earns double + accrual ties out; transfer atomic
  (both rows or none), cap enforced, net liability constant across the transfer; expiring-points event
  fires once. **Docs:** narrative 19 (steps 9/15 + control row + rev), manual 13, UAT +2, RCM regen (171).

## 2. Phase W2 — Coalition network: earn anywhere, burn anywhere, settle in the GL ⭐ the differentiator

**Goal:** a franchise/multi-brand operator runs ONE points economy across its shops — and, unlike
BuzzeBees, every cross-shop point movement lands as an **auditable intercompany entry**, so each shop's
2250 liability is exactly what it owes.

- **Coalition master (one migration + RLS):** `coalitions` (HQ-owned: code, name, active) +
  `coalition_members` (tenant_id ↔ coalition, share flags). Opt-in per shop; HQ/Admin manages
  (`users`/`exec`).
- **Cross-shop identity:** a member's *home* shop keeps the roster row; at a partner shop the member is
  resolved **by phone within the coalition** (read-only lookup honouring PDPA — only code/name/points
  cross the boundary, never contact/consent data).
- **Earn/burn anywhere:** a sale at shop B for a shop-A member earns/burns on the **home (A) ledger** via
  the same `earnInTx`/`redeemInTx` (one locked path, unchanged) — plus a **coalition clearing entry**
  through the existing `modules/intercompany` (`createIcTransaction`): B owes A the earn's fair value
  (B caused A's liability to grow); a burn at B reverses it. Periodic `settleIc` nets the balances.
  Every shop's 2250 accrual (LYL-03) keeps tying out to *its own* members' ledger — by construction.
- **Control:** new **LYL-19** — *coalition point movements settle through balanced intercompany entries;
  cross-shop resolution is coalition-scoped and PDPA-minimal* (Preventive+Detective) — in the RCM census. SoD: shop
  staff earn/burn (`pos`/`loyalty`); coalition config is HQ-only.
- **Web:** coalition admin card on `/loyalty` (HQ), a "เครือข่ายพันธมิตรแต้ม" badge at POS member lookup
  when a coalition member resolves, and the IC settlement rides the existing intercompany screen.
- **Verify:** harness `loyalty` (or new `coalition` slice): B-shop earn lands on A's ledger + IC entry
  B→A at fair value; burn reverses; both shops' liability posts still tie out (LYL-03 both tenants);
  non-coalition tenant cannot resolve the member (404); settlement nets. **Docs:** narrative 19 (new step +
  control row + rev), manual 13 (coalition guide), UAT +2, RCM regen (172), PDPA note in
  `docs/ops/data-retention-policy.md` cross-ref.

## 3. Phase W3 — CX closed loop + messaging governance

**Goal:** every purchase can become a promoter — and every send respects the member's night.

- **NPS micro-survey:** post-sale (configurable trigger), send a tokenized link (`@Public`
  `GET/POST /api/nps/:token` — single-use, expiring, no PII in the URL per the CWE-598 lesson) asking the
  0–10 question (+ optional comment). Store in `nps_responses` (one migration, RLS). **Detractor (≤6)**
  fires `loyalty.nps_detractor` into the automation catalog → wire to a service-recovery journey (G1) and
  it surfaces in the member 360; the score also feeds a `nps` analytics tile (score = %promoters −
  %detractors, trend by month).
- **Messaging governance (tenant-wide):** per-tenant `quiet_hours` (default 21:00–09:00 Asia/Bangkok) and a
  **global cross-channel frequency cap** (default N marketing messages / member / 7 days) enforced **inside
  `MessagingService.send`** for *marketing* sends (transactional — OTP, receipts, delivery callbacks —
  exempt): a quiet-hours send is **deferred** (journeys re-snap; ad-hoc blasts audit `skipped:
  'quiet hours'`), an over-cap send audits `skipped: 'global cap'`. Rides **MKT-04/MKT-12**; config on
  `/settings/messaging`; stored in the existing `tenant_messaging_config` (a `governance` channel row —
  no new table).
- **Verify:** harness `line-crm`/`crm`: detractor response fires the event + 360 shows the score; quiet-hours
  blast audits deferred/skipped; global cap counts across channels (journey + blast) and audits the skip.
  **Docs:** narrative 19 (steps 11/28 + rev), manual 13 (§NPS + governance), UAT +2; no new control beyond
  W1/W2's (governance rides MKT-04/12 — flagged for sign-off if audit wants an ID).

## 4. Delivery discipline

- Three PRs, **W1 → W2 → W3**; merge only on all-green CI; branch restarts from `main` after each merge.
  Migrations take the next free 4-digit id at PR time (expected: W1 tier column, W2 coalition tables + RLS
  loop, W3 `nps_responses` + RLS), journaled sequentially.
- **New controls:** W1 **LYL-18**, W2 **LYL-19** (both in the RCM census — 173 controls as of the audit-remediation merge) — `build_rcm.py` regen in each PR;
  W3 rides MKT-04/12.
- Sequencing: W1 first (small, consumer-visible, and W2's fair-value math reuses the multiplier-aware earn);
  W2 second (the differentiator — biggest surface, wants W1 settled); W3 last (independent polish).

## 5. Explicitly out of scope (beyond this plan)

Apple/Google Wallet passes (env-activated provider candidate — needs signing certs), coalition across
*separate legal entities outside one DB* (federation), paid-tier subscriptions (VIP membership fees),
marketplace coupon exchange, blockchain points. Multi-armed bandits / trained models stay out per docs/26.

## Revision history

| Ver | Date | Author | Change |
|---|---|---|---|
| 1.2 | 2026-07-02 | Platform | **W2 SHIPPED — the differentiator.** `coalitions`/`coalition_members` + `ic_category` `'loyalty-clearing'` (migration `0222`); HQ-only config (`COALITION_HQ_ONLY`); PDPA-minimal coalition-scoped resolve; `POST /api/coalition/earn|redeem` on the member's HOME ledger (locked earnInTx/redeemInTx — per-shop 2250 truth by construction) + atomic balanced IC clearing at fair value (closed partner period rejects the whole movement); `settleIc` nets, reconciliation eliminates; `createIcInternal` extracted (manual IC endpoint unchanged/HQ-only). Control **LYL-19** added to the RCM. New CI-gated `coalition` harness (21 checks); compliance 117/117; intercompany 16/16, loyalty 30/30. Narrative 19 rev 1.34 (step 30 + row 30), manual 13 rev 1.30 (§7b), UAT 54→56, data-retention 0.3. |
| 1.1 | 2026-07-02 | Platform | **W1 SHIPPED.** Tier `earn_mult` now applies on the REAL earn path (`earnInTx`; the column already existed — no schema change; ledger notes audit `tier Gold ×2`); P2P transfer (`POST /api/member/points/transfer` + staff route; atomic ascending-id-locked two-row move; `loyalty_config.transfer_day_cap`, migration `0221`; control **LYL-18** added to the RCM); expiry look-ahead `loyalty.points_expiring` (idempotent per member × expire-by via `loyalty_expiry_notices`, migration `0221`). Transfer rows integrated into the expiry model (inbound ages from its own date, outbound consumes). Harness: `loyalty` +14 → 30/30, `compliance` +1 → 116/116; narrative 19 rev 1.33, manual 13 rev 1.29, UAT 52→54. |
| 1.0 | 2026-07-02 | Platform | Initial above-BuzzeBees plan: W1 tier economics + P2P transfer + expiry nudges (LYL-18), W2 coalition earn/burn with intercompany GL settlement (LYL-19 — the differentiator no loyalty SaaS can match), W3 NPS closed loop + quiet-hours/global-cap messaging governance. |
