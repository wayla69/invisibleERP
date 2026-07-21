# 53 — Pricing & Packaging Overhaul: Product-Line Split (POS / ERP / Complete)

> **Status: SHIPPED v1.1 (2026-07-21).** Candidate **C1 approved (sign-off §10)** and implemented the
> same day: suite split (`sales` → order-to-cash + `pos_frontoffice`), four line SKUs (`pos_lite`,
> `pos_pro`, `erp_essentials`, `erp_growth`; POS line per-branch via `subscriptions.branches`,
> migration 0457), procurement → Standard (Q1), Solo/Trial display renames (Q2/Q4), price
> grandfathering (Q7, migration 0456), CI wiring for `plan-gating`/`proration`, and the `/plans`
> product-line picker. Spec of record for the live packaging: docs/36 §3/§3b. Market evidence:
> [`docs/ops/pricing-market-study-2026-07.md`](ops/pricing-market-study-2026-07.md).
> Delta vs the proposal: quotas landed exactly as tabled; the per-branch mechanism shipped as
> `features.per_branch` + `subscriptions.branches` (simpler than §4's sketched
> `included_branches`/`branch_addon_thb` pair); locations caps remain advisory (as on all
> pre-existing plans); the two new UAT cases are classified functional (plan gating is a commercial
> gate, not an ICFR control — no RCM mapping).

## 1. Executive summary

The platform today sells one bundle ladder (Free / SME ฿690 / Standard ฿2,900 / Business
฿4,900 / Professional ฿9,900 / Franchise ฿14,900 / Enterprise custom) plus four à-la-carte
add-on SKUs and metered usage. The bundles price *well* against the fragmented stacks the
mid-market actually runs (at 3+ branches we undercut them while adding the audited ledger
— study §6), but the bundle-only catalog loses two entries the market expects to buy
separately: **POS only** and **ERP only**. The owner has additionally directed that the
product present as a **multi-industry platform** (retail, services, manufacturing,
projects, real estate — with F&B as one strong vertical), not as a restaurant product.

This proposal introduces **two sellable product lines beside the existing Complete
bundles** — a per-branch POS line and a per-company ERP line — implemented as *additive*
plan SKUs on the shipped suites/add-on machinery, with the existing seven plan codes
frozen. Three candidate structures are laid out (§6); the recommendation is **C1 — Two
lines + Complete bundles** (§7).

## 2. What changed since the packaging shipped (baseline for this proposal)

PRs #885–#890 (2026-07-20/21) already delivered: the public **/plans configurator** with
pack selection carried through signup; the **Franchise plan** (฿14,900, 100 seats / 25
locations, manufacturing + projects included); **à-la-carte add-on SKUs** on
`subscriptions.addons` (`scm_advanced` ฿1,500 · `integrations` ฿990 · `cdp` ฿1,290 ·
`sandbox` ฿2,900); per-plan module matrix + add-on management in the Platform Console; and
SaaS lifecycle automation (trial reminders, grace auto-suspend, dunning). This proposal
**builds on** that architecture — the add-on mechanism and configurator are exactly the
rails a product-line split needs — and does not revisit it.

## 3. The two gaps, evidenced

1. **POS-only entry.** The Thai POS market prices **per branch** at ฿270–1,700/mo (study
   §2). A single-branch buyer with POS intent compares our cheapest multi-seat plan
   (Standard ฿2,900, bundled with finance) against FoodStory ฿1,250–1,700 — and closes the
   tab. SME ฿690 exists but is fenced to one seat, which a counter+kitchen shop already
   exceeds.
2. **ERP-only entry.** Service/project firms and back-office-first buyers get a register
   they didn't ask for; the sale wins on price but the message reads "restaurant system."
   Renaming nothing, the same suites sold without the POS front-office — priced against
   PEAK (฿1,200) below and Odoo/Zoho (per-user, ฿7k+ at 10 staff) above — is a clean,
   winnable position.

Industry-neutrality follows from the same split: "POS" and "ERP" are category words with
no vertical connotation; vertical fit lives in the existing `tenants.industry` starter
kits and (Phase B, collateral) proof-point sections, not in packaging.

## 4. Design constraints (from the shipped code)

- **Plan codes are frozen**; new SKUs are additive (`subscriptions.plan_code` FK stays
  valid; no data migration).
- The `sales` suite currently bundles the register with order-to-cash
  (`pos, order_mgt, claim_mgt, crm, delivery, returns, pricelist, promos`). A POS-only /
  ERP-only split **requires recomposing it** into a front-office suite and an
  order-to-cash remainder — the one structural code change (blast set #2: entitlements
  maps + `check-entitlements` + `plan-gating` fixtures; no `@RequiresSuite` sites exist on
  `sales` today, so the decorator sweep is expected to be a no-op).
- A per-branch axis needs one new feature key pair (`included_branches`,
  `branch_addon_thb`) and a guard check alongside `checkUserLimit`.
- Enforcement remains behind `ENTITLEMENTS_ENFORCE` (shadow-first rollout per docs/36).

## 5. Design questions → resolutions (applied in all candidates)

| # | Question | Resolution |
|---|---|---|
| Q1 | Procurement placement | Base procurement (PR→PO→blind-count GRN) moves INTO Standard (`starter`); `scm_advanced` (RFQ, 3-way match routing) stays the ฿1,500 add-on. Fixes the controls story at ฿2,900 without giving away the premium routing. |
| Q2 | SME/Standard bimodality | Keep SME's breadth — it is the deliberate solo wedge — but re-present it as the **Solo edition of the Complete line** (display name "Solo", seat fence shown first on /plans). No suite changes. |
| Q3 | Pricing axis | POS line: **per branch** (market axis). ERP line + Complete bundles: **flat per company** (our differentiator vs per-user suites). |
| Q4 | Free tier | Keep as evaluation/lead-gen only; relabel display "Trial". Not a sellable product. |
| Q5 | Add-on prices | Keep shipped ฿1,500/990/1,290/2,900 (validated against Loyverse's US$25/store add-on economics and StoreHub tier gaps). |
| Q6 | Quotas | Line SKUs get proportionate meters (POS line: `pos_txns_monthly` scales per branch; ERP line: `etax_docs_monthly` as Standard). AI stays in SME / Professional+ / as add-on later — not in entry lines. |
| Q7 | Grandfathering | Implement the snapshot NOW (before any future repricing): `grandfathered_price` columns on `subscriptions`, backfilled = current price ⇒ zero-behavior deploy. Makes docs' "price until renewal" true in code. |
| Q8 | Trial | Keep 14 days, all lines. |
| Q9 | Implementation packages | Keep ฿30k/80k/150k+ (familiar to Express-generation buyers, study §4). POS Lite explicitly self-serve (no package required). |
| Q10 | Plan codes | Frozen; new: `pos_lite`, `pos_pro`, `erp_essentials`, `erp_growth` (C1/C3) — additive. |

## 6. Candidates

All prices THB/mo, annual = 10× monthly (unchanged policy). All candidates keep the
existing seven codes and the four add-on SKUs.

### C1 — Two lines + Complete bundles (recommended)

| Line | SKU (code) | Price | Suites | Caps |
|---|---|---|---|---|
| POS | **POS Lite** (`pos_lite`) | **฿590/branch** | core, pos_frontoffice | 3 seats/br, counters only |
| POS | **POS Pro** (`pos_pro`) | **฿1,190/branch** | + inventory, portal (QR ordering), delivery channels | 10 seats/br |
| ERP | **ERP Essentials** (`erp_essentials`) | **฿1,900** | core, finance, masterdata, selfservice, order-to-cash (sales remainder), inventory | 10 seats, 1 loc |
| ERP | **ERP Growth** (`erp_growth`) | **฿3,900** | + procurement, planning | 25 seats, 3 loc |
| Complete | Solo (`sme`) · Standard (`starter`, **+procurement** per Q1) · Business (`business`) · Professional (`pro`) · Franchise (`franchise`) · Enterprise | unchanged ฿690 / 2,900 / 4,900 / 9,900 / 14,900 / custom | as shipped (+Q1) | as shipped |

Positioning checks: POS Lite ฿590 sits above Wongnai ฿405 with deeper stock, below Ocha
฿799; POS Pro ฿1,190 undercuts FoodStory FS ฿1,700; ERP Essentials ฿1,900 sits above PEAK
฿1,200 with order-to-cash + inventory attached; bundle arithmetic rewards the merge
(POS Pro + ERP Essentials = ฿3,090 > Standard ฿2,900 for one branch — the bundle is
always the better buy at equal scope, preserving upgrade gravity). Upgrade path is an
entitlement flip: POS→Complete and ERP→Complete keep the tenant, data, and codes.

### C2 — Base platform + composable packs

One thin base SKU (฿990: core, masterdata, selfservice) + everything as à-la-carte packs
(POS pack ฿590/branch, Finance pack ฿1,200, SCM pack ฿900, CRM pack ฿690, verticals as
today's add-ons). Maximal flexibility; the /plans configurator could render it natively.
**Rejected as primary:** pricing arithmetic becomes a project for the buyer (study:
Thai SMEs "close the tab"); every sale needs configuration; revenue per deal drifts
unpredictably; entitlement matrix grows combinatorially in support.

### C3 — Single ladder + two entry SKUs

Keep the seven-tier Complete ladder as the only line; add exactly `pos_pro` (฿1,190/branch)
and `erp_essentials` (฿1,900) as feeder SKUs. Smallest change; but the POS line has no
Lite rung against Wongnai/SilomPOS's sub-฿500 entries, and marketing must still explain
why the "real" catalog is bundles. **Viable fallback** if C1's four new SKUs are judged
too many.

### Trade-off matrix

| Criterion | C1 | C2 | C3 |
|---|---|---|---|
| Matches market split-sell norm | ✅ two named lines | ◑ implicit | ◑ partial |
| Message simplicity (one-page price table) | ✅ | ❌ | ✅ |
| Implementation cost | ◑ sales-suite split + branch axis | ❌ largest | ✅ smallest |
| Cannibalization control | ✅ bundle-beats-sum arithmetic | ❌ hard to steer | ✅ |
| Competes at POS floor (<฿600) | ✅ POS Lite | ✅ | ❌ |
| Industry-neutral read | ✅ | ✅ | ◑ |

## 7. Recommendation

**C1.** It is the only candidate that fights in both market bands on their own axes
(per-branch at the POS floor, flat per-company against the suites ceiling) while keeping a
one-page catalog and the bundle-beats-sum upgrade gravity. Implementation rides almost
entirely on shipped rails; the only structural change is the `sales` suite split, which
was already anticipated as blast set #2.

## 8. Revenue impact (shape)

Additive SKUs + frozen bundle prices ⇒ **zero repricing of the installed base** (verify:
`SELECT plan_code, COUNT(*) FROM subscriptions GROUP BY 1`). Impact is new-funnel only:
POS-line deals are net-new (currently lost to FoodStory/Wongnai per study §6); ERP-line
deals convert service-firm prospects the restaurant framing repelled. Managed risk: a
Standard prospect with pure POS intent may now land at ฿1,190 instead of ฿2,900 — but
study §6 indicates those deals were predominantly not closing at ฿2,900 at all.

## 9. Phase B implementation pointer (details in the approved plan)

PR-2 hardening (CI wiring for `cutover:plan-gating` + `cutover:proration`; sync stale
`docs/ops/pricing-and-ai-cogs.md`) → PR-3 grandfathering (migration **0456**, snapshot
backfill, COALESCE charge path) → PR-4 packaging (entitlements split of `sales` →
`pos_frontoffice` + remainder; four additive SKUs in PLAN_SEED; `included_branches`
feature key + guard; provisioning defaults; /plans + configurator + Platform Console
surfaces; fixtures sweep; docs/36+49+ops+user-manual sync) → PR-5 collateral re-render
with **industry-neutral repositioning** (multi-industry ERP + POS lines; F&B/retail/
services as proof points; fix stale "26 SoD rules" → 23 across collateral).

## 10. Sign-off block (to be completed by the owner — gates Phase B)

| Decision | Choice | Notes |
|---|---|---|
| Candidate | ☑ **C1** | approved as recommended |
| Q1 procurement → Standard | ☑ approve | |
| Q2 SME as "Solo" display | ☑ approve | |
| POS line prices (฿590 / ฿1,190 per branch) | ☑ approve | |
| ERP line prices (฿1,900 / ฿3,900) | ☑ approve | |
| Q7 grandfathering snapshot | ☑ approve | |
| Signed | Owner (via chat directive "next") · 2026-07-21 | recommended defaults accepted |

## Revision history

| Ver | Date | Change |
|---|---|---|
| 1.0 | 2026-07-21 | Initial proposal (market study 2026-07; post-#885–#890 baseline). |
| 1.1 | 2026-07-21 | C1 signed off and SHIPPED (Phase B: 0456 grandfathering, 0457 line SKUs, suite split, /plans picker, CI wiring). |
