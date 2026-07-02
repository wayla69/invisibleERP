-- 0217_send_time — Phase H3 (docs/26): per-member preferred send hour (histogram mode of paid-order hours,
-- Asia/Bangkok, null under 3 orders — computed in refreshProfile, SCORE_VERSION v2) + a per-journey default
-- snap hour. Journey wait steps snap FORWARD to the member's hour. Additive columns.
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS preferred_hour integer;
--> statement-breakpoint
ALTER TABLE journeys ADD COLUMN IF NOT EXISTS default_send_hour integer NOT NULL DEFAULT 10;
