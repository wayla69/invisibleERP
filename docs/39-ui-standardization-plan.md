# 39 — UI standardization track (workstream 2.10)

> **Status:** IN PROGRESS — batch 1 delivered. The measured baseline (2026-07-08 inventory) shows the app
> is already substantially standardized (StateView in 161 files, DataTable 140, PageHeader 175, `ui/button`
> 186, `useLang` 185, `lib/format` 147 — over 208 pages), so this track is a **residual-cleanup + adoption
> sweep**, not a design-system build. The spec of record is `docs/05-frontend.md` §5 (shadcn/ui + brand
> tokens + DataTable as the central list surface); this doc adds the measured gaps and the batch plan.

## 1. Measured gaps (2026-07-08 inventory)

| Gap | Count | Standard |
|---|---|---|
| Raw `<select>` (inlined `selectCls` strings) | 75 files (vs 14 on the primitive) | `components/form-controls.tsx` `Select` (native element — keeps form/keyboard semantics + `page.selectOption()` e2e) |
| Raw `<input>` | 28 files | `ui/input` (+ `FormField`, currently 12 files) |
| `window.confirm` for destructive actions | ~~7 sites / 6 files~~ **0 (batch 1)** | `components/confirm-dialog.tsx` `ConfirmDialog` |
| Hand-rolled `<table>` (no sort/pagination/mobile cards) | 21 files | `components/data-table.tsx` |
| Ad-hoc `toLocaleString` / `toFixed` | 26 / 7 files | `lib/format.ts` `baht`/`num`/`thaiDate`/`pct` (pct added in batch 1) |
| `toast()` unused vs inline `Msg` ambiguity | Toaster mounted, 1 caller | decide in batch 5 |
| `ModulePage` scaffold adoption | 19 files | widen after the atoms land |
| Breadcrumbs | primitive exists, 0 pages | decide in batch 5 |

## 2. Hard constraints (every batch)

- **`check-use-client` ratchet stays flat or goes DOWN** (baseline 253). Shared components carry **no
  `'use client'` directive** — they inherit the importing page's boundary (the `state-view.tsx` pattern,
  docs/28 §4). All batch-1 components follow this.
- Native `<select>` stays native — the radix Select changes keyboard/form semantics and breaks
  `page.selectOption()` in the e2e specs. Standardize the *styling + import*, not the interaction.
- Verify per batch: `pnpm -r typecheck` · `pnpm --filter @ierp/web build` · `check-use-client` ·
  relevant e2e (`mobile-smoke.mobile.spec.ts`, `sidebar.capture.spec.ts` are the broadest nets) · i18n keys
  in the catalog (no hardcoded strings in new markup).

## 3. Batch plan

| Batch | Scope | Status |
|---|---|---|
| 1 | Charter (this doc) + primitives: `ConfirmDialog`, `form-controls.tsx` (`Select` + canonical `selectCls`), `format.pct()` + migrate all 7 `window.confirm` sites (customers, suppliers, setup/items merges · tables remove · pos-control discard/void · settings nav-reset) | **DELIVERED** |
| 2 | Formatting sweep → `baht`/`num(v,digits?)`/`thaiDate`/**`thaiDateTime`** (new — audit/log timestamps keep their time)/`pct`. 27 files swept; **6 documented exceptions** stay: `command-center` `fmt()` + `treasury` `nn()` (coherent multi-unit local formatters) and their SVG chart coordinates, `demand` fraction-`pct`/MASE metrics, `tax-codes`/`bom`/`buffet` deliberate fixed-digit semantics | **DELIVERED** |
| 3a | Shared `Select` adoption — all 4 finance-area inline-class files + **all 41 local-`selectCls` files** (15 drifted copies of one intent converged on the canonical style; layout preserved: no-`w-full` variants become `className="w-auto"` via twMerge). Raw `<select>` files 75 → **30** | **DELIVERED** |
| 3b | Remaining 30 inline-class `<select>` files (per-site visual judgment) + raw `<input>`/`FormField` adoption | planned |
| 4 (slice 1) | DataTable adoption — `controls` findings, `developer` API keys (keeps the shared `Select` tier picker), `einvoice` submissions converted (sort + pagination + mobile cards for free). **Exceptions documented:** `loyalty` tier ladder (mini 4-row config table with inline editor — pagination/sort UI would be noise) and `projects/portfolio` (capacity **heatmap calendar**, not a list) stay hand-rolled by design. Raw-table pages 21 → 16 | **DELIVERED (slice 1)** |
| 4 (slice 2) | DataTable adoption — `billing` charge history, `custom-objects` records (dynamic per-field column spec, values flattened onto the row so the built-in sort works), `query` studio + `nl-analytics` result grids (the inline share-of-sales bar kept as a cell render). **Exception documented:** `doc-ai` extract preview is a 6-row key-value detail card, not a list. Raw-table pages 16 → 12 (11 candidates + 1 exception) | **DELIVERED (slice 2)** |
| 3b | Native-select standardization — ALL 16 remaining inline-class `<select>` sites (the `h-9 rounded-md border bg-transparent px-3 text-sm` signature) across 11 pages (ai-config, einvoice, theme, migration ×2, payroll, setup ×2, document-templates ×2, object-layouts, automation ×5-via-const, query, custom-objects ×4) now use the canonical `selectCls` from `form-controls.tsx` — native `<select>` element kept everywhere (e2e `selectOption` compat), local style consts deleted, the two direct-flex-child sites (`document-templates` docType, `object-layouts` obj) carry a `cn(selectCls, 'w-auto')` override per the twMerge precedent. Raw `<textarea>`s stay as-is (no shared textarea component exists — future slice if warranted); label+control → `FormField` deferred (structural, `setup` already uses it — candidates documented). | **DELIVERED** |
| 4 (audit close-out) | Full audit of the remaining ~11 raw `<table>` sites concluded **none is a list surface**: statement layouts with `tfoot` totals (`finance/profitability` P&L matrix, `financial-statements` ×8), dashboard mini-panels ≤10 rows (`finance/treasury` ×4 — one with a min-week row highlight DataTable can't express — and `finance/close-cockpit` tie-out), form editors / nested detail rows (`gl-schedules` template-line editor + per-card JE lines), and the customer-facing `display/[terminal]` queue board. Converting these would REGRESS behaviour (lose totals footers, row highlights, inline editing) for zero list-UX gain — kept hand-rolled by design, same footing as the loyalty ladder / portfolio heatmap / doc-ai exceptions. **Batch 4 COMPLETE**: every genuine list surface in the app now rides the shared DataTable. | **COMPLETE** |
| 5 (proposal) | **Decisions proposed for sign-off (approve by merging this row):** **(a) toast-vs-`Msg`** — measured state: sonner `toast` is the live pattern in the NEWEST workspace (projects/* ×8, expense-approvals, floor-plan) while 18 older pages use inline `Msg`. Convention: **`toast` for transient mutation outcomes** (success/failure of an action — non-layout-shifting, matches the newest code), **`Msg` stays for persistent inline states** (validation summaries, statuses that must remain visible while the user works). Convergence is opportunistic — swap `Msg`→`toast` only when a page is otherwise being touched; no big-bang migration. **(b) Breadcrumbs** — primitive exists, 0 adopters; the sidebar + `PageHeader` already carry location for the 1-level-deep majority. Adopt **only on nested detail routes** (e.g. `/projects/[code]`) where a parent-list crumb genuinely aids navigation; the primitive otherwise stays parked (not deleted). **(c) `ModulePage` widening** — 19 pages adopted; the candidate audit (imports PageHeader + StateView, not yet ModulePage) measures **154 files** — a long tail, not a batch. Policy: convert **one representative slice** of high-traffic list pages now (proof + template for the pattern), then adopt **opportunistically** — any page being touched for another reason migrates if it fits the PageHeader → toolbar → StateView → body shape (same convergence rule as toast). No big-bang migration of 154 files; an un-migrated page is byte-identical by design. | **PROPOSED** |
| 5a-c (impl) | Implementation slices once the proposal row lands: 5a ModulePage slice(s), 5b breadcrumbs on nested detail routes, 5c toast convention is docs-only (effective immediately for new work) | pending sign-off |

Interleaved with this track: the **docs/38 2.1 pilot (bi facade extraction)** — golden-master (496 paths)
must stay byte-identical.

## 4. Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-07-08 | Platform / IT | Charter + measured inventory + batch plan; batch 1 delivered (ConfirmDialog / form-controls / pct + all window.confirm sites migrated; master-io dedupes `selectCls`). |
| 0.2 | 2026-07-08 | Platform / IT | Batch 2 delivered: formatting sweep (27 files → lib helpers; `thaiDateTime` + `num(v,digits?)` added; `pct` semantics locked to drop-trailing-zeros; local `baht`/`money`/`pct` duplicates removed in qr/track/query/nl-analytics/match/deferred-tax); 6 exceptions documented in §3. |
| 0.4 | 2026-07-08 | Platform / IT | Batch 4 slice 1: DataTable adoption in controls/developer/einvoice; loyalty tier-ladder + portfolio heatmap documented as exceptions (not list surfaces). |
| 0.5 | 2026-07-08 | Platform / IT | Batch 4 slice 2: DataTable adoption in billing/custom-objects/query/nl-analytics (dynamic columns + bar-render patterns established); doc-ai key-value card documented as an exception. |
| 0.6 | 2026-07-08 | Platform / IT | Batch 4 closed out by audit — the remaining raw-table sites are statement layouts / dashboard mini-panels / form editors / the display terminal (taxonomy in the batch table), not list surfaces; conversion would regress totals footers, row highlights and inline editing. Next: batch 3b (selects/inputs/FormField), batch 5 (ModulePage widening, toast-vs-Msg, breadcrumbs decision). |
| 0.7 | 2026-07-08 | Platform / IT | Batch 3b delivered — all 16 inline-class native selects standardized on `selectCls` (11 pages, element + behavior unchanged; two flex-child sites keep `w-auto`). Textareas + FormField adoption noted as explicit non-goals this slice. Remaining batch: 5 (ModulePage widening, toast-vs-Msg, breadcrumbs decision). |
| 0.8 | 2026-07-08 | Platform / IT | Batch 5 DECISION PROPOSAL written (toast-for-transient / Msg-for-persistent with opportunistic convergence · breadcrumbs on nested detail routes only · ModulePage widening by mechanical-candidate audit). Docs-only — merging this revision constitutes sign-off; implementation slices 5a/5b follow. |
| 0.3 | 2026-07-08 | Platform / IT | Batch 3a delivered: shared `Select` adopted in 45 files (~95 selects); all 41 local `selectCls` constants deleted (15 drifted variants converged); width semantics preserved (`w-auto` where the local style had no `w-full`); assets' style-sharing input imports the shared `selectCls`. |
