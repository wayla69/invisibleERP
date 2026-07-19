// ───────────────── Financial-statement section binding (งบดุล / งบกำไรขาดทุน) ─────────────────
// Each account can be BOUND to a section/line of the Balance Sheet and the Income Statement, mirroring how
// it already binds to a Cash-Flow bucket (accounts.cf_bucket / CF_CLASSIFY). Resolution order matches the
// SCF precedent: the account's OWN column (accounts.bs_group / accounts.is_group) → a canonical default
// (the maps below) → a type-based fallback. So a statement is nicely grouped out of the box, and a company
// can override any account's placement from the Chart-of-Accounts dialog (GL-11).

export type BsGroup = 'current_asset' | 'noncurrent_asset' | 'current_liability' | 'noncurrent_liability' | 'equity';
export type IsGroup = 'revenue' | 'cogs' | 'selling_admin' | 'other_income' | 'other_expense' | 'finance_cost' | 'tax';

export const BS_GROUPS: BsGroup[] = ['current_asset', 'noncurrent_asset', 'current_liability', 'noncurrent_liability', 'equity'];
export const IS_GROUPS: IsGroup[] = ['revenue', 'cogs', 'selling_admin', 'other_income', 'other_expense', 'finance_cost', 'tax'];

export const BS_GROUP_LABELS: Record<BsGroup, { th: string; en: string }> = {
  current_asset: { th: 'สินทรัพย์หมุนเวียน', en: 'Current assets' },
  noncurrent_asset: { th: 'สินทรัพย์ไม่หมุนเวียน', en: 'Non-current assets' },
  current_liability: { th: 'หนี้สินหมุนเวียน', en: 'Current liabilities' },
  noncurrent_liability: { th: 'หนี้สินไม่หมุนเวียน', en: 'Non-current liabilities' },
  equity: { th: 'ส่วนของผู้ถือหุ้น', en: 'Equity' },
};

export const IS_GROUP_LABELS: Record<IsGroup, { th: string; en: string }> = {
  revenue: { th: 'รายได้', en: 'Revenue' },
  cogs: { th: 'ต้นทุนขาย', en: 'Cost of sales' },
  selling_admin: { th: 'ค่าใช้จ่ายในการขายและบริหาร', en: 'Selling & administrative expenses' },
  other_income: { th: 'รายได้อื่น', en: 'Other income' },
  other_expense: { th: 'ค่าใช้จ่ายอื่น', en: 'Other expenses' },
  finance_cost: { th: 'ต้นทุนทางการเงิน', en: 'Finance costs' },
  tax: { th: 'ภาษีเงินได้', en: 'Income tax' },
};

// Canonical codes whose current/non-current placement is NOT the default (assets default current, liabilities
// default current). Everything not listed falls to the current bucket for its type unless is_current says so.
const NONCURRENT_ASSET_CODES = new Set([
  '1150', '1155', '1350', '1355', '1360', '1370', // long-term IC loan + investments
  '1500', '1520', '1530', '1540', '1550', '1560', '1570', '1590', // PP&E + CIP + accum. dep.
  '1600', '1610', '1690', // right-of-use / net investment in lease + accum. ROU dep.
  '1700', // deferred tax asset
  '1800', '1810', // intangibles + accum. amortization
]);
const NONCURRENT_LIABILITY_CODES = new Set([
  '2155', // long-term IC loan payable
  '2550', // long-term borrowings
  '2600', // lease liability
  '2700', // deferred tax liability
]);

// Income-statement default classification (only the non-obvious codes; the rest fall to revenue/selling_admin).
const IS_CLASSIFY: Record<string, IsGroup> = {
  // Cost of sales
  '5000': 'cogs', '5300': 'cogs', '5500': 'cogs', '5800': 'cogs', '5810': 'cogs',
  // Other income (non-operating / financial income + the odd disposal gain account 1510)
  '1510': 'other_income', '4600': 'other_income', '4620': 'other_income', '4700': 'other_income', '4800': 'other_income', '4810': 'other_income', '4900': 'other_income',
  // Other expenses (FX / hedge / impairment / bad debt / donation / SBT / cash variance / misc)
  '5400': 'other_expense', '5410': 'other_expense', '5430': 'other_expense', '5440': 'other_expense', '5450': 'other_expense',
  '5720': 'other_expense', '5820': 'other_expense', '5830': 'other_expense', '5840': 'other_expense', '5760': 'other_expense', '5870': 'other_expense',
  // Finance costs
  '5900': 'finance_cost',
  // Income tax
  '5950': 'tax', '5960': 'tax',
};

interface AccountLike { code: string; type: string; bsGroup?: string | null; isGroup?: string | null; isCurrent?: boolean | null; parentCode?: string | null }

/** Resolve an account's Balance-Sheet section (own column → canonical default → type + is_current fallback). */
export function resolveBsGroup(a: AccountLike): BsGroup | null {
  if (a.bsGroup && (BS_GROUPS as string[]).includes(a.bsGroup)) return a.bsGroup as BsGroup;
  if (a.type === 'Equity') return 'equity';
  if (a.type === 'Asset') {
    if (a.isCurrent === false || NONCURRENT_ASSET_CODES.has(a.code) || (a.parentCode ? NONCURRENT_ASSET_CODES.has(a.parentCode) : false)) return 'noncurrent_asset';
    return 'current_asset';
  }
  if (a.type === 'Liability') {
    if (a.isCurrent === false || NONCURRENT_LIABILITY_CODES.has(a.code) || (a.parentCode ? NONCURRENT_LIABILITY_CODES.has(a.parentCode) : false)) return 'noncurrent_liability';
    return 'current_liability';
  }
  return null; // Revenue/Expense are not on the balance sheet
}

/** Resolve an account's Income-Statement section (own column → canonical default → type fallback). */
export function resolveIsGroup(a: AccountLike): IsGroup | null {
  if (a.isGroup && (IS_GROUPS as string[]).includes(a.isGroup)) return a.isGroup as IsGroup;
  const def = IS_CLASSIFY[a.code] ?? (a.parentCode ? IS_CLASSIFY[a.parentCode] : undefined); // a sub-account inherits its parent's section
  if (def) return def;
  if (a.type === 'Revenue') return 'revenue';
  if (a.type === 'Expense') return 'selling_admin';
  return null; // Asset/Liability/Equity are not on the income statement
}

export function isBsGroup(v: unknown): v is BsGroup { return typeof v === 'string' && (BS_GROUPS as string[]).includes(v); }
export function isIsGroup(v: unknown): v is IsGroup { return typeof v === 'string' && (IS_GROUPS as string[]).includes(v); }

// ── Canonical display order (P2 — CoA numbering is frozen; ordering is metadata-driven) ──────────────
// The natural account codes grew feature-by-feature (next-free-number), so a raw code sort interleaves
// classes (a P&L account like 1510 sits in the 1xxx range, banks after fixed assets, …). Rather than
// renumber the natural keys — 1,000+ hard-coded posting sites depend on them — we compute a stable
// sort_order from the account's CLASS and its statement section, so every account lists in proper
// accountant order (assets → liabilities → equity → revenue → COGS → opex → other → finance → tax) and
// nests under its correct statement heading regardless of the literal code. Purely presentational: it
// never touches postings, balances, or the code itself.
const TYPE_RANK: Record<string, number> = { Asset: 1, Liability: 2, Equity: 3, Revenue: 4, Expense: 5 };
const BS_RANK: Record<BsGroup, number> = { current_asset: 1, noncurrent_asset: 2, current_liability: 3, noncurrent_liability: 4, equity: 5 };
const IS_RANK: Record<IsGroup, number> = { revenue: 1, cogs: 2, selling_admin: 3, other_income: 4, other_expense: 5, finance_cost: 6, tax: 7 };

/** Stable presentational sort key: class → statement section → (parent, then child) so a sub-account nests
 *  directly under its canonical parent. Independent of code hygiene. */
export function coaSortOrder(a: AccountLike): number {
  const t = TYPE_RANK[a.type] ?? 9;
  const bs = resolveBsGroup(a);
  const is = resolveIsGroup(a);
  const sub = bs ? BS_RANK[bs] : is ? IS_RANK[is] : 0;
  // A sub-account sorts by its PARENT's number, then its own trailing suffix, so 126001/126002 nest right
  // under 1260 (rather than at the end of the section). A top-level account sorts by its own number, suffix 0.
  const parent = a.parentCode ? Number.parseInt(a.parentCode, 10) || 0 : 0;
  const base = parent || (Number.parseInt(a.code, 10) || 0);         // ≤ 9999 for canonical parents
  const childSeq = a.parentCode ? (Number.parseInt(a.code.slice(a.parentCode.length), 10) || 0) : 0; // ≤ 99
  return t * 1_000_000_000_000 + sub * 100_000_000 + base * 100 + childSeq;
}
