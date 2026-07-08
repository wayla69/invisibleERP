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
| 2 | Formatting sweep: 26 `toLocaleString` + 7 `toFixed` files → `baht`/`num`/`thaiDate`/`pct` | planned |
| 3a-c | Raw `<select>`/`<input>`/`FormField` adoption, per area (finance+procurement · loyalty+projects · settings/platform+POS) | planned |
| 4 | DataTable adoption for the 21 raw-`<table>` pages, per area, simplest first (`controls`, `developer`, `einvoice`, `loyalty`, `projects/portfolio` → finance analytics clients last) | planned |
| 5 | `ModulePage` widening + toast-vs-`Msg` convention decision + breadcrumb decision | planned |

Interleaved with this track: the **docs/38 2.1 pilot (bi facade extraction)** — golden-master (496 paths)
must stay byte-identical.

## 4. Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-07-08 | Platform / IT | Charter + measured inventory + batch plan; batch 1 delivered (ConfirmDialog / form-controls / pct + all window.confirm sites migrated; master-io dedupes `selectCls`). |
