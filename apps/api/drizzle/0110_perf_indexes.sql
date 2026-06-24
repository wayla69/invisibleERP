-- 0110_perf_indexes — Pre-production performance hardening (NASDAQ readiness audit).
-- Adds indexes on financial/inventory hot-path join keys, tenant-scoped date ranges, and FK children
-- that were previously unindexed (full table scans under peak load). All idempotent (IF NOT EXISTS).
-- No data change, append-only DDL; mirrored in the Drizzle schema (ledger/payments/sales/inventory/procurement).

-- General Ledger: lines join header on entry_id (every trial-balance / statement / consolidation read).
CREATE INDEX IF NOT EXISTS idx_jl_entry ON journal_lines (entry_id);
CREATE INDEX IF NOT EXISTS idx_jl_tenant ON journal_lines (tenant_id);
-- GL header: period reports filter status='Posted' over entry_date, scoped by tenant.
CREATE INDEX IF NOT EXISTS idx_je_tenant_date ON journal_entries (tenant_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_je_status_date ON journal_entries (status, entry_date);

-- Payments / refunds: tender lookup by sale_no, tenant reporting by created_at, refund history by payment_no.
CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments (sale_no);
CREATE INDEX IF NOT EXISTS idx_payments_tenant_created ON payments (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON payment_refunds (payment_no);

-- POS / sales: highest-volume retail table + line join keys.
CREATE INDEX IF NOT EXISTS idx_cps_tenant_date ON cust_pos_sales (tenant_id, sale_date);
CREATE INDEX IF NOT EXISTS idx_cps_branch ON cust_pos_sales (branch_id, sale_date);
CREATE INDEX IF NOT EXISTS idx_cpi_sale ON cust_pos_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines (order_id);
CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items (return_id);
CREATE INDEX IF NOT EXISTS idx_pending_order_items_pending ON pending_order_items (pending_id);

-- Inventory movement ledgers: stock ledger / valuation filter item + move_date, lookups by doc / lot / location.
CREATE INDEX IF NOT EXISTS idx_sm_item_date ON stock_movements (item_id, move_date);
CREATE INDEX IF NOT EXISTS idx_sm_doc ON stock_movements (doc_no);
CREATE INDEX IF NOT EXISTS idx_ll_item_loc ON lot_ledger (item_id, location_id);
CREATE INDEX IF NOT EXISTS idx_ll_lot ON lot_ledger (lot_no);
CREATE INDEX IF NOT EXISTS idx_locstock_item ON location_stock (item_id, location_id);

-- Procurement FK children + 3-way-match join keys.
CREATE INDEX IF NOT EXISTS idx_pr_items_pr ON pr_items (pr_id);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON po_items (po_id);
CREATE INDEX IF NOT EXISTS idx_po_deliveries_po ON po_deliveries (po_id);
CREATE INDEX IF NOT EXISTS idx_gr_pono ON goods_receipts (po_no);
CREATE INDEX IF NOT EXISTS idx_gr_items_gr ON gr_items (gr_id);
CREATE INDEX IF NOT EXISTS idx_gr_items_pono ON gr_items (po_no);
