-- 0218 — Tenant-index backfill (docs/27 R1-1, investment-audit finding AUD-ARC-01).
-- RLS (0002_rls.sql) puts a tenant_id predicate on EVERY query against a tenant-scoped table; 132 such
-- tables had no index whose LEADING column is tenant_id, so per-tenant reads seq-scanned and degrade
-- non-linearly under concurrency. This adds the minimum uniform cover: a plain (tenant_id) btree per
-- uncovered table. Generated from live introspection over the applied migration set (PGlite), names
-- collision-checked against pg_indexes. Idempotent (IF NOT EXISTS); plain CREATE (not CONCURRENTLY) is
-- deliberate — current data volumes make the lock window trivial; revisit if a large tenant lands first.
-- The 'tenant-idx' cutover harness re-runs this introspection in CI and fails on ANY uncovered table,
-- so a new tenant-scoped table cannot ship without a tenant-leading index (no grandfathering).
--
-- PROD HOTFIX (2026-07-03): this file also re-creates the objects of 0145_table_reservations and
-- 0146_tip_distribution. Their journal `when` values are NON-MONOTONIC (0145 = 2023610000004 < 0144's
-- 2023620000004; 0146 == 0144's), and drizzle-kit migrate only applies entries whose `when` is strictly
-- greater than the last applied timestamp — so prod (migrated at 0144 before 0145/0146 merged) silently
-- skipped BOTH forever. Fresh DBs (CI PGlite) apply everything in one pass, hiding the gap until this
-- file's idx_tip_distribution_lines_tenant hit the missing table and blocked every prod deploy (42P01).
-- Everything below is idempotent, so environments that DID apply 0145/0146 are unaffected.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reservation_status') THEN
    CREATE TYPE reservation_status AS ENUM ('booked', 'waiting', 'ready', 'seated', 'cancelled', 'no_show');
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS table_reservations (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  kind text NOT NULL DEFAULT 'reservation',           -- 'reservation' | 'waitlist'
  table_id bigint REFERENCES dining_tables(id),        -- optional assigned table
  reserved_for timestamptz,                            -- booking time (null for walk-in waitlist)
  party_size integer NOT NULL DEFAULT 2,
  customer_name text,
  customer_phone text,
  member_id bigint REFERENCES pos_members(id),         -- optional loyalty link
  status reservation_status NOT NULL DEFAULT 'booked',
  quoted_wait_min integer,
  notes text,
  notified_at timestamptz,
  seated_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_table_reservations_status ON table_reservations (tenant_id, status, kind);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tip_distributions (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  dist_no text NOT NULL,
  period_from text NOT NULL,
  period_to text NOT NULL,
  method text NOT NULL DEFAULT 'equal',
  pool_amount numeric(18,4) NOT NULL,
  pay_account text NOT NULL DEFAULT '1000',
  journal_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tip_distribution_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  dist_id bigint NOT NULL REFERENCES tip_distributions(id),
  staff text NOT NULL,
  basis numeric(18,4) NOT NULL DEFAULT 0,
  share numeric(9,6) NOT NULL DEFAULT 0,
  amount numeric(18,4) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tip_dist_period ON tip_distributions (tenant_id, period_from, period_to);
--> statement-breakpoint
-- Re-run the RLS loop so the backfilled tenant_id tables are isolation-scoped (idempotent — DROP POLICY IF EXISTS).
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)', r.table_name);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_abandoned_carts_tenant" ON "abandoned_carts" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_access_reviews_tenant" ON "access_reviews" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_account_groups_tenant" ON "account_groups" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_api_keys_tenant" ON "api_keys" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_approval_actions_tenant" ON "approval_actions" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_ar_dunning_log_tenant" ON "ar_dunning_log" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_ar_invoices_tenant" ON "ar_invoices" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_asset_meters_tenant" ON "asset_meters" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_asset_movements_tenant" ON "asset_movements" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_asset_revaluations_tenant" ON "asset_revaluations" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_automation_campaigns_tenant" ON "automation_campaigns" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_bank_statement_lines_tenant" ON "bank_statement_lines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_bom_submission_lines_tenant" ON "bom_submission_lines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_bom_submissions_tenant" ON "bom_submissions" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_budget_drivers_tenant" ON "budget_drivers" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_budget_scenarios_tenant" ON "budget_scenarios" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_buffet_package_items_tenant" ON "buffet_package_items" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_campaign_reads_tenant" ON "campaign_reads" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_cash_movements_tenant" ON "cash_movements" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_channel_adapters_tenant" ON "channel_adapters" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_channel_webhook_events_tenant" ON "channel_webhook_events" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_close_run_steps_tenant" ON "close_run_steps" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_combo_components_tenant" ON "combo_components" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_connector_syncs_tenant" ON "connector_syncs" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_connectors_tenant" ON "connectors" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_consol_elimination_rules_tenant" ON "consol_elimination_rules" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_cust_bom_tenant" ON "cust_bom" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_cust_bom_lines_tenant" ON "cust_bom_lines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_cust_prod_runs_tenant" ON "cust_prod_runs" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_cust_stock_log_tenant" ON "cust_stock_log" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_cust_variance_tenant" ON "cust_variance" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_customer_inventory_tenant" ON "customer_inventory" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_customer_items_tenant" ON "customer_items" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_delivery_orders_tenant" ON "delivery_orders" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_depreciation_lines_tenant" ON "depreciation_lines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_dine_in_order_items_tenant" ON "dine_in_order_items" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_doc_counters_tenant_tenant" ON "doc_counters_tenant" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_einvoice_config_tenant" ON "einvoice_config" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_etax_submissions_tenant" ON "etax_submissions" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_floor_zones_tenant" ON "floor_zones" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_forecast_lines_tenant" ON "forecast_lines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_fraud_risks_tenant" ON "fraud_risks" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_gift_card_txns_tenant" ON "gift_card_txns" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_gift_cards_tenant" ON "gift_cards" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_gl_audit_log_tenant" ON "gl_audit_log" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_governance_oversight_tenant" ON "governance_oversight" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_ic_settlements_tenant" ON "ic_settlements" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_ic_transactions_tenant" ON "ic_transactions" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_invoice_match_results_tenant" ON "invoice_match_results" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_kitchen_stations_tenant" ON "kitchen_stations" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_labor_alerts_tenant" ON "labor_alerts" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_leases_tenant" ON "leases" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_leave_balances_tenant" ON "leave_balances" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_loyalty_mission_progress_tenant" ON "loyalty_mission_progress" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_loyalty_privilege_claims_tenant" ON "loyalty_privilege_claims" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_loyalty_privileges_tenant" ON "loyalty_privileges" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_loyalty_referrals_tenant" ON "loyalty_referrals" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_loyalty_tier_history_tenant" ON "loyalty_tier_history" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_loyalty_tiers_tenant" ON "loyalty_tiers" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_loyalty_txn_tenant" ON "loyalty_txn" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_loyalty_wheel_segments_tenant" ON "loyalty_wheel_segments" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_maintenance_wo_lines_tenant" ON "maintenance_wo_lines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_menu_item_modifier_groups_tenant" ON "menu_item_modifier_groups" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_menu_recipe_lines_tenant" ON "menu_recipe_lines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_migration_jobs_tenant" ON "migration_jobs" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_modifier_options_tenant" ON "modifier_options" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_my_customers_tenant" ON "my_customers" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_my_purchase_orders_tenant" ON "my_purchase_orders" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_my_suppliers_tenant" ON "my_suppliers" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_order_delivery_details_tenant" ON "order_delivery_details" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_orders_tenant" ON "orders" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_payment_intents_tenant" ON "payment_intents" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_payment_refunds_tenant" ON "payment_refunds" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_payment_terminals_tenant" ON "payment_terminals" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_payslips_tenant" ON "payslips" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_pending_orders_tenant" ON "pending_orders" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_performance_obligations_tenant" ON "performance_obligations" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_pick_list_lines_tenant" ON "pick_list_lines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_pick_waves_tenant" ON "pick_waves" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_pm_schedules_tenant" ON "pm_schedules" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_pos_check_splits_tenant" ON "pos_check_splits" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_pos_held_orders_tenant" ON "pos_held_orders" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_pos_member_ledger_tenant" ON "pos_member_ledger" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_pos_overrides_tenant" ON "pos_overrides" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_pos_return_items_tenant" ON "pos_return_items" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_pos_returns_tenant" ON "pos_returns" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_posting_rules_tenant" ON "posting_rules" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_prepaid_schedules_tenant" ON "prepaid_schedules" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_price_list_tenant" ON "price_list" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_price_rules_tenant" ON "price_rules" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_pricing_rules_tenant" ON "pricing_rules" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_project_baselines_tenant" ON "project_baselines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_project_change_orders_tenant" ON "project_change_orders" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_project_entries_tenant" ON "project_entries" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_project_health_snapshots_tenant" ON "project_health_snapshots" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_project_milestones_tenant" ON "project_milestones" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_project_risks_tenant" ON "project_risks" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_project_tasks_tenant" ON "project_tasks" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_project_template_items_tenant" ON "project_template_items" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_promo_audience_rules_tenant" ON "promo_audience_rules" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_promo_redemptions_tenant" ON "promo_redemptions" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_promotion_items_tenant" ON "promotion_items" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_reason_codes_tenant" ON "reason_codes" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_receipt_prints_tenant" ON "receipt_prints" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_recurring_journals_tenant" ON "recurring_journals" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_refund_liability_tenant" ON "refund_liability" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_report_subscriptions_tenant" ON "report_subscriptions" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_rev_rec_lines_tenant" ON "rev_rec_lines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_rfqs_tenant" ON "rfqs" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_rma_lines_tenant" ON "rma_lines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_rmas_tenant" ON "rmas" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_routing_operations_tenant" ON "routing_operations" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_sales_returns_tenant" ON "sales_returns" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_settlement_batches_tenant" ON "settlement_batches" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_shipments_tenant" ON "shipments" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_subscriptions_tenant" ON "subscriptions" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_supplier_quotes_tenant" ON "supplier_quotes" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_supplier_scorecards_tenant" ON "supplier_scorecards" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_survey_responses_tenant" ON "survey_responses" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_table_sessions_tenant" ON "table_sessions" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_tax_invoice_lines_tenant" ON "tax_invoice_lines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_till_sessions_tenant" ON "till_sessions" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_time_clock_tenant" ON "time_clock" (tenant_id);
-- Restored (was briefly deleted by the hotfix PR #353 while the real fix — the 0145/0146 backfill above —
-- was in flight): the table is tenant-scoped and the tenant-idx harness fails on ANY uncovered table.
CREATE INDEX IF NOT EXISTS "idx_tip_distribution_lines_tenant" ON "tip_distribution_lines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_users_tenant" ON "users" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_whistleblower_cases_tenant" ON "whistleblower_cases" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_wht_cert_lines_tenant" ON "wht_cert_lines" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_work_centers_tenant" ON "work_centers" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_work_order_components_tenant" ON "work_order_components" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_work_order_operations_tenant" ON "work_order_operations" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_workflow_steps_tenant" ON "workflow_steps" (tenant_id);
CREATE INDEX IF NOT EXISTS "idx_xz_report_denominations_tenant" ON "xz_report_denominations" (tenant_id);
-- Post-merge addition (docs/27 R1-1): journey_steps arrived from the docs/25-crm series (0212_journeys)
-- without a tenant-leading index — caught by the tenant-idx guard on the main merge.
CREATE INDEX IF NOT EXISTS "idx_journey_steps_tenant" ON "journey_steps" (tenant_id);
