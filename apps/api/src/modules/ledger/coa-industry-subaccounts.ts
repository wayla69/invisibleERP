// ───────────────────── Industry sub-account registry (single source of truth) ─────────────────────
// The 6-digit analytical sub-accounts an industry surfaces under a canonical parent (e.g. construction WIP
// by trade phase under 1260; manufacturing COGS by cost element under 5000). Historically each sub-account
// was declared TWICE — once as a canonical seed row in `ledger-constants.ts` (code/name/type/parentCode +
// bsGroup/isGroup classification) and again in the `coa-templates.ts` per-industry block (Thai name + which
// vertical surfaces it) — kept in sync by hand. This registry unifies both: ONE entry carries everything, so
// `ledger-constants.ts` DERIVES its canonical rows from here (`toCanonicalSubAccountRows`) and each industry
// template in `coa-templates.ts` DERIVES its rows from here (`industrySubAccountRows`). Adding a vertical's
// sub-account is now a single data edit.
//
// SCOPE: only GENUINE sub-accounts (a distinct sub-ledger account with its own statement line/nature).
// Purely ANALYTICAL breakdowns (retail sales by category, revenue by channel) belong to the posting
// DIMENSIONS (cost_center/branch/project), NOT the code tree — see the sub-account-vs-dimension guardrails.
// INVARIANT: every `code` is a real canonical sub-account (parentCode is a 4-digit canonical parent) and is
// declared exactly once here; the boot guards (`assertTemplatesSubsetOf`, SUBACCOUNT_TOO_DEEP) still bind.
// Order matters: it reproduces the prior hand-written ordering in both consuming files (byte-identical seed).

import type { CoaSeedRow } from './ledger-constants';
import type { IndustryKey } from './coa-templates';

export interface IndustrySubAccount {
  industry: Exclude<IndustryKey, 'general'>; // the vertical whose template surfaces this sub-account
  code: string;
  parentCode: string;
  type: 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense';
  name: string;   // English display name (canonical + template)
  nameTh: string; // Thai display name (template overlay)
  bsGroup?: string;
  isGroup?: string;
  isCurrent?: boolean;
}

// Order preserved from the prior canonical block (P3 verticals, then P5 "remaining verticals"), so both the
// derived canonical seed and each derived per-industry template come out identical to before.
export const INDUSTRY_SUBACCOUNTS: IndustrySubAccount[] = [
  // CONSTRUCTION — work-in-progress by trade phase (under 1260) + cost of work by resource (under 5800).
  { industry: 'construction', code: '126001', parentCode: '1260', type: 'Asset', name: 'WIP — Earthwork', nameTh: 'งานระหว่างก่อสร้าง — งานดิน' },
  { industry: 'construction', code: '126002', parentCode: '1260', type: 'Asset', name: 'WIP — Structure', nameTh: 'งานระหว่างก่อสร้าง — งานโครงสร้าง' },
  { industry: 'construction', code: '126003', parentCode: '1260', type: 'Asset', name: 'WIP — Architectural / Finishing', nameTh: 'งานระหว่างก่อสร้าง — งานสถาปัตย์/ตกแต่ง' },
  { industry: 'construction', code: '126004', parentCode: '1260', type: 'Asset', name: 'WIP — MEP / Systems', nameTh: 'งานระหว่างก่อสร้าง — งานระบบ' },
  { industry: 'construction', code: '580001', parentCode: '5800', type: 'Expense', isGroup: 'cogs', name: 'Cost of Work — Labor', nameTh: 'ต้นทุนงานก่อสร้าง — ค่าแรง' },
  { industry: 'construction', code: '580002', parentCode: '5800', type: 'Expense', isGroup: 'cogs', name: 'Cost of Work — Materials', nameTh: 'ต้นทุนงานก่อสร้าง — ค่าวัสดุ' },
  { industry: 'construction', code: '580003', parentCode: '5800', type: 'Expense', isGroup: 'cogs', name: 'Cost of Work — Subcontractor', nameTh: 'ต้นทุนงานก่อสร้าง — ค่าผู้รับเหมาช่วง' },
  { industry: 'construction', code: '580004', parentCode: '5800', type: 'Expense', isGroup: 'cogs', name: 'Cost of Work — Equipment / Plant', nameTh: 'ต้นทุนงานก่อสร้าง — ค่าเครื่องจักร' },

  // MANUFACTURING — WIP by cost element (under 1250) + COGS by cost element (under 5000).
  { industry: 'manufacturing', code: '125001', parentCode: '1250', type: 'Asset', name: 'WIP — Direct Materials', nameTh: 'งานระหว่างทำ — วัตถุดิบทางตรง' },
  { industry: 'manufacturing', code: '125002', parentCode: '1250', type: 'Asset', name: 'WIP — Direct Labor', nameTh: 'งานระหว่างทำ — ค่าแรงทางตรง' },
  { industry: 'manufacturing', code: '125003', parentCode: '1250', type: 'Asset', name: 'WIP — Manufacturing Overhead', nameTh: 'งานระหว่างทำ — ค่าโสหุ้ยการผลิต' },
  { industry: 'manufacturing', code: '500001', parentCode: '5000', type: 'Expense', isGroup: 'cogs', name: 'COGS — Direct Materials', nameTh: 'ต้นทุนขาย — วัตถุดิบทางตรง' },
  { industry: 'manufacturing', code: '500002', parentCode: '5000', type: 'Expense', isGroup: 'cogs', name: 'COGS — Direct Labor', nameTh: 'ต้นทุนขาย — ค่าแรงทางตรง' },
  { industry: 'manufacturing', code: '500003', parentCode: '5000', type: 'Expense', isGroup: 'cogs', name: 'COGS — Manufacturing Overhead', nameTh: 'ต้นทุนขาย — ค่าโสหุ้ยการผลิต' },

  // HOSPITALITY — revenue by department (room under 4300; F&B under 4000) + F&B cost by kind (under 5000).
  { industry: 'hospitality', code: '430001', parentCode: '4300', type: 'Revenue', name: 'Room Revenue', nameTh: 'รายได้ค่าห้องพัก' },
  { industry: 'hospitality', code: '430002', parentCode: '4300', type: 'Revenue', name: 'Other Service Revenue (spa/laundry)', nameTh: 'รายได้บริการอื่น (สปา/ซักรีด)' },
  { industry: 'hospitality', code: '400001', parentCode: '4000', type: 'Revenue', name: 'Food Sales', nameTh: 'รายได้อาหาร' },
  { industry: 'hospitality', code: '400002', parentCode: '4000', type: 'Revenue', name: 'Beverage Sales', nameTh: 'รายได้เครื่องดื่ม' },
  { industry: 'hospitality', code: '500011', parentCode: '5000', type: 'Expense', isGroup: 'cogs', name: 'Cost of Food', nameTh: 'ต้นทุนอาหาร' },
  { industry: 'hospitality', code: '500012', parentCode: '5000', type: 'Expense', isGroup: 'cogs', name: 'Cost of Beverage', nameTh: 'ต้นทุนเครื่องดื่ม' },

  // PROFESSIONAL SERVICES — unbilled WIP by engagement kind (under 1260) + cost of services by kind (under 5800).
  { industry: 'professional', code: '126010', parentCode: '1260', type: 'Asset', name: 'Unbilled WIP — Staff Time', nameTh: 'งานระหว่างทำ — ค่าแรงวิชาชีพ' },
  { industry: 'professional', code: '126011', parentCode: '1260', type: 'Asset', name: 'Unbilled WIP — Disbursements', nameTh: 'งานระหว่างทำ — ค่าใช้จ่ายทดรองตามงาน' },
  { industry: 'professional', code: '580010', parentCode: '5800', type: 'Expense', isGroup: 'cogs', name: 'Cost of Services — Staff Time', nameTh: 'ต้นทุนงานบริการ — ค่าแรง' },
  { industry: 'professional', code: '580011', parentCode: '5800', type: 'Expense', isGroup: 'cogs', name: 'Cost of Services — Disbursements', nameTh: 'ต้นทุนงานบริการ — ค่าใช้จ่ายทดรอง' },

  // ECOMMERCE — distinct selling costs + the marketplace settlement receivable.
  { industry: 'ecommerce', code: '510010', parentCode: '5100', type: 'Expense', name: 'Payment Gateway Fees', nameTh: 'ค่าธรรมเนียมเกตเวย์ชำระเงิน' },
  { industry: 'ecommerce', code: '510011', parentCode: '5100', type: 'Expense', name: 'Marketplace Commission', nameTh: 'ค่าคอมมิชชันมาร์เก็ตเพลส' },
  { industry: 'ecommerce', code: '510012', parentCode: '5100', type: 'Expense', name: 'Fulfilment / Shipping Cost', nameTh: 'ค่าจัดส่ง/แพ็กสินค้า' },
  { industry: 'ecommerce', code: '116010', parentCode: '1160', type: 'Asset', name: 'Marketplace Payout Receivable', nameTh: 'ลูกหนี้เงินโอนจากมาร์เก็ตเพลส' },

  // LOGISTICS — cost of services by resource (under 5800).
  { industry: 'logistics', code: '580020', parentCode: '5800', type: 'Expense', isGroup: 'cogs', name: 'Cost of Service — Fuel', nameTh: 'ต้นทุนบริการ — น้ำมันเชื้อเพลิง' },
  { industry: 'logistics', code: '580021', parentCode: '5800', type: 'Expense', isGroup: 'cogs', name: 'Cost of Service — Driver / Crew Wages', nameTh: 'ต้นทุนบริการ — ค่าแรงพนักงานขับรถ/ประจำรถ' },
  { industry: 'logistics', code: '580022', parentCode: '5800', type: 'Expense', isGroup: 'cogs', name: 'Cost of Service — Subcontracted Transport', nameTh: 'ต้นทุนบริการ — ค่าจ้างขนส่งช่วง' },
  { industry: 'logistics', code: '580023', parentCode: '5800', type: 'Expense', isGroup: 'cogs', name: 'Cost of Service — Vehicle R&M', nameTh: 'ต้นทุนบริการ — ค่าซ่อมบำรุงยานพาหนะ' },
  { industry: 'logistics', code: '580024', parentCode: '5800', type: 'Expense', isGroup: 'cogs', name: 'Cost of Service — Warehousing / Handling', nameTh: 'ต้นทุนบริการ — ค่าคลังสินค้า/ยกขน' },

  // AUTOMOTIVE — a distinct vehicle-sales revenue line, COGS by stream, and a warranty provision.
  { industry: 'automotive', code: '400020', parentCode: '4000', type: 'Revenue', name: 'Vehicle Sales', nameTh: 'รายได้ขายรถยนต์' },
  { industry: 'automotive', code: '500020', parentCode: '5000', type: 'Expense', isGroup: 'cogs', name: 'COGS — Vehicles', nameTh: 'ต้นทุนขายรถยนต์' },
  { industry: 'automotive', code: '500021', parentCode: '5000', type: 'Expense', isGroup: 'cogs', name: 'COGS — Parts', nameTh: 'ต้นทุนขายอะไหล่' },
  { industry: 'automotive', code: '203010', parentCode: '2030', type: 'Liability', name: 'Warranty Provision', nameTh: 'ประมาณการหนี้สินการรับประกัน' },

  // HEALTHCARE — revenue by service line + drug vs medical-supplies inventory.
  { industry: 'healthcare', code: '430010', parentCode: '4300', type: 'Revenue', name: 'OPD Revenue', nameTh: 'รายได้ผู้ป่วยนอก (OPD)' },
  { industry: 'healthcare', code: '430011', parentCode: '4300', type: 'Revenue', name: 'IPD Revenue', nameTh: 'รายได้ผู้ป่วยใน (IPD)' },
  { industry: 'healthcare', code: '430012', parentCode: '4300', type: 'Revenue', name: 'Laboratory & Imaging Revenue', nameTh: 'รายได้ห้องปฏิบัติการและเอกซเรย์' },
  { industry: 'healthcare', code: '120010', parentCode: '1200', type: 'Asset', name: 'Drug Inventory', nameTh: 'ยาคงคลัง' },
  { industry: 'healthcare', code: '120011', parentCode: '1200', type: 'Asset', name: 'Medical Supplies Inventory', nameTh: 'เวชภัณฑ์คงคลัง' },

  // AGRICULTURE — biological assets (TAS 41) + COGS by farm input.
  { industry: 'agriculture', code: '125010', parentCode: '1250', type: 'Asset', name: 'Biological Assets — Livestock', nameTh: 'สินทรัพย์ชีวภาพ — ปศุสัตว์' },
  { industry: 'agriculture', code: '125011', parentCode: '1250', type: 'Asset', name: 'Growing Crops', nameTh: 'พืชผลระหว่างเพาะปลูก' },
  { industry: 'agriculture', code: '500030', parentCode: '5000', type: 'Expense', isGroup: 'cogs', name: 'COGS — Seed & Planting', nameTh: 'ต้นทุน — เมล็ดพันธุ์/เพาะปลูก' },
  { industry: 'agriculture', code: '500031', parentCode: '5000', type: 'Expense', isGroup: 'cogs', name: 'COGS — Fertilizer & Chemicals', nameTh: 'ต้นทุน — ปุ๋ยและเคมีภัณฑ์' },
  { industry: 'agriculture', code: '500032', parentCode: '5000', type: 'Expense', isGroup: 'cogs', name: 'COGS — Feed', nameTh: 'ต้นทุน — อาหารสัตว์' },
  { industry: 'agriculture', code: '500033', parentCode: '5000', type: 'Expense', isGroup: 'cogs', name: 'COGS — Farm Labor', nameTh: 'ต้นทุน — ค่าแรงในฟาร์ม' },

  // EDUCATION — tuition vs fees vs activity income (distinct revenue lines).
  { industry: 'education', code: '430020', parentCode: '4300', type: 'Revenue', name: 'Tuition Revenue', nameTh: 'รายได้ค่าเล่าเรียน' },
  { industry: 'education', code: '430021', parentCode: '4300', type: 'Revenue', name: 'Registration & Exam Fees', nameTh: 'ค่าลงทะเบียนและค่าสอบ' },
  { industry: 'education', code: '430022', parentCode: '4300', type: 'Revenue', name: 'Activity & Excursion Income', nameTh: 'รายได้กิจกรรมและทัศนศึกษา' },

  // REAL ESTATE — property inventory stages (under 1520) + rental income by property class (under 4610).
  { industry: 'realestate', code: '152010', parentCode: '1520', type: 'Asset', name: 'Land Held for Development', nameTh: 'ที่ดินเพื่อการพัฒนา' },
  { industry: 'realestate', code: '152011', parentCode: '1520', type: 'Asset', name: 'Construction Work in Progress', nameTh: 'งานก่อสร้างระหว่างทำ' },
  { industry: 'realestate', code: '461010', parentCode: '4610', type: 'Revenue', name: 'Residential Rental Income', nameTh: 'รายได้ค่าเช่าที่อยู่อาศัย' },
  { industry: 'realestate', code: '461011', parentCode: '4610', type: 'Revenue', name: 'Commercial Rental Income', nameTh: 'รายได้ค่าเช่าเชิงพาณิชย์' },

  // NONPROFIT — grant vs donation income, the classic functional-expense split, restricted vs unrestricted net assets.
  { industry: 'nonprofit', code: '430030', parentCode: '4300', type: 'Revenue', name: 'Grant Income', nameTh: 'รายได้ทุนสนับสนุน' },
  { industry: 'nonprofit', code: '430031', parentCode: '4300', type: 'Revenue', name: 'Donation Income', nameTh: 'รายได้เงินบริจาค' },
  { industry: 'nonprofit', code: '510020', parentCode: '5100', type: 'Expense', name: 'Program Services Expense', nameTh: 'ค่าใช้จ่ายดำเนินโครงการ' },
  { industry: 'nonprofit', code: '510021', parentCode: '5100', type: 'Expense', name: 'Management & Administration Expense', nameTh: 'ค่าใช้จ่ายบริหารจัดการ' },
  { industry: 'nonprofit', code: '510022', parentCode: '5100', type: 'Expense', name: 'Fundraising Expense', nameTh: 'ค่าใช้จ่ายการระดมทุน' },
  { industry: 'nonprofit', code: '310010', parentCode: '3100', type: 'Equity', name: 'Unrestricted Net Assets', nameTh: 'สินทรัพย์สุทธิไม่มีข้อจำกัด' },
  { industry: 'nonprofit', code: '310011', parentCode: '3100', type: 'Equity', name: 'Restricted Net Assets', nameTh: 'สินทรัพย์สุทธิที่มีข้อจำกัด' },

  // RETAIL — the genuine distinct line only (category/department analysis is a DIMENSION).
  { industry: 'retail', code: '500040', parentCode: '5000', type: 'Expense', isGroup: 'cogs', name: 'Inventory Shrinkage / Markdown', nameTh: 'ผลขาดทุนสินค้าขาด/ปรับลดราคา' },
  // DISTRIBUTION — inbound freight as a distinct COGS line.
  { industry: 'distribution', code: '500050', parentCode: '5000', type: 'Expense', isGroup: 'cogs', name: 'COGS — Inbound Freight', nameTh: 'ต้นทุน — ค่าขนส่งขาเข้า' },
  // SERVICES — cost of services by kind.
  { industry: 'services', code: '580030', parentCode: '5800', type: 'Expense', isGroup: 'cogs', name: 'Cost of Services — Staff Cost', nameTh: 'ต้นทุนงานบริการ — ค่าแรงพนักงาน' },
  { industry: 'services', code: '580031', parentCode: '5800', type: 'Expense', isGroup: 'cogs', name: 'Cost of Services — Subcontractors', nameTh: 'ต้นทุนงานบริการ — ผู้รับเหมาช่วง' },
];

// Canonical seed rows (postable superset) derived from the registry — consumed by `ledger-constants.ts` COA.
// A code is seeded once even if (hypothetically) two verticals shared it; registry order is preserved.
export function toCanonicalSubAccountRows(): CoaSeedRow[] {
  const seen = new Set<string>();
  const rows: CoaSeedRow[] = [];
  for (const s of INDUSTRY_SUBACCOUNTS) {
    if (seen.has(s.code)) continue;
    seen.add(s.code);
    const row: CoaSeedRow = { code: s.code, name: s.name, type: s.type, parentCode: s.parentCode };
    if (s.bsGroup !== undefined) row.bsGroup = s.bsGroup;
    if (s.isGroup !== undefined) row.isGroup = s.isGroup;
    if (s.isCurrent !== undefined) row.isCurrent = s.isCurrent;
    rows.push(row);
  }
  return rows;
}

// The per-industry template rows (code/name/nameTh) for a given industry — consumed by `coa-templates.ts`.
export function industrySubAccountRows(industry: Exclude<IndustryKey, 'general'>): { code: string; name: string; nameTh: string }[] {
  return INDUSTRY_SUBACCOUNTS.filter((s) => s.industry === industry).map((s) => ({ code: s.code, name: s.name, nameTh: s.nameTh }));
}
