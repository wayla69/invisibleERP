import { pgTable, bigserial, text, numeric, boolean, date, timestamp } from 'drizzle-orm/pg-core';

// จาก tbl_customers — เดิม PK = Customer_Name (string). V2: surrogate id + code = ชื่อเดิม
export const tenants = pgTable('tenants', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  code: text('code').notNull().unique(), // legacy Customer_Name / Owner_Customer
  name: text('name').notNull(),
  contactName: text('contact_name'),
  phone: text('phone'),
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
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  subDistrict: text('sub_district'),                              // ตำบล/แขวง
  district: text('district'),                                     // อำเภอ/เขต
  province: text('province'),                                     // จังหวัด
  postalCode: text('postal_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;
