import { pgTable, bigserial, bigint, text, numeric, boolean, date, timestamp, jsonb } from 'drizzle-orm/pg-core';

// จาก tbl_customers — เดิม PK = Customer_Name (string). V2: surrogate id + code = ชื่อเดิม
export const tenants = pgTable('tenants', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  code: text('code').notNull().unique(), // legacy Customer_Name / Owner_Customer
  name: text('name').notNull(),
  // ── Hybrid tenancy (0196) — groups tenants under one HQ "org". NULL until multi-company is enabled.
  // Under TENANCY_MODE=multi-company an Admin's RLS bypass is scoped to tenants sharing its org_id
  // (instead of seeing ALL tenants). Single-company deployments leave this NULL → global HQ bypass. ──
  orgId: bigint('org_id', { mode: 'number' }),
  contactName: text('contact_name'),
  phone: text('phone'),
  fax: text('fax'),
  email: text('email'),
  taxId: text('tax_id'),
  address: text('address'),
  creditTerm: text('credit_term'),
  creditLimit: numeric('credit_limit', { precision: 14, scale: 2 }).default('0'),
  creditHold: boolean('credit_hold').default(false),
  outstandingAr: numeric('outstanding_ar', { precision: 14, scale: 2 }).default('0'),
  // ── Seller identity for Thai tax invoices (ม.86/4 + ประกาศอธิบดี ฉบับที่ 199) ──
  legalName: text('legal_name'),                                   // ชื่อนิติบุคคลตามทะเบียน
  branchCode: text('branch_code').default('00000'),               // '00000'=สำนักงานใหญ่ / 'NNNNN'=สาขา
  branchLabelTh: text('branch_label_th').default('สำนักงานใหญ่'),
  vatRegistered: boolean('vat_registered').default(false),         // เฉพาะผู้จด VAT จึงออกใบกำกับภาษีได้
  vatRegDate: date('vat_reg_date'),
  vatRate: numeric('vat_rate', { precision: 6, scale: 4 }).default('0.0700'), // per-tenant VAT (0044) — TH 7% default
  taxCountry: text('tax_country').default('TH'),                    // ISO-3166 alpha-2 for TaxService provider
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  subDistrict: text('sub_district'),                              // ตำบล/แขวง
  district: text('district'),                                     // อำเภอ/เขต
  province: text('province'),                                     // จังหวัด
  postalCode: text('postal_code'),
  promptpayId: text('promptpay_id'),                              // PromptPay merchant target (mobile/13-digit ID) for QR (0049)
  defaultLanguage: text('default_language').default('th'),         // 'th' | 'en' — customer-facing output language (receipts, display, QR) (0077)
  industry: text('industry'),                                      // CoA template chosen at signup (0139); see INDUSTRY_KEYS in modules/ledger/coa-templates.ts (restaurant/retail/distribution/services/manufacturing/construction/ecommerce/hospitality/healthcare/professional/agriculture/automotive/logistics/education/nonprofit/realestate/general)
  // ── Branding (0085, Phase 9) — rendered on customer-facing documents ──
  logoUrl: text('logo_url'),                                       // https URL or small image data-URI
  tagline: text('tagline'),                                        // short company tagline under the name
  brandingPrefs: jsonb('branding_prefs').default({}),              // {show_logo_on_receipt?: bool, ...}
  themePrefs: jsonb('theme_prefs').default({}),                    // E4 (Phase 29) white-label theme tokens {primary_hue, radius, brand_name, logo_url, tagline}
  // ── C1: Functional currency (ISO-4217) for this tenant's reporting/GL (migration 0175) ──
  // Default 'THB'. Change only at entity setup — all historical GL remains in the prior currency.
  functionalCurrency: text('functional_currency').notNull().default('THB'),
  // ── #5 tenant lifecycle (migration 0235) — suspended_at != null ⇒ the company is suspended; its users are
  // blocked at the auth guard (TENANT_SUSPENDED). Platform owners are exempt so they can reactivate. ──
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  suspendedBy: text('suspended_by'),
  suspendReason: text('suspend_reason'),
  // ── Soft-delete (migration 0393) — deleted_at != null hides the company from the Platform Console
  // fleet list/switcher and PERMANENTLY blocks its users at the auth guard (TENANT_DELETED), independent
  // of suspended_at (so a stray reactivate can't silently re-open a deleted company). Business data is
  // untouched (unlike factory-reset) — reversible via restoreTenant. ──
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
  // Purge (migration 0393) — purged_at != null means every OTHER tenant-scoped row (business data, users,
  // subscriptions, AI/usage meters) has been permanently wiped; ONLY audit_log (ITGC-AC-16 append-only
  // chain) and this tenants row itself survive, kept solely as the audit trail's anchor. IRREVERSIBLE —
  // restoreTenant refuses once this is set (there is nothing left to restore: no users can ever log in).
  purgedAt: timestamp('purged_at', { withTimezone: true }),
  purgedBy: text('purged_by'),
  // Platform Console tags/segments (migration 0246) — free-form labels for fleet organisation/filtering.
  tags: jsonb('tags').notNull().default([]),
  // ── SME single-user edition (docs/49, migration 0414) — the control profile chosen at company creation.
  // 'enterprise' (default): full maker-checker; 'sme': one operator may self-approve WITH a mandatory
  // logged reason (evidence → self_approvals, reviewed by SME-01). Upgrade-only: sme→enterprise allowed,
  // enterprise→sme forbidden (PROFILE_DOWNGRADE_FORBIDDEN — a full-SoD entity may not weaken later). ──
  controlProfile: text('control_profile').notNull().default('enterprise'), // 'enterprise' | 'sme'
  // Per-tenant stamped copy of platform_sme_defaults taken at provisioning {hidden_nav_groups?, accountant_email?}.
  smePrefs: jsonb('sme_prefs').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;
