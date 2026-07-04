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
flagged). A **sixth (final mop-up) sweep** covered the remaining 22 table-bearing screens — read-only
report/viewers (restaurant-analytics, SoD, lots, food-cost, tax-reports, BI, audit, POS-home, loyalty-members,
item-detail, POS) got guided empty states, and production-plan/menu/goods-issue/CPQ/costing/buffet/branches/
saved-views/images/campaigns/AI-actions also got toasts (22/22, 0 flagged) — bringing the total to **~79
screens**, essentially the whole internal app. Inline `<Msg>` is kept for **in-dialog field validation**;
only action *result* feedback moved to toasts.

### 1.6 First-run guidance on the dashboard (`apps/web/src/components/getting-started.tsx`)
A **"เริ่มต้นใช้งาน" (Getting started)** panel at the top of the ERP home (`dashboard/page.tsx`), above the
action launcher. It surfaces the **already-existing** onboarding checklist (`GET /api/onboarding`) right
where a new tenant lands — a completion bar plus each *incomplete* step as a row that **deep-links to the
screen where it gets done** (`branding→/setup`, `theme→/theme`, `locale→/localization`,
`first_product→/master-data`, `first_sale→/pos/register`, `invite_user→/admin/users`) and can be ticked
off in place (`POST /api/onboarding/steps/:key/complete`). This unifies the previously-buried `/onboarding`
+ per-task screens into the landing page (the "guided first-run" gap called out for the Paypers-style
usability pass).

**Self-hiding, no new perms:** the query runs `retry:false`, so a user without onboarding access (403 →
`data` undefined) sees nothing — same pattern as `today-actions`. The panel also renders nothing once
`percent >= 100` or no step is pending, so it never nags an established tenant. **Reuses existing endpoints
only** — no API/route/permission/GL/control change.

### 1.7 Global "spotlight" search in the ⌘K palette (`apps/api/src/modules/search/search.module.ts` + `command-palette.tsx`)
The command palette was **navigation-only** (jump to a screen). It now also **finds records** — the
Paypers/PEAK "type a name, open the thing" experience. A new read-only `GET /api/search?q=` searches the
**customer / vendor / item** masters (ILIKE over name/code/contact/phone/email/description, ≤6 per type) and
returns `{type, id, label, sublabel, href}` rows; the palette fetches them (debounced 250 ms, controlled
`CommandInput`) and renders a **ข้อมูล (Records)** group above the nav groups, each row deep-linking to the
record (items → `/inventory/{itemId}` detail; customers/vendors → their list screen).

**Security:** tenant isolation is the automatic per-request RLS tx (no manual `tenant_id`). **Per-entity
permission is enforced in-service** against the caller's *expanded* permissions (customer→`crm|exec|ar`,
vendor→`procurement|warehouse|creditors|exec`, item→`warehouse|dashboard|planner`), so a user only sees
result types they could already open — the endpoint never widens access. Additive + read-only ⇒ no
migration, no GL, no new control. Verified end-to-end by the `e2e` cutover harness (real Nest app + PGlite +
RLS proxy): item search returns the seeded item and deep-links `/inventory/A`, the `q<2` guard returns empty.

**Depth (v1.12):** the endpoint was refactored to a **config-driven `ENTITIES` table** and now covers **7
types** — the three masters plus the day-to-day **documents**: `sale` (`cust_pos_sales.sale_no`),
`ar_invoice` (`ar_invoices.invoice_no|order_no`), `tax_invoice` (`tax_invoices.doc_no|buyer_name|source_ref`)
and `purchase_order` (`purchase_orders.po_no|vendor_name`), each with its own mirrored `@Permissions` gate.
Since none of these documents has a per-record detail page, the deep-link opens the owning **list carrying
`?q={id}`** and the list **seeds its search box from that param** (`lib/url.ts` `readQueryParam`, wired into
`/inventory/purchase-orders` and `/pos`) so the record is visible immediately. The palette shows a per-type
label chip + icon (i18n `search.type.*`). Harness extended (sale + PO by number and by vendor name → 22/22).

**Depth (v1.14):** five more types — **`member`** (`pos_members`), **`project`** (`projects`),
**`requisition`** (`purchase_requests`), **`ap_invoice`** (`ap_transactions`) and **`employee`**
(`employees`) — bringing the total to **12**, each with its mirrored `@Permissions` gate. `member` and
`project` join `item` as the **real per-record detail deep-links** (`/loyalty/members/{numeric id}` — the
Member 360 page keys on the numeric id, not the code — and `/projects/{code}`); the others open their list.
Harness seeds a member and asserts the numeric-id deep-link (→ 23/23).

### 1.8 Global floating AI helper (`apps/web/src/components/assistant-widget.tsx` + `hooks/use-assistant-chat.ts`)
The AI assistant was a **page you had to navigate to** (`/assistant`). It's now also an **always-available
floating button** in the corner of the internal shell — contextual help from any screen, the friendly-SaaS
"help is always one click away" pattern. The chat state + SSE streaming was extracted verbatim into a shared
`useAssistantChat` hook consumed by **both** the full page (now a thin UI over the hook) and the widget, so
there's one implementation. The widget is mounted + **permission-gated** by `app-shell` (`ai_chat|dashboard`,
via `hasPerm`) so it self-hides for users who can't use the assistant, and an ⤢ button opens the full page.
Reuses the existing `GET /api/chat/stream` — no API/route/permission/GL/control change.

### 1.9 Lighter data entry — inline validation on the company-profile form (`apps/web/src/app/(internal)/setup/page.tsx`)
The §1.5 friendliness pass moved *result* feedback to toasts but left several long field-grids on raw
`<Label>+<Input>` with **post-save** error strings. This starts closing that gap on a representative
high-value form (`/setup`): every field now uses the shared **`FormField`** (label + hint + inline error),
formats are **validated as you type** (tax ID 13 digits, branch/postal 5 digits, PromptPay 10/13, email,
VAT rate 0–1), **Save is blocked** until valid, and success/failure are **toasts** (`notify`) instead of the
inline `<Msg>` banner. Same `PATCH /api/tenant/profile` call and payload — pure client validation + a11y
(`aria-invalid`, `role="alert"`). No API/route/permission/GL/control change.

**Depth (v1.13):** the same pattern was rolled out to the heaviest **line-item** forms — procurement
`PrForm`/`PoForm`/`GrForm` (`components/procurement-forms.tsx`) and the BOM `Library` (`bom/page.tsx`). They
now show **per-field and per-line** inline errors (only after a submit attempt; a line validates once it has
an Item ID so the trailing empty row never nags): PR/PO/GR require a submittable line (Item ID + qty > 0),
PO requires a vendor (name or id) and a non-negative unit price, GR requires a PO number, BOM requires
code + name and non-negative price/labor with per-line qty/conv-factor > 0. Result feedback moved to
toasts. **Payloads/endpoints unchanged** — the submit button no longer just sits `disabled`; it validates on
click and points the user at the exact bad field. Pure client validation + a11y.

**Depth II (v1.15):** the **double-entry ledger** forms — manual Journal (`accounting-client.tsx`),
Recurring journal + Prepaid (`gl-schedules-client.tsx`) — now validate inline. A shared
`lib/journal-validation.ts` (`jeLineError`/`jeFormError`) enforces the accounting invariants **with a
message**: each posting line needs an account and exactly one non-negative side (no line carrying both
debit and credit), at least two posting lines, a positive total, and **debits = credits** — and when it's
off it says *which side is over and by how much* (e.g. "เครดิตเกิน ฿50.00") instead of a mute "ยังไม่สมดุล"
badge. Prepaid also validates name/total(>0)/months(int≥1). Submit validates on click (no longer just
disabled). Same POST bodies to `/api/ledger/journal|recurring|prepaid`. The helper's branch logic was
behaviourally checked (balanced/unbalanced/single-line/both-sides/negative/trailing-empty).

### 1.10 i18n rollout — Phase 1: the ERP dashboard surface (`lib/messages.ts` + dashboard/today-actions/getting-started)
The i18n framework (`useLang`/`t()`, 5 locales, server-synced) was **built but barely consumed** — only the
chrome called `t()`, so the "English" toggle left every page hardcoded Thai. This starts the rollout on the
**first surface a user sees**: the ERP home. `dash.*`, `today.*`, `getstarted.*` message keys (th+en) were
added and `t()` wired through **`dashboard/page.tsx`**, **`today-actions.tsx`** and **`getting-started.tsx`**,
so flipping the language toggle now renders the whole landing surface (header, KPI cards, action launcher,
first-run panel, chart/table headings, empty states) in English. Onboarding step labels use the API's
existing `label`/`label_en`. (Currency/`thaiDate` number formatting is unchanged — a separate concern.) This
is the **template** for the remaining pages: add keys → replace literals with `t()`. Pure presentation — no
API/route/permission/GL/control change.

**Phase 2 (v1.16):** the **POS home** (`pos-home/page.tsx`) — the POS operator's landing surface, parallel
to the ERP dashboard — and the **Onboarding** page (`onboarding/page.tsx`, completing the first-run pair with
`getting-started`) are now fully `t()`-wired (`pos.*`/`onb.*` keys, reusing `dash.*` where shared). Onboarding
step + industry-pack labels use the API's `label`/`label_en`. A key-coverage check confirms every referenced
key exists (a missing key would render as the raw string). Same additive, presentation-only pattern.

**Phase 3 (v1.17):** the **Finance** cycle page (`finance/page.tsx`, ~540 lines — the biggest single-page
i18n so far) is fully `t()`-wired across all three tabs (Overview KPIs + revenue/aging charts; AR list +
receipt + write-off + collections/dunning; AP list + vendor-bill + pay-request + AP-aging export) — ~90
`fin.*` keys covering headers, dialogs, table columns, empty states, dunning stages, VAT/channel selects,
and the **interpolated toasts** (receipt/write-off/pay-request/dunning/sweep). Module-level constants
(`AGING_BUCKETS`, the dunning stage labels) were refactored to key-based lookup resolved with `t()` at render.
Key-coverage checked; only developer comments remain Thai. Same presentation-only pattern.

**Phase 4 (v1.18):** the **Accounting / GL** workspace (`accounting-client.tsx`, ~913 lines — the largest
page yet, 12 tab components: trial balance, GL detail, subledger tie-out, chart of accounts + edit dialog,
manual journal, JE approval queue, income statement, balance sheet, cash flow, opening balances) is fully
`t()`-wired — **155 `acct.*` keys** (reusing `fin.save`/`fin.cancel`/`fin.approve`/`fin.col_status` where the
Thai matched). The `SUB_TH` subledger-label map was refactored to a key-based `subLabel()` helper (guarded by
a known-codes list, preserving the raw-code fallback), and the embedded-`<strong>` sentences (COA curation
card, paste-help, SoD note) were split into ordered part-keys like the `fin.ap_note_*` pattern. Interpolated
toasts (activate/deactivate account, save, JE draft/approve/reject, opening-balance import/post, tie-out run)
verified var-for-placeholder. Key-coverage + Thai-leftover (comments only) + interpolation checks all pass.

**Phase 5 (v1.19):** the **finance maker-checker loop** is now bilingual end-to-end — **Disbursements**
(`disbursements/page.tsx`, the AP-payment checker side) and the **Pending approvals** monitor
(`approvals/page.tsx`, GOV-01) are fully `t()`-wired (`disb.*`/`appr.*` keys, reusing `fin.*`). The
`TYPE_TH` approval-type map was refactored to a key-based `typeLabel()` helper (known-list guarded, raw-code
fallback), and the reject-reason `window.prompt` is localized. So a finance user now has the whole cycle —
`/finance` (request) → `/disbursements` (approve/release) and the cross-system `/approvals` queue — in
English. Presentation-only; `฿` currency glyph kept as-is. Key-coverage + Thai-leftover checks pass.

**Phase 6 (v1.20):** the **Inventory** operations surface — the stock list (`inventory/page.tsx`), the item
detail page (`inventory/[itemId]/page.tsx`), the suppliers list (`inventory/suppliers/page.tsx`) and the PO
list (`inventory/purchase-orders/page.tsx`) — is fully `t()`-wired (`inv.*` keys, reusing `dash.*`/`fin.*` for
shared table columns like date/no/customer/amount/status and `dash.need_restock`). A local `t` (a `setTimeout`
handle in the inventory search debounce) was renamed to `timer` to free the name for the translate fn. The
supplier count ("N of M suppliers") and the item-detail meta line are interpolated keys. Key-coverage clean;
no UI Thai remains (not even comments in these files). Same presentation-only pattern.

**Phase 7 (v1.21):** the **Procurement** cycle — the shared PR/PO/GR create forms
(`components/procurement-forms.tsx`, incl. their inline-validation messages from §1.9) and the
`/procurement` page (PO create + list + the PO-attachments card) — is `t()`-wired with `proc.*` keys (reusing
`inv.col_qty`/`inv.col_uom`/`inv.col_supplier`/`inv.po_empty_title` and `dash.col_date`/`fin.col_amount`/
`fin.col_status`). Because the forms are shared, the `/requisitions` (PrForm) and `/receiving` (GrForm) pages
become bilingual for free. Interpolated toasts (PR/PO/GR created) and the LINE-attach hint are keyed. No
API/permission/GL/control change; key-coverage + Thai-leftover checks pass.

---

## 2. Control / compliance impact — **none**

The original convergence pass (§1.1–1.6) changed **no** API endpoint, route `href`, permission/SoD rule, GL
posting, validation/error code, or workflow. The finance maker-checker (**EXP-06**), collections/dunning
(**REV-08/REV-12**), reconciliation SoD, and all postings are byte-for-byte the same logic, only re-laid-out
in the client.

The only API surface added is §1.7's **read-only `GET /api/search`** (a convenience spotlight over existing
master data). It performs **no** write, GL posting, or state change; it **reuses existing per-entity read
permissions** (no new permission/SoD rule) and the standard RLS tenant isolation. It is therefore **not a
control** and creates no new control objective — so the **RCM, control matrices, and process narratives are
unaffected** and were intentionally not modified (per the doc-sync policy's "say so explicitly" clause). It
is, however, covered by an automated check in the **`e2e` cutover harness** (permission-scoped result,
deep-link, min-length guard). The API-level **UAT** cases (`docs/uat/02-order-to-cash`,
`03-procure-to-pay`, `05-general-ledger-close`, `09-reports-analytics`) drive `/api/finance/*` endpoints
directly, not the screen, so they remain valid as-is.

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
| 2026-06-25 | v1.6 (IMPLEMENTED) | Web / Product | **Final mop-up sweep** (§1.5): guided empty states on the remaining read-only report/viewer screens (restaurant-analytics/sod/lots/food-cost/tax-reports/bi/audit/pos-home/loyalty-members/inventory-item/pos) + toasts & empty states on the rest (production-plan/menu/goods-issue/cpq/costing/buffet/branches/saved-views/images/campaigns/ai-actions) — 22 screens, **~79 total** (essentially the whole internal app). Independently review-verified behavior-preserving (22/22, 0 flagged). No API/route/permission/control change. Verified: web typecheck ✅ + build ✅ (127/127). |
| 2026-07-03 | v1.7 (IMPLEMENTED) | Web / Product | **First-run guidance** (§1.6): new `getting-started.tsx` panel on the ERP dashboard surfacing the existing onboarding checklist (`GET /api/onboarding`) with per-step deep-links + in-place tick-off — closes the "guided first-run" gap for the Paypers-style usability pass. Self-hides on 403 / 100% / no pending step; reuses existing endpoints only. No API/route/permission/GL/control change. Docs synced (this file, user-manual 00). Verified: web typecheck ✅ + build ✅. |
| 2026-07-04 | v1.21 (IMPLEMENTED) | Web / Product | **i18n rollout Phase 7** (§1.10): `t()`-wired the **Procurement** cycle — the shared PR/PO/GR forms (`procurement-forms.tsx`, incl. their validation messages) + the `/procurement` page (create/list/attachments) — new `proc.*` keys reusing `inv.*`/`dash.*`/`fin.*`; the shared forms make `/requisitions` + `/receiving` bilingual for free. No API/permission/GL/control change. Docs synced (this file). Verified: web typecheck ✅ + build ✅ + key-coverage + Thai-leftover checks. |
| 2026-07-04 | v1.20 (IMPLEMENTED) | Web / Product | **i18n rollout Phase 6** (§1.10): `t()`-wired the **Inventory** surface — stock list, item detail (`[itemId]`), suppliers list, PO list — new `inv.*` keys reusing `dash.*`/`fin.*` for shared columns; renamed a colliding `setTimeout` local `t`→`timer`; interpolated supplier-count + item-detail meta. No API/permission/GL/control change. Docs synced (this file). Verified: web typecheck ✅ + build ✅ + key-coverage + Thai-leftover (none) checks. |
| 2026-07-04 | v1.19 (IMPLEMENTED) | Web / Product | **i18n rollout Phase 5** (§1.10): `t()`-wired the finance maker-checker loop — **Disbursements** (`disbursements/page.tsx`) + the **Pending approvals** monitor (`approvals/page.tsx`, GOV-01) — new `disb.*`/`appr.*` keys reusing `fin.*`; refactored the `TYPE_TH` map to a key-based helper and localized the reject-reason prompt. Completes the bilingual finance cycle (request → approve/release → approvals queue). No API/permission/GL/control change. Docs synced (this file). Verified: web typecheck ✅ + build ✅ + key-coverage + Thai-leftover checks. |
| 2026-07-04 | v1.18 (IMPLEMENTED) | Web / Product | **i18n rollout Phase 4** (§1.10): fully `t()`-wired the **Accounting / GL** workspace (`accounting-client.tsx`, ~913 lines, 12 tabs — trial balance / GL detail / tie-out / CoA + edit / journal / JE approvals / P&L / balance sheet / cash flow / opening balances) — **155 `acct.*` keys**, reusing `fin.*` where shared; refactored the `SUB_TH` map to a key-based helper and split embedded-`<strong>` sentences into part-keys. No API/permission/GL/control change. Docs synced (this file). Verified: web typecheck ✅ + build ✅ + key-coverage + interpolation-var + Thai-leftover (comments only) checks. |
| 2026-07-04 | v1.17 (IMPLEMENTED) | Web / Product | **i18n rollout Phase 3** (§1.10): fully `t()`-wired the **Finance** cycle page (`finance/page.tsx`, all 3 tabs — AR/AP lists, receipt/write-off/pay-request/collections dialogs, aging charts + export) — ~90 `fin.*` keys incl. interpolated toasts; refactored `AGING_BUCKETS` + dunning-stage labels to key-based `t()` lookup. No API/permission/GL/control change. Docs synced (this file). Verified: web typecheck ✅ + build ✅ + key-coverage check. |
| 2026-07-04 | v1.16 (IMPLEMENTED) | Web / Product | **i18n rollout Phase 2** (§1.10): `t()`-wired the **POS home** (`pos-home`, the POS landing surface) and the **Onboarding** page (`onboarding`, completing the first-run pair) — new `pos.*`/`onb.*` keys (th+en), reusing `dash.*` where shared; onboarding step/pack labels use the API `label`/`label_en`. Key-coverage checked. No API/permission/GL/control change. Docs synced (this file). Verified: web typecheck ✅ + build ✅. |
| 2026-07-04 | v1.15 (IMPLEMENTED) | Web / Product | **Lighter data entry depth II** (§1.9): the double-entry ledger forms (manual Journal, Recurring, Prepaid) now validate inline via a shared `lib/journal-validation.ts` — per-line (account + one non-negative side), form-level (≥2 lines, positive total, **debits = credits** with the imbalance amount/side shown), + Prepaid name/total/months. Submit validates on click; same POST bodies. No API/permission/GL/control change. Docs synced (this file, user-manual 06). Verified: web typecheck ✅ + build ✅ + helper behaviour check. |
| 2026-07-04 | v1.14 (IMPLEMENTED) | Web / Platform | **Global search depth II** (§1.7): +5 types (`member`/`project`/`requisition`/`ap_invoice`/`employee`) → 12 total, each perm-mirrored; `member`→`/loyalty/members/{numeric id}` and `project`→`/projects/{code}` are real detail deep-links. Palette icons + i18n `search.type.*`. No migration/GL/control change. Docs synced (this file, API spec). Verified: shared+api+web typecheck ✅, web build ✅, **`e2e` harness 23/23** (seeded member → numeric-id deep-link). |
| 2026-07-04 | v1.13 (IMPLEMENTED) | Web / Product | **Lighter data entry depth** (§1.9): rolled the `FormField` + inline-validation pattern out to the heavy line-item forms — procurement `PrForm`/`PoForm`/`GrForm` and BOM `Library` — with per-field + per-line errors (Item ID + qty>0, PO vendor + non-negative price, GR PO no., BOM code/name/non-negative price) and toast result feedback. Payloads/endpoints unchanged. No API/permission/GL/control change. Docs synced (this file, user-manual 03). Verified: web typecheck ✅ + build ✅. |
| 2026-07-04 | v1.12 (IMPLEMENTED) | Web / Platform | **Global search depth** (§1.7): refactored `search.module.ts` to a config-driven `ENTITIES` table and added 4 document types (`sale`/`ar_invoice`/`tax_invoice`/`purchase_order`) with mirrored per-type perms; document deep-links carry `?q={id}` and the `/pos` + `/inventory/purchase-orders` lists seed their search box from it (`lib/url.ts`); palette shows per-type label chips (i18n `search.type.*`). No migration/GL/control change. Docs synced (this file, API spec). Verified: shared+api+web typecheck ✅, web build ✅, **`e2e` harness 22/22** (sale + PO by number/vendor). |
| 2026-07-03 | v1.11 (IMPLEMENTED) | Web / Product | **i18n rollout Phase 1** (§1.10): added `dash.*`/`today.*`/`getstarted.*` message keys (th+en) and wired `t()` through the ERP dashboard surface (`dashboard/page.tsx`, `today-actions.tsx`, `getting-started.tsx`) so the language toggle now translates the whole landing page — the template for extending i18n to the rest of the app. No API/route/permission/GL/control change. Docs synced (this file). Verified: web typecheck ✅ + build ✅. |
| 2026-07-03 | v1.10 (IMPLEMENTED) | Web / Product | **Lighter data entry** (§1.9): company-profile form (`/setup`) migrated to shared `FormField` + **inline format validation** (tax ID / branch / postal / PromptPay / email / VAT rate), Save gated on validity, and `notify` toasts replacing the inline `<Msg>` banner. Same API call/payload; pure client validation + a11y. Establishes the `FormField`+validate template for the remaining raw forms. No API/route/permission/GL/control change. Docs synced (this file, user-manual 11). Verified: web typecheck ✅ + build ✅. |
| 2026-07-03 | v1.9 (IMPLEMENTED) | Web / Product | **Global floating AI helper** (§1.8): extracted the assistant chat/SSE into a shared `useAssistantChat` hook and added an always-available floating `assistant-widget.tsx` (permission-gated in `app-shell`, ⤢ to full page). `/assistant` page refactored to the hook (behaviour-preserving). Reuses `GET /api/chat/stream` — no API/route/permission/GL/control change. Docs synced (this file, user-manual 00). Verified: web typecheck ✅ + build ✅. |
| 2026-07-03 | v1.8 (IMPLEMENTED) | Web / Platform | **Global spotlight search** (§1.7): new read-only `GET /api/search?q=` (`modules/search/search.module.ts`) over customer/vendor/item masters, wired into the ⌘K palette as a **ข้อมูล (Records)** group (debounced, controlled input, deep-links). RLS tenant-scoped; per-entity results gated in-service by the caller's expanded permissions (no new perm/SoD/GL/control). Docs synced (this file incl. §2, API spec, user-manual 00). Verified: shared+API+web typecheck ✅, web build ✅, **`e2e` cutover harness ✅ (19/19, +3 search checks — real Nest app + PGlite + RLS)**. |
