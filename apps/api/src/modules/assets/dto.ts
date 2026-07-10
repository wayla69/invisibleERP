import { z } from 'zod';

export const CreateCategoryBody = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  default_useful_life_years: z.number().int().positive().default(5),
  asset_account: z.string().default('1500'),
  accum_dep_account: z.string().default('1590'),
  dep_expense_account: z.string().default('5200'),
});
export type CreateCategoryDto = z.infer<typeof CreateCategoryBody>;

// FIN-6a — the parallel TAX depreciation basis. Optional on every acquire path; when supplied the asset keeps
// a memo-only tax book alongside book depreciation that feeds the deferred-tax temporary difference (TAX-06).
const TaxBookShape = {
  tax_useful_life_months: z.number().int().positive().optional(),        // tax life (defaults to book life)
  tax_salvage_value: z.number().nonnegative().optional(),               // tax residual (defaults to book salvage)
  tax_initial_allowance_pct: z.number().min(0).max(100).optional(),      // Thai first-year special allowance % of depreciable base
};

export const AcquireAssetBody = z.object({
  name: z.string().min(1),
  category_id: z.number().int().optional(),
  acquire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  acquire_cost: z.number().positive(),
  salvage_value: z.number().nonnegative().default(0),
  useful_life_months: z.number().int().positive().optional(),
  acquire_source: z.enum(['cash', 'credit']).default('cash'),
  location: z.string().optional(),
  department: z.string().optional(),
  serial_no: z.string().optional(),
  notes: z.string().optional(),
  ...TaxBookShape,
}).refine((b) => b.useful_life_months != null || b.category_id != null, { message: 'useful_life_months or category_id required' });
export type AcquireAssetDto = z.infer<typeof AcquireAssetBody>;

// FA-10 — register a fixed asset FROM a capital goods-receipt line (maker-checker). The GR line supplies the
// cost/source linkage; the preparer fills in the depreciation params. Either useful_life_months or a category
// (which carries a default life) must resolve. Raised as PendingApproval — no GL until a different user approves.
export const RegisterFromGrBody = z.object({
  gr_no: z.string().min(1),
  gr_item_id: z.number().int().positive(),
  name: z.string().min(1),
  category_id: z.number().int().optional(),
  acquire_cost: z.number().positive().optional(),   // default = received_qty × unit_cost of the GR line
  salvage_value: z.number().nonnegative().default(0),
  useful_life_months: z.number().int().positive().optional(),
  location: z.string().optional(),
  department: z.string().optional(),
  serial_no: z.string().optional(),
  notes: z.string().optional(),
}).refine((b) => b.useful_life_months != null || b.category_id != null, { message: 'useful_life_months or category_id required' });
export type RegisterFromGrDto = z.infer<typeof RegisterFromGrBody>;

export const RunDepreciationBody = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) });

export const DisposeAssetBody = z.object({
  disposal_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  proceeds: z.number().nonnegative().default(0),
  remarks: z.string().optional(),
});
export type DisposeAssetDto = z.infer<typeof DisposeAssetBody>;

// ── CIP / AUC (FA-13) ────────────────────────────────────────────────────────────────────────────────
// Open a construction-in-progress asset; accumulate cost lines onto it; settle (capitalise) it into a normal
// fixed asset under a maker-checker gate.
export const OpenCipBody = z.object({
  name: z.string().min(1),
  category_id: z.number().int().optional(),
  location: z.string().optional(),
  department: z.string().optional(),
  notes: z.string().optional(),
});
export type OpenCipDto = z.infer<typeof OpenCipBody>;

export const AddCipCostBody = z.object({
  amount: z.number().positive(),
  source_type: z.enum(['manual', 'gr', 'project']).default('manual'),
  source_ref: z.string().optional(),          // GR no / project code / free text
  description: z.string().optional(),
  cost_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  pay_source: z.enum(['cash', 'credit']).default('credit'),
});
export type AddCipCostDto = z.infer<typeof AddCipCostBody>;

// Settlement REQUEST (maker) — the depreciation params the CIP capitalises into. A mandatory reason is
// recorded for the audit trail. Either useful_life_months or a category (default life) must resolve.
export const SettleCipBody = z.object({
  name: z.string().optional(),                // defaults to the CIP name
  category_id: z.number().int().optional(),
  useful_life_months: z.number().int().positive().optional(),
  salvage_value: z.number().nonnegative().default(0),
  reason: z.string().min(1),                  // mandatory settlement reason (audited)
  ...TaxBookShape,
}).refine((b) => b.useful_life_months != null || b.category_id != null, { message: 'useful_life_months or category_id required' });
export type SettleCipDto = z.infer<typeof SettleCipBody>;
