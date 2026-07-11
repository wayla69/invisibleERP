# docs/43 — Posting-override FULL coverage: every GL mapping user-adjustable (PROPOSED)

**Status: PROPOSED (v0.1, 2026-07-11) — awaiting review/comparison before implementation.**
Extends docs/42 (steps 1–4, delivered) from 3 wired posters to **every posting flow in the system**,
plus the platform rails that make tenant re-mapping safe at this scale.

---

## 0. Scope discovered (the numbers)

A full sweep of `apps/api/src/modules/**` found:

- **~90 distinct posting flows** across **~40 service files** still carry hardcoded account literals
  (52 finance/treasury-side + ~40 operations-side; 3 files post nothing).
- **~27 flows** map onto the **27 already-seeded** `posting_event_types` (0158);
  **~45 new event keys** are needed → catalogue grows to **~72 events**.
- **3 flows are already wired** (docs/42): payroll `PAYROLL.*`, FA depreciation `DEPRECIATION.FA`,
  lease run `LEASE.INTEREST/PRINCIPAL` + `DEPRECIATION.ROU`.
- A **second, older override layer already exists and stays**: item-grain determination (GL-21,
  `AccountDeterminationService`, flag `posting_determination`) drives inventory/COGS/VAT/revenue by
  item→category→warehouse. Posting-rules overrides are the **event-grain** complement — the two
  compose as `item-determination ?? posting-rule override ?? literal` where both apply.
- **14 reconciliations/tie-outs pin specific accounts** (see §3) — the central design constraint.

## 1. Definition of done

1. Every posting leg in the system resolves its account as
   **`item-determination ?? tenant posting-rule override ?? registry default`** — or is explicitly
   classified *pinned* with a machine-enforced reason (sub-ledger control, equity plug, cash set).
2. A tenant can re-map any *overridable* leg from `/setup/posting-rules` **without a deploy**, with
   save-time validation, maker-checker approval, and an audit trail.
3. No override configured ⇒ **byte-identical postings** (golden master never re-pins in this series).
4. A runtime-created account (docs/42 UI) is **fully report-correct**: cash-flow bucket and
   current/non-current classification live on the account row, not only in code constants.
5. Every recon/tie-out either **widens** to the override account-set (like `inventoryAccountSet`)
   or the role is pinned — no recon can silently break because of a re-map.

## 2. Design decisions (the part to challenge in review)

- **D1 — Keep `override ?? default`, do NOT retrofit `PostingService.post()`.** The dormant engine
  builds legs from DB rules; our flows have heavy *conditional* legs (sign-dependent variance, FX
  gain/loss direction, optional VAT/retention/WHT). Moving leg construction into data would be a
  behavioral rewrite with golden-master risk. We re-map **accounts only**; leg structure stays in
  code. `PostingService.post/preview` remains a preview/simulation surface.
- **D2 — A single in-code EVENT REGISTRY as source of truth** (`ledger/posting-events.ts`):
  `{ event, roles: { role: { side, default, tier, description } } }`. Posting sites import their
  default from the registry (kills literal-vs-seed drift); the event-type seed migration is
  generated from it; boot-assert: every default ∈ canonical COA (mirrors `assertTemplatesSubsetOf`).
- **D3 — Tenant rows only** (docs/42 rule kept): NULL-tenant seeded rules are display defaults and
  never shadow code.
- **D4 — Three-tier override policy per ROLE** (enforced at save time):
  - **Tier A `free`** — pure P&L legs + presentation liabilities with no sub-ledger
    (expenses, incomes, variances, rounding, service charge, deferred/membership revenue…).
  - **Tier B `widen`** — legs a reconciliation reads, where the recon can sum an account SET
    (templates already in-tree: `inventoryAccountSet`, PP30 `vatAccounts`). Overridable **only
    after** that recon is widened in the same PR.
  - **Tier C `pinned`** — sub-ledger control accounts and structural legs:
    AR 1100 · AP 2000 · INV 1200 · gift 2200 · loyalty 2250 · unapplied 2220 · advances 1180 ·
    retention 1170/2440 · lessor 1610 · lease 2600 · FA 1500/1590 · IC 1150/2150 ·
    equity plugs 3000/3100/3200 · the CASH set 1000/1010/1015/1020 (bank/petty GL are already
    per-row configurable on `bank_accounts`/fund). Save-time reject: `OVERRIDE_ROLE_PINNED`.
- **D5 — Rule-change governance (new control, proposed GL-24).** `upsertRule` today validates
  nothing and applies immediately. Add: (a) account exists + postable (`INVALID_POSTING_ACCOUNT`,
  reusing the docs/42 guard), (b) role ∈ registry + side matches, (c) tier check, (d)
  **maker-checker**: a rule change lands `PendingApproval` and takes effect only when a different
  user approves (mirrors GL-05/BUD-01), (e) append-only audit rows. Posting-rule changes re-route
  financial statements — SOX-wise they are config changes to an application control.
- **D6 — Per-tenant cache** for override maps (copy `ModuleConfigService`'s load-once/bust-on-write
  + `TtlCache`): one cached `Map<event, Map<role, account>>` per tenant; `upsertRule`/approve busts
  it. Batch API `postingOverridesMany(events[])` so a POS sale does ≤1 read even uncached.
- **D7 — Reporting completeness for custom accounts**: nullable `accounts.cf_bucket`, `cf_label`,
  `is_current` columns; single choke point `aggregateByType` (already left-joins `accounts`)
  propagates them; `cashFlowStatement`/`cashFlowDirect`/finance-metrics use
  `constant ?? column ?? type/numbering fallback`. COA create/edit dialogs (docs/42) gain the two
  dropdowns; `CF_CLASSIFY`/`finance-metrics-constants` become seed/fallback, not the only truth.
- **D8 — Shared keys across modules**: one event key per business meaning, wherever it posts —
  `TILL.VARIANCE` (payments `closeTill` + hub `ingestTill`), `APPAY.WHT` (AP payment + subcontract
  valuation 2361), `SALE.*` roles shared by dine-in / portal POS / channel / CPQ / house accounts.

## 3. Tie-out constraint map (what forces the tiers)

| Recon / control | Pins | Today | Plan |
|---|---|---|---|
| Inventory sub-ledger (INV-06/GL-14) | 1200 set | **already widened** (`inventoryAccountSet`) | template for others |
| PP30 VAT tie (TAX-04/05) | 2100 + tax-code accts | **already widened** (`vatAccounts`) | add posting-rule VAT overrides to the set |
| REC-04 / Close-cockpit (GL-22) | 1100/2000/1200/2200/2400 | hard-pinned `glBal('…')` | Tier C for control roles; 2400 → Tier B (widen `reconcileControls` to a set) |
| Payroll liabilities (PAY-02) | 2350/2360/2370 | schedule hard-pins; **posting already overridable (docs/42)** — latent mismatch | PR-7 widens the schedule to the override set (closes the docs/42 gap) |
| Tips (TIP-01) | 2300 | hard-pinned + live over-distribute guard | Tier C both legs (collect+payout) |
| Unapplied receipts (REV-21) | 2220 | hard-pinned | Tier C |
| Retention sub-ledger | 1170/2440 | const maps | Tier C (pure control reclass — excluded entirely) |
| Lessor net investment (LSE-02) | 1610 | hard-pinned recon | Tier C |
| Lease liability (LSE-01) | 2600 | hard-pinned recon | Tier C |
| FA register (FA-01/02) | 1500/1590 | register↔GL tie | Tier C; only P&L legs of asset events overridable |
| IC elimination (CON-*) | 1150/2150 | must net to zero | Tier C |
| Loyalty watermark | 2250 | accrual tie | Tier C (5700 expense = Tier A) |
| Cash-flow / liquidity | CASH set 1000/1010/1015/1020 | code constants | Tier C + D7 widens classification for new accounts |
| Bank / petty GL | per-row `gl_account_code` | already configurable | keep — out of posting-rules scope |

## 4. Event/role matrix (full appendix)

Legend: **(E)** existing key · **(N)** new key · tier per role. Defaults shown are today's literals.

### 4.1 Finance & treasury
| Event | Roles (tier) | Flows (file) |
|---|---|---|
| ADVANCE.ISSUE (E) | advance_asset 1180 (C) · cash 1000 (C) | finance `ADV`; petty-cash advance |
| ADVANCE.SETTLE (E) | expense 5100 (A — already dto-overridable) · advance 1180 (C) | finance `ADV-STL`; petty `PEX-STL` |
| BADDEBT.WRITEOFF (E) | bad_debt_exp 5720 (A) · ar_control 1100 (C) | finance `AR-WRITEOFF` |
| APPAY.WHT (N) | wht_payable 2361 (B — widen PND3/53 report set) | finance `PAY-AP`; subcontracts `PRJ-SUBVAL` |
| APPAY.DISCOUNT (N) | discount_income 4600 (A — per-policy override exists; registry default) | ap-payment-run `AP-DISC` |
| RCVAT.SELF (N) | input_vat 1300 (B — PP30/36 set) · pp36_payable 2120 (B) | finance AP reverse-charge |
| FX.UNREALIZED (E) | fx_gain_loss 5400 (A); control deltas 1100/2000/1010 (C) | fx `FXREVAL`(+`-REV`) |
| FX.REALIZED (E) | fx_gain_loss 5410 (A) | payments-depth `HOUSE-SETTLE` |
| BANK.INTEREST (N) / BANK.FEE (N) | interest_income 4000 (A) · fee_expense 5100 (A) | bank `BANKADJ` |
| PETTY.TOPUP (N) / PETTY.EXPENSE (N) | fund GL per-fund (keep) · expense 5100 (A) | petty-cash |
| REVENUE.DEFER (N) / REVENUE.RECOGNIZE (N) | deferred 2400 (B — REC-04 widen) · revenue per-schedule (keep) | revenue `DEFREV`/`REVREC` |
| MEMBERSHIP.DEFER (N) / MEMBERSHIP.RECOGNIZE (N) | deferred 2410 (A) · revenue 4300 (A) | loyalty membership `VIP`/`VIP-REC` |
| LOYALTY.ACCRUE (N) | loyalty_expense 5700 (A) · liability 2250 (C) | ledger `LOYALTY` |
| GIFTCARD.ISSUE (E) | liability 2200 (C) · cash 1000 (C) | gift-card `GCISSUE` |
| RETURN.AR (E) | revenue_reversal 4000 (A) · vat_reversal 2100 (B) · credit leg 1000/2200 (C) | returns `RTN` |
| RETURN.STOCK (E) | cogs_reversal 5300 (A) · inventory 1200 (C) | returns `RTN-COGS` |
| SALE.VAT (E) | vat_output 2100 (B — PP30 set, partially done) | every sale/CN/DN path |
| SBT.TAX (N) | sbt_expense 5840 (A) · sbt_payable 2130 (B — ภ.ธ.40 set) | realestate `RE-TRANSFER` |
| CN/DN adjustments | reuse SALE.FOOD/SALE.VAT roles | tax-invoice `issueAdjustment` |

### 4.2 POS / restaurant / payments (hot paths)
| Event | Roles (tier) | Flows |
|---|---|---|
| SALE.FOOD (E) | revenue 4000 (A — composes under item-determination) | dine-in, portal POS, split, channel, CPQ `CPQ-WIN`, house `HOUSE-CHARGE` |
| SVC.CHARGE (N) | service_charge_income 4400 (A) | dine-in / portal POS |
| POS.ROUNDING (N) | rounding 4900 (A) | dine-in / portal POS |
| SALE.DELIVERY (N) | delivery_income 4100 (A) | channel-order `POS-DELIV` |
| TIP.COLLECT (N) / TIP.PAYOUT (N) | tips_payable 2300 (C both) — events exist for visibility only | payments `POS_TIP`; tip.service |
| TILL.VARIANCE (N) | cash_over_short 5830 (A) | payments `closeTill` + hub `ingestTill` (shared) |
| TILL.CASHMOV (N) | expense 5100 (A) | payments `recordCashMovement` |
| DEPOSIT.TAKE/APPLY/REFUND (N) | deposit_liability 2210 (A) · revenue 4000 (A) · vat 2100 (B) | payments-depth |
| SURCHARGE.INCOME (N) | surcharge_income 4500 (A) | payments-depth |
| COSTING.ISSUE (E) | cogs 5000/5300 (A — composes under item-determination) · inventory 1200 (C) | POS COGS ×3, costing, inventory issue |

### 4.3 Assets / leases
| Event | Roles (tier) | Flows |
|---|---|---|
| ASSET.ACQUIRE (N) | funding 2000/1000 (C) · gross 1500 (C) — **register event, no free roles**; ambition = per-asset-category accounts (FA categories already carry defaults — prefer wiring `asset_categories` accounts over posting-rules here) | assets `acquire`/CIP settle |
| ASSET.DISPOSE (N) | gain_loss 1510 (A); 1500/1590/1000 (C) | assets `dispose` |
| ASSET.REVALUE (N) | impairment_loss 5820 (A) · surplus 3200 (C) | assets `revalue` |
| ASSET.CIP_COST (N) | cip 1520 (C) · funding (C) | assets `addCipCost` |
| LEASE.COMMENCE (N) | rou 1600 (C) · liability 2600 (C) — visibility only | leases `createLease` |
| LEASE.MODIFY (N) | remeasure_gain 1510 (A); 1600/2600 (C) | leases `modifyLease` |
| LEASE.LESSOR_COMMENCE (N) | selling_pl 1510 (A); 1610/1500 (C) | lessor |
| LEASE.LESSOR_FINANCE (N) | interest_income 4600 (A); 1610/1000 (C) | lessor run |
| LEASE.LESSOR_OPERATING (N) | rental_income 4610 (A) · dep 5200/1590 (A/C) | lessor run |
| PAYROLL.REMIT (N) | liability leg (B — same widened set as PAY-02) · cash (C) | payroll `remitLiability` |
| PAYROLL.GROSS net_pay_cash role (add) | 1000 (C — visibility) | payroll cash leg |
| PREPAID.CAPITALIZE / PREPAID.AMORTIZE (N) | prepaid 1280 (A — per-schedule exists) · expense 5100 (A) | ledger-recurring |

### 4.4 Projects / construction / real estate / IC
| Event | Roles (tier) | Flows |
|---|---|---|
| PROJECT.COST (E) | project_wip 1260 (C) · applied 2390 (A) · **project_cogs 5800 (A, new role)** | projects `logCost`, subcontracts, inventory issue-to-project |
| PROJECT.REVENUE (E) | project_revenue 4200 (A) · project_cogs 5800 (A) · vat 2100 (B); 1100/1260/1265/2410 (C) | projects `bill`/`recognizePoc`, progress-billing, realestate transfer |
| PROJECT.BILLING (N) | contract_asset 1265 (C) · billings_in_excess 2410 (B) | projects POC invoice |
| REALESTATE.BOOK/CONTRACT/INSTALL (N) | deposit 2210 (A) · contract_liability 2410 (B) | realestate |
| IC.TRANSACTION (E) | recovery/expense legs per category MAP (A) · 1150/2150 (C) | intercompany create |
| IC.SETTLE (N) | 1150/2150/1000 (C — visibility only) | intercompany settle |
| MFG.WO_ISSUE (N) | wip 1250 (C) · applied 2380 (A) · inventory (C) | manufacturing |
| MFG.WO_COMPLETE (N) | fg 1210 (C) · variance 5810 (A) | manufacturing |
| QA.SCRAP (N) | scrap_loss 5810 (A) · source credit (C, ref-type-resolved) | mfg-depth quality |
| INV.ADJUST (N) | adjustment 5810 (A — composes with warehouse determination) | inventory adjust |
| WASTE.WRITEOFF (N) | waste_loss 5810 (A) · inventory 1200 (C) | waste |
| GR.AP (E) | ap_control 2000 (C) — inventory leg already determination-resolved | inventory receive |

**Excluded (no override, documented):** AR cash application ×4, AR/AP netting, plain receipts
`RCP`/`SUB-PAY`, retention release, opening balance 3000, year-end close 3100, reval-surplus recycle
3200, consolidation NCI/CTA (not JEs), bank deposit reclass.

## 5. PR series (each PR = code + docs + UAT + harness per CLAUDE.md)

| PR | Scope | Key risks / verification |
|---|---|---|
| **PR-1 Rails** | `posting-events.ts` registry (all ~72 events, roles/tiers/defaults) + boot assert; ONE migration seeding new `posting_event_types`; `upsertRule` validation (postable / role / side / tier) + **maker-checker + audit** (control GL-24 in RCM → census bump); per-tenant cache + `postingOverridesMany`; deactivate endpoint | golden untouched; unit tests on validation matrix; compliance ToE for GL-24 SoD |
| **PR-2 Finance/treasury** | wire §4.1 (finance, ap-run, bank, petty, fx, returns, giftcards, loyalty, membership, revenue, tax-invoice CN/DN) | `basics`/`taxdocs`/`worldclass` + new override ToEs; golden unchanged |
| **PR-3 Assets & leases** | §4.3 (asset dispose/revalue P&L legs; lessor income legs; lease modify; payroll remit + net_pay role; prepaid) — prefer `asset_categories` accounts for acquire/dep defaults | `basics` FA/lease blocks; golden unchanged |
| **PR-4 Projects/RE/IC** | §4.4 projects, progress-billing, subcontracts, realestate, intercompany | `projects` (44), `basics`; **golden touches projects service — verify no re-pin** |
| **PR-5 Manufacturing & inventory** | MFG.WO_*, QA.SCRAP, INV.ADJUST, WASTE, GR.AP leg, COSTING roles | `manufacturing`/`costing`/`wms` harnesses + inventory reconcile stays green |
| **PR-6 POS hot paths** | dine-in / portal / channel / split, tips, till, deposits, surcharge (batch + cached reads; hub-sync shares keys) | `restaurant` 182, `splitbill`, `tips`, `e2e`, hub; latency check on cached path |
| **PR-7 Tie-out widening** | PAY-02 schedule set (fixes the docs/42 latent gap), REC-04 2400 set, PND3/53 2361 set, ภ.ธ.40 2130 set; flip those roles Tier B→active | `payroll`/`compliance` recon ToEs: override + schedule still `reconciled:true` |
| **PR-8 Reporting completeness** | `accounts.cf_bucket/cf_label/is_current` (migration) + `aggregateByType`/SCF/metrics fallback chain + COA dialogs + optional masterdata IO for `accounts`+`posting_rules` | `basics` SCF/metrics; `analytics` parity; census |
| **PR-9 UI overhaul** | `/setup/posting-rules`: per-event role grid showing **default vs override**, COA picker (validated), pending-approval queue, deactivate, auto-role preview; Thai i18n | web build + ratchets (extend existing island); mobile spec |

Sequencing: PR-1 blocks all; PR-2..6 independent after it; PR-7 after 2–3; PR-8/9 anytime after 1.

## 6. Explicit non-goals

- No leg-construction-from-DB (D1). No override of pinned control accounts (D4). No per-branch/
  per-dimension rule conditions in this series (schema supports `condition`; UI/consumption later).
- Consolidation CTA/NCI accounts stay code-level (group presentation, not tenant JEs).

## 7. Risks

| Risk | Mitigation |
|---|---|
| Override breaks a recon we missed | Tier gate at save + §3 map + per-PR recon ToEs |
| Registry vs literal drift | defaults imported from registry; boot assert ⊆ COA |
| POS latency | per-tenant cache, bust-on-approve, batch resolve, PR-6 latency assertion |
| Migration number collisions (active main) | one seed migration per PR max; renumber per CLAUDE.md |
| RCM census churn (GL-24) | single census bump in PR-1 |
| Harness fan-out (~110 scripts) | per-PR endpoint grep per mantra #11 before push |

## 8. Open questions for review

1. GL-24 maker-checker on posting rules: hard requirement from day one, or ship audit-only first?
2. Should `ASSET.ACQUIRE`/`DEPRECIATION.FA` defaults move to `asset_categories` accounts (per-category
   grain, mirrors item-determination) instead of tenant-wide posting rules? (plan prefers this)
3. Widen REC-04 to sets in PR-7, or keep 2400/2361/2130 pinned permanently?
4. Masterdata bulk IO for `posting_rules` (xlsx import of a full mapping) — in PR-8 or dropped?

## Revision history

| Date | Version | Change |
|---|---|---|
| 2026-07-11 | 0.1 | Initial full-coverage plan (inventory: ~90 flows / ~45 new events; tier policy; 9-PR series). |
