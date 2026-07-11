-- 0330_posting_rule_governance — docs/43 PR-1 (control GL-24): the posting-event catalogue grows to the
-- full registry (74 events — see apps/api/src/modules/ledger/posting-events.ts, the single source of
-- truth this seed is generated from), and tenant posting-rule changes become GOVERNED config:
--   • posting_rules gains status ('Approved' default so pre-existing rows + direct harness seeds are
--     grandfathered; the API writes 'PendingApproval'), created_by / approved_by / approved_at.
--   • posting_rule_audit — append-only trail of every CREATE/APPROVE/REJECT/DEACTIVATE on a rule
--     (tenant-scoped: leading (tenant_id,…) index + the canonical 0232-form RLS policy via the DO-loop).
-- The resolver (LedgerService.postingOverrides) consumes ONLY active + Approved rules.
INSERT INTO posting_event_types (key, name, description) VALUES
  ('SALE.DELIVERY', 'Sale — delivery income', 'Delivery-fee income on channel orders'),
  ('SVC.CHARGE', 'Sale — service charge', 'Auto service-charge income (large parties)'),
  ('POS.ROUNDING', 'Sale — satang rounding', 'Cash rounding adjustment (sign-conditional legs)'),
  ('SURCHARGE.INCOME', 'Card surcharge income', 'Card surcharge collected at settlement'),
  ('TIP.COLLECT', 'Tip collected', 'Tip pass-through collected with a payment'),
  ('TIP.PAYOUT', 'Tip paid out', 'Tip pool distribution to staff'),
  ('TILL.VARIANCE', 'Till close over/short', 'Z-close cash variance (payments + hub replay share this key)'),
  ('TILL.CASHMOV', 'Till paid-in/out', 'Drawer paid-in / paid-out movement'),
  ('DEPOSIT.TAKE', 'Customer deposit taken', 'Booking/tab prepayment received'),
  ('DEPOSIT.APPLY', 'Customer deposit applied', 'Deposit recognised into a sale'),
  ('DEPOSIT.REFUND', 'Customer deposit refunded', 'Deposit returned to the customer'),
  ('INV.ADJUST', 'Inventory adjustment', 'Count/valuation adjustment (direction-conditional)'),
  ('WASTE.WRITEOFF', 'Waste write-off', 'Spoilage/waste written off stock'),
  ('MFG.WO_ISSUE', 'Work order — issue', 'Materials + applied labour/OH into WIP'),
  ('MFG.WO_COMPLETE', 'Work order — complete', 'Finished goods in; yield variance out'),
  ('QA.SCRAP', 'QC scrap disposition', 'Scrap loss written off (source credit resolved by ref type)'),
  ('PAYROLL.REMIT', 'Payroll liability remittance', 'Statutory liability remitted to RD/SSO'),
  ('ASSET.ACQUIRE', 'Asset acquisition', 'Capitalise an asset (per-category accounts are the docs/43 Q2 grain — this event is catalog visibility)'),
  ('ASSET.DISPOSE', 'Asset disposal', 'Derecognition with gain/loss'),
  ('ASSET.REVALUE', 'Asset revaluation / impairment', 'Revaluation surplus up / impairment down'),
  ('ASSET.CIP_COST', 'CIP cost accumulation', 'Construction-in-progress cost (FA-13)'),
  ('LEASE.COMMENCE', 'Lease commencement', 'ROU + liability at PV (LSE-01 schedule ties both)'),
  ('LEASE.MODIFY', 'Lease remeasurement', 'Modification/termination remeasurement'),
  ('LEASE.LESSOR_COMMENCE', 'Lessor finance-lease commencement', 'Derecognise asset → net investment (LSE-02)'),
  ('LEASE.LESSOR_FINANCE', 'Lessor finance-lease receipt', 'Collection: interest income + principal'),
  ('LEASE.LESSOR_OPERATING', 'Lessor operating-lease receipt', 'Straight-line rental + continued depreciation'),
  ('APPAY.WHT', 'AP payment — vendor WHT', 'ภ.ง.ด.3/53 withholding at AP payment (shared by AP pay + subcontract valuations)'),
  ('APPAY.DISCOUNT', 'AP early-payment discount', 'Prompt-payment discount captured on a run (EXP-14)'),
  ('RCVAT.SELF', 'Reverse-charge self VAT', 'ภ.พ.36 self-assessed VAT on imported services'),
  ('BANK.INTEREST', 'Bank interest income', 'Bank-rec adjustment: interest earned'),
  ('BANK.FEE', 'Bank fee expense', 'Bank-rec adjustment: charges'),
  ('PETTY.TOPUP', 'Petty-cash replenishment', 'Imprest float top-up (fund GL per-fund)'),
  ('PETTY.EXPENSE', 'Petty-cash expense', 'Expense paid from the float'),
  ('REVENUE.DEFER', 'Revenue deferred', 'Cash received into deferred revenue'),
  ('REVENUE.RECOGNIZE', 'Revenue recognized', 'Deferred → earned per schedule (per-schedule accounts already supported)'),
  ('MEMBERSHIP.DEFER', 'Membership sold (deferred)', 'VIP membership fee into contract liability'),
  ('MEMBERSHIP.RECOGNIZE', 'Membership recognized', 'Membership revenue earned over the term'),
  ('LOYALTY.ACCRUE', 'Loyalty points accrual', 'Points liability provision (TFRS 15)'),
  ('PREPAID.CAPITALIZE', 'Prepaid capitalised', 'Up-front payment into the prepaid asset'),
  ('PREPAID.AMORTIZE', 'Prepaid amortised', 'Monthly amortisation of the prepaid'),
  ('SBT.TAX', 'Specific business tax', 'ภ.ธ.40 SBT accrued at RE ownership transfer (TAX-09)'),
  ('IC.SETTLE', 'Intercompany settlement', 'Cash settlement of the IC pair'),
  ('PROJECT.BILLING', 'POC progress invoice', 'Contract asset relief / billings in excess'),
  ('REALESTATE.BOOK', 'RE booking deposit', 'Unit booking deposit received'),
  ('REALESTATE.CONTRACT', 'RE contract down payment', 'Contract signing: deposit reclass + down payment'),
  ('REALESTATE.INSTALL', 'RE installment received', 'Installment into the contract liability')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
ALTER TABLE posting_rules ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Approved';
--> statement-breakpoint
ALTER TABLE posting_rules ADD COLUMN IF NOT EXISTS created_by text;
--> statement-breakpoint
ALTER TABLE posting_rules ADD COLUMN IF NOT EXISTS approved_by text;
--> statement-breakpoint
ALTER TABLE posting_rules ADD COLUMN IF NOT EXISTS approved_at timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS posting_rule_audit (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  rule_id bigint,
  action text NOT NULL,
  actor text,
  detail jsonb,
  at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_posting_rule_audit_tenant ON posting_rule_audit (tenant_id, rule_id);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new
-- audit table gets RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))',
      r.table_name);
  END LOOP;
END $$;
