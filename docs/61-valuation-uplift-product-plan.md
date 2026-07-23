# docs/61 — Valuation-Uplift Product Plan: three revenue engines to defend a 15% seed dilution

> **Status:** PROPOSED v0.1 · **Date:** 2026-07-22 · **Owner:** CEO (commercial) / Platform (build)
> Purpose: close the valuation gap between the current seed model (raise 70M baht at 320M pre-money
> → ~18% dilution) and the owner's 15% target (→ ~400M pre-money) by adding product capabilities
> that raise the defensible forward-ARR base from 40M to 50M baht — or equivalently defend a 10×
> (vs 8×) revenue multiple. Companion to the investor deck (`docs/pitch-deck/`), the market study
> (`docs/ops/pricing-market-study-2026-07.md`), and the shipped packaging model (docs/36, docs/53).

## 1. The math this plan must close

| Scenario | Pre-money | Raise | Dilution | Requirement |
|---|---|---|---|---|
| Today (deck v. 2026-07-22) | 320M | 70M | ~18% | shipped |
| **Target (this plan)** | **~400M** | 70M | **15.0%** | forward ARR 40M → **50M** at 8×, **or** hold 40M and defend **10×** |
| Fallback C (no new build) | ~340M | 60M | 15.0% | negotiation-only; runway 20 → ~17 months |

Both target paths are served by the same three engines below: each adds recurring revenue that is
**not seat-count-bound** (usage/GMV/channel-leveraged), which is precisely what re-rates a plain-ERP
multiple toward software-plus-payments comps (Toast, Shopify).

## 2. Engine 1 — Embedded payments with a take-rate (P1, highest impact)

**What:** move from *confirming* payments (Wave C/D rails: PromptPay QR, slip claims + verify queue,
slip-OCR pre-fill — PRs #895/#897) to *monetizing* them: platform-routed payment acceptance earning
~0.3–0.8% of transaction volume, via revenue-share with a licensed Thai PSP first (no payment
licence needed for MVP), payment-facilitator status later.

**Why it moves valuation:** revenue scales with customer GMV, not tenant count. Bridge math:
1,000 merchants × ~2M baht/yr card+QR volume × 0.5% take ≈ **10M baht/yr** — the entire 40M→50M gap.

**Build on (do not rebuild):** the QR/slip verification queue, `saas-receipts`, billing metering
(`billing-metering.service.ts` usage-quota machinery meters take-rate volume the same way it meters
AI tokens), GL posting events. New: PSP settlement ingestion (webhook, mirrors the existing PSP
HMAC pattern in `common/webhook-auth.ts`), a settlement-reconciliation control (REC family), payout
ledger. **MVP ~6–8 senior person-weeks** + PSP partnership (commercial lead time dominates — start
the partnership conversation first).

**Proof metric for the pitch:** take-rate revenue live with even 50 merchants beats any projection.

## 3. Engine 2 — Marketplace commerce connectors: Shopee → Lazada → TikTok Shop (P2)

**What:** order/stock/settlement sync with the three Thai marketplaces, posting into the same
audited GL — the first ask of every Thai retail merchant, and uncovered end-to-end by any local
competitor in the 2026-07 market study.

**Why:** widens TAM beyond food-service into all retail (locks in the industry-neutral
positioning), and channel features sit in higher tiers → structural tier-upgrade pull. Marketplace
GMV also feeds Engine 1 volume.

**Build on:** the channel-adapter architecture (delivery channels + restaurant channel adapters are
the template — registry-driven, HMAC-verified webhooks); inventory reservations; the returns spine.
One marketplace ≈ **4–6 person-weeks** (Shopee first — largest GMV); the second is cheaper (the
adapter seam is proven).

## 4. Engine 3 — Accountant-firm portal (P3, distribution flywheel)

**What:** a multi-client console for accounting firms managing 20–100 SME clients: cross-client
close status, document inbox, SME-02 review workflow, per-client drill-in — priced per firm seat +
a revenue share on referred subscriptions.

**Why:** each signed firm becomes a sales channel (thousands of Thai firms currently steer SMEs to
Express/PEAK). VCs price distribution flywheels; this is also the cheapest engine — it is largely a
re-scope of existing machinery: the external-accountant `sme_review` duty, the Platform Console
multi-company patterns, act-as scoping, and the god-console UI kit. **~5–7 person-weeks.**
Bounded-context note: this is a new *portal surface* (own module), not an extension of the platform
console — gate by a new firm-level principal, never by widening god.

## 5. Supporting items (story-strengthening, cheap)

- **S1 — AI anomaly detection on the control ledger** (~3–4 person-weeks): score voids, discounts,
  stock adjustments, and after-hours postings against per-tenant baselines; surface as a detective
  worklist beside the existing G14/discount-exception reports. Data + 307-control framework already
  exist; upgrades "audit-ready" to "AI-audited" — the direct defence of the 10× multiple. Extends
  the roadmap-slide "anomaly-detecting controls" from Future into Delivered.
- **S2 — one SEA tax/language pack** (Vietnam or Indonesia; ~4–6 person-weeks localization +
  ongoing tax maintenance): converts the "regional scale" roadmap slide from plan into proof.
  i18n architecture already supports additional locales; tax engine needs a country pack seam.

**Deliberately excluded:** more depth in manufacturing / projects / WMS — already strong, does not
change the revenue model, adds cost without moving the multiple.

## 6. Sequencing & the fundraise clock

1. **Now → pitch:** start the PSP partnership conversation (longest lead item); build Engine 1 MVP
   behind a feature flag; draft the "path to 50M forward ARR" deck slide (three stacked bars:
   subscriptions 40M + payments ~7M + channel/portal expansion ~3M).
2. **Pitch-ready bar:** Engine 1 live with a pilot cohort (even 50 merchants) + S1 demo. That is
   the evidence that moves the room from 320M to ~400M; without live numbers, expect negotiation
   back toward fallback C (340M pre / 60M raise — still 15%).
3. **Post-raise:** Engines 2–3 with the round's product budget (they are also the first two rows of
   the use-of-funds slide's "platform depth" allocation).

Every engine ships under the house rules: owning-module bounded context, posting events for any GL
impact, RCM controls + narrative/UAT/manual doc-sync in the same change, harness ToE, and the
entitlement gating seam (each engine is a suite/add-on in `entitlements.ts` — Engine 1 take-rate is
metered, not suite-gated).

## 7. Handoff notes for the implementing session

- **Branch state (2026-07-22):** `claude/erp-pitch-deck-react-xfsmne` sits on top of merged main
  (#894 → #918 all in); three unmerged deck commits (`e2a5855`, `5bf813e`, `7b0978f`) + this doc —
  **no PR open yet**; open one when the owner says so (squash-merge convention, babysit to green).
- **Deck source-of-truth & standing rules:** interactive `docs/pitch-deck/PitchDeck.jsx` + the
  hand-mirrored static builder in the session scratchpad (`build-deck-html.mjs` — every content
  change must be applied in BOTH, then HTML→repo copy→Chromium print→overflow check). Rules: white
  background/pastel/dark text; business-formal tone (no AI-formal); **no ฿ glyph, no T-scale — all
  money in M with "unit: baht / หน่วย: บาท" captions**; counts verified against built
  `@ierp/shared` + `build_rcm.py --counts` (2026-07-22: 24 roles / 82 perms / 24 SoD / 307 controls).
- **Valuation chain (single source in the deck):** replacement floor 67M+ → sensitivity grid
  (bear 25M / base 40M / bull 55M forward ARR × 6/8/10×) → highlighted cell = the ask's pre-money →
  The-Ask stats (raise / pre / equity % / runway) → ARR milestone. **Change them as one chain, never
  one number** — dilution % = raise ÷ (pre + raise).
- **Adjacent live workstreams:** ENTITLEMENTS_SHADOW is ON in prod (Railway, invisibleERP service)
  soaking until ~2026-08-06 spanning month-end; then runbook §5 triage
  (`docs/ops/entitlements-rollout-runbook.md` v1.2 — observation ledger is the primary source)
  before any ENFORCE decision; after permanent ENFORCE, move the two flags from `transitional` to
  `expected` in `docs/ops/railway-env-manifest.json` (one-line PR).

## 8. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-07-22 | Platform / CEO | Initial plan: three revenue engines (embedded payments take-rate, marketplace connectors, accountant-firm portal) + S1/S2 supports, sized against the 15%-dilution target (pre 320M → ~400M; forward ARR 40M → 50M or 8× → 10×). |
