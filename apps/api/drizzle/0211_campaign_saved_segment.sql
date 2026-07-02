-- 0211_campaign_saved_segment — Phase F1: a loyalty campaign can target a SAVED custom segment
-- (audience='saved_segment' resolves saved_segments rules at send time). Additive nullable column on an
-- existing tenant-scoped table (RLS already applies); no RLS loop needed.
ALTER TABLE loyalty_campaigns ADD COLUMN IF NOT EXISTS saved_segment_id bigint;
