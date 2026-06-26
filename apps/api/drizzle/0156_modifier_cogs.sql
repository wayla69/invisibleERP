-- Step 1 — Modifier COGS deltas. A POS modifier option ("extra patty", "add cheese") can now carry a
-- standard COGS delta so selecting it raises the sold line's cost of goods (Dr 5300 / Cr 1200), closing
-- the menu-variance leak where modifiers moved revenue (price_delta) but never moved COGS. recipe_ref_id
-- is a forward hook to link a modifier to a mini-recipe for ingredient-level deduction (not yet costed).
-- modifier_options already has tenant_id + the 0002 RLS policy, so this additive ALTER needs no RLS loop.
ALTER TABLE modifier_options ADD COLUMN IF NOT EXISTS cogs_delta numeric(14,2) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE modifier_options ADD COLUMN IF NOT EXISTS recipe_ref_id bigint REFERENCES menu_recipes(id);
