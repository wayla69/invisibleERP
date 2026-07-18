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

export type IndustryKey =
  | 'restaurant'
  | 'retail'
  | 'distribution'
  | 'services'
  | 'manufacturing'
  | 'construction'
  | 'ecommerce'
  | 'hospitality'
  | 'healthcare'
  | 'professional'
  | 'agriculture'
  | 'automotive'
  | 'logistics'
  | 'education'
  | 'nonprofit'
  | 'realestate'
  | 'general';

// A template row only overrides presentation (name) — type/normal-balance come from the canonical account.
export interface CoaTemplateRow {
  code: string;
  name: string; // English display name on this industry's chart
  nameTh: string; // Thai display name
}

// Industries other than `general` are pickable packs; `general` = full canonical chart (no curation).
export const INDUSTRY_KEYS: IndustryKey[] = [
  'restaurant', 'retail', 'distribution', 'services', 'manufacturing', 'construction', 'ecommerce',
  'hospitality', 'healthcare', 'professional', 'agriculture', 'automotive', 'logistics', 'education',
  'nonprofit', 'realestate', 'general',
];
export const CURATED_INDUSTRIES: Exclude<IndustryKey, 'general'>[] = [
  'restaurant', 'retail', 'distribution', 'services', 'manufacturing', 'construction', 'ecommerce',
  'hospitality', 'healthcare', 'professional', 'agriculture', 'automotive', 'logistics', 'education',
  'nonprofit', 'realestate',
];

export const INDUSTRY_LABELS: Record<IndustryKey, { label: string; labelEn: string }> = {
  restaurant: { label: 'ร้านอาหาร', labelEn: 'Restaurant' },
  retail: { label: 'ค้าปลีก', labelEn: 'Retail' },
  distribution: { label: 'ค้าส่ง / กระจายสินค้า', labelEn: 'Distribution' },
  services: { label: 'ธุรกิจบริการ', labelEn: 'Services' },
  manufacturing: { label: 'การผลิต / โรงงาน', labelEn: 'Manufacturing' },
  construction: { label: 'ก่อสร้าง / รับเหมา', labelEn: 'Construction' },
  ecommerce: { label: 'อีคอมเมิร์ซ / ขายออนไลน์', labelEn: 'E-commerce' },
  hospitality: { label: 'โรงแรม / ที่พัก', labelEn: 'Hospitality (Hotel)' },
  healthcare: { label: 'สุขภาพ / คลินิก', labelEn: 'Healthcare & Clinic' },
  professional: { label: 'บริการวิชาชีพ / ที่ปรึกษา', labelEn: 'Professional services' },
  agriculture: { label: 'เกษตรกรรม', labelEn: 'Agriculture' },
  automotive: { label: 'ยานยนต์ / ศูนย์บริการ', labelEn: 'Automotive & service' },
  logistics: { label: 'โลจิสติกส์ / ขนส่ง', labelEn: 'Logistics & transport' },
  education: { label: 'การศึกษา', labelEn: 'Education' },
  nonprofit: { label: 'องค์กรไม่แสวงหากำไร', labelEn: 'Non-profit' },
  realestate: { label: 'อสังหาริมทรัพย์ / ให้เช่า', labelEn: 'Real estate' },
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

// Manufacturing: raw-material → WIP → finished-goods flow, standard-cost PPV, scrap/rework, applied costs.
const MANUFACTURING: CoaTemplateRow[] = [
  ...CORE,
  { code: '1200', name: 'Raw Material Inventory', nameTh: 'วัตถุดิบคงคลัง' },
  { code: '1250', name: 'Work-in-Process', nameTh: 'งานระหว่างทำ' },
  { code: '1210', name: 'Finished Goods', nameTh: 'สินค้าสำเร็จรูป' },
  { code: '4000', name: 'Sales Revenue', nameTh: 'รายได้จากการขาย' },
  { code: '5000', name: 'Cost of Goods Sold', nameTh: 'ต้นทุนขาย' },
  { code: '5500', name: 'Purchase Price Variance', nameTh: 'ผลต่างราคาซื้อ' },
  { code: '2380', name: 'Manufacturing Costs Applied', nameTh: 'ค่าใช้จ่ายการผลิตรอปันส่วน' },
  { code: '5810', name: 'Scrap / Rework Loss', nameTh: 'ผลขาดทุนของเสีย/แก้ไขงาน' },
];

// Construction / contracting: CIP, project WIP, contract asset/liability, retention both sides, progress revenue.
const CONSTRUCTION: CoaTemplateRow[] = [
  ...CORE,
  { code: '1200', name: 'Construction Materials', nameTh: 'วัสดุก่อสร้างคงคลัง' },
  { code: '1520', name: 'Construction in Progress', nameTh: 'งานระหว่างก่อสร้าง' },
  { code: '1260', name: 'Project WIP / Unbilled Cost', nameTh: 'ต้นทุนงานที่ยังไม่เรียกเก็บ' },
  { code: '1265', name: 'Contract Asset (Unbilled Receivable)', nameTh: 'สินทรัพย์ตามสัญญา' },
  { code: '1170', name: 'Retention Receivable', nameTh: 'ลูกหนี้เงินประกันผลงาน' },
  { code: '2440', name: 'Retention Payable', nameTh: 'เจ้าหนี้เงินประกันผลงาน' },
  { code: '2410', name: 'Contract Liability / Deferred Revenue', nameTh: 'หนี้สินตามสัญญา' },
  { code: '4200', name: 'Construction / Project Revenue', nameTh: 'รายได้งานก่อสร้าง' },
  { code: '5800', name: 'Cost of Construction Work', nameTh: 'ต้นทุนงานก่อสร้าง' },
];

// E-commerce: merchandise inventory, online sales, delivery & card surcharge income, gift cards, loyalty.
const ECOMMERCE: CoaTemplateRow[] = [
  ...CORE,
  { code: '1200', name: 'Merchandise Inventory', nameTh: 'สินค้าคงคลัง' },
  { code: '4000', name: 'Online Sales', nameTh: 'รายได้จากการขายออนไลน์' },
  { code: '4100', name: 'Delivery Income', nameTh: 'รายได้ค่าจัดส่ง' },
  { code: '4500', name: 'Card Surcharge Income', nameTh: 'รายได้ค่าธรรมเนียมบัตร' },
  { code: '5000', name: 'Cost of Goods Sold', nameTh: 'ต้นทุนขาย' },
  { code: '2200', name: 'Customer Deposits (Gift Cards / Store Credit)', nameTh: 'เงินมัดจำลูกค้า (บัตร/เครดิตร้าน)' },
  { code: '2250', name: 'Loyalty Points Liability', nameTh: 'หนี้สินแต้มสะสม' },
  { code: '5700', name: 'Loyalty Points Expense', nameTh: 'ค่าใช้จ่ายแต้มสะสม' },
];

// Hospitality / hotel: rooms + F&B revenue, service charge, booking deposits, tips, recipe COGS.
const HOSPITALITY: CoaTemplateRow[] = [
  ...CORE,
  { code: '1200', name: 'F&B & Supplies Inventory', nameTh: 'วัตถุดิบและของใช้คงคลัง' },
  { code: '4300', name: 'Room & Service Revenue', nameTh: 'รายได้ค่าห้องพักและบริการ' },
  { code: '4000', name: 'Food & Beverage Sales', nameTh: 'รายได้อาหารและเครื่องดื่ม' },
  { code: '4400', name: 'Service Charge Income', nameTh: 'รายได้ค่าบริการ (เซอร์วิสชาร์จ)' },
  { code: '2210', name: 'Customer Deposits — Booking', nameTh: 'เงินมัดจำการจอง' },
  { code: '2300', name: 'Tips Payable', nameTh: 'ทิปพนักงานค้างจ่าย' },
  { code: '5000', name: 'Cost of Food & Beverage', nameTh: 'ต้นทุนอาหารและเครื่องดื่ม' },
  { code: '5300', name: 'Recipe Ingredient COGS', nameTh: 'ต้นทุนวัตถุดิบตามสูตร' },
];

// Healthcare / clinic: medical-service revenue, drug & supplies inventory, prepaid packages, bad debt.
const HEALTHCARE: CoaTemplateRow[] = [
  ...CORE,
  { code: '1200', name: 'Drug & Medical Supplies Inventory', nameTh: 'ยาและเวชภัณฑ์คงคลัง' },
  { code: '4300', name: 'Medical Service Revenue', nameTh: 'รายได้ค่ารักษาพยาบาล' },
  { code: '4000', name: 'Pharmacy / Product Sales', nameTh: 'รายได้ขายยาและผลิตภัณฑ์' },
  { code: '5000', name: 'Cost of Drugs & Supplies', nameTh: 'ต้นทุนยาและเวชภัณฑ์' },
  { code: '2400', name: 'Unearned Revenue (Prepaid Packages)', nameTh: 'รายได้รับล่วงหน้า (แพ็กเกจ)' },
  { code: '5720', name: 'Bad Debt Expense', nameTh: 'หนี้สูญ' },
];

// Professional services / consulting: retainer + project revenue, unbilled cost, contract asset, advances.
const PROFESSIONAL: CoaTemplateRow[] = [
  ...CORE,
  { code: '4300', name: 'Service / Retainer Revenue', nameTh: 'รายได้ค่าบริการวิชาชีพ' },
  { code: '4200', name: 'Project Revenue', nameTh: 'รายได้งานโครงการ' },
  { code: '1260', name: 'Unbilled Project Cost', nameTh: 'ต้นทุนงานที่ยังไม่เรียกเก็บ' },
  { code: '1265', name: 'Contract Asset (Unbilled Receivable)', nameTh: 'สินทรัพย์ตามสัญญา' },
  { code: '2400', name: 'Unearned Revenue', nameTh: 'รายได้รับล่วงหน้า' },
  { code: '5800', name: 'Cost of Services', nameTh: 'ต้นทุนงานบริการ' },
  { code: '1180', name: 'Employee Advances', nameTh: 'เงินทดรองจ่ายพนักงาน' },
];

// Agriculture: produce/supplies inventory, growing crops (biological WIP), harvested goods, produce sales.
const AGRICULTURE: CoaTemplateRow[] = [
  ...CORE,
  { code: '1200', name: 'Produce & Supplies Inventory', nameTh: 'ผลผลิตและวัสดุคงคลัง' },
  { code: '1250', name: 'Growing Crops / Biological WIP', nameTh: 'ผลผลิตระหว่างเพาะปลูก' },
  { code: '1210', name: 'Harvested / Finished Produce', nameTh: 'ผลผลิตสำเร็จรูป' },
  { code: '4000', name: 'Produce Sales', nameTh: 'รายได้จากการขายผลผลิต' },
  { code: '5000', name: 'Cost of Goods Sold', nameTh: 'ต้นทุนขาย' },
  { code: '5500', name: 'Purchase Price Variance', nameTh: 'ผลต่างราคาซื้อ' },
];

// Automotive / repair centre: parts inventory, parts sales + repair-service revenue, service charge.
const AUTOMOTIVE: CoaTemplateRow[] = [
  ...CORE,
  { code: '1200', name: 'Parts & Accessories Inventory', nameTh: 'อะไหล่และอุปกรณ์คงคลัง' },
  { code: '4000', name: 'Parts Sales', nameTh: 'รายได้ขายอะไหล่' },
  { code: '4300', name: 'Repair & Service Revenue', nameTh: 'รายได้ค่าบริการซ่อม' },
  { code: '4400', name: 'Service Charge Income', nameTh: 'รายได้ค่าบริการ' },
  { code: '5000', name: 'Cost of Parts Sold', nameTh: 'ต้นทุนอะไหล่ที่ขาย' },
  { code: '5800', name: 'Cost of Services', nameTh: 'ต้นทุนงานบริการ' },
];

// Logistics / transport: freight & logistics-service revenue, goods-in-transit, cost of services.
const LOGISTICS: CoaTemplateRow[] = [
  ...CORE,
  { code: '4100', name: 'Freight & Delivery Income', nameTh: 'รายได้ค่าขนส่ง' },
  { code: '4300', name: 'Logistics Service Revenue', nameTh: 'รายได้ค่าบริการโลจิสติกส์' },
  { code: '1255', name: 'Goods-in-Transit', nameTh: 'สินค้าระหว่างทาง' },
  { code: '5800', name: 'Cost of Services', nameTh: 'ต้นทุนงานบริการ' },
];

// Education: tuition & course revenue, prepaid fees (unearned), book/material sales + inventory.
const EDUCATION: CoaTemplateRow[] = [
  ...CORE,
  { code: '4300', name: 'Tuition & Course Revenue', nameTh: 'รายได้ค่าเล่าเรียนและคอร์ส' },
  { code: '2400', name: 'Unearned Tuition (Prepaid Fees)', nameTh: 'ค่าเล่าเรียนรับล่วงหน้า' },
  { code: '4000', name: 'Books & Materials Sales', nameTh: 'รายได้ขายหนังสือและอุปกรณ์' },
  { code: '1200', name: 'Books & Materials Inventory', nameTh: 'หนังสือและอุปกรณ์คงคลัง' },
  { code: '5000', name: 'Cost of Goods Sold', nameTh: 'ต้นทุนขาย' },
];

// Non-profit: grants/donation revenue, restricted (deferred) funds, fundraising income, supplies.
const NONPROFIT: CoaTemplateRow[] = [
  ...CORE,
  { code: '4300', name: 'Grants & Donation Revenue', nameTh: 'รายได้เงินบริจาคและทุนสนับสนุน' },
  { code: '2400', name: 'Restricted / Deferred Funds', nameTh: 'เงินทุนที่มีข้อจำกัด (รับล่วงหน้า)' },
  { code: '4000', name: 'Program / Fundraising Income', nameTh: 'รายได้จากกิจกรรมและการระดมทุน' },
  { code: '1200', name: 'Supplies Inventory', nameTh: 'วัสดุคงคลัง' },
];

// Real estate: rental + property-sales revenue, property under development (CIP), booking deposits, SBT.
const REALESTATE: CoaTemplateRow[] = [
  ...CORE,
  { code: '4610', name: 'Rental Income', nameTh: 'รายได้ค่าเช่า' },
  { code: '4000', name: 'Property Sales Revenue', nameTh: 'รายได้ขายอสังหาริมทรัพย์' },
  { code: '1520', name: 'Property under Development (CIP)', nameTh: 'อสังหาฯ ระหว่างพัฒนา' },
  { code: '2210', name: 'Customer Deposits — Booking', nameTh: 'เงินมัดจำ/เงินจอง' },
  { code: '2130', name: 'Specific Business Tax Payable (ภ.ธ.40)', nameTh: 'ภาษีธุรกิจเฉพาะค้างจ่าย' },
  { code: '5840', name: 'Specific Business Tax Expense', nameTh: 'ค่าภาษีธุรกิจเฉพาะ' },
  { code: '5000', name: 'Cost of Property Sold', nameTh: 'ต้นทุนอสังหาริมทรัพย์ที่ขาย' },
];

// `general` omitted — provisioning falls back to the full canonical chart with canonical names.
export const COA_TEMPLATES: Record<Exclude<IndustryKey, 'general'>, CoaTemplateRow[]> = {
  restaurant: RESTAURANT,
  retail: RETAIL,
  distribution: DISTRIBUTION,
  services: SERVICES,
  manufacturing: MANUFACTURING,
  construction: CONSTRUCTION,
  ecommerce: ECOMMERCE,
  hospitality: HOSPITALITY,
  healthcare: HEALTHCARE,
  professional: PROFESSIONAL,
  agriculture: AGRICULTURE,
  automotive: AUTOMOTIVE,
  logistics: LOGISTICS,
  education: EDUCATION,
  nonprofit: NONPROFIT,
  realestate: REALESTATE,
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
