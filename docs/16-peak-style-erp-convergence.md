# 16 — PEAK-style ERP Convergence (Finance cycles · action center · page scaffold)

> **Date:** 2026-06-25 · **Status:** v1.0 — IMPLEMENTED · **Owner:** Web / Product
> **Scope:** A **UI/UX** convergence pass that makes the ERP read and work more like
> [PEAK Account](https://www.peakaccount.com/) (the Thai cloud-accounting app users compared us to):
> organise Finance by **business cycle** (รายรับ/รายจ่าย/บัญชี/ธนาคาร), give the landing page a
> **task launcher** ("สิ่งที่ต้องทำวันนี้", à la *PEAK Board*), and standardise the per-screen layout so
> every page looks the same. **Web-only, URL-stable, no API/permission/GL/control change.**
> Builds on the navigation IA restructure in [`15-ui-ux-menu-restructure-plan.md`](./15-ui-ux-menu-restructure-plan.md)
> (groups, favourites/recents, collapsible Settings) — this is the *next* layer, not a redo.

---

## 0. Problem (one paragraph)

After the doc-15 IA restructure the menu *shelving* is good, but three things still made the ERP feel
heavier than PEAK: (1) the **Finance** menu was a flat 10-item list mixing AR, AP, GL, bank and reporting,
where PEAK leads with what you *do* — รายรับ vs รายจ่าย; (2) the **`/finance` page was a single ~470-line
"everything" screen** (KPIs + AR + AP + approvals + collections + aging) instead of focused cycle screens;
(3) **every page hand-rolled its own layout**, so screens lacked PEAK's uniform shell; and (4) the landing
page was a passive metrics board, not a task launcher. None of this is a data or control problem — it is
information architecture and screen composition.

---

## 1. What shipped

### 1.1 Finance menu → PEAK-style cycle sub-sections (`apps/web/src/lib/nav.ts`)
The flat *การเงิน* group is now five collapsible sub-sections (using the existing `NavSubGroup` model from
doc 15 — no new infra). **Every `href` and `perms` is unchanged** — pure shelving:

| Sub-section | Items (routes unchanged) | Opens |
|---|---|---|
| รายรับ–รายจ่าย (AR/AP) | `/finance` | expanded |
| สมุดบัญชี & แยกประเภท | `/accounting`, `/revenue`, `/assets` | expanded |
| ธนาคาร & กระทบยอด | `/bank`, `/reconciliation` | expanded |
| งบ & วิเคราะห์การเงิน | `/financial-health`, `/consolidation` | collapsed |
| ระหว่างบริษัท & สกุลเงิน | `/intercompany`, `/fx` | collapsed |

> AR and AP cannot be split in the *menu* (both live behind the single `/finance` route) — that split is
> done in the **page** (§1.2).

### 1.2 `/finance` page → three cycle tabs (`apps/web/src/app/(internal)/finance/page.tsx`)
The everything-page is split into **ภาพรวม (Overview) · รายรับ (AR) · รายจ่าย (AP)** tabs, reusing the exact
same queries/mutations and the existing `CollectionsSection`/aging/maker-checker pieces (no behaviour
change — `AgingSection` was split into `ArAgingSection`/`ApAgingSection`, `pendingPay` keeps its
`retry:false` self-hide). The route stays `/finance`; the active tab is **deep-linkable** via `?tab=`
(`?tab=receivables` / `?tab=payables`) through a new URL-synced variant of the shared `Tabs` wrapper
(`apps/web/src/components/tabs.tsx`, client-side `history.replaceState` — no router refetch, no
`useSearchParams` Suspense requirement).

### 1.3 Dashboard action center (`apps/web/src/components/today-actions.tsx` + `dashboard/page.tsx`)
A **"สิ่งที่ต้องทำวันนี้"** strip above the KPIs: live, clickable counts for *pending approvals*
(`/api/workflow/my-approvals`), *AP payment requests awaiting approval*
(`/api/finance/ap/payments/pending`), *overdue receivables*
(`/api/finance/ar/collections?overdue_only=1`), and *low stock* (from the existing `/api/dashboard`
payload). **Reuses existing endpoints only.** Each card deep-links into the owning screen/tab; cards whose
gated endpoint returns 403 simply don't render (same self-hide pattern as the finance approval queue) — so
it is role-aware without any new permission logic.

### 1.4 `ModulePage` scaffold (`apps/web/src/components/module-page.tsx`)
A thin **composition** of the blocks pages already hand-assemble — `PageHeader` + KPI grid + toolbar +
`StateView` + body (or URL-synced `Tabs`). Opt-in per page; an un-migrated page is byte-identical. `title`
is **optional** so it can also be used as a headerless **tab/section body** (the page renders one
`PageHeader`, each tab uses `ModulePage` for just toolbar/stats/table); `statsClassName` overrides the KPI
grid when a page has ≠4 cards.

Adopted on: `inventory/page.tsx`, `bank/page.tsx` (`statsClassName="xl:grid-cols-3"`),
`inventory/suppliers/page.tsx`, `inventory/purchase-orders/page.tsx` (`sm:grid-cols-3 xl:grid-cols-3`),
the `revenue/page.tsx` **SchedulesTab** (headerless body — `title` omitted), and `reconciliation/page.tsx`
(minimal: header + layout only, keeping its create-card/period-detail ungated). Each adoption is a **pure
layout swap** — same queries, columns, dialogs, gating and order — verified by an independent per-page
review (0 behavior-parity defects). The standard side effect of adoption is that the **toolbar (search/
filters) renders during loading** instead of only after data arrives, matching the `inventory` reference.

### 1.5 UX friendliness pass (toasts · guided empty states · clearable search · a11y)
A consistency layer that makes everyday use friendlier, built on three new shared primitives —
`lib/notify.ts` (success/error **toasts** over the already-mounted sonner `<Toaster>`),
`components/search-input.tsx` (**clearable** search with a live result `count`), and
`components/form-field.tsx` (label + required marker + hint/error) — plus two upgrades to
`components/data-table.tsx` that lift **all ~67 tables at once**: a rich `emptyState` (icon + title +
description + action) and **keyboard-operable, focus-ringed clickable rows** (Enter/Space, `role="button"`).

Adopted on the high-traffic screens, each a reviewed behavior-preserving change (verified by an independent
per-page review — 0 flagged): **inventory · suppliers · purchase-orders** (SearchInput + a no-match-vs-no-data
empty state with a *ล้างตัวกรอง* action), **finance** (8 mutations → toasts; guided empty states on the AR /
AP / maker-checker / collections tables), and **reconciliation · bank · workflow** (mutation toasts + empty
states). A **second reviewed sweep** extended the same toasts + guided empty states to **procurement ·
RFQs · CRM · projects · fixed-assets · accounting · tax invoices · HCM · planning · pricing · service**
(11/11 behavior-preserving, 0 flagged). A **third reviewed sweep** added admin/users · webhooks ·
scheduled-reports · alerts · marketing · delivery-channels · production · WMS · 3-way-match · replenishment
(10/10, 0 flagged). A **fourth sweep** added payroll · FX · sales-pipeline · manufacturing · stocktake ·
mobile-scan · claims · delivery · payment accounts/terminals · loyalty member-detail/rewards (12/12, 0
flagged). A **fifth sweep** added settings · custom-fields · pos-ops · pos-control · peripherals · pos-fiscal
· print · loyalty missions/campaigns · tax-WHT · profitability · consolidation · intercompany · BoM (14/14, 0
flagged) — bringing the total to **~57 screens** sharing the pattern. Inline `<Msg>` is kept for **in-dialog
field validation**; only action *result* feedback moved to toasts.

---

## 2. Control / compliance impact — **none**

This pass changes **no** API endpoint, route `href`, permission/SoD rule, GL posting, validation/error code,
or workflow. The finance maker-checker (**EXP-06**), collections/dunning (**REV-08/REV-12**), reconciliation
SoD, and all postings are byte-for-byte the same logic, only re-laid-out in the client. Therefore the
**RCM, control matrices, process narratives, and the `tools/cutover` control harnesses are unaffected** and
were intentionally not modified (per the doc-sync policy's "say so explicitly" clause). The API-level **UAT**
cases (`docs/uat/02-order-to-cash`, `03-procure-to-pay`, `05-general-ledger-close`, `09-reports-analytics`)
drive `/api/finance/*` endpoints directly, not the screen, so they remain valid as-is.

**Docs updated:** this file; `docs/15-…` revision row; user-manual `05-finance-ar-ap.md` (tab navigation)
and `00-getting-started.md` (Finance cycle sub-sections + action center).

---

## 3. Verification

- `pnpm --filter @ierp/web typecheck` ✅ · `pnpm --filter @ierp/web build` ✅ (all routes compile incl.
  `/finance`, `/dashboard`, `/inventory`, `/bank`).
- Playwright `e2e/workspace-split.spec.ts` — added two cases: **Finance cycle sub-sections** (header
  visible, advanced sub-section collapsed-by-default) and **`?tab=` deep-link** (opens the matching AR/AP
  tab, writes the param back on switch). *(Runs in CI — local Chromium download is sandbox-blocked.)*
- No finance API/harness touched → `pnpm --filter @ierp/cutover basics`/`compliance` semantics unchanged.

---

## Revision history

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-06-25 | v1.0 (IMPLEMENTED) | Web / Product | Finance menu → 5 PEAK-style cycle sub-sections; `/finance` split into ภาพรวม/รายรับ/รายจ่าย tabs with `?tab=` deep-link (URL-synced `Tabs`); dashboard "สิ่งที่ต้องทำวันนี้" action center (reuses existing endpoints, self-hides by permission); `ModulePage` scaffold adopted on inventory + bank. No href/API/permission/GL/control change. Docs synced (this file, doc 15, user-manual 05 + 00). Verified: web typecheck ✅ + build ✅; 2 new e2e cases (CI). |
| 2026-06-25 | v1.1 (IMPLEMENTED) | Web / Product | `ModulePage.title` made optional (headerless tab/section body). Scaffold rolled out to `inventory/suppliers`, `inventory/purchase-orders`, the `revenue` SchedulesTab, and `reconciliation` (minimal) — each a pure layout swap, independently review-verified (0 behavior-parity defects). Still no API/route/permission/control change. Verified: web typecheck ✅ + build ✅. |
| 2026-06-25 | v1.2 (IMPLEMENTED) | Web / Product | **UX friendliness pass** (§1.5): new shared primitives — `notify` toasts, `SearchInput` (clearable + live count), `FormField` — and `DataTable` rich `emptyState` + keyboard-accessible focus-ringed rows (lifts all ~67 tables). Adopted on inventory/suppliers/purchase-orders/finance/reconciliation/bank/workflow: 8 finance mutations + several others → toasts, guided no-match/no-data empty states, clearable search. All review-verified behavior-preserving (6/6, 0 flagged). No API/route/permission/control change. Verified: web typecheck ✅ + build ✅ (127/127). |
| 2026-06-25 | v1.3 (IMPLEMENTED) | Web / Product | **Second + third friendliness sweeps** (§1.5): same toasts + guided empty states (+ search where hand-rolled) extended to 11 more screens (procurement/RFQs/CRM/projects/assets/accounting/tax-invoices/HCM/planning/pricing/service) and then 10 more (admin-users/webhooks/scheduled-reports/alerts/marketing/channels/production/wms/3-way-match/replenishment) — **~31 screens** total. Each page independently review-verified behavior-preserving (11/11 then 10/10, 0 flagged). No API/route/permission/control change. Verified: web typecheck ✅ + build ✅ (127/127). |
| 2026-06-25 | v1.4 (IMPLEMENTED) | Web / Product | **Fourth friendliness sweep** (§1.5): same toasts + guided empty states extended to 12 more screens (payroll/fx/pipeline/manufacturing/stocktake/mobile-scan/claims/delivery/payments-accounts/payments-terminals/loyalty-member-detail/loyalty-rewards) — **~43 screens** total. Independently review-verified behavior-preserving (12/12, 0 flagged). No API/route/permission/control change. Verified: web typecheck ✅ + build ✅ (127/127). |
| 2026-06-25 | v1.5 (IMPLEMENTED) | Web / Product | **Fifth friendliness sweep** (§1.5): same toasts + guided empty states extended to 14 more screens (settings/custom-fields/pos-ops/pos-control/peripherals/pos-fiscal/print/loyalty-missions/loyalty-campaigns/tax-wht/profitability/consolidation/intercompany/bom) — **~57 screens** total. Independently review-verified behavior-preserving (14/14, 0 flagged). No API/route/permission/control change. Verified: web typecheck ✅ + build ✅ (127/127). |
