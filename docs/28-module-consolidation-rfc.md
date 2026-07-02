# 25 — Module Consolidation & Web RSC Migration — RFC

> **Date:** 2026-07-02 · **Status:** v1.4 — **IN EXECUTION (PRs 1–4 shipped: payments ✅, tax ✅, crm/pipeline ✅, loyalty ✅)** · **Owner:** ERP / Platform
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
| **Loyalty/CRM-B2C** ✅ | `loyalty`, `loyalty-analytics`, `member`, `rewards`, `referrals`, `wheels`, `giftcards`, `gamification` (8) | `loyalty/` core + `loyalty/engagement/` (rewards, referrals, wheels, gamification) + `loyalty/analytics/` + `loyalty/member/` — **SHIPPED (PR #4, 2026-07-02):** `LoyaltyModule` umbrella imports + re-exports the engagement + analytics modules; **`MemberModule` is folder-co-located but stays app-registered** — it *consumes* `LoyaltyModule` + the engagement modules, so pulling it into the umbrella would cycle; **`giftcards` stays separate** as planned. Routes/permissions/tables untouched. | Gift cards carry their own GL liability (2200) + REC-04 reconciliation — a finance instrument, not an engagement toy; keep its boundary. |
| **CRM-B2B/pipeline** ✅ | `crm`, `crm-pipeline`, `pipeline` (3) | `crm/` (accounts + 360) + `crm/pipeline/` — **SHIPPED (PR #3, 2026-07-02):** both pipeline slices co-located under `crm/pipeline/` (filenames distinct), umbrella `CrmModule` imports + re-exports both; app.module standalone entries removed; bi + ai importers re-pointed. Route check passed: `/api/crm`, `/api/crm/pipeline`, `/api/pipeline` — no collision, all unchanged. **Service-level merge evaluated and rejected**: the two are different data models (`pipeline_stages`/`opportunities` stage-board vs `crm_leads`/`crm_opportunities` lead→convert REV-17) — aliasing them to one service would need a data migration + response-shape change, out of scope per §1's behavior-identical rule. | `pipeline` predates `crm-pipeline`; both expose forecast views but over different tables — a folder consolidation, not a semantic one. |
| **Tax** ✅ | `tax`, `tax-docs`, `tax-reports` (3) | `tax/` core + `tax/documents/` + `tax/reports/` — **SHIPPED (PR #2, 2026-07-02):** files git-mv'd keeping names; new `TaxCoreModule` (bare `TaxService`) breaks the `TaxDocsModule`→umbrella cycle; umbrella `TaxModule` imports + re-exports all three, so the six existing `TaxModule` importers keep receiving `TaxService` unchanged; app.module standalone entries removed; routes (`/api/tax*`, `/api/tax-reports/*`), permissions and tables untouched | Statutory-filing snapshots (`tax-docs`) are audit records — folder moves only, never touch their tables. |
| **Payments** ✅ | `payments`, `payments-depth` (2) | merge `payments-depth` into `payments/` — **SHIPPED (PR #1, 2026-07-02):** files moved to `payments/depth/`, `PaymentsModule` imports + re-exports `PaymentsDepthModule`, standalone app.module entry removed; routes/permissions/GL unchanged; no facade needed (zero external importers) | "depth" was a phase name, not a boundary. |

Explicitly **NOT** consolidated: `finance` vs `ledger` (sub-ledger vs GL is a real accounting boundary),
`analytics` vs `bi` vs `demand-ml` (parity-locked files live in `analytics`; keep the lock isolated),
`hcm` vs `payroll` (time/labor vs statutory pay), the `ai*` trio (agent vs config vs doc-ai have different
authority models).

## 3. Sequencing (five PRs, priority order, each independently green)

1. **payments** ✅ (2→1; smallest — SHIPPED, the recipe holds) → 2. **tax** ✅ (3→1; SHIPPED — first cluster that needed
a cycle-breaker core module) → 3. **crm/pipeline** ✅ (3→1; SHIPPED — route check clean, service merge
rejected as non-mechanical) → 4. **loyalty** ✅ (8→4 registrations; SHIPPED — member kept outside the
umbrella to avoid a consumer-cycle, giftcards kept separate by design) → 5. **pos** (largest; last, after
the recipe is boring).

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
| 1.4 | 2026-07-02 | Platform | **Consolidation PR #4 (loyalty) shipped** — `rewards`/`referrals`/`wheels`/`gamification` → `loyalty/engagement/`, `loyalty-analytics` → `loyalty/analytics/`, `member` → `loyalty/member/`; `LoyaltyModule` umbrella imports + re-exports engagement + analytics. `MemberModule` deliberately stays app-registered (it imports `LoyaltyModule` + the engagement modules — umbrella inclusion would cycle); `giftcards` untouched per the finance-boundary rule. Proof: loyalty 30 · line-crm 26 · coalition 21 · pos-p2 33 · cookie-auth 16 · ext 262 · restaurant 162 · crm 48 · basics 215 · compliance 117 · vitest 95 + coverage · ts-debt green; typecheck + build green. Module count 118→113. |
| 1.3 | 2026-07-02 | Platform | **Consolidation PR #3 (crm/pipeline) shipped** — `crm-pipeline` + `pipeline` co-located under `crm/pipeline/` beneath the `CrmModule` umbrella (imports + re-exports both); bi + ai import paths re-pointed; app.module entries removed. Route-collision check clean (`/api/pipeline` vs `/api/crm/pipeline` — distinct, unchanged). The RFC's floated "one service behind both routes" was **rejected**: different tables + semantics ⇒ non-mechanical. Proof: pipeline 12 · crm 48 · bi 32 · projects 114 · ai-actions 14 · basics 215 · compliance 115 · vitest 95 + coverage gate · ts-debt green; typecheck + build green. Module count 120→118. |
| 1.2 | 2026-07-02 | Platform | **Consolidation PR #2 (tax) shipped** — `tax-docs` → `tax/documents/`, `tax-reports` → `tax/reports/`; new `TaxCoreModule` provides/exports `TaxService` so `TaxDocsModule` can depend on it without a cycle through the umbrella; umbrella `TaxModule` imports + re-exports `TaxCoreModule`/`TaxDocsModule`/`TaxReportsModule` (existing importers untouched); external import paths re-pointed (restaurant, pos, pos-fiscal, harness dist imports) — no facades, all importers in-repo. Zero route/permission/table change. Proof: taxdocs 52 · etax 9 · etax-sign 10 · etax-email 4 · promptpay 6 · pos-p0 25 · pos-p1 19 · restaurant 162 · basics 215 · compliance 115 · ts-debt green; typecheck + build green. Module count 121→120 (app.module registrations; TaxCoreModule is internal). |
