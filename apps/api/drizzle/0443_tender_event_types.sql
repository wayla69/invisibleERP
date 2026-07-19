-- 0443_tender_event_types — register the split-payment tender events TENDER.CASH/CARD/QR/VOUCHER/OTHER in
-- posting_event_types (docs/52 Phase 6a). These were added to the code registry (posting-events.sales.ts) so
-- that a split sale can post one asset (cash) debit per tender method; seeding them here lets a tenant remap a
-- method to a clearing / bank / gift-card-liability account via a GL-24 posting override (posting_rules.event_type
-- FKs this table). Idempotent (ON CONFLICT DO NOTHING); no behaviour change on its own — every method defaults
-- to 1000 (Cash), so an all-default split is net-GL-identical to the legacy single Dr 1000 = total.
INSERT INTO posting_event_types (key, name, description) VALUES
  ('TENDER.CASH',    'Tender — cash',                'Split-payment cash leg (asset debit)'),
  ('TENDER.CARD',    'Tender — card',                'Split-payment card leg (remap to a card-clearing/bank account via GL-24)'),
  ('TENDER.QR',      'Tender — QR / e-wallet',       'Split-payment QR/PromptPay/e-wallet leg (remap to a clearing account via GL-24)'),
  ('TENDER.VOUCHER', 'Tender — voucher / gift card', 'Split-payment voucher/gift-card leg (remap to the 2200 gift-card liability via GL-24)'),
  ('TENDER.OTHER',   'Tender — other',               'Split-payment fallback leg for any other method (asset debit)')
ON CONFLICT (key) DO NOTHING;
