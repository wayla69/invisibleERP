// ─────────────────────────────────────────────────────────────────────────────
// Finance KPI engine — canonical metric definitions (docs/35 Phase 1).
//
// One source of truth for the CFO scorecard: the account-group classification the
// balance-sheet / P&L KPIs roll up to, and the METRICS registry (id → formula,
// unit, group, RAG band). Everything downstream — the /api/finance/metrics/pack
// endpoint, the CFO Command Center tiles, the scheduled cfo_kpi_pack, and the
// exec_scorecard finance leg — reads the SAME definition here, so no metric drifts.
//
// Per CLAUDE.md (mirrors the CF_CLASSIFY gotcha in ledger-constants.ts): when a NEW
// balance-sheet / P&L GL account is added, classify it in the sets below or the
// ratios silently mis-bucket it. Codes not listed fall back by account_type + the
// numbering convention (assets ≥1500 = non-current, liabilities ≥2600 = non-current).
// ─────────────────────────────────────────────────────────────────────────────

// ── Balance-sheet account groups (as-of balances, signed by normal balance) ──
// Cash & equivalents — same set the SCF explains (kept in sync with CASH_ACCOUNTS).
export const CASH_ACCOUNTS = ['1000', '1010', '1015', '1020'];
// Trade + other receivables (net of the 1190 allowance contra, credit-normal ⇒ reduces the group).
export const RECEIVABLE_ACCOUNTS = ['1100', '1150', '1180', '1260', '1265', '1190'];
// Inventory / WIP / finished goods.
export const INVENTORY_ACCOUNTS = ['1200', '1210', '1250'];
// Other current assets (prepaids).
export const OTHER_CURRENT_ASSET_ACCOUNTS = ['1280'];
// Non-current assets: PP&E (+ accum-dep contra), ROU (+ accum-ROU-dep contra), deferred-tax asset.
export const NONCURRENT_ASSET_ACCOUNTS = ['1500', '1590', '1600', '1690', '1700'];
// Current liabilities.
export const CURRENT_LIABILITY_ACCOUNTS = [
  '2000', '2100', '2150', '2200', '2210', '2250', '2300', '2350', '2360', '2361',
  '2370', '2380', '2390', '2400', '2410', '2420',
];
// Non-current liabilities: lease liability, deferred-tax liability.
export const NONCURRENT_LIABILITY_ACCOUNTS = ['2600', '2700'];
// Interest-bearing debt (for net-debt / leverage). Lease liability is the only debt-like account in the CoA.
export const INTEREST_BEARING_DEBT_ACCOUNTS = ['2600'];
// Trade-control accounts used for DSO/DPO (the sub-ledger control lines).
export const AR_CONTROL_ACCOUNTS = ['1100', '1190']; // net of allowance
export const AP_CONTROL_ACCOUNTS = ['2000'];

// ── P&L account groups (period flows) ──
export const COGS_ACCOUNTS = ['5000', '5300', '5500', '5800'];
export const DEPRECIATION_ACCOUNTS = ['5200', '5210']; // depreciation & amortization (incl. ROU)
export const INTEREST_EXPENSE_ACCOUNTS = ['5900'];
export const INCOME_TAX_ACCOUNTS = ['5950']; // deferred-tax expense (no current-tax account in the CoA yet)

export type MetricGroup =
  | 'liquidity' | 'efficiency' | 'profitability' | 'leverage' | 'growth_cash' | 'receivables_payables';

export type MetricUnit = 'ratio' | 'x' | 'days' | 'pct' | 'currency' | 'months';

// RAG band: `good` says which direction is healthy; `green`/`amber` are the thresholds.
//   good:'up'   → v≥green ⇒ green,  v≥amber ⇒ amber, else red
//   good:'down' → v≤green ⇒ green,  v≤amber ⇒ amber, else red
export interface RagBand { good: 'up' | 'down'; green: number; amber: number }

export function ragOf(band: RagBand | null | undefined, value: number | null): 'green' | 'amber' | 'red' | null {
  if (!band || value == null || !Number.isFinite(value)) return null;
  if (band.good === 'up') return value >= band.green ? 'green' : value >= band.amber ? 'amber' : 'red';
  return value <= band.green ? 'green' : value <= band.amber ? 'amber' : 'red';
}

// The raw aggregates one KPI snapshot needs; each metric is a pure function of this.
export interface FinSnapshot {
  from: string; to: string; days: number;
  // Balance sheet (as of `to`)
  cash: number; receivables: number; inventory: number; otherCurrentAssets: number;
  currentAssets: number; nonCurrentAssets: number; totalAssets: number;
  currentLiabilities: number; nonCurrentLiabilities: number; totalLiabilities: number;
  equity: number; interestBearingDebt: number;
  arControl: number; apControl: number;
  // P&L (over the window) — used for margins (ratios of same-window flows, window-length-independent)
  revenue: number; cogs: number; grossProfit: number; opex: number;
  depreciation: number; interest: number; incomeTax: number;
  operatingIncome: number; ebitda: number; netIncome: number;
  // Trailing-twelve-month P&L (ending at `to`, CLOSE excluded) — the basis for annualized/efficiency KPIs
  // (turnover, DSO/DPO/DIO, ROA/ROE, days-cash, runway) so they are stable regardless of the display window.
  ttmRevenue: number; ttmCogs: number; ttmOpex: number; ttmNetIncome: number;
  // Cash flow (over the window)
  ocf: number; capex: number; fcf: number;
  // AR/AP health (as of `to`, from aging) — comparatives may be null when not recomputable historically
  arTotal: number; arOverdue: number; ar90plus: number; allowance: number;
  apTotal: number; apOverdue: number;
}

const pct = (num: number, den: number): number | null => (den > 0 || den < 0 ? round2((num / den) * 100) : null);
const ratio = (num: number, den: number): number | null => (den > 0 ? round4(num / den) : null);
function round2(x: number): number { return Math.round((Number(x) || 0) * 100) / 100; }
function round4(x: number): number { return Math.round((Number(x) || 0) * 10000) / 10000; }

export interface MetricDef {
  id: string;
  group: MetricGroup;
  label: string;    // Thai
  labelEn: string;
  unit: MetricUnit;
  rag?: RagBand;
  // The GL account codes behind the metric (for drill-through). Empty ⇒ derived-only.
  drill?: string[];
  compute: (s: FinSnapshot) => number | null;
}

// ── The canonical ~32-KPI registry ──────────────────────────────────────────
export const METRICS: MetricDef[] = [
  // Liquidity
  { id: 'current_ratio', group: 'liquidity', label: 'อัตราส่วนทุนหมุนเวียน', labelEn: 'Current ratio', unit: 'ratio', rag: { good: 'up', green: 1.5, amber: 1.0 }, drill: [...CASH_ACCOUNTS, ...RECEIVABLE_ACCOUNTS, ...INVENTORY_ACCOUNTS, ...OTHER_CURRENT_ASSET_ACCOUNTS, ...CURRENT_LIABILITY_ACCOUNTS], compute: (s) => ratio(s.currentAssets, s.currentLiabilities) },
  { id: 'quick_ratio', group: 'liquidity', label: 'อัตราส่วนทุนหมุนเวียนเร็ว', labelEn: 'Quick (acid-test) ratio', unit: 'ratio', rag: { good: 'up', green: 1.0, amber: 0.8 }, drill: [...CASH_ACCOUNTS, ...RECEIVABLE_ACCOUNTS, ...CURRENT_LIABILITY_ACCOUNTS], compute: (s) => ratio(s.currentAssets - s.inventory, s.currentLiabilities) },
  { id: 'cash_ratio', group: 'liquidity', label: 'อัตราส่วนเงินสด', labelEn: 'Cash ratio', unit: 'ratio', rag: { good: 'up', green: 0.5, amber: 0.2 }, drill: [...CASH_ACCOUNTS, ...CURRENT_LIABILITY_ACCOUNTS], compute: (s) => ratio(s.cash, s.currentLiabilities) },
  { id: 'working_capital', group: 'liquidity', label: 'เงินทุนหมุนเวียนสุทธิ', labelEn: 'Working capital', unit: 'currency', drill: [...CASH_ACCOUNTS, ...RECEIVABLE_ACCOUNTS, ...INVENTORY_ACCOUNTS, ...OTHER_CURRENT_ASSET_ACCOUNTS, ...CURRENT_LIABILITY_ACCOUNTS], compute: (s) => round2(s.currentAssets - s.currentLiabilities) },
  { id: 'days_cash_on_hand', group: 'liquidity', label: 'จำนวนวันที่มีเงินสดใช้', labelEn: 'Days cash on hand', unit: 'days', rag: { good: 'up', green: 60, amber: 30 }, drill: CASH_ACCOUNTS, compute: (s) => { const dailyOpex = (s.ttmCogs + s.ttmOpex) > 0 ? (s.ttmCogs + s.ttmOpex) / 365 : 0; return dailyOpex > 0 ? round2(s.cash / dailyOpex) : null; } },
  { id: 'cash_conversion_cycle', group: 'liquidity', label: 'วงจรเงินสด (CCC)', labelEn: 'Cash conversion cycle', unit: 'days', rag: { good: 'down', green: 30, amber: 60 }, compute: (s) => { const dso = s.ttmRevenue > 0 ? (s.arControl / s.ttmRevenue) * 365 : null; const dpo = s.ttmCogs > 0 ? (s.apControl / s.ttmCogs) * 365 : null; const dio = s.ttmCogs > 0 ? (s.inventory / s.ttmCogs) * 365 : null; return dso == null || dpo == null || dio == null ? null : round2(dso + dio - dpo); } },

  // Efficiency — annualized on the trailing-twelve-month flow (window-length-independent)
  { id: 'dso', group: 'efficiency', label: 'ระยะเวลาเก็บหนี้ (DSO)', labelEn: 'Days sales outstanding', unit: 'days', rag: { good: 'down', green: 45, amber: 60 }, drill: AR_CONTROL_ACCOUNTS, compute: (s) => (s.ttmRevenue > 0 ? round2((s.arControl / s.ttmRevenue) * 365) : null) },
  { id: 'dpo', group: 'efficiency', label: 'ระยะเวลาชำระหนี้ (DPO)', labelEn: 'Days payable outstanding', unit: 'days', rag: { good: 'up', green: 30, amber: 20 }, drill: AP_CONTROL_ACCOUNTS, compute: (s) => (s.ttmCogs > 0 ? round2((s.apControl / s.ttmCogs) * 365) : null) },
  { id: 'dio', group: 'efficiency', label: 'ระยะเวลาขายสินค้า (DIO)', labelEn: 'Days inventory outstanding', unit: 'days', rag: { good: 'down', green: 30, amber: 60 }, drill: INVENTORY_ACCOUNTS, compute: (s) => (s.ttmCogs > 0 ? round2((s.inventory / s.ttmCogs) * 365) : null) },
  { id: 'ar_turnover', group: 'efficiency', label: 'อัตราหมุนเวียนลูกหนี้', labelEn: 'AR turnover', unit: 'x', rag: { good: 'up', green: 8, amber: 4 }, drill: AR_CONTROL_ACCOUNTS, compute: (s) => ratio(s.ttmRevenue, s.arControl) },
  { id: 'ap_turnover', group: 'efficiency', label: 'อัตราหมุนเวียนเจ้าหนี้', labelEn: 'AP turnover', unit: 'x', drill: AP_CONTROL_ACCOUNTS, compute: (s) => ratio(s.ttmCogs, s.apControl) },
  { id: 'inventory_turnover', group: 'efficiency', label: 'อัตราหมุนเวียนสินค้าคงเหลือ', labelEn: 'Inventory turnover', unit: 'x', rag: { good: 'up', green: 6, amber: 3 }, drill: INVENTORY_ACCOUNTS, compute: (s) => ratio(s.ttmCogs, s.inventory) },

  // Profitability
  { id: 'gross_margin_pct', group: 'profitability', label: 'อัตรากำไรขั้นต้น', labelEn: 'Gross margin %', unit: 'pct', rag: { good: 'up', green: 40, amber: 20 }, compute: (s) => pct(s.grossProfit, s.revenue) },
  { id: 'operating_margin_pct', group: 'profitability', label: 'อัตรากำไรจากการดำเนินงาน', labelEn: 'Operating margin %', unit: 'pct', rag: { good: 'up', green: 15, amber: 5 }, compute: (s) => pct(s.operatingIncome, s.revenue) },
  { id: 'net_margin_pct', group: 'profitability', label: 'อัตรากำไรสุทธิ', labelEn: 'Net margin %', unit: 'pct', rag: { good: 'up', green: 10, amber: 3 }, compute: (s) => pct(s.netIncome, s.revenue) },
  { id: 'ebitda', group: 'profitability', label: 'EBITDA', labelEn: 'EBITDA', unit: 'currency', compute: (s) => round2(s.ebitda) },
  { id: 'ebitda_margin_pct', group: 'profitability', label: 'อัตรากำไร EBITDA', labelEn: 'EBITDA margin %', unit: 'pct', rag: { good: 'up', green: 15, amber: 5 }, compute: (s) => pct(s.ebitda, s.revenue) },
  { id: 'roa_pct', group: 'profitability', label: 'ผลตอบแทนต่อสินทรัพย์ (ROA)', labelEn: 'Return on assets %', unit: 'pct', rag: { good: 'up', green: 8, amber: 3 }, compute: (s) => pct(s.ttmNetIncome, s.totalAssets) },
  { id: 'roe_pct', group: 'profitability', label: 'ผลตอบแทนต่อส่วนของผู้ถือหุ้น (ROE)', labelEn: 'Return on equity %', unit: 'pct', rag: { good: 'up', green: 15, amber: 5 }, compute: (s) => (s.equity > 0 ? pct(s.ttmNetIncome, s.equity) : null) },

  // Leverage / solvency
  { id: 'debt_to_equity', group: 'leverage', label: 'อัตราส่วนหนี้สินต่อทุน', labelEn: 'Debt-to-equity', unit: 'ratio', rag: { good: 'down', green: 1.0, amber: 2.0 }, compute: (s) => (s.equity > 0 ? ratio(s.totalLiabilities, s.equity) : null) },
  { id: 'interest_coverage', group: 'leverage', label: 'ความสามารถชำระดอกเบี้ย', labelEn: 'Interest coverage', unit: 'x', rag: { good: 'up', green: 3, amber: 1.5 }, drill: INTEREST_EXPENSE_ACCOUNTS, compute: (s) => (s.interest > 0 ? ratio(s.operatingIncome, s.interest) : null) },
  { id: 'net_debt', group: 'leverage', label: 'หนี้สินสุทธิ', labelEn: 'Net debt', unit: 'currency', drill: [...INTEREST_BEARING_DEBT_ACCOUNTS, ...CASH_ACCOUNTS], compute: (s) => round2(s.interestBearingDebt - s.cash) },

  // Growth & cash  (revenue_growth_* are cross-snapshot — computed in the service, not from one snapshot)
  { id: 'operating_cash_flow', group: 'growth_cash', label: 'กระแสเงินสดจากการดำเนินงาน', labelEn: 'Operating cash flow', unit: 'currency', compute: (s) => round2(s.ocf) },
  { id: 'free_cash_flow', group: 'growth_cash', label: 'กระแสเงินสดอิสระ', labelEn: 'Free cash flow', unit: 'currency', compute: (s) => round2(s.fcf) },
  { id: 'cash_runway_months', group: 'growth_cash', label: 'ระยะเวลาเงินสดคงเหลือ (เดือน)', labelEn: 'Cash runway (months)', unit: 'months', rag: { good: 'up', green: 12, amber: 6 }, drill: CASH_ACCOUNTS, compute: (s) => { const monthlyBurn = s.ttmNetIncome < 0 ? (-s.ttmNetIncome) / 12 : 0; return monthlyBurn > 0 ? round2(s.cash / monthlyBurn) : null; } }, // null ⇒ profitable / not burning (TTM)

  // Receivables & payables health (as-of; comparatives null when aging not historically recomputable)
  { id: 'overdue_ar_pct', group: 'receivables_payables', label: 'สัดส่วนลูกหนี้เกินกำหนด', labelEn: 'Overdue AR %', unit: 'pct', rag: { good: 'down', green: 10, amber: 25 }, drill: AR_CONTROL_ACCOUNTS, compute: (s) => pct(s.arOverdue, s.arTotal) },
  { id: 'ar_over_90_pct', group: 'receivables_payables', label: 'ลูกหนี้ค้างเกิน 90 วัน', labelEn: 'AR > 90d concentration %', unit: 'pct', rag: { good: 'down', green: 5, amber: 15 }, drill: AR_CONTROL_ACCOUNTS, compute: (s) => pct(s.ar90plus, s.arTotal) },
  { id: 'overdue_ap_pct', group: 'receivables_payables', label: 'สัดส่วนเจ้าหนี้เกินกำหนด', labelEn: 'Overdue AP %', unit: 'pct', rag: { good: 'down', green: 10, amber: 25 }, drill: AP_CONTROL_ACCOUNTS, compute: (s) => pct(s.apOverdue, s.apTotal) },
  { id: 'allowance_coverage_pct', group: 'receivables_payables', label: 'สัดส่วนค่าเผื่อหนี้สงสัยจะสูญ', labelEn: 'Allowance coverage %', unit: 'pct', drill: ['1190'], compute: (s) => pct(s.allowance, s.arTotal) },
];

export const METRIC_BY_ID: Record<string, MetricDef> = Object.fromEntries(METRICS.map((m) => [m.id, m]));

export const METRIC_GROUPS: { id: MetricGroup; label: string; labelEn: string }[] = [
  { id: 'liquidity', label: 'สภาพคล่อง', labelEn: 'Liquidity' },
  { id: 'efficiency', label: 'ประสิทธิภาพเงินทุนหมุนเวียน', labelEn: 'Working-capital efficiency' },
  { id: 'profitability', label: 'ความสามารถทำกำไร', labelEn: 'Profitability' },
  { id: 'leverage', label: 'โครงสร้างหนี้สิน', labelEn: 'Leverage & solvency' },
  { id: 'growth_cash', label: 'การเติบโตและกระแสเงินสด', labelEn: 'Growth & cash' },
  { id: 'receivables_payables', label: 'สุขภาพลูกหนี้/เจ้าหนี้', labelEn: 'Receivables & payables health' },
];
