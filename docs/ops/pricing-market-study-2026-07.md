# Pricing Market Study — Thailand ERP / POS landscape (2026-07)

> **Status: research input, v1.0 (2026-07-21).** Raw market data supporting the packaging
> proposal in [`docs/53-pricing-packaging-overhaul.md`](../53-pricing-packaging-overhaul.md).
> Compiled from public web sources on **2026-07-21**; every figure carries its source and a
> verification level. Prices change frequently — re-verify before quoting externally.
>
> **FX basis:** all USD conversions at **US$1 = ฿33.64** (TradingEconomics /
> exchange-rates.org, 2026-07-20). EUR figures quoted as published, not converted.
>
> **Verification levels:** ✅ = two independent sources · ◑ = single source · ☎ =
> contact-gated (vendor does not publish; figure unavailable or partial).

## 1. Method

Each competitor was researched via its own pricing page plus at least one corroborating
source (reseller listing, review site, bank-partner page). Where a vendor gates pricing
behind a sales contact, that is recorded rather than estimated. Prices are list prices —
Thai vendors discount routinely (bank partnerships, first-year promos), so treat the list
as the ceiling of what buyers actually pay.

## 2. Band 1 — POS point solutions (per branch / per device)

| Vendor | Package | Price | Notes | Verif. |
|---|---|---|---|---|
| SilomPOS | Free edition | ฿0 | entry funnel | ◑ |
| SilomPOS | from | ฿250/mo | promo entry | ◑ |
| SilomPOS | Starter+ | ฿490/mo · ฿4,900/yr | POS + basic stock + CRM-lite | ◑ |
| Wongnai POS | Quick Service | ฿3,240/yr (≈฿270/mo) | Android | ✅ |
| Wongnai POS | Full Service | ฿4,860/yr (≈฿405/mo) | orders + stock | ✅ |
| Loyverse | Core POS | ฿0 | free core | ✅ |
| Loyverse | Employee mgmt add-on | US$25/store/mo (≈฿840) | annual −16.7% | ✅ |
| Loyverse | Advanced inventory add-on | US$25/store/mo (≈฿840) | per store | ✅ |
| Ocha (Shopee) | Software subscription | ฿799/mo | per device; BYO iPad/tablet | ✅ |
| Ocha | Hardware bundles | ฿17,990–30,990 one-time | incl. 3 mo software | ✅ |
| FoodStory (LMWN) | Quick Service, Stand Alone | ฿15,000/yr (≈฿1,250/mo) | | ◑ |
| FoodStory | Full Service iOS | list ฿20,400/yr (≈฿1,700/mo); promo ฿18,360/yr | K BIZ −10% promos | ◑ |
| StoreHub | Starter / Advanced / Pro | US$39 / 79 / 149/mo (≈฿1,310 / 2,660 / 5,010) | SEA all-in-one; Enterprise custom | ✅ |
| Qashier | Essential / Growth | ☎ annual-billed; THB not published | contact-gated | ☎ |
| Zort (retail/omni) | Online seller | ฿716/mo | order+stock mgmt | ◑ |
| Zort | E-commerce | from ฿2,000/mo | annual −10% | ✅ |

**Band shape:** free → ฿270–800/mo/branch for basic registers → ฿1,250–1,700/mo/branch
for full-service F&B POS (FoodStory, the LMWN flagship) → ฿2,700–5,000/mo for premium
all-in-one (StoreHub Advanced/Pro). The market's pricing axis is **per branch (or per
device)**, billed annually. None of these carry a general ledger, purchasing controls, or
payroll — accounting is always a separate purchase.

## 3. Band 2 — Thai cloud accounting / ERP-lite (per company)

| Vendor | Package | Price | Notes | Verif. |
|---|---|---|---|---|
| FlowAccount | entry | from ≈฿165–199/mo | annual basis | ✅ |
| FlowAccount | Payroll add-on | +฿399/mo | | ◑ |
| PEAK | Pro | ฿1,200/mo | Basic below, Pro+ above; −15% first purchase | ✅ |
| PEAK | Basic / Pro+ | ☎ ladder confirmed, exact prices not in captured sources | | ☎ |
| TRCloud | cloud ERP/accounting | ☎ not published | | ☎ |
| AccRevo | digital accounting platform | ☎ not published | | ☎ |

**Band shape:** ฿165–1,500/mo per company, seat-light, accountant-centric. Strong Thai
tax/WHT/e-Tax localization is table stakes here. No POS, no warehouse operations, no
manufacturing.

## 4. Band 3 — Legacy Thai ERP (perpetual + maintenance)

| Vendor | Model | Price | Notes | Verif. |
|---|---|---|---|---|
| Express | perpetual, Single user | ฿20,330 one-time (incl. VAT) | LAN multi-user higher; installed base is huge | ✅ |
| MAC-5 | perpetual + AMC | ☎ not published | | ☎ |
| WINSpeed (Prosoft) | perpetual + AMC | ☎ not published | | ☎ |

**Band shape:** one-time ฿20k–100k+ licenses, on-premise, accountant-operated. This is
the incumbent our ERP line displaces at modernization time; its "one-time" framing is why
implementation-package pricing (ours: ฿30k/80k/150k) reads familiar to Thai buyers.

## 5. Band 4 — Per-user ERP suites (the ceiling)

| Vendor | Model | Price | Notes | Verif. |
|---|---|---|---|---|
| Odoo Online | per user | ≈US$9–24/user/mo (APAC) | + Thai localization ฿30k–150k one-time via partner | ✅ |
| Zoho One | per employee | US$37–45/employee/mo (all-employee) or US$90–105/user (flex) | | ✅ |
| NetSuite | base + per user | ≈US$999/mo base + US$129–199/user | negotiated; impl. US$25k+ | ✅ |
| SAP Business One | cloud per user | €47 (limited) / €91 (professional) /user/mo; US$110–219 range cited | partner-quoted | ✅ |

**Band shape:** at Thai mid-market scale (10–50 users) these land at ฿10k–150k+/mo plus
five-to-seven-figure implementations. Their axis is **per user** — which punishes exactly
the businesses (many low-wage branch staff) our flat tiers serve well.

## 6. Reference stack costs (what the ICP actually pays today)

Monthly cost of the fragmented stack a prospect runs before us, list prices, ex-hardware.
"Spreadsheet labor" is real but excluded (it strengthens our case further).

### Profile A — F&B chain (full-service POS + accounting)
| Branches | Stack | Est. monthly |
|---|---|---|
| 1 | FoodStory FS ฿1,700 + FlowAccount ฿399 + payroll ฿399 | **≈฿2,500** |
| 3 | 3 × FoodStory ฿5,100 + PEAK Pro ฿1,200 | **≈฿6,300** |
| 10 | 10 × FoodStory ฿17,000 + PEAK Pro+ ≈฿1,500 | **≈฿18,500** |

### Profile B — Retail chain (all-in-one POS + order/stock + accounting)
| Branches | Stack | Est. monthly |
|---|---|---|
| 1 | StoreHub Starter ฿1,310 + FlowAccount ฿399 | **≈฿1,700** |
| 3 | 3 × StoreHub Adv ฿7,980 + Zort ฿2,000 + PEAK ฿1,200 | **≈฿11,200** |
| 10 | 10 × StoreHub Adv ฿26,600 + Zort + PEAK | **≈฿29,800** |

### Profile C — Service / project firm (no POS)
| Size | Stack | Est. monthly |
|---|---|---|
| 5 staff | PEAK Pro ฿1,200 + spreadsheets | **≈฿1,200** |
| 10 staff | Odoo 10 × US$20 ≈ ฿6,700 (+ localization amortized) | **≈฿7,000+** |
| 25 staff | Zoho One 25 × US$37 ≈ ฿31,100 | **≈฿31,000** |

### Read-through vs. our current bundles
- At **3+ branches** our bundles already *undercut* the fragmented stack while adding the
  GL/controls layer no stack component has: Business ฿4,900 vs ≈฿6,300 (F&B, 3 br);
  Professional ฿9,900 vs ≈฿18,500 (F&B, 10 br); Franchise ฿14,900 vs ≈฿29,800 (retail, 10 br).
- At **1 branch, POS-only intent**, we have no answer: the buyer compares Standard ฿2,900
  (bundled with finance they didn't ask for) against FoodStory ฿1,250–1,700 or Wongnai
  ฿405 — and closes the tab. **This is the gap a POS-only SKU fills.**
- For **service firms (ERP-only intent)** the bundle carries an unused register; the sale
  survives on price (฿2,900 beats Zoho/Odoo at ≥5 users) but the message is muddy.
  **An ERP-only SKU fixes the message at the same economics.**
- Per-user suites confirm our structural advantage: at 25 staff, Zoho One costs
  ≈฿31,000/mo vs our flat Business ฿4,900 — flat pricing is the wedge against the ceiling
  band, and per-branch pricing is the fair-fight axis against the floor band.

## 7. Sources

POS band: Shopee/Ocha help center (hardware + ฿799/mo software); Wongnai POS via
wongnai.com POS article + Qashier comparison blog; FoodStory pricing page + LMWN package
article (foodstory.co/pricing, linemanwongnai salesforce-sites); Loyverse loyverse.com/pricing
+ pricingnow/loman guides; StoreHub storehub.com/pricing + Capterra/SoftwareFinder;
SilomPOS silompos.com (ราคา SilomPOS FOOD, free edition pages); Zort zortout.com package
pages; Qashier qashier.com/th (contact-gated).
Accounting band: FlowAccount via software-listing.com + pmaccounting.net reviews; PEAK via
peakaccount.com compare page + UOB BizSmart partner page; TRCloud trcloud.co; AccRevo
accrevo.com (both contact-gated).
Legacy: Express via dhanakom.com reseller price list (฿20,330) + itac.co.th.
Suites: Odoo via oec.sh + odoo.com/pricing + elevanta.cc (Thai localization); NetSuite via
erpresearch.com + brokenrubik.com + techfino.com; Zoho One via zoho.com/one/pricing +
cxtoday/aaxonix; SAP B1 via erpresearch.com + costbench.com.
FX: tradingeconomics.com/thailand/currency + exchange-rates.org (2026-07-20).
