-- 0071 — KDS course firing: tag each order line with a course number so the kitchen can be fired
-- course-by-course (apps → mains → dessert) instead of all at once. Column on an existing RLS table,
-- so no RLS loop is needed. Existing lines default to course 1 (fire-all behaviour unchanged).
ALTER TABLE dine_in_order_items ADD COLUMN IF NOT EXISTS course integer NOT NULL DEFAULT 1;
