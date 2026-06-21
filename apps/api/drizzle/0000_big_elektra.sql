CREATE TYPE "public"."claim_status" AS ENUM('Waiting', 'Approved', 'Rejected');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('Unpaid', 'Partial', 'Paid', 'Cancelled');--> statement-breakpoint
CREATE TYPE "public"."lot_status" AS ENUM('Active', 'Consumed', 'Expired', 'Quarantine');--> statement-breakpoint
CREATE TYPE "public"."move_type" AS ENUM('Issue', 'Transfer', 'GR', 'Return', 'Stock In', 'Stock Out');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('Pending', 'Processing', 'Shipped', 'Completed', 'Claimed', 'Cancelled');--> statement-breakpoint
CREATE TYPE "public"."po_status" AS ENUM('Draft', 'Pending', 'Approved', 'Received', 'Closed', 'Cancelled');--> statement-breakpoint
CREATE TYPE "public"."pos_status" AS ENUM('Completed', 'Voided', 'Open');--> statement-breakpoint
CREATE TYPE "public"."role_enum" AS ENUM('Admin', 'Sales', 'Customer', 'Warehouse', 'Procurement', 'Planner');--> statement-breakpoint
CREATE TYPE "public"."stocktake_status" AS ENUM('Draft', 'Posted');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"phone" text,
	"email" text,
	"tax_id" text,
	"address" text,
	"credit_term" text,
	"credit_limit" numeric(14, 2) DEFAULT '0',
	"credit_hold" boolean DEFAULT false,
	"outstanding_ar" numeric(14, 2) DEFAULT '0',
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "tenants_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "permissions" (
	"key" text PRIMARY KEY NOT NULL,
	"emoji" text,
	"label_th" text,
	"label_en" text,
	"grp" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_permissions" (
	"role" "role_enum" NOT NULL,
	"perm" text NOT NULL,
	CONSTRAINT "role_permissions_role_perm_pk" PRIMARY KEY("role","perm")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_permissions" (
	"user_id" bigint NOT NULL,
	"perm" text NOT NULL,
	CONSTRAINT "user_permissions_user_id_perm_pk" PRIMARY KEY("user_id","perm")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "role_enum" DEFAULT 'Sales' NOT NULL,
	"tenant_id" bigint,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"item_description" text,
	"uom" text,
	"base_uom" text,
	"conversion_factor" numeric DEFAULT '1',
	"unit_price" numeric(14, 2) DEFAULT '0',
	"category" text,
	"temperature_type" text,
	"bu_id" text,
	"min_stock" numeric DEFAULT '0',
	"max_stock" numeric DEFAULT '9999',
	"avg_daily_usage" numeric DEFAULT '0',
	"lead_time_days" numeric DEFAULT '3',
	"image_key" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "items_item_id_unique" UNIQUE("item_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "location_stock" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"location_id" text,
	"item_id" text,
	"item_description" text,
	"lot_no" text,
	"qty" numeric,
	"uom" text,
	"expiry_date" date,
	"last_updated" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locations" (
	"location_id" text PRIMARY KEY NOT NULL,
	"location_name" text,
	"zone" text DEFAULT 'Main',
	"type" text DEFAULT 'Storage',
	"capacity" numeric,
	"temperature" text DEFAULT 'Ambient',
	"active" boolean DEFAULT true,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lot_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lot_no" text,
	"item_id" text,
	"item_description" text,
	"uom" text,
	"location_id" text DEFAULT 'WH-MAIN',
	"gr_no" text,
	"qty_in" numeric,
	"qty_out" numeric,
	"balance" numeric,
	"mfg_date" date,
	"expiry_date" date,
	"status" "lot_status" DEFAULT 'Active',
	"move_date" timestamp with time zone,
	"ref_doc" text,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scan_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_no" text,
	"scanned_at" timestamp with time zone,
	"qr_data" text,
	"item_id" text,
	"item_description" text,
	"lot_no" text,
	"expiry_date" date,
	"qty" numeric DEFAULT '1',
	"uom" text,
	"action" text,
	"location_id" text,
	"confirmed" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scan_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_no" text,
	"session_type" text,
	"location_id" text,
	"doc_ref" text,
	"status" text DEFAULT 'Open',
	"created_by" text,
	"created_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "scan_sessions_session_no_unique" UNIQUE("session_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"move_date" timestamp with time zone,
	"doc_no" text,
	"move_type" "move_type",
	"item_id" text,
	"item_description" text,
	"uom" text,
	"qty" numeric,
	"from_location" text,
	"to_location" text,
	"ref_doc" text,
	"remarks" text,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"generate_date" timestamp with time zone NOT NULL,
	"item_id" text NOT NULL,
	"item_description" text,
	"uom" text,
	"temperature_type" text,
	"bu_id" text,
	"expiry_date" date,
	"av_qty" numeric,
	"delivery_qty" integer,
	"total_stock" numeric
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stocktakes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"st_no" text,
	"st_date" date,
	"item_id" text,
	"item_description" text,
	"uom" text,
	"system_qty" numeric,
	"physical_qty" numeric,
	"difference" numeric,
	"counted_by" text,
	"status" "stocktake_status" DEFAULT 'Draft',
	"remarks" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cust_pos_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_id" bigint,
	"item_id" text,
	"item_description" text,
	"qty" numeric,
	"uom" text,
	"unit_price" numeric(14, 2),
	"discount_pct" numeric DEFAULT '0',
	"amount" numeric(14, 2),
	"is_custom" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cust_pos_sales" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_no" text NOT NULL,
	"sale_date" date,
	"tenant_id" bigint,
	"subtotal" numeric(14, 2),
	"discount" numeric(14, 2),
	"tax_amount" numeric(14, 2),
	"total" numeric(14, 2),
	"payment_method" text DEFAULT 'Cash',
	"points_used" numeric DEFAULT '0',
	"points_earned" numeric DEFAULT '0',
	"status" "pos_status" DEFAULT 'Completed',
	"notes" text,
	"created_by" text,
	CONSTRAINT "cust_pos_sales_sale_no_unique" UNIQUE("sale_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_claims" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_line_id" bigint,
	"claimed_qty" numeric,
	"claim_reason" text,
	"claim_image_key" text,
	"admin_status" "claim_status" DEFAULT 'Waiting',
	"reject_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" bigint,
	"item_id" text,
	"item_description" text,
	"order_qty" numeric,
	"stock_uom" text,
	"unit_price" numeric(14, 2),
	"total_price" numeric(14, 2),
	"status" "order_status" DEFAULT 'Pending',
	"received_qty" numeric DEFAULT '0'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_no" text NOT NULL,
	"order_date" date,
	"tenant_id" bigint,
	"status" "order_status" DEFAULT 'Pending',
	"estimated_delivery" date,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "orders_order_no_unique" UNIQUE("order_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_order_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"pending_id" bigint,
	"item_id" text,
	"item_description" text,
	"suggested_qty" numeric,
	"final_qty" numeric,
	"uom" text,
	"unit_price" numeric(14, 2),
	"trigger_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_orders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"pending_no" text NOT NULL,
	"tenant_id" bigint,
	"created_at" timestamp with time zone,
	"status" text DEFAULT 'Draft',
	"trigger_type" text DEFAULT 'Auto',
	"total_items" numeric,
	"notes" text,
	CONSTRAINT "pending_orders_pending_no_unique" UNIQUE("pending_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "return_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"return_id" bigint,
	"item_id" text,
	"item_description" text,
	"return_qty" numeric,
	"uom" text,
	"unit_price" numeric(14, 2),
	"amount" numeric(14, 2),
	"reason" text,
	"return_to_stock" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_returns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"return_no" text NOT NULL,
	"return_date" date,
	"tenant_id" bigint,
	"order_no" text,
	"return_type" text DEFAULT 'Return',
	"status" text DEFAULT 'Approved',
	"total_amount" numeric(14, 2),
	"remarks" text,
	"created_by" text,
	"created_at" timestamp with time zone,
	CONSTRAINT "sales_returns_return_no_unique" UNIQUE("return_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goods_receipts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gr_no" text NOT NULL,
	"gr_date" date,
	"po_no" text,
	"vendor_id" bigint,
	"vendor_name" text,
	"received_by" text,
	"remarks" text,
	CONSTRAINT "goods_receipts_gr_no_unique" UNIQUE("gr_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gr_claims" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"claim_no" text NOT NULL,
	"claim_date" date,
	"gr_no" text,
	"po_no" text,
	"vendor_id" bigint,
	"item_id" text,
	"item_description" text,
	"gr_qty" numeric,
	"claim_qty" numeric,
	"uom" text,
	"reason" text,
	"image_key" text,
	"status" text DEFAULT 'Open',
	"supplier_action" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"remarks" text,
	CONSTRAINT "gr_claims_claim_no_unique" UNIQUE("claim_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gr_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gr_id" bigint,
	"po_no" text,
	"item_id" text,
	"item_description" text,
	"po_qty" numeric,
	"received_qty" numeric,
	"uom" text,
	"lot_no" text,
	"expiry_date" date,
	"unit_cost" numeric(14, 2),
	"remarks" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "po_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"po_id" bigint,
	"delivery_no" integer,
	"item_id" text,
	"scheduled_qty" numeric,
	"scheduled_date" date,
	"received_qty" numeric DEFAULT '0',
	"status" text DEFAULT 'Pending'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "po_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"po_id" bigint,
	"item_id" text,
	"item_description" text,
	"order_qty" numeric,
	"unit_price" numeric(14, 2),
	"uom" text,
	"amount" numeric(14, 2),
	"received_qty" numeric DEFAULT '0',
	"status" text DEFAULT 'Open'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pr_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"pr_id" bigint,
	"item_id" text,
	"item_description" text,
	"request_qty" numeric,
	"uom" text,
	"required_date" date,
	"reason" text,
	"po_no" text,
	"status" text DEFAULT 'Open'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_orders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"po_no" text NOT NULL,
	"po_date" date,
	"vendor_id" bigint,
	"vendor_name" text,
	"status" "po_status" DEFAULT 'Draft',
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"remarks" text,
	"total_amount" numeric(14, 2),
	"created_by" text,
	"expected_date" date,
	CONSTRAINT "purchase_orders_po_no_unique" UNIQUE("po_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"pr_no" text NOT NULL,
	"pr_date" date,
	"requested_by" text,
	"status" text DEFAULT 'Draft',
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"remarks" text,
	"priority" text DEFAULT 'Normal',
	CONSTRAINT "purchase_requests_pr_no_unique" UNIQUE("pr_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"req_date" date,
	"supplier_name" text,
	"contact" text,
	"phone" text,
	"email" text,
	"address" text,
	"payment_terms" text,
	"lead_time_days" integer,
	"requested_by" text,
	"status" text DEFAULT 'Pending',
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"remarks" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendors" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vendor_code" text,
	"name" text NOT NULL,
	"is_supplier" boolean DEFAULT true,
	"is_creditor" boolean DEFAULT false,
	"contact" text,
	"phone" text,
	"email" text,
	"address" text,
	"tax_id" text,
	"payment_terms" text DEFAULT 'Cash',
	"lead_time_days" integer DEFAULT 3,
	"rating" numeric DEFAULT '3.0',
	"bank_name" text,
	"bank_account" text,
	"credit_limit" numeric(14, 2),
	"currency" text DEFAULT 'THB',
	"category" text DEFAULT 'Supplier',
	"active" boolean DEFAULT true,
	"notes" text,
	CONSTRAINT "vendors_vendor_code_unique" UNIQUE("vendor_code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ap_transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"txn_no" text NOT NULL,
	"vendor_id" bigint,
	"vendor_name" text,
	"ref_doc" text,
	"txn_type" text,
	"invoice_no" text,
	"invoice_date" date,
	"due_date" date,
	"amount" numeric(14, 2),
	"paid_amount" numeric(14, 2) DEFAULT '0',
	"currency" text DEFAULT 'THB',
	"status" "invoice_status" DEFAULT 'Unpaid',
	"remarks" text,
	"created_by" text,
	"created_at" timestamp with time zone,
	CONSTRAINT "ap_transactions_txn_no_unique" UNIQUE("txn_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ar_invoices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"invoice_no" text NOT NULL,
	"invoice_date" date,
	"due_date" date,
	"tenant_id" bigint,
	"order_no" text,
	"amount" numeric(14, 2),
	"paid_amount" numeric(14, 2) DEFAULT '0',
	"status" "invoice_status" DEFAULT 'Unpaid',
	"remarks" text,
	"created_by" text,
	"created_at" timestamp with time zone,
	CONSTRAINT "ar_invoices_invoice_no_unique" UNIQUE("invoice_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ar_receipts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"receipt_no" text NOT NULL,
	"receipt_date" date,
	"tenant_id" bigint,
	"invoice_no" text,
	"amount" numeric(14, 2),
	"method" text DEFAULT 'Transfer',
	"ref_no" text,
	"remarks" text,
	"created_by" text,
	"created_at" timestamp with time zone,
	CONSTRAINT "ar_receipts_receipt_no_unique" UNIQUE("receipt_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bom_master" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bom_code" text NOT NULL,
	"product_name" text,
	"yield_qty" numeric DEFAULT '1',
	"yield_uom" text,
	"labor_cost" numeric(14, 2),
	"overhead_cost" numeric(14, 2),
	"other_cost" numeric(14, 2),
	"selling_price" numeric(14, 2),
	"notes" text,
	"created_at" timestamp with time zone,
	"created_by" text,
	CONSTRAINT "bom_master_bom_code_unique" UNIQUE("bom_code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bom_master_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bom_id" bigint,
	"item_id" text,
	"item_description" text,
	"buy_uom" text,
	"use_uom" text,
	"conv_factor" numeric DEFAULT '1',
	"qty_use_uom" numeric,
	"qty_buy_uom" numeric,
	"unit_cost" numeric(14, 2),
	"line_cost" numeric(14, 2),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bom_submission_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"submission_id" bigint,
	"tenant_id" bigint,
	"item_id" text,
	"item_description" text,
	"buy_uom" text,
	"use_uom" text,
	"conv_factor" numeric DEFAULT '1',
	"qty_use_uom" numeric,
	"qty_buy_uom" numeric,
	"unit_cost" numeric(14, 2),
	"line_cost" numeric(14, 2),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bom_submissions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bom_code" text,
	"tenant_id" bigint,
	"product_name" text,
	"yield_qty" numeric,
	"yield_uom" text,
	"labor_cost" numeric(14, 2),
	"overhead_cost" numeric(14, 2),
	"other_cost" numeric(14, 2),
	"selling_price" numeric(14, 2),
	"notes" text,
	"submitted_at" timestamp with time zone,
	"status" text DEFAULT 'Pending'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cust_bom" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bom_code" text,
	"tenant_id" bigint,
	"product_name" text,
	"product_item_id" text,
	"yield_qty" numeric,
	"yield_uom" text,
	"labor_cost" numeric(14, 2),
	"overhead_cost" numeric(14, 2),
	"other_cost" numeric(14, 2),
	"selling_price" numeric(14, 2),
	"active" boolean DEFAULT true,
	"notes" text,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cust_bom_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cust_bom_id" bigint,
	"tenant_id" bigint,
	"item_id" text,
	"item_description" text,
	"buy_uom" text,
	"use_uom" text,
	"conv_factor" numeric DEFAULT '1',
	"qty_use_uom" numeric,
	"qty_buy_uom" numeric,
	"unit_cost" numeric(14, 2),
	"line_cost" numeric(14, 2),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cust_prod_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint,
	"item_id" text,
	"item_description" text,
	"theoretical_qty" numeric,
	"actual_qty" numeric,
	"variance" numeric,
	"uom" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cust_prod_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_no" text NOT NULL,
	"bom_code" text,
	"tenant_id" bigint,
	"run_date" date,
	"batch_qty" numeric DEFAULT '1',
	"status" text DEFAULT 'Completed',
	"total_cost" numeric(14, 2),
	"created_by" text,
	CONSTRAINT "cust_prod_runs_run_no_unique" UNIQUE("run_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cust_variance" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"var_date" date,
	"tenant_id" bigint,
	"item_id" text,
	"item_description" text,
	"bom_code" text,
	"theoretical_use" numeric,
	"actual_use" numeric,
	"variance" numeric,
	"variance_pct" numeric,
	"uom" text,
	"reason" text,
	"shift" text DEFAULT 'Day'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cust_stock_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint,
	"item_id" text,
	"item_description" text,
	"log_date" timestamp with time zone,
	"log_type" text,
	"qty_change" numeric,
	"balance_after" numeric,
	"ref_doc" text,
	"notes" text,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_inventory" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint,
	"item_id" text,
	"item_description" text,
	"uom" text,
	"current_stock" numeric,
	"reorder_point" numeric,
	"reorder_qty" numeric,
	"last_updated" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint,
	"item_id" text,
	"item_name" text,
	"category" text,
	"unit_price" numeric(14, 2),
	"uom" text,
	"description" text,
	"created_at" timestamp with time zone,
	"synced_central" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "my_customers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint,
	"customer_name" text,
	"phone" text,
	"address" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "my_po_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"my_po_id" bigint,
	"item_description" text,
	"qty" numeric,
	"uom" text,
	"unit_price" numeric(14, 2),
	"amount" numeric(14, 2)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "my_purchase_orders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"po_no" text NOT NULL,
	"tenant_id" bigint,
	"po_date" text,
	"supplier_name" text,
	"total_amount" numeric(14, 2),
	"status" text DEFAULT 'Issued',
	"remarks" text,
	CONSTRAINT "my_purchase_orders_po_no_unique" UNIQUE("po_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "my_suppliers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint,
	"supplier_name" text,
	"contact_name" text,
	"phone" text,
	"address" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ab_tests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"test_id" text,
	"test_name" text,
	"campaign_id" text,
	"status" text DEFAULT 'Running',
	"start_date" date,
	"end_date" date,
	"winner" text,
	"created_by" text,
	"created_at" timestamp with time zone,
	CONSTRAINT "ab_tests_test_id_unique" UNIQUE("test_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ab_variants" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"test_id" text,
	"variant" text,
	"content_text" text,
	"image_key" text,
	"impressions" integer DEFAULT 0,
	"clicks" integer DEFAULT 0,
	"conversions" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abandoned_carts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint,
	"cart_data" jsonb,
	"created_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"recovered" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_reads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"campaign_id" text,
	"tenant_id" bigint,
	"read_at" timestamp with time zone,
	"action" text DEFAULT 'Closed'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loyalty_config" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false,
	"points_per_baht" numeric DEFAULT '1.0',
	"baht_per_point" numeric DEFAULT '0.1',
	"min_redeem" numeric DEFAULT '100',
	"expiry_days" integer DEFAULT 365,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loyalty_points" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint,
	"balance" numeric DEFAULT '0',
	"lifetime" numeric DEFAULT '0',
	"last_updated" timestamp with time zone,
	CONSTRAINT "loyalty_points_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loyalty_txn" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint,
	"txn_date" timestamp with time zone,
	"txn_type" text,
	"points" numeric,
	"balance_after" numeric,
	"ref_doc" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketing_campaigns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"campaign_id" text,
	"campaign_name" text,
	"campaign_type" text DEFAULT 'Popup',
	"content_text" text,
	"image_key" text,
	"ticker_text" text,
	"start_date" date,
	"end_date" date,
	"target_type" text DEFAULT 'All',
	"target_value" text,
	"priority" integer,
	"active" boolean DEFAULT true,
	"created_by" text,
	"created_at" timestamp with time zone,
	CONSTRAINT "marketing_campaigns_campaign_id_unique" UNIQUE("campaign_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_list" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"list_name" text DEFAULT 'Standard',
	"tenant_id" bigint,
	"item_id" text,
	"item_description" text,
	"base_price" numeric(14, 2),
	"special_price" numeric(14, 2),
	"discount_pct" numeric,
	"min_qty" numeric DEFAULT '1',
	"valid_from" date,
	"valid_to" date,
	"active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promotion_items" (
	"promo_id" bigint NOT NULL,
	"item_id" text NOT NULL,
	CONSTRAINT "promotion_items_promo_id_item_id_pk" PRIMARY KEY("promo_id","item_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promotions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"promo_id" text,
	"promo_name" text,
	"promo_type" text,
	"start_date" date,
	"end_date" date,
	"min_qty" numeric,
	"min_amount" numeric(14, 2),
	"discount_pct" numeric,
	"discount_amt" numeric(14, 2),
	"free_item_id" text,
	"free_qty" numeric,
	"customer_group" text DEFAULT 'All',
	"category" text,
	"max_uses" integer,
	"used_count" integer DEFAULT 0,
	"active" boolean DEFAULT true,
	"notes" text,
	CONSTRAINT "promotions_promo_id_unique" UNIQUE("promo_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "survey_answers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"response_id" bigint,
	"question_no" integer,
	"answer" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "survey_responses" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"survey_id" text,
	"tenant_id" bigint,
	"order_no" text,
	"response_date" date,
	"nps_score" integer,
	"comments" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "surveys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"survey_id" text,
	"survey_name" text,
	"survey_type" text DEFAULT 'NPS',
	"trigger" text DEFAULT 'Post-Delivery',
	"active" boolean DEFAULT true,
	"created_at" timestamp with time zone,
	CONSTRAINT "surveys_survey_id_unique" UNIQUE("survey_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_orders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"do_no" text NOT NULL,
	"do_date" date,
	"tenant_id" bigint,
	"address" text,
	"driver" text,
	"vehicle" text,
	"status" text DEFAULT 'Pending',
	"delivered_at" timestamp with time zone,
	"pod_image_key" text,
	"remarks" text,
	"created_by" text,
	CONSTRAINT "delivery_orders_do_no_unique" UNIQUE("do_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "do_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"do_id" bigint,
	"order_no" text,
	"item_id" text,
	"item_description" text,
	"qty" numeric,
	"uom" text,
	"status" text DEFAULT 'Pending'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "doc_counters" (
	"doc_type" text NOT NULL,
	"day" text NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "doc_counters_doc_type_day_pk" PRIMARY KEY("doc_type","day")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "doc_number_config" (
	"doc_type" text PRIMARY KEY NOT NULL,
	"format" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "doc_status_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"doc_type" text,
	"doc_no" text,
	"old_status" text,
	"new_status" text,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now(),
	"remarks" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"target_tenant_id" bigint,
	"target_role" "role_enum",
	"message" text,
	"message_en" text,
	"is_read" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_perm_permissions_key_fk" FOREIGN KEY ("perm") REFERENCES "public"."permissions"("key") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_perm_permissions_key_fk" FOREIGN KEY ("perm") REFERENCES "public"."permissions"("key") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "location_stock" ADD CONSTRAINT "location_stock_location_id_locations_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("location_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cust_pos_items" ADD CONSTRAINT "cust_pos_items_sale_id_cust_pos_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."cust_pos_sales"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cust_pos_sales" ADD CONSTRAINT "cust_pos_sales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_claims" ADD CONSTRAINT "order_claims_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_order_items" ADD CONSTRAINT "pending_order_items_pending_id_pending_orders_id_fk" FOREIGN KEY ("pending_id") REFERENCES "public"."pending_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_orders" ADD CONSTRAINT "pending_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_id_sales_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."sales_returns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gr_claims" ADD CONSTRAINT "gr_claims_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gr_items" ADD CONSTRAINT "gr_items_gr_id_goods_receipts_id_fk" FOREIGN KEY ("gr_id") REFERENCES "public"."goods_receipts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "po_deliveries" ADD CONSTRAINT "po_deliveries_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "po_items" ADD CONSTRAINT "po_items_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pr_items" ADD CONSTRAINT "pr_items_pr_id_purchase_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."purchase_requests"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ap_transactions" ADD CONSTRAINT "ap_transactions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ar_invoices" ADD CONSTRAINT "ar_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ar_receipts" ADD CONSTRAINT "ar_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bom_master_lines" ADD CONSTRAINT "bom_master_lines_bom_id_bom_master_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."bom_master"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bom_submission_lines" ADD CONSTRAINT "bom_submission_lines_submission_id_bom_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."bom_submissions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bom_submission_lines" ADD CONSTRAINT "bom_submission_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bom_submissions" ADD CONSTRAINT "bom_submissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cust_bom" ADD CONSTRAINT "cust_bom_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cust_bom_lines" ADD CONSTRAINT "cust_bom_lines_cust_bom_id_cust_bom_id_fk" FOREIGN KEY ("cust_bom_id") REFERENCES "public"."cust_bom"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cust_bom_lines" ADD CONSTRAINT "cust_bom_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cust_prod_items" ADD CONSTRAINT "cust_prod_items_run_id_cust_prod_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."cust_prod_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cust_prod_runs" ADD CONSTRAINT "cust_prod_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cust_variance" ADD CONSTRAINT "cust_variance_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cust_stock_log" ADD CONSTRAINT "cust_stock_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_inventory" ADD CONSTRAINT "customer_inventory_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_items" ADD CONSTRAINT "customer_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "my_customers" ADD CONSTRAINT "my_customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "my_po_items" ADD CONSTRAINT "my_po_items_my_po_id_my_purchase_orders_id_fk" FOREIGN KEY ("my_po_id") REFERENCES "public"."my_purchase_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "my_purchase_orders" ADD CONSTRAINT "my_purchase_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "my_suppliers" ADD CONSTRAINT "my_suppliers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "abandoned_carts" ADD CONSTRAINT "abandoned_carts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_reads" ADD CONSTRAINT "campaign_reads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loyalty_points" ADD CONSTRAINT "loyalty_points_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loyalty_txn" ADD CONSTRAINT "loyalty_txn_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_list" ADD CONSTRAINT "price_list_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "promotion_items" ADD CONSTRAINT "promotion_items_promo_id_promotions_id_fk" FOREIGN KEY ("promo_id") REFERENCES "public"."promotions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_response_id_survey_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."survey_responses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "do_items" ADD CONSTRAINT "do_items_do_id_delivery_orders_id_fk" FOREIGN KEY ("do_id") REFERENCES "public"."delivery_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_target_tenant_id_tenants_id_fk" FOREIGN KEY ("target_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_snap_item_date" ON "stock_snapshots" USING btree ("item_id","generate_date");