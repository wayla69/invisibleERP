// ───────────────── Per-industry default statutory P&L layouts (FIN-4, P6) ─────────────────
// The generic Thai DBD/TFRS P&L (thai-dbd-fs.ts DBD-PL) already lists each industry's sub-accounts as line
// items under the right section. These bespoke defaults exist only for the industries whose STATEMENT
// STRUCTURE genuinely differs — where the standard multi-step P&L is the wrong shape:
//   • nonprofit    — a Statement of Activities (support − functional expenses = change in net assets)
//   • manufacturing— cost of goods sold broken into DM / DL / manufacturing overhead
//   • construction — contract P&L with cost of work by resource (labour/materials/subcontract/equipment)
//   • hospitality  — an operating statement that surfaces revenue (and F&B cost) by department
// getDefinition('DBD-PL') resolves the caller's tenant industry to one of these; everything else falls back
// to the generic DBD-PL. A tenant that authors its own 'DBD-PL' definition still overrides all of this.
// Every layout TIES OUT to the canonical income statement: its bottom line = revenue − all expenses.

import type { FsBuilderConfig, FsGroup } from './statutory-fs.service';

export interface IndustryFsDef { name: string; statementType: 'pl' | 'bs'; config: FsBuilderConfig }

// The shared multi-step tail from gross profit → net profit (identical to the generic DBD-PL tail, so the
// bottom line reconciles to incomeStatement.net_income). `grossKey` is the subtotal it builds on.
function plTail(grossKey: string): FsGroup[] {
  return [
    { key: 'other_income', label: 'Other income', labelTh: 'รายได้อื่น', level: 0, normalSide: 'credit', isGroups: ['other_income'], showAccounts: true },
    { key: 'selling_admin', label: 'Selling & administrative expenses', labelTh: 'ค่าใช้จ่ายในการขายและบริหาร', level: 0, normalSide: 'debit', isGroups: ['selling_admin', 'other_expense'], showAccounts: true },
    { key: 'operating_profit', label: 'Operating profit', labelTh: 'กำไรจากการดำเนินงาน', level: 0, sumOf: [{ key: grossKey, factor: 1 }, { key: 'other_income', factor: 1 }, { key: 'selling_admin', factor: -1 }] },
    { key: 'finance_cost', label: 'Finance costs', labelTh: 'ต้นทุนทางการเงิน', level: 0, normalSide: 'debit', isGroups: ['finance_cost'], showAccounts: true },
    { key: 'profit_before_tax', label: 'Profit before income tax', labelTh: 'กำไรก่อนภาษีเงินได้', level: 0, sumOf: [{ key: 'operating_profit', factor: 1 }, { key: 'finance_cost', factor: -1 }] },
    { key: 'income_tax', label: 'Income tax expense', labelTh: 'ค่าใช้จ่ายภาษีเงินได้', level: 0, normalSide: 'debit', isGroups: ['tax'], showAccounts: true },
    { key: 'net_profit', label: 'Net profit (loss)', labelTh: 'กำไร(ขาดทุน)สุทธิ', level: 0, sumOf: [{ key: 'profit_before_tax', factor: 1 }, { key: 'income_tax', factor: -1 }] },
  ];
}

// MANUFACTURING — COGS broken into the three cost elements; the residual (posted straight to the 5000
// parent) shows as "Other cost of sales" so the breakdown always sums to total cost of goods sold.
const MANUFACTURING_PL: FsBuilderConfig = {
  groups: [
    { key: 'revenue', label: 'Revenue from sales', labelTh: 'รายได้จากการขาย', level: 0, normalSide: 'credit', isGroups: ['revenue'], showAccounts: true },
    { key: 'cogs_dm', label: 'Direct materials', labelTh: 'วัตถุดิบทางตรง', level: 1, normalSide: 'debit', accounts: ['500001'] },
    { key: 'cogs_dl', label: 'Direct labour', labelTh: 'ค่าแรงทางตรง', level: 1, normalSide: 'debit', accounts: ['500002'] },
    { key: 'cogs_moh', label: 'Manufacturing overhead', labelTh: 'ค่าโสหุ้ยการผลิต', level: 1, normalSide: 'debit', accounts: ['500003'] },
    { key: 'cogs_other', label: 'Other cost of sales', labelTh: 'ต้นทุนขายอื่น', level: 1, sumOf: [{ key: 'cogs', factor: 1 }, { key: 'cogs_dm', factor: -1 }, { key: 'cogs_dl', factor: -1 }, { key: 'cogs_moh', factor: -1 }] },
    { key: 'cogs', label: 'Total cost of goods sold', labelTh: 'รวมต้นทุนขาย', level: 0, normalSide: 'debit', isGroups: ['cogs'] },
    { key: 'gross_profit', label: 'Gross profit', labelTh: 'กำไรขั้นต้น', level: 0, sumOf: [{ key: 'revenue', factor: 1 }, { key: 'cogs', factor: -1 }] },
    ...plTail('gross_profit'),
  ],
};

// CONSTRUCTION — cost of work by resource (labour / materials / subcontractor / equipment) + residual.
const CONSTRUCTION_PL: FsBuilderConfig = {
  groups: [
    { key: 'revenue', label: 'Construction / project revenue', labelTh: 'รายได้งานก่อสร้าง', level: 0, normalSide: 'credit', isGroups: ['revenue'], showAccounts: true },
    { key: 'cw_labor', label: 'Cost of work — labour', labelTh: 'ต้นทุนงาน — ค่าแรง', level: 1, normalSide: 'debit', accounts: ['580001'] },
    { key: 'cw_materials', label: 'Cost of work — materials', labelTh: 'ต้นทุนงาน — ค่าวัสดุ', level: 1, normalSide: 'debit', accounts: ['580002'] },
    { key: 'cw_subcontract', label: 'Cost of work — subcontractor', labelTh: 'ต้นทุนงาน — ค่าผู้รับเหมาช่วง', level: 1, normalSide: 'debit', accounts: ['580003'] },
    { key: 'cw_equipment', label: 'Cost of work — equipment / plant', labelTh: 'ต้นทุนงาน — ค่าเครื่องจักร', level: 1, normalSide: 'debit', accounts: ['580004'] },
    { key: 'cw_other', label: 'Cost of work — other', labelTh: 'ต้นทุนงาน — อื่น', level: 1, sumOf: [{ key: 'cogs', factor: 1 }, { key: 'cw_labor', factor: -1 }, { key: 'cw_materials', factor: -1 }, { key: 'cw_subcontract', factor: -1 }, { key: 'cw_equipment', factor: -1 }] },
    { key: 'cogs', label: 'Total cost of work', labelTh: 'รวมต้นทุนงานก่อสร้าง', level: 0, normalSide: 'debit', isGroups: ['cogs'] },
    { key: 'gross_profit', label: 'Gross profit', labelTh: 'กำไรขั้นต้น', level: 0, sumOf: [{ key: 'revenue', factor: 1 }, { key: 'cogs', factor: -1 }] },
    ...plTail('gross_profit'),
  ],
};

// HOSPITALITY — operating statement that surfaces revenue by department (rooms / F&B) and the direct F&B
// cost; the standard gross/operating/net subtotals keep the tie-out.
const HOSPITALITY_PL: FsBuilderConfig = {
  groups: [
    { key: 'room_revenue', label: 'Rooms & other service revenue', labelTh: 'รายได้ห้องพักและบริการ', level: 1, normalSide: 'credit', accounts: ['430001', '430002'] },
    { key: 'fnb_revenue', label: 'Food & beverage revenue', labelTh: 'รายได้อาหารและเครื่องดื่ม', level: 1, normalSide: 'credit', accounts: ['400001', '400002'] },
    { key: 'revenue', label: 'Total revenue', labelTh: 'รวมรายได้', level: 0, normalSide: 'credit', isGroups: ['revenue'] },
    { key: 'fnb_cost', label: 'Cost of food & beverage', labelTh: 'ต้นทุนอาหารและเครื่องดื่ม', level: 1, normalSide: 'debit', accounts: ['500011', '500012'] },
    { key: 'cogs', label: 'Total cost of sales', labelTh: 'รวมต้นทุนขาย', level: 0, normalSide: 'debit', isGroups: ['cogs'] },
    { key: 'gross_profit', label: 'Gross operating profit', labelTh: 'กำไรขั้นต้นจากการดำเนินงาน', level: 0, sumOf: [{ key: 'revenue', factor: 1 }, { key: 'cogs', factor: -1 }] },
    ...plTail('gross_profit'),
  ],
};

// NONPROFIT — a Statement of Activities: support & revenue less functional expenses (program / management &
// administration / fundraising, with a residual) = change in net assets. `total_expenses` selects all
// Expense-type accounts so the functional split always reconciles, and the bottom line = support − expenses
// (equal to the canonical net income).
const NONPROFIT_PL: FsBuilderConfig = {
  groups: [
    { key: 'support', label: 'Revenue & support', labelTh: 'รายได้และเงินสนับสนุน', level: 0, normalSide: 'credit', isGroups: ['revenue', 'other_income'], showAccounts: true },
    { key: 'exp_program', label: 'Program services', labelTh: 'ค่าใช้จ่ายดำเนินโครงการ', level: 1, normalSide: 'debit', accounts: ['510020'] },
    { key: 'exp_admin', label: 'Management & administration', labelTh: 'ค่าใช้จ่ายบริหารจัดการ', level: 1, normalSide: 'debit', accounts: ['510021'] },
    { key: 'exp_fundraising', label: 'Fundraising', labelTh: 'ค่าใช้จ่ายการระดมทุน', level: 1, normalSide: 'debit', accounts: ['510022'] },
    { key: 'exp_other', label: 'Other operating expenses', labelTh: 'ค่าใช้จ่ายดำเนินงานอื่น', level: 1, sumOf: [{ key: 'total_expenses', factor: 1 }, { key: 'exp_program', factor: -1 }, { key: 'exp_admin', factor: -1 }, { key: 'exp_fundraising', factor: -1 }] },
    { key: 'total_expenses', label: 'Total expenses', labelTh: 'รวมค่าใช้จ่าย', level: 0, normalSide: 'debit', types: ['Expense'] },
    { key: 'change_in_net_assets', label: 'Change in net assets', labelTh: 'การเปลี่ยนแปลงในสินทรัพย์สุทธิ', level: 0, sumOf: [{ key: 'support', factor: 1 }, { key: 'total_expenses', factor: -1 }] },
  ],
};

// ───────────────── Per-industry default statutory Balance Sheet layouts (FIN-4, P7) ─────────────────
// The generic DBD-BS (thai-dbd-fs.ts) already sections every account current/non-current asset · liability ·
// equity. These bespoke defaults exist only for industries whose STATEMENT STRUCTURE genuinely differs:
//   • nonprofit    — a Statement of Financial Position with NET ASSETS split with/without donor restrictions
//                    (ASC 958 / Thai NPO practice) instead of share capital + retained earnings
//   • agriculture  — biological assets surfaced as a distinct statutory line (TAS 41)
//   • construction — contract work-in-progress (contract assets) surfaced as a distinct current-asset line
//   • real estate  — property inventory under development surfaced as a distinct non-current line
// getDefinition('DBD-BS') resolves the caller's / requested industry to one of these; everything else keeps
// the generic DBD-BS. Every layout TIES OUT: total assets == total liabilities + equity(+net assets), the
// same identity the generic balance sheet holds (the current-period result folds into equity/unrestricted).

// The standard liabilities + equity tail shared by the asset-side-only variants (agriculture/construction/
// real estate keep the generic equity presentation; only the asset section is re-shaped).
function bsLiabilitiesEquityTail(): FsGroup[] {
  return [
    { key: 'current_liabilities', label: 'Current liabilities', labelTh: 'หนี้สินหมุนเวียน', level: 0, normalSide: 'credit', bsGroups: ['current_liability'], showAccounts: true },
    { key: 'noncurrent_liabilities', label: 'Non-current liabilities', labelTh: 'หนี้สินไม่หมุนเวียน', level: 0, normalSide: 'credit', bsGroups: ['noncurrent_liability'], showAccounts: true },
    { key: 'equity_accounts', label: 'Share capital & reserves', labelTh: 'ทุนและสำรอง', level: 1, normalSide: 'credit', bsGroups: ['equity'], showAccounts: true },
    { key: 'result_for_period', label: 'Retained earnings / result for the period', labelTh: 'กำไร(ขาดทุน)สะสมและผลประกอบการงวดปัจจุบัน', level: 1, normalSide: 'credit', types: ['Revenue', 'Expense'] },
    { key: 'total_equity', label: 'Total equity', labelTh: 'รวมส่วนของผู้ถือหุ้น', level: 0, sumOf: [{ key: 'equity_accounts', factor: 1 }, { key: 'result_for_period', factor: 1 }] },
    { key: 'total_liab_equity', label: 'Total liabilities and equity', labelTh: 'รวมหนี้สินและส่วนของผู้ถือหุ้น', level: 0, sumOf: [{ key: 'current_liabilities', factor: 1 }, { key: 'noncurrent_liabilities', factor: 1 }, { key: 'total_equity', factor: 1 }] },
  ];
}

// NONPROFIT — Statement of Financial Position. Assets & liabilities as usual, but the residual is NET ASSETS
// split WITH vs WITHOUT donor restrictions (310011 restricted; everything else + the period surplus is
// unrestricted). `_all_equity` is a hidden helper so "without restrictions" = all equity + result − restricted.
const NONPROFIT_BS: FsBuilderConfig = {
  groups: [
    { key: 'current_assets', label: 'Current assets', labelTh: 'สินทรัพย์หมุนเวียน', level: 0, normalSide: 'debit', bsGroups: ['current_asset'], showAccounts: true },
    { key: 'noncurrent_assets', label: 'Non-current assets', labelTh: 'สินทรัพย์ไม่หมุนเวียน', level: 0, normalSide: 'debit', bsGroups: ['noncurrent_asset'], showAccounts: true },
    { key: 'total_assets', label: 'Total assets', labelTh: 'รวมสินทรัพย์', level: 0, sumOf: [{ key: 'current_assets', factor: 1 }, { key: 'noncurrent_assets', factor: 1 }] },
    { key: 'current_liabilities', label: 'Current liabilities', labelTh: 'หนี้สินหมุนเวียน', level: 0, normalSide: 'credit', bsGroups: ['current_liability'], showAccounts: true },
    { key: 'noncurrent_liabilities', label: 'Non-current liabilities', labelTh: 'หนี้สินไม่หมุนเวียน', level: 0, normalSide: 'credit', bsGroups: ['noncurrent_liability'], showAccounts: true },
    { key: 'total_liabilities', label: 'Total liabilities', labelTh: 'รวมหนี้สิน', level: 0, sumOf: [{ key: 'current_liabilities', factor: 1 }, { key: 'noncurrent_liabilities', factor: 1 }] },
    { key: '_all_equity', label: '(all equity)', level: 0, normalSide: 'credit', bsGroups: ['equity'], hidden: true },
    { key: '_result', label: '(result)', level: 0, normalSide: 'credit', types: ['Revenue', 'Expense'], hidden: true },
    { key: 'na_restricted', label: 'Net assets with donor restrictions', labelTh: 'สินทรัพย์สุทธิที่มีข้อจำกัด', level: 1, normalSide: 'credit', accounts: ['310011'], showAccounts: true },
    { key: 'na_unrestricted', label: 'Net assets without donor restrictions', labelTh: 'สินทรัพย์สุทธิที่ไม่มีข้อจำกัด', level: 1, sumOf: [{ key: '_all_equity', factor: 1 }, { key: '_result', factor: 1 }, { key: 'na_restricted', factor: -1 }] },
    { key: 'total_net_assets', label: 'Total net assets', labelTh: 'รวมสินทรัพย์สุทธิ', level: 0, sumOf: [{ key: 'na_unrestricted', factor: 1 }, { key: 'na_restricted', factor: 1 }] },
    { key: 'total_liab_net_assets', label: 'Total liabilities and net assets', labelTh: 'รวมหนี้สินและสินทรัพย์สุทธิ', level: 0, sumOf: [{ key: 'total_liabilities', factor: 1 }, { key: 'total_net_assets', factor: 1 }] },
  ],
};

// AGRICULTURE — biological assets (125010/125011, current) as a distinct TAS-41 line; "_all_current" is a
// hidden helper so "other current assets" = all current − biological, and the section total still ties.
const AGRICULTURE_BS: FsBuilderConfig = {
  groups: [
    { key: '_all_current', label: '(all current)', level: 0, normalSide: 'debit', bsGroups: ['current_asset'], hidden: true },
    { key: 'biological_assets', label: 'Biological assets (TAS 41)', labelTh: 'สินทรัพย์ชีวภาพ (TAS 41)', level: 1, normalSide: 'debit', prefixes: ['1250'], showAccounts: true },
    { key: 'other_current_assets', label: 'Other current assets', labelTh: 'สินทรัพย์หมุนเวียนอื่น', level: 1, sumOf: [{ key: '_all_current', factor: 1 }, { key: 'biological_assets', factor: -1 }] },
    { key: 'current_assets', label: 'Total current assets', labelTh: 'รวมสินทรัพย์หมุนเวียน', level: 0, sumOf: [{ key: 'biological_assets', factor: 1 }, { key: 'other_current_assets', factor: 1 }] },
    { key: 'noncurrent_assets', label: 'Non-current assets', labelTh: 'สินทรัพย์ไม่หมุนเวียน', level: 0, normalSide: 'debit', bsGroups: ['noncurrent_asset'], showAccounts: true },
    { key: 'total_assets', label: 'Total assets', labelTh: 'รวมสินทรัพย์', level: 0, sumOf: [{ key: 'current_assets', factor: 1 }, { key: 'noncurrent_assets', factor: 1 }] },
    ...bsLiabilitiesEquityTail(),
  ],
};

// CONSTRUCTION — contract work-in-progress (126xxx, current) surfaced as "contract assets"; symmetric to
// agriculture's biological-asset carve-out.
const CONSTRUCTION_BS: FsBuilderConfig = {
  groups: [
    { key: '_all_current', label: '(all current)', level: 0, normalSide: 'debit', bsGroups: ['current_asset'], hidden: true },
    { key: 'contract_wip', label: 'Construction work in progress (contract assets)', labelTh: 'งานระหว่างก่อสร้าง (สินทรัพย์ตามสัญญา)', level: 1, normalSide: 'debit', prefixes: ['1260'], showAccounts: true },
    { key: 'other_current_assets', label: 'Other current assets', labelTh: 'สินทรัพย์หมุนเวียนอื่น', level: 1, sumOf: [{ key: '_all_current', factor: 1 }, { key: 'contract_wip', factor: -1 }] },
    { key: 'current_assets', label: 'Total current assets', labelTh: 'รวมสินทรัพย์หมุนเวียน', level: 0, sumOf: [{ key: 'contract_wip', factor: 1 }, { key: 'other_current_assets', factor: 1 }] },
    { key: 'noncurrent_assets', label: 'Non-current assets', labelTh: 'สินทรัพย์ไม่หมุนเวียน', level: 0, normalSide: 'debit', bsGroups: ['noncurrent_asset'], showAccounts: true },
    { key: 'total_assets', label: 'Total assets', labelTh: 'รวมสินทรัพย์', level: 0, sumOf: [{ key: 'current_assets', factor: 1 }, { key: 'noncurrent_assets', factor: 1 }] },
    ...bsLiabilitiesEquityTail(),
  ],
};

// REAL ESTATE — property inventory under development (152xxx, NON-current) surfaced as a distinct line within
// non-current assets; "_all_noncurrent" is the hidden helper for the residual.
const REALESTATE_BS: FsBuilderConfig = {
  groups: [
    { key: 'current_assets', label: 'Current assets', labelTh: 'สินทรัพย์หมุนเวียน', level: 0, normalSide: 'debit', bsGroups: ['current_asset'], showAccounts: true },
    { key: '_all_noncurrent', label: '(all non-current)', level: 0, normalSide: 'debit', bsGroups: ['noncurrent_asset'], hidden: true },
    { key: 'property_inventory', label: 'Property inventory under development', labelTh: 'อสังหาริมทรัพย์ระหว่างพัฒนา', level: 1, normalSide: 'debit', prefixes: ['1520'], showAccounts: true },
    { key: 'other_noncurrent_assets', label: 'Other non-current assets', labelTh: 'สินทรัพย์ไม่หมุนเวียนอื่น', level: 1, sumOf: [{ key: '_all_noncurrent', factor: 1 }, { key: 'property_inventory', factor: -1 }] },
    { key: 'noncurrent_assets', label: 'Total non-current assets', labelTh: 'รวมสินทรัพย์ไม่หมุนเวียน', level: 0, sumOf: [{ key: 'property_inventory', factor: 1 }, { key: 'other_noncurrent_assets', factor: 1 }] },
    { key: 'total_assets', label: 'Total assets', labelTh: 'รวมสินทรัพย์', level: 0, sumOf: [{ key: 'current_assets', factor: 1 }, { key: 'noncurrent_assets', factor: 1 }] },
    ...bsLiabilitiesEquityTail(),
  ],
};

export const INDUSTRY_FS_DEFS: Record<string, { pl?: IndustryFsDef; bs?: IndustryFsDef }> = {
  manufacturing: { pl: { name: 'งบกำไรขาดทุน — การผลิต (DBD/TFRS)', statementType: 'pl', config: MANUFACTURING_PL } },
  construction: {
    pl: { name: 'งบกำไรขาดทุน — งานก่อสร้าง (DBD/TFRS)', statementType: 'pl', config: CONSTRUCTION_PL },
    bs: { name: 'งบแสดงฐานะการเงิน — งานก่อสร้าง (DBD/TFRS)', statementType: 'bs', config: CONSTRUCTION_BS },
  },
  hospitality: { pl: { name: 'งบกำไรขาดทุน — โรงแรม/บริการ (DBD/TFRS)', statementType: 'pl', config: HOSPITALITY_PL } },
  nonprofit: {
    pl: { name: 'งบแสดงกิจกรรม (Statement of Activities)', statementType: 'pl', config: NONPROFIT_PL },
    bs: { name: 'งบแสดงฐานะการเงิน (Statement of Financial Position)', statementType: 'bs', config: NONPROFIT_BS },
  },
  agriculture: { bs: { name: 'งบแสดงฐานะการเงิน — เกษตร (TAS 41)', statementType: 'bs', config: AGRICULTURE_BS } },
  realestate: { bs: { name: 'งบแสดงฐานะการเงิน — อสังหาริมทรัพย์ (DBD/TFRS)', statementType: 'bs', config: REALESTATE_BS } },
};
