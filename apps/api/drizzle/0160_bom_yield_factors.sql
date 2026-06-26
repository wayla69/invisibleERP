-- Step 3 — yield/waste factors on BoM lines. qty_per is the EDIBLE (plated) amount per serving; the kitchen
-- must issue more RAW stock to cover trim/cook loss. gross_qty = qty_per / (yield_factor − waste_factor),
-- so ingredient deduction + recipe COGS reflect what is actually consumed (margins were fiction at 100%
-- yield). Defaults (yield 1.0, waste 0.0) keep the historic behaviour → existing recipes unchanged.
-- menu_recipe_lines already has tenant_id + the 0002 RLS policy, so this additive ALTER needs no RLS loop.
ALTER TABLE menu_recipe_lines ADD COLUMN IF NOT EXISTS yield_factor numeric(5,4) NOT NULL DEFAULT 1.0000;
--> statement-breakpoint
ALTER TABLE menu_recipe_lines ADD COLUMN IF NOT EXISTS waste_factor numeric(5,4) NOT NULL DEFAULT 0.0000;
