-- 0216_campaign_window — Phase H2 (docs/26): per-campaign attribution window for the organic-purchase
-- holdout baseline (the report joins each A/B/holdout group's members to their actual paid orders within
-- window_days after their send). Additive defaulted column on an existing tenant-scoped table.
ALTER TABLE automation_campaigns ADD COLUMN IF NOT EXISTS window_days integer NOT NULL DEFAULT 30;
