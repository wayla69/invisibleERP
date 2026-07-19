// ───────────────── Default Thai DBD / TFRS statutory statement layouts (FIN-4) ─────────────────
// The FS builder (statutory-fs.service.ts) renders a งบแสดงฐานะการเงิน / งบกำไรขาดทุน from a stored
// fs_report_definitions.config. Historically every layout was buyer-authored, so a fresh tenant had no
// statutory statement out of the box. These two built-in defaults give the standard Thai statutory captions
// (the DBD / TFRS financial-statement format a Thai company files with the Department of Business
// Development) driven off the SAME account classification metadata as the quick balanceSheet/incomeStatement
// (resolveBsGroup / resolveIsGroup) — so the rendered statement always ties to the canonical engine, and a
// tenant can still author its own definition of the same code to override the default (a DB row wins).
//
// This is the Thai analogue of a standard chart's statutory statement mapping (cf. the Luxembourg PCN, where
// each account maps to a balance-sheet caption like A.IV.1.): here the mapping is metadata-driven rather than
// per-account, so it survives new accounts without maintenance.

import type { FsBuilderConfig } from './statutory-fs.service';

export interface DefaultFsDef { code: string; name: string; statementType: 'bs' | 'pl'; config: FsBuilderConfig }

// งบแสดงฐานะการเงิน (Balance sheet) — DBD/TFRS. Section subtotals via the balance-sheet groups (complete by
// construction); the unclosed current-year result folds into equity (types Revenue+Expense) so
// total assets == total liabilities + equity ties out exactly, matching the canonical balanceSheet.
const DBD_BS: FsBuilderConfig = {
  groups: [
    { key: 'current_assets', label: 'Current assets', labelTh: 'สินทรัพย์หมุนเวียน', level: 0, normalSide: 'debit', bsGroups: ['current_asset'], showAccounts: true },
    { key: 'noncurrent_assets', label: 'Non-current assets', labelTh: 'สินทรัพย์ไม่หมุนเวียน', level: 0, normalSide: 'debit', bsGroups: ['noncurrent_asset'], showAccounts: true },
    { key: 'total_assets', label: 'Total assets', labelTh: 'รวมสินทรัพย์', level: 0, sumOf: [{ key: 'current_assets', factor: 1 }, { key: 'noncurrent_assets', factor: 1 }] },
    { key: 'current_liabilities', label: 'Current liabilities', labelTh: 'หนี้สินหมุนเวียน', level: 0, normalSide: 'credit', bsGroups: ['current_liability'], showAccounts: true },
    { key: 'noncurrent_liabilities', label: 'Non-current liabilities', labelTh: 'หนี้สินไม่หมุนเวียน', level: 0, normalSide: 'credit', bsGroups: ['noncurrent_liability'], showAccounts: true },
    { key: 'equity_accounts', label: 'Share capital & reserves', labelTh: 'ทุนและสำรอง', level: 1, normalSide: 'credit', bsGroups: ['equity'], showAccounts: true },
    // Retained earnings incl. the current-period result — the unclosed year still sits in Revenue/Expense
    // (closeYear later sweeps it to 3100), so fold it in here to keep equity — and the tie-out — complete.
    { key: 'result_for_period', label: 'Retained earnings / result for the period', labelTh: 'กำไร(ขาดทุน)สะสมและผลประกอบการงวดปัจจุบัน', level: 1, normalSide: 'credit', types: ['Revenue', 'Expense'] },
    { key: 'total_equity', label: 'Total equity', labelTh: 'รวมส่วนของผู้ถือหุ้น', level: 0, sumOf: [{ key: 'equity_accounts', factor: 1 }, { key: 'result_for_period', factor: 1 }] },
    { key: 'total_liab_equity', label: 'Total liabilities and equity', labelTh: 'รวมหนี้สินและส่วนของผู้ถือหุ้น', level: 0, sumOf: [{ key: 'current_liabilities', factor: 1 }, { key: 'noncurrent_liabilities', factor: 1 }, { key: 'total_equity', factor: 1 }] },
  ],
};

// งบกำไรขาดทุน (Income statement) — DBD/TFRS, multi-step. Mirrors incomeStatement.summary
// (gross profit / operating profit / profit before tax / net profit) off the income-statement groups.
const DBD_PL: FsBuilderConfig = {
  groups: [
    { key: 'revenue', label: 'Revenue from sales and services', labelTh: 'รายได้จากการขายและการให้บริการ', level: 0, normalSide: 'credit', isGroups: ['revenue'], showAccounts: true },
    { key: 'cogs', label: 'Cost of sales and services', labelTh: 'ต้นทุนขายและต้นทุนการให้บริการ', level: 0, normalSide: 'debit', isGroups: ['cogs'], showAccounts: true },
    { key: 'gross_profit', label: 'Gross profit', labelTh: 'กำไรขั้นต้น', level: 0, sumOf: [{ key: 'revenue', factor: 1 }, { key: 'cogs', factor: -1 }] },
    { key: 'other_income', label: 'Other income', labelTh: 'รายได้อื่น', level: 0, normalSide: 'credit', isGroups: ['other_income'], showAccounts: true },
    { key: 'selling_admin', label: 'Selling & administrative expenses', labelTh: 'ค่าใช้จ่ายในการขายและบริหาร', level: 0, normalSide: 'debit', isGroups: ['selling_admin', 'other_expense'], showAccounts: true },
    { key: 'operating_profit', label: 'Operating profit', labelTh: 'กำไรจากการดำเนินงาน', level: 0, sumOf: [{ key: 'gross_profit', factor: 1 }, { key: 'other_income', factor: 1 }, { key: 'selling_admin', factor: -1 }] },
    { key: 'finance_cost', label: 'Finance costs', labelTh: 'ต้นทุนทางการเงิน', level: 0, normalSide: 'debit', isGroups: ['finance_cost'], showAccounts: true },
    { key: 'profit_before_tax', label: 'Profit before income tax', labelTh: 'กำไรก่อนภาษีเงินได้', level: 0, sumOf: [{ key: 'operating_profit', factor: 1 }, { key: 'finance_cost', factor: -1 }] },
    { key: 'income_tax', label: 'Income tax expense', labelTh: 'ค่าใช้จ่ายภาษีเงินได้', level: 0, normalSide: 'debit', isGroups: ['tax'], showAccounts: true },
    { key: 'net_profit', label: 'Net profit (loss)', labelTh: 'กำไร(ขาดทุน)สุทธิ', level: 0, sumOf: [{ key: 'profit_before_tax', factor: 1 }, { key: 'income_tax', factor: -1 }] },
  ],
};

// Built-in defaults, keyed by their reserved code. getDefinition/listDefinitions surface these when a tenant
// has authored no definition of the same code; a DB row of the same code overrides the built-in.
export const THAI_DBD_DEFS: Record<string, DefaultFsDef> = {
  'DBD-BS': { code: 'DBD-BS', name: 'งบแสดงฐานะการเงิน (DBD/TFRS)', statementType: 'bs', config: DBD_BS },
  'DBD-PL': { code: 'DBD-PL', name: 'งบกำไรขาดทุน (DBD/TFRS)', statementType: 'pl', config: DBD_PL },
};
