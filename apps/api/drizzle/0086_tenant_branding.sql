-- 0085 — Tenant branding (Platform Phase 9). Adds a logo, a tagline and a small branding-preferences blob
-- to the tenant (org) record so a tenant admin can brand customer-facing documents. These are genuinely
-- consumed: the receipt header renders the logo + tagline when set (gated by branding_prefs). Additive
-- columns on the root `tenants` table (its own RLS policy from 0003 already scopes a tenant to its own row)
-- — no RLS loop. A logo is stored as a pasted https URL or a small image data-URI (no file-upload infra).

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_url text;
--> statement-breakpoint
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tagline text;
--> statement-breakpoint
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branding_prefs jsonb DEFAULT '{}'::jsonb;
