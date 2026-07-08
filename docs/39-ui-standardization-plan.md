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
| 4 (rest) | Remaining 16 raw-table pages, per area (finance analytics clients last) | planned |
| 5 | `ModulePage` widening + toast-vs-`Msg` convention decision + breadcrumb decision | planned |

Interleaved with this track: the **docs/38 2.1 pilot (bi facade extraction)** — golden-master (496 paths)
must stay byte-identical.

## 4. Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-07-08 | Platform / IT | Charter + measured inventory + batch plan; batch 1 delivered (ConfirmDialog / form-controls / pct + all window.confirm sites migrated; master-io dedupes `selectCls`). |
| 0.2 | 2026-07-08 | Platform / IT | Batch 2 delivered: formatting sweep (27 files → lib helpers; `thaiDateTime` + `num(v,digits?)` added; `pct` semantics locked to drop-trailing-zeros; local `baht`/`money`/`pct` duplicates removed in qr/track/query/nl-analytics/match/deferred-tax); 6 exceptions documented in §3. |
| 0.4 | 2026-07-08 | Platform / IT | Batch 4 slice 1: DataTable adoption in controls/developer/einvoice; loyalty tier-ladder + portfolio heatmap documented as exceptions (not list surfaces). |
| 0.3 | 2026-07-08 | Platform / IT | Batch 3a delivered: shared `Select` adopted in 45 files (~95 selects); all 41 local `selectCls` constants deleted (15 drifted variants converged); width semantics preserved (`w-auto` where the local style had no `w-full`); assets' style-sharing input imports the shared `selectCls`. |
