# Pricing & Module Configurator (prototype)

A single-file, artifact-ready React component (`PricingConfigurator.tsx`) that prototypes a
simplified buying experience for the Invisible ERP/POS platform: five tiered "Starter Packs",
à-la-carte "Advanced Add-ons", a Monthly/Annual billing toggle, and a live total-cost calculator.

**Status:** marketing/UX prototype only. It is NOT wired into `apps/web`, exposes no routes, and
changes no application behavior — so it has no process-narrative / user-manual / UAT doc-sync
surface and does not touch the `use-client` or other CI ratchets.

## How to use

- **Claude Artifact:** paste the file's contents into a React artifact as-is (imports only
  `react` and `lucide-react`; styling is Tailwind utility classes).
- **In an app:** drop the file into any React 18/19 + Tailwind (v3/v4) + `lucide-react` project
  and render the default export. No props, no external state.

## Content grounding (what's real vs. indicative)

| Element | Source |
|---|---|
| Essential ฿2,900 / Growth ฿4,900 / Scale ฿9,900 per month | Real seeded plans `starter` (Standard) / `business` / `pro` in `apps/api/src/modules/billing/billing.service.ts` `SEED_PLANS` |
| Annual = 10 × monthly ("2 months free", ≈17% off) | Same source: every seeded plan's `priceYearly` = 10 × `priceMonthly` |
| Franchise ฿14,900 · Enterprise "starting at" ฿19,900 | **Indicative** — no seeded plan; Enterprise is custom-priced (`priceMonthly: '0'`, `custom: true`) |
| Module names (KDS, QR ordering, channels, loyalty, consolidation, SSO, e-Tax, …) | Real modules; labels follow `packages/shared/src/entitlements.ts` suite labels |
| "23 Segregation-of-Duty (SoD) Rules" | Real count of `SOD_RULES` (R01–R23) in `packages/shared/src/permissions.ts` — the original brief said 26; corrected to stay truthful |
| Add-on prices (฿1,500 / ฿990 / ฿1,290 / ฿2,900) | **Indicative** — the underlying modules exist (procurement/sourcing, inbound webhooks, CRM audience export, developer sandbox) but are not separately priced today |

## Design notes

- Palette: slate neutrals, indigo primary/selection, emerald for savings — professional SaaS look.
- Lucide icon chips distinguish **POS / front-of-house** modules (indigo) from **back-office ERP**
  modules (slate); a legend sits above the tier grid.
- Tier grid: 1 → 2 → 3 → 5 columns (`sm` / `lg` / `xl`); Growth carries the "Most popular" pill.
- Summary: sticky right-hand card on desktop (`lg:sticky top-6`), fixed expandable bottom bar on
  mobile (page reserves `pb-44` below `lg` so content never hides behind it).
- All money math flows from one constant (`ANNUAL_MONTHS = 10`) and one helper (`perMonth`), so
  the discount policy is changed in a single place.

## Preview build (optional)

The interactive preview used for review was produced locally (not committed) by bundling the
component with esbuild (React resolved from `apps/web/node_modules`) and generating the CSS with
the Tailwind v4 CLI scanning this file, then inlining both into a single self-contained HTML page.
