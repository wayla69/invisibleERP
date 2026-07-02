# 25 — Module Consolidation & Web RSC Migration — RFC

> **Date:** 2026-07-02 · **Status:** v1.5 — **DELIVERED (all 5 PRs shipped: payments ✅, tax ✅, crm/pipeline ✅, loyalty ✅, pos ✅ — module registrations 122→108)** · **Owner:** ERP / Platform
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
| **POS** ✅ | `pos`, `pos-audit`, `pos-control`, `pos-fiscal`, `pos-loyalty-labor`, `pos-scale`, `pos-terminal` (7) | `pos/` core + sub-folders (`audit`, `control`, `fiscal`, `labor`, `scale`, `terminal`) — **SHIPPED (PR #5, 2026-07-02):** six satellites git-mv'd under `pos/`, `PosModule` umbrella imports + re-exports all six (no cycle: no satellite imports the umbrella; payments/restaurant/portal/tax-docs import the satellites directly and were re-pointed); app.module 6 registrations removed. `pos/` core files unmoved, so the parity/ai-eval `dist/modules/pos/pos.service` imports were untouched. Routes/permissions/tables unchanged. | Highest traffic domain; move folders + module imports only. `pos-scale`'s realtime bus already extracted to `common/realtime-bus.ts` (R1-3) — the hardest coupling is gone. |
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
umbrella to avoid a consumer-cycle, giftcards kept separate by design) → 5. **pos** ✅ (7→1; SHIPPED —
the recipe was indeed boring by then). **All five clusters delivered 2026-07-02; this RFC is fully executed.**

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
- Conversion candidates, in order of bundle-weight × read-share: `accounting/page.tsx` ✅ **(#1,
  2026-07-02)**, `eam/page.tsx` ✅ **(#2, 2026-07-02 — same pattern: server shell prefetches
  `/api/eam/work-orders`, island unchanged)**, `projects/[code]/page.tsx` ✅ **(#3, 2026-07-02 —
  server shell prefetches detail + EVM, takes the route param as a prop; Gantt/EVM chart stay in the
  island)**, `reports`, `insights` overview tabs. Note: a shell+island conversion is **count-neutral**
  for the `use client` ratchet (the directive moves into the island file) — the ratchet's job is
  preventing growth; the count only drops when a page goes fully server. Pattern: server component fetches +
  renders the shell/tables; interactive islands (`'use client'`) only for filters/charts/dialogs.
- **Shipped seam (conversion #1):** `lib/server-api.ts` — a server-only, cookie-forwarding, GET-only fetch
  helper (`API_PROXY_TARGET → NEXT_PUBLIC_API_URL → localhost` base; null on any failure). `accounting`
  is now a server page that prefetches the default tab's trial balance and hands it to the client island
  as react-query `initialData` — first paint carries data, no client fetch waterfall; mutations and
  filters unchanged in the island. Measured: route chunk 14.2→14.3 kB (islands still ship — the byte win
  comes when report tables move fully server-side), route `○ static → ƒ dynamic`, e2e smoke green.
- Guardrail before converting: cookie-based auth already works server-side (httpOnly `ierp_token` is
  readable by route handlers) — verify per page that data fetching moves to the server without widening
  CORS. Measure with the Playwright e2e smoke + a bundle-size note in the PR.
- ~~Ratchet idea (follow-up)~~ **Ratchet ARMED (2026-07-02, after conversions #1+#2 per this gate):**
  `tools/ci/check-use-client.mjs` in the CI build job counts files whose first statement is
  `'use client'` against `use-client-baseline.json` (**233** — re-based once when PR #320's new
  `/loyalty/recovery` page raced past the freshly-armed guard: its CI predated the ratchet) — any
  increase fails CI; conversions lower the baseline in the same PR.

## 5. Decision requested

Approve §2 target map + §3 sequencing (five mechanical PRs), and §4 as the standing direction for new web
pages. On approval, PR #1 (payments) ships with the full-matrix proof; each later PR only starts after the
previous one merges (the docs/19 lesson — shared files, sequential PRs).

## Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 1.0 | 2026-07-02 | Platform | Initial RFC from the 2026-07 investment-audit findings AUD-ARC-10 (module sprawl → 5-cluster ownership map + mechanical recipe + 5-PR sequencing) and AUD-ARC-09 (RSC direction: server-by-default for new pages, top-5 conversion list, /legal/privacy as the shipped pattern). |
| 1.1 | 2026-07-02 | Platform | **Consolidation PR #1 (payments) shipped** — `payments-depth` folded into `payments/depth/` under the `PaymentsModule` umbrella (import + re-export); app.module registration removed; zero route/permission/GL change. Proof: pos-p2 33 · cash-banking 11 · restaurant 162 · basics 215 · compliance 115 · ts-debt green; typecheck + build green. Module count 122→121. |
| 1.8 | 2026-07-02 | Platform | **RSC conversion #3 (projects/[code]) shipped (§4 / R5-2).** Dynamic-route variant of the pattern: server `page.tsx` awaits `params`, prefetches `/api/projects/:code` + `/evm`, passes `code` down as a prop (island drops `useParams`); Gantt/EVM chart + all mutations unchanged in `project-detail-client.tsx`. Web build + e2e 15/15 green; use-client ratchet correctly flat at 232 (shell+island conversions are count-neutral — noted in §4). |
| 1.7 | 2026-07-02 | Platform | **RSC conversion #2 (eam) shipped + `use client` ratchet armed (§4 / R5-2).** `eam/page.tsx` → server shell prefetching `/api/eam/work-orders` via the conversion-#1 seam; `eam-client.tsx` island unchanged (route 5.63→5.67 kB, static→dynamic; e2e 15/15). New CI guard `check-use-client.mjs` (baseline 232 client-first files, decrease-only) wired next to the ts-debt ratchet — armed now that two conversions prove the pattern, per this section's own gate. |
| 1.6 | 2026-07-02 | Platform | **RSC conversion #1 (accounting) shipped (§4 / R5-2).** New `lib/server-api.ts` server-fetch seam (cookie-forwarded, GET-only, null-on-failure fallback); `accounting/page.tsx` → server shell prefetching the trial balance, `accounting-client.tsx` island unchanged for tabs/forms/mutations. No route/permission/behavior change; web build + e2e smoke green (the one qr-self-order local failure pre-exists on main and passes in CI). Bundle note: route chunk 14.2→14.3 kB, static→dynamic. |
| 1.5 | 2026-07-02 | Platform | **Consolidation PR #5 (pos) shipped — RFC fully executed.** Six POS satellites moved under `pos/` (`audit`/`control`/`fiscal`/`labor`/`scale`/`terminal`); `PosModule` umbrella imports + re-exports all six; importers re-pointed (payments module/service/gateways, portal module/pos.service, restaurant module/dine-in, tax/documents ×2); app.module 6 registrations removed (module count 113→108, from 122 at RFC start). `pos/` core unmoved — harness dist imports untouched. Proof: pos-p0 25 · pos-p1 19 · pos-p2 33 · pos-wiring 20 · pos-pin 10 · pos-discount 20 · payments-gateway 8 · taxdocs 52 · etax 9 · portal-extra 7 · restaurant 162 · realtime-kds 4 · basics 215 · compliance 117 · vitest 95 + coverage · ts-debt green; typecheck + build green. AUD-ARC-10 remediation complete. |
| 1.4 | 2026-07-02 | Platform | **Consolidation PR #4 (loyalty) shipped** — `rewards`/`referrals`/`wheels`/`gamification` → `loyalty/engagement/`, `loyalty-analytics` → `loyalty/analytics/`, `member` → `loyalty/member/`; `LoyaltyModule` umbrella imports + re-exports engagement + analytics. `MemberModule` deliberately stays app-registered (it imports `LoyaltyModule` + the engagement modules — umbrella inclusion would cycle); `giftcards` untouched per the finance-boundary rule. Proof: loyalty 30 · line-crm 26 · coalition 21 · pos-p2 33 · cookie-auth 16 · ext 262 · restaurant 162 · crm 48 · basics 215 · compliance 117 · vitest 95 + coverage · ts-debt green; typecheck + build green. Module count 118→113. |
| 1.3 | 2026-07-02 | Platform | **Consolidation PR #3 (crm/pipeline) shipped** — `crm-pipeline` + `pipeline` co-located under `crm/pipeline/` beneath the `CrmModule` umbrella (imports + re-exports both); bi + ai import paths re-pointed; app.module entries removed. Route-collision check clean (`/api/pipeline` vs `/api/crm/pipeline` — distinct, unchanged). The RFC's floated "one service behind both routes" was **rejected**: different tables + semantics ⇒ non-mechanical. Proof: pipeline 12 · crm 48 · bi 32 · projects 114 · ai-actions 14 · basics 215 · compliance 115 · vitest 95 + coverage gate · ts-debt green; typecheck + build green. Module count 120→118. |
| 1.2 | 2026-07-02 | Platform | **Consolidation PR #2 (tax) shipped** — `tax-docs` → `tax/documents/`, `tax-reports` → `tax/reports/`; new `TaxCoreModule` provides/exports `TaxService` so `TaxDocsModule` can depend on it without a cycle through the umbrella; umbrella `TaxModule` imports + re-exports `TaxCoreModule`/`TaxDocsModule`/`TaxReportsModule` (existing importers untouched); external import paths re-pointed (restaurant, pos, pos-fiscal, harness dist imports) — no facades, all importers in-repo. Zero route/permission/table change. Proof: taxdocs 52 · etax 9 · etax-sign 10 · etax-email 4 · promptpay 6 · pos-p0 25 · pos-p1 19 · restaurant 162 · basics 215 · compliance 115 · ts-debt green; typecheck + build green. Module count 121→120 (app.module registrations; TaxCoreModule is internal). |
