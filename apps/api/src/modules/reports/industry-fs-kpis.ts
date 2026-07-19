// ───────────────── Per-industry statutory-statement KPIs (FIN-4, P8) ─────────────────
// A rendered statutory statement (DBD-PL / DBD-BS, incl. the per-industry P6/P7 shapes) carries the ratios an
// analyst actually reads it by. Each KPI is computed from the statement's OWN already-rendered group values
// (by group key) — numerator ÷ denominator — so it inherits the exact tie-out of the statement and never
// re-derives a balance. A KPI is emitted only when both referenced rows are present and the denominator is
// non-zero, so the set adapts to whatever layout rendered (generic or an industry shape).

export interface FsKpiSpec {
  key: string;
  label: string;
  labelTh: string;
  num: string;   // group key of the numerator row
  den: string;   // group key of the denominator row
  format: 'pct' | 'ratio';
}

// Generic KPIs that apply to any statement of the given type when the referenced rows exist.
const GENERIC: Record<'pl' | 'bs', FsKpiSpec[]> = {
  pl: [
    { key: 'gross_margin', label: 'Gross margin', labelTh: 'อัตรากำไรขั้นต้น', num: 'gross_profit', den: 'revenue', format: 'pct' },
    { key: 'net_margin', label: 'Net profit margin', labelTh: 'อัตรากำไรสุทธิ', num: 'net_profit', den: 'revenue', format: 'pct' },
  ],
  bs: [
    { key: 'current_ratio', label: 'Current ratio', labelTh: 'อัตราส่วนสภาพคล่อง', num: 'current_assets', den: 'current_liabilities', format: 'ratio' },
  ],
};

// Industry-specific KPIs. A spec whose (num, den) pair matches a generic one REPLACES it (so construction's
// "contract gross margin" and hospitality's "gross operating profit %" relabel the generic gross margin), while
// a genuinely new ratio (nonprofit program-expense / restricted-net-assets) is added alongside.
const BY_INDUSTRY: Record<string, Partial<Record<'pl' | 'bs', FsKpiSpec[]>>> = {
  nonprofit: {
    pl: [{ key: 'program_expense_ratio', label: 'Program-expense ratio', labelTh: 'อัตราส่วนค่าใช้จ่ายเพื่อโครงการ', num: 'exp_program', den: 'total_expenses', format: 'pct' }],
    bs: [{ key: 'restricted_net_assets_ratio', label: 'Donor-restricted net assets %', labelTh: 'สัดส่วนสินทรัพย์สุทธิที่มีข้อจำกัด', num: 'na_restricted', den: 'total_net_assets', format: 'pct' }],
  },
  construction: {
    pl: [{ key: 'contract_gross_margin', label: 'Contract gross margin', labelTh: 'อัตรากำไรขั้นต้นงานก่อสร้าง', num: 'gross_profit', den: 'revenue', format: 'pct' }],
  },
  hospitality: {
    pl: [{ key: 'gop_margin', label: 'Gross operating profit %', labelTh: 'อัตรากำไรขั้นต้นจากการดำเนินงาน', num: 'gross_profit', den: 'revenue', format: 'pct' }],
  },
};

// The KPI specs for a rendered statement, industry-specific first (replacing any generic spec with the same
// numerator/denominator), then the remaining generic specs.
export function fsKpiSpecs(statement: 'pl' | 'bs', industry: string | null): FsKpiSpec[] {
  const ind = (industry ? BY_INDUSTRY[industry]?.[statement] : undefined) ?? [];
  const covered = new Set(ind.map((k) => `${k.num}|${k.den}`));
  const generic = (GENERIC[statement] ?? []).filter((g) => !covered.has(`${g.num}|${g.den}`));
  return [...ind, ...generic];
}
