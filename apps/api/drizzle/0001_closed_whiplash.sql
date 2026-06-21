CREATE TYPE "public"."account_type" AS ENUM('Asset', 'Liability', 'Equity', 'Revenue', 'Expense');--> statement-breakpoint
CREATE TYPE "public"."journal_status" AS ENUM('Draft', 'Posted', 'Voided');--> statement-breakpoint
CREATE TYPE "public"."period_status" AS ENUM('Open', 'Closed');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('Pending', 'Authorized', 'Captured', 'Failed', 'Refunded', 'Voided');--> statement-breakpoint
CREATE TYPE "public"."till_status" AS ENUM('Open', 'Closed');--> statement-breakpoint
CREATE TYPE "public"."sub_status" AS ENUM('Trialing', 'Active', 'PastDue', 'Canceled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint,
	"name" text,
	"prefix" text NOT NULL,
	"hashed_key" text NOT NULL,
	"scopes" text DEFAULT '',
	"last_used_at" timestamp with time zone,
	"revoked" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now(),
	"actor" text,
	"tenant_id" bigint,
	"action" text,
	"entity" text,
	"entity_id" text,
	"ip" text,
	"request_id" text,
	"trace_id" text,
	"status" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"webhook_id" bigint,
	"event" text,
	"payload" jsonb,
	"status" text DEFAULT 'pending',
	"status_code" integer,
	"attempts" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhooks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint,
	"url" text NOT NULL,
	"events" text DEFAULT '',
	"secret" text NOT NULL,
	"active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"parent_code" text,
	"currency" text DEFAULT 'THB',
	"active" text DEFAULT 'true',
	CONSTRAINT "accounts_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fiscal_periods" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "period_status" DEFAULT 'Open',
	CONSTRAINT "fiscal_periods_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entry_no" text NOT NULL,
	"entry_date" date NOT NULL,
	"period" text,
	"memo" text,
	"source" text,
	"source_ref" text,
	"tenant_id" bigint,
	"currency" text DEFAULT 'THB',
	"status" "journal_status" DEFAULT 'Posted',
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "journal_entries_entry_no_unique" UNIQUE("entry_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entry_id" bigint NOT NULL,
	"account_code" text NOT NULL,
	"debit" numeric(18, 4) DEFAULT '0',
	"credit" numeric(18, 4) DEFAULT '0',
	"currency" text DEFAULT 'THB',
	"memo" text,
	"tenant_id" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_refunds" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"refund_no" text NOT NULL,
	"payment_no" text NOT NULL,
	"tenant_id" bigint,
	"amount" numeric(18, 4) NOT NULL,
	"reason" text,
	"status" text DEFAULT 'Refunded',
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "payment_refunds_refund_no_unique" UNIQUE("refund_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"payment_no" text NOT NULL,
	"sale_no" text,
	"tenant_id" bigint,
	"till_session_id" bigint,
	"method" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency" text DEFAULT 'THB',
	"gateway" text DEFAULT 'mock',
	"gateway_ref" text,
	"status" "payment_status" DEFAULT 'Captured',
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"captured_at" timestamp with time zone,
	CONSTRAINT "payments_payment_no_unique" UNIQUE("payment_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "till_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_no" text NOT NULL,
	"tenant_id" bigint,
	"opened_by" text,
	"opened_at" timestamp with time zone DEFAULT now(),
	"opening_float" numeric(18, 4) DEFAULT '0',
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"closing_count" numeric(18, 4),
	"expected_cash" numeric(18, 4),
	"variance" numeric(18, 4),
	"status" "till_status" DEFAULT 'Open',
	CONSTRAINT "till_sessions_session_no_unique" UNIQUE("session_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plans" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_monthly" numeric(12, 2) DEFAULT '0',
	"currency" text DEFAULT 'THB',
	"features" jsonb,
	"active" text DEFAULT 'true'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"plan_code" text NOT NULL,
	"status" "sub_status" DEFAULT 'Trialing',
	"trial_ends_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sso_subject" text;--> statement-breakpoint
ALTER TABLE "cust_pos_sales" ADD COLUMN "currency" text DEFAULT 'THB';--> statement-breakpoint
ALTER TABLE "cust_pos_sales" ADD COLUMN "fx_rate" numeric(18, 8) DEFAULT '1';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "currency" text DEFAULT 'THB';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fx_rate" numeric(18, 8) DEFAULT '1';--> statement-breakpoint
ALTER TABLE "ar_invoices" ADD COLUMN "currency" text DEFAULT 'THB';--> statement-breakpoint
ALTER TABLE "ar_invoices" ADD COLUMN "fx_rate" numeric(18, 8) DEFAULT '1';--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "till_sessions" ADD CONSTRAINT "till_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_actor" ON "audit_log" USING btree ("actor");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_ts" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_je_source" ON "journal_entries" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jl_account" ON "journal_lines" USING btree ("account_code");