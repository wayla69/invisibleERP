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

export interface IndustryFsDef { name: string; statementType: 'pl'; config: FsBuilderConfig }

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

export const INDUSTRY_FS_DEFS: Record<string, { pl?: IndustryFsDef }> = {
  manufacturing: { pl: { name: 'งบกำไรขาดทุน — การผลิต (DBD/TFRS)', statementType: 'pl', config: MANUFACTURING_PL } },
  construction: { pl: { name: 'งบกำไรขาดทุน — งานก่อสร้าง (DBD/TFRS)', statementType: 'pl', config: CONSTRUCTION_PL } },
  hospitality: { pl: { name: 'งบกำไรขาดทุน — โรงแรม/บริการ (DBD/TFRS)', statementType: 'pl', config: HOSPITALITY_PL } },
  nonprofit: { pl: { name: 'งบแสดงกิจกรรม (Statement of Activities)', statementType: 'pl', config: NONPROFIT_PL } },
};
