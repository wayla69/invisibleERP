// ───────────────────────── Industry Chart-of-Accounts templates (CoA overlay) ─────────────────────────
// The posting engine binds to a FIXED, global account universe (the `COA` array in ledger.service.ts) —
// every GL posting hard-references its account code, so those codes are immutable. These templates do NOT
// introduce new codes; they curate a per-tenant VIEW over that universe: which canonical accounts a tenant
// of a given industry sees as "active", and what they are NAMED/grouped as on that tenant's chart.
//
// A new company picks its industry at signup (billing.service.ts → LedgerService.provisionTenantCoA), which
// materialises the chosen template into the per-tenant `tenant_accounts` overlay. The engine keeps posting
// to canonical codes regardless; reports never hide a code that carries a balance (active OR has activity).
//
// INVARIANT: every `code` below MUST exist in the canonical `COA`. Enforced at boot via
// assertTemplatesSubsetOf() (called from LedgerService.seedChartOfAccounts) so a typo fails fast.
// The `general` industry is intentionally absent here — it falls back to the full canonical chart with
// canonical names (today's behaviour), built at provisioning time from `COA`.

export type IndustryKey = 'restaurant' | 'retail' | 'distribution' | 'services' | 'general';

// A template row only overrides presentation (name) — type/normal-balance come from the canonical account.
export interface CoaTemplateRow {
  code: string;
  name: string; // English display name on this industry's chart
  nameTh: string; // Thai display name
}

// Industries other than `general` are pickable packs; `general` = full canonical chart (no curation).
export const INDUSTRY_KEYS: IndustryKey[] = ['restaurant', 'retail', 'distribution', 'services', 'general'];
export const CURATED_INDUSTRIES: Exclude<IndustryKey, 'general'>[] = ['restaurant', 'retail', 'distribution', 'services'];

export const INDUSTRY_LABELS: Record<IndustryKey, { label: string; labelEn: string }> = {
  restaurant: { label: 'ร้านอาหาร', labelEn: 'Restaurant' },
  retail: { label: 'ค้าปลีก', labelEn: 'Retail' },
  distribution: { label: 'ค้าส่ง / กระจายสินค้า', labelEn: 'Distribution' },
  services: { label: 'ธุรกิจบริการ', labelEn: 'Services' },
  general: { label: 'ทั่วไป (ผังบัญชีเต็ม)', labelEn: 'General (full chart)' },
};

// Shared backbone every industry gets. Codes that industries name differently (inventory/sales/COGS) live
// in the per-industry blocks below, NOT here, so no code is declared twice within one template.
const CORE: CoaTemplateRow[] = [
  { code: '1000', name: 'Cash', nameTh: 'เงินสด' },
  { code: '1010', name: 'Bank — Current', nameTh: 'เงินฝากกระแสรายวัน' },
  { code: '1020', name: 'Bank — Savings', nameTh: 'เงินฝากออมทรัพย์' },
  { code: '1100', name: 'Accounts Receivable', nameTh: 'ลูกหนี้การค้า' },
  { code: '1280', name: 'Prepaid Expenses', nameTh: 'ค่าใช้จ่ายจ่ายล่วงหน้า' },
  { code: '1500', name: 'Fixed Assets', nameTh: 'สินทรัพย์ถาวร' },
  { code: '1590', name: 'Accumulated Depreciation', nameTh: 'ค่าเสื่อมราคาสะสม' },
  { code: '2000', name: 'Accounts Payable', nameTh: 'เจ้าหนี้การค้า' },
  { code: '2100', name: 'Tax Payable (VAT)', nameTh: 'ภาษีค้างจ่าย (VAT)' },
  { code: '2350', name: 'Social Security Payable', nameTh: 'ประกันสังคมค้างจ่าย' },
  { code: '2360', name: 'Payroll WHT Payable (PND1)', nameTh: 'ภาษีหัก ณ ที่จ่ายเงินเดือนค้างจ่าย (ภ.ง.ด.1)' },
  { code: '3000', name: 'Owner Capital', nameTh: 'ทุนเจ้าของ' },
  { code: '3100', name: 'Retained Earnings', nameTh: 'กำไรสะสม' },
  { code: '5100', name: 'Operating Expense', nameTh: 'ค่าใช้จ่ายในการดำเนินงาน' },
  { code: '5200', name: 'Depreciation Expense', nameTh: 'ค่าเสื่อมราคา' },
  { code: '5600', name: 'Salaries & Wages', nameTh: 'เงินเดือนและค่าจ้าง' },
  { code: '5610', name: 'Social Security (Employer)', nameTh: 'เงินสมทบประกันสังคม (นายจ้าง)' },
  { code: '5710', name: 'Repairs & Maintenance', nameTh: 'ค่าซ่อมแซมและบำรุงรักษา' },
  { code: '5900', name: 'Interest Expense', nameTh: 'ดอกเบี้ยจ่าย' },
  { code: '4900', name: 'Rounding Adjustment', nameTh: 'ปรับปรุงเศษสตางค์' },
];

// Restaurant: F&B inventory, recipe COGS, tips, service charge, delivery, gift cards/bookings.
const RESTAURANT: CoaTemplateRow[] = [
  ...CORE,
  { code: '1200', name: 'Food & Beverage Inventory', nameTh: 'สินค้าคงคลังอาหารและเครื่องดื่ม' },
  { code: '4000', name: 'Food & Beverage Sales', nameTh: 'รายได้อาหารและเครื่องดื่ม' },
  { code: '4100', name: 'Delivery Income', nameTh: 'รายได้ค่าจัดส่ง' },
  { code: '4400', name: 'Service Charge Income', nameTh: 'รายได้ค่าบริการ (เซอร์วิสชาร์จ)' },
  { code: '4500', name: 'Card Surcharge Income', nameTh: 'รายได้ค่าธรรมเนียมบัตร' },
  { code: '5000', name: 'Cost of Food & Beverage', nameTh: 'ต้นทุนอาหารและเครื่องดื่ม' },
  { code: '5300', name: 'Recipe Ingredient COGS', nameTh: 'ต้นทุนวัตถุดิบตามสูตร' },
  { code: '2200', name: 'Customer Deposits (Gift Cards)', nameTh: 'เงินมัดจำลูกค้า (บัตรของขวัญ)' },
  { code: '2210', name: 'Customer Deposits — Booking', nameTh: 'เงินรับล่วงหน้า (จองโต๊ะ)' },
  { code: '2300', name: 'Tips Payable', nameTh: 'ทิปพนักงานค้างจ่าย' },
];

// Retail: merchandise inventory, COGS, purchase price variance, loyalty points, gift cards/store credit.
const RETAIL: CoaTemplateRow[] = [
  ...CORE,
  { code: '1200', name: 'Merchandise Inventory', nameTh: 'สินค้าคงคลัง' },
  { code: '4000', name: 'Retail Sales', nameTh: 'รายได้จากการขายสินค้า' },
  { code: '4500', name: 'Card Surcharge Income', nameTh: 'รายได้ค่าธรรมเนียมบัตร' },
  { code: '5000', name: 'Cost of Goods Sold', nameTh: 'ต้นทุนขาย' },
  { code: '5500', name: 'Purchase Price Variance', nameTh: 'ผลต่างราคาซื้อ' },
  { code: '2200', name: 'Customer Deposits (Store Credit / Gift Cards)', nameTh: 'เงินมัดจำลูกค้า (เครดิตร้าน/บัตรของขวัญ)' },
  { code: '2250', name: 'Loyalty Points Liability', nameTh: 'หนี้สินแต้มสะสม' },
  { code: '5700', name: 'Loyalty Points Expense', nameTh: 'ค่าใช้จ่ายแต้มสะสม' },
];

// Distribution / wholesale: stock for resale, COGS, PPV, delivery income, intercompany.
const DISTRIBUTION: CoaTemplateRow[] = [
  ...CORE,
  { code: '1200', name: 'Stock for Resale', nameTh: 'สินค้าคงคลังเพื่อจำหน่าย' },
  { code: '4000', name: 'Wholesale Sales', nameTh: 'รายได้ขายส่ง' },
  { code: '4100', name: 'Delivery Income', nameTh: 'รายได้ค่าจัดส่ง' },
  { code: '5000', name: 'Cost of Goods Sold', nameTh: 'ต้นทุนขาย' },
  { code: '5500', name: 'Purchase Price Variance', nameTh: 'ผลต่างราคาซื้อ' },
  { code: '1150', name: 'Intercompany Receivable', nameTh: 'ลูกหนี้ระหว่างบริษัท' },
  { code: '2150', name: 'Intercompany Payable', nameTh: 'เจ้าหนี้ระหว่างบริษัท' },
];

// Services: no inventory/COGS — service & project revenue, unbilled cost, deferred revenue, advances.
const SERVICES: CoaTemplateRow[] = [
  ...CORE,
  { code: '4300', name: 'Service Revenue', nameTh: 'รายได้ค่าบริการ' },
  { code: '4200', name: 'Project Revenue', nameTh: 'รายได้งานโครงการ' },
  { code: '2400', name: 'Unearned Revenue', nameTh: 'รายได้รับล่วงหน้า' },
  { code: '1260', name: 'Unbilled Project Cost', nameTh: 'ต้นทุนงานโครงการที่ยังไม่เรียกเก็บ' },
  { code: '1265', name: 'Contract Asset (Unbilled Receivable)', nameTh: 'สินทรัพย์ตามสัญญา' },
  { code: '2390', name: 'Project Costs Applied', nameTh: 'ต้นทุนโครงการรอปันส่วน' },
  { code: '5800', name: 'Cost of Services', nameTh: 'ต้นทุนงานบริการ' },
  { code: '1180', name: 'Employee Advances', nameTh: 'เงินทดรองจ่ายพนักงาน' },
];

// `general` omitted — provisioning falls back to the full canonical chart with canonical names.
export const COA_TEMPLATES: Record<Exclude<IndustryKey, 'general'>, CoaTemplateRow[]> = {
  restaurant: RESTAURANT,
  retail: RETAIL,
  distribution: DISTRIBUTION,
  services: SERVICES,
};

export function isIndustryKey(v: unknown): v is IndustryKey {
  return typeof v === 'string' && (INDUSTRY_KEYS as string[]).includes(v);
}

// Boot-time guard: every template code must exist in the canonical chart, and no template may declare a
// code twice. Throws (fail-fast at startup) so a bad template can never reach a tenant's overlay.
export function assertTemplatesSubsetOf(canonicalCodes: Iterable<string>): void {
  const canon = new Set(canonicalCodes);
  for (const industry of CURATED_INDUSTRIES) {
    const rows = COA_TEMPLATES[industry];
    const seen = new Set<string>();
    for (const r of rows) {
      if (!canon.has(r.code)) {
        throw new Error(`CoA template "${industry}" references unknown account code ${r.code} (not in canonical COA)`);
      }
      if (seen.has(r.code)) {
        throw new Error(`CoA template "${industry}" declares account code ${r.code} more than once`);
      }
      seen.add(r.code);
    }
  }
}
