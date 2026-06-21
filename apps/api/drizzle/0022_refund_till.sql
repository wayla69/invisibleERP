-- Adversarial-verify fix #1: cash refunds must reduce the drawer the cash LEAVES (the till open at
-- refund time), not the original sale's till. A cash sale on a since-closed shift refunded today would
-- otherwise lower that closed shift's expected_cash (phantom overage) while today's drawer actually pays.
-- payment_refunds now records the till it was processed against; aggregateTill keys cash refunds by it.
ALTER TABLE payment_refunds ADD COLUMN IF NOT EXISTS till_session_id bigint;
CREATE INDEX IF NOT EXISTS idx_payment_refunds_till ON payment_refunds(till_session_id);
