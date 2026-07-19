-- 0439_sale_service_event_types — register the business-type-neutral revenue events SALE.GOODS / SALE.SERVICE
-- in posting_event_types (docs/52 Phase 2a). These were added to the code registry in Phase 1 but never
-- seeded into the table, so a GL-24 posting-override for them (posting_rules.event_type FKs this table) was
-- impossible — a services business could not remap SALE.SERVICE to its own service-income account. This
-- closes that gap. Idempotent (ON CONFLICT DO NOTHING); no behaviour change on its own (defaults stay 4000).
INSERT INTO posting_event_types (key, name, description) VALUES
  ('SALE.GOODS',   'Sale — goods revenue',   'Generic retail-goods sale revenue leg (universal POS; profile revenue_event)'),
  ('SALE.SERVICE', 'Sale — service revenue', 'Generic service sale revenue leg (service items post here; remap to a service-income account via GL-24)')
ON CONFLICT (key) DO NOTHING;
