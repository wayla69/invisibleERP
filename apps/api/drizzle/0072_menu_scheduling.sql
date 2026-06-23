-- 0072 — Day-parting / menu scheduling: time-of-day + day-of-week availability windows on menu items
-- (breakfast / lunch / happy-hour). Evaluated on Asia/Bangkok business time. All columns nullable —
-- null means "always available", so existing items are unchanged. Column on an existing RLS table.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS avail_days text;          -- 7-char mask, index 0=Sunday (Bangkok); null = every day
--> statement-breakpoint
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS avail_start_min integer;  -- minutes from midnight (Bangkok); null = from open
--> statement-breakpoint
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS avail_end_min integer;    -- minutes from midnight (Bangkok); null = until close
