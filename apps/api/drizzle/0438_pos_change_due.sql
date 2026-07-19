-- 0438_pos_change_due — cash tendering + change-due on a POS tender (#1, the universal cashier need).
-- The cashier enters the cash the customer physically handed over; the register computes and records the
-- change given back. Net drawer cash is unchanged (cash in − change out = the tender amount), so there is
-- NO GL effect — these are a cashier convenience + an audit trail (X/Z drawer count reconciliation, and a
-- recallable "how much change did we give?" for disputes). Nullable columns on an existing tenant-scoped
-- table (payments already has RLS + a tenant-leading index) ⇒ no RLS loop / no index change needed.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cash_tendered numeric(18,4);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS change_given numeric(18,4);
