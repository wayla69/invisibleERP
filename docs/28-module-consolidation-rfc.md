# 25 — Module Consolidation & Web RSC Migration — RFC

> **Date:** 2026-07-02 · **Status:** v1.2 — **IN EXECUTION (PRs 1–2 shipped: payments ✅, tax ✅)** · **Owner:** ERP / Platform
> **Scope:** Answer the 2026-07 investment audit's two architecture-hygiene findings — **AUD-ARC-10**
> (module sprawl: 122 API modules with overlapping domain ownership) and **AUD-ARC-09** (the web app is
> ~89% `'use client'`; RSC benefits forfeited) — with a target ownership map, a mechanical sequencing that
> cannot change behavior, and the guardrails that make each move provable. Per docs/27 R5-3: **RFC first,
> then mechanical moves**, each its own doc-synced PR gated by the full harness matrix.

---

## 1. Why consolidate at all (and why NOT rewrite)

122 modules is not itself a defect — most are healthy single-purpose slices. The audit's finding is the
**duplicated ownership surface**: five domains where multiple modules co-own one business concept, so a
change fans out over parallel files and copy-paste drift accumulates (the `round4` helper existed 10+
times before docs/27 R1-4). The remedy is **boundary consolidation, not rewriting**: same services, same
routes, same tables — moved under one owning module with facades where the old import paths are load-bearing.

**Non-negotiable discipline (from CLAUDE.md + docs/27):** every move is behavior-identical — API routes,
permissions, error codes, GL postings unchanged; the ~90-harness matrix is the proof, and the `ts-debt`
ratchet + `tenant-idx`/`migration-parity`/census guards must stay green. A move that needs a migration or
a route change is out of scope for this RFC.

## 2. Target ownership map (the five clusters)

| Cluster | Today (modules) | Target | Rationale / risk notes |
|---|---|---|---|
| **POS** | `pos`, `pos-audit`, `pos-control`, `pos-fiscal`, `pos-loyalty-labor`, `pos-scale`, `pos-terminal` (7) | `pos/` core + `pos/` sub-folders (`audit`, `control`, `fiscal`, `labor`, `scale`, `terminal`) under ONE `PosModule` umbrella that re-exports today's Nest modules | Highest traffic domain; move folders + module imports only. `pos-scale`'s realtime bus already extracted to `common/realtime-bus.ts` (R1-3) — the hardest coupling is gone. |
| **Loyalty/CRM-B2C** | `loyalty`, `loyalty-analytics`, `member`, `rewards`, `referrals`, `wheels`, `giftcards`, `gamification` (8) | `loyalty/` core (members, ledger, consents) + `loyalty/engagement/` (rewards, referrals, wheels, gamification); **`giftcards` stays separate** | Gift cards carry their own GL liability (2200) + REC-04 reconciliation — a finance instrument, not an engagement toy; keep its boundary. |
| **CRM-B2B/pipeline** | `crm`, `crm-pipeline`, `pipeline` (3) | `crm/` (accounts + 360) + `crm/pipeline/` (opportunities, win/loss) — fold the older `pipeline` forecaster into `crm/pipeline` | `pipeline` predates `crm-pipeline`; both expose forecast views. Verify no route collision (`/api/pipeline` vs `/api/crm/pipeline`) before folding; keep both routes as aliases for one service. |
| **Tax** ✅ | `tax`, `tax-docs`, `tax-reports` (3) | `tax/` core + `tax/documents/` + `tax/reports/` — **SHIPPED (PR #2, 2026-07-02):** files git-mv'd keeping names; new `TaxCoreModule` (bare `TaxService`) breaks the `TaxDocsModule`→umbrella cycle; umbrella `TaxModule` imports + re-exports all three, so the six existing `TaxModule` importers keep receiving `TaxService` unchanged; app.module standalone entries removed; routes (`/api/tax*`, `/api/tax-reports/*`), permissions and tables untouched | Statutory-filing snapshots (`tax-docs`) are audit records — folder moves only, never touch their tables. |
| **Payments** ✅ | `payments`, `payments-depth` (2) | merge `payments-depth` into `payments/` — **SHIPPED (PR #1, 2026-07-02):** files moved to `payments/depth/`, `PaymentsModule` imports + re-exports `PaymentsDepthModule`, standalone app.module entry removed; routes/permissions/GL unchanged; no facade needed (zero external importers) | "depth" was a phase name, not a boundary. |

Explicitly **NOT** consolidated: `finance` vs `ledger` (sub-ledger vs GL is a real accounting boundary),
`analytics` vs `bi` vs `demand-ml` (parity-locked files live in `analytics`; keep the lock isolated),
`hcm` vs `payroll` (time/labor vs statutory pay), the `ai*` trio (agent vs config vs doc-ai have different
authority models).

## 3. Sequencing (five PRs, priority order, each independently green)

1. **payments** ✅ (2→1; smallest — SHIPPED, the recipe holds) → 2. **tax** ✅ (3→1; SHIPPED — first cluster that needed
a cycle-breaker core module) → 3. **crm/pipeline** (needs the route-alias
check) → 4. **loyalty** → 5. **pos** (largest; last, after the recipe is boring).

**The recipe per PR:** `git mv` folders → update module imports + the Nest `imports:[]` graph → add
re-export facades at the old paths (`modules/pos-audit/index.ts` → `export * from '../pos/audit'`) so
harness/dist imports keep resolving → full matrix + guards green → docs: narrative touched only if a
narrative names a module path; user manual/UAT untouched (no behavior change — state it per policy).

## 4. AUD-ARC-09 — web RSC migration (direction, not a mandate)

229/258 web files are `'use client'`; the App Router's server rendering is mostly forfeited. Full
conversion is NOT the goal (the app is an authenticated, highly interactive dashboard — client components
are often correct); the goal is **server-by-default for new pages + conversion of the read-heavy top 5**:

- Pattern (already shipped once): `/legal/privacy` (docs/27 R0-2) is a pure server component — zero JS
  shipped for a content page. Use it as the template for content/report-like pages.
- Conversion candidates, in order of bundle-weight × read-share: `accounting/page.tsx` (545 lines),
  `eam/page.tsx` (552), `projects/[code]/page.tsx` (605 — split the Gantt into a client island),
  `reports`, `insights` overview tabs. Pattern: server component fetches + renders the shell/tables;
  interactive islands (`'use client'`) only for filters/charts/dialogs.
- Guardrail before converting: cookie-based auth already works server-side (httpOnly `ierp_token` is
  readable by route handlers) — verify per page that data fetching moves to the server without widening
  CORS. Measure with the Playwright e2e smoke + a bundle-size note in the PR.
- Ratchet idea (follow-up): count `'use client'` files in CI like the ts-debt guard — only after the
  first two conversions prove the pattern, so the baseline starts honest.

## 5. Decision requested

Approve §2 target map + §3 sequencing (five mechanical PRs), and §4 as the standing direction for new web
pages. On approval, PR #1 (payments) ships with the full-matrix proof; each later PR only starts after the
previous one merges (the docs/19 lesson — shared files, sequential PRs).

## Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 1.0 | 2026-07-02 | Platform | Initial RFC from the 2026-07 investment-audit findings AUD-ARC-10 (module sprawl → 5-cluster ownership map + mechanical recipe + 5-PR sequencing) and AUD-ARC-09 (RSC direction: server-by-default for new pages, top-5 conversion list, /legal/privacy as the shipped pattern). |
| 1.1 | 2026-07-02 | Platform | **Consolidation PR #1 (payments) shipped** — `payments-depth` folded into `payments/depth/` under the `PaymentsModule` umbrella (import + re-export); app.module registration removed; zero route/permission/GL change. Proof: pos-p2 33 · cash-banking 11 · restaurant 162 · basics 215 · compliance 115 · ts-debt green; typecheck + build green. Module count 122→121. |
| 1.2 | 2026-07-02 | Platform | **Consolidation PR #2 (tax) shipped** — `tax-docs` → `tax/documents/`, `tax-reports` → `tax/reports/`; new `TaxCoreModule` provides/exports `TaxService` so `TaxDocsModule` can depend on it without a cycle through the umbrella; umbrella `TaxModule` imports + re-exports `TaxCoreModule`/`TaxDocsModule`/`TaxReportsModule` (existing importers untouched); external import paths re-pointed (restaurant, pos, pos-fiscal, harness dist imports) — no facades, all importers in-repo. Zero route/permission/table change. Proof: taxdocs 52 · etax 9 · etax-sign 10 · etax-email 4 · promptpay 6 · pos-p0 25 · pos-p1 19 · restaurant 162 · basics 215 · compliance 115 · ts-debt green; typecheck + build green. Module count 121→120 (app.module registrations; TaxCoreModule is internal). |
