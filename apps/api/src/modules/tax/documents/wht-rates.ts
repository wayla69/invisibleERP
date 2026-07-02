// อัตราภาษีหัก ณ ที่จ่าย ตามประเภทเงินได้ (มาตรา 40 / คำสั่ง 3 เตรส) — ยืนยันจาก rd.go.th (ท.ป.4/2528,
// คู่มือ ภ.ง.ด.3/53). เก็บเป็น lookup เพราะอัตราเปลี่ยนตามคำสั่งกรมสรรพากร + มีอัตราลดชั่วคราว (e-WHT).
// caller อาจส่ง rate มาเอง (override) ได้ แต่ service จะ validate กับ allow-set ของ income type นั้น.
export type PayeeKind = 'person' | 'company';
export type PndType = 'PND1K' | 'PND1KS' | 'PND2' | 'PND2K' | 'PND3' | 'PND3K' | 'PND53';

export interface IncomeTypeDef {
  code: string;              // canonical key stored in wht_cert_lines.income_type
  labelTh: string;           // printed row label
  group: 1 | 2 | 3 | 4 | 5;  // ม.40 group → drives ภ.ง.ด. form (5 = service-type / 3 เตรส)
  rate: { person?: number; company?: number }; // standard rate; empty = caller must supply (e.g. salary progressive)
  requiresDesc?: boolean;    // row 5/6 require คำอธิบาย (ระบุ)
}

export const WHT_INCOME_TYPES: IncomeTypeDef[] = [
  { code: '40(1)', labelTh: 'เงินเดือน ค่าจ้าง เบี้ยเลี้ยง โบนัส (ม.40(1))', group: 1, rate: {} },                 // progressive
  { code: '40(2)', labelTh: 'ค่าธรรมเนียม ค่านายหน้า (ม.40(2))', group: 2, rate: { person: 0.03, company: 0.03 } },
  { code: '40(3)', labelTh: 'ค่าแห่งลิขสิทธิ์ (ม.40(3))', group: 2, rate: { person: 0.03, company: 0.03 } },
  { code: '40(4a)', labelTh: 'ดอกเบี้ย (ม.40(4)(ก))', group: 4, rate: { person: 0.15, company: 0.01 } },
  { code: '40(4b)', labelTh: 'เงินปันผล (ม.40(4)(ข))', group: 4, rate: { person: 0.1, company: 0.1 } },
  { code: '40(5)', labelTh: 'ค่าเช่าทรัพย์สิน (ม.40(5))', group: 5, rate: { person: 0.05, company: 0.05 } },
  { code: '40(6)', labelTh: 'ค่าวิชาชีพอิสระ (ม.40(6))', group: 5, rate: { person: 0.03, company: 0.03 } },
  { code: '40(7-8)', labelTh: 'ค่าจ้างทำของ/รับเหมา (ม.40(7)(8))', group: 5, rate: { person: 0.03, company: 0.03 } },
  { code: '3tre-service', labelTh: 'ค่าบริการ (3 เตรส)', group: 5, rate: { person: 0.03, company: 0.03 }, requiresDesc: true },
  { code: '3tre-ad', labelTh: 'ค่าโฆษณา (3 เตรส)', group: 5, rate: { person: 0.02, company: 0.02 }, requiresDesc: true },
  { code: '3tre-transport', labelTh: 'ค่าขนส่ง (ไม่ใช่สาธารณะ, 3 เตรส)', group: 5, rate: { person: 0.01, company: 0.01 }, requiresDesc: true },
  { code: '3tre-prize', labelTh: 'รางวัล/ส่งเสริมการขาย (3 เตรส)', group: 5, rate: { person: 0.05, company: 0.05 }, requiresDesc: true },
  { code: 'other', labelTh: 'เงินได้อื่นๆ (ระบุ)', group: 5, rate: {}, requiresDesc: true },
];

const BY_CODE = new Map(WHT_INCOME_TYPES.map((t) => [t.code, t]));

export function incomeType(code: string): IncomeTypeDef | undefined {
  return BY_CODE.get(code);
}

// standard rate for an income type + payee kind; undefined if the caller must supply one
export function defaultWhtRate(code: string, kind: PayeeKind): number | undefined {
  return BY_CODE.get(code)?.rate[kind];
}

// the ภ.ง.ด. form this payment belongs to (derived from ม.40 group × payee kind)
export function resolvePnd(code: string, kind: PayeeKind): PndType {
  const g = BY_CODE.get(code)?.group ?? 5;
  if (g === 1) return 'PND1K';                 // เงินเดือน → ภ.ง.ด.1ก
  if (kind === 'company') return 'PND53';      // นิติบุคคล → ภ.ง.ด.53
  if (g === 2 || g === 4) return 'PND2';       // บุคคล + ลิขสิทธิ์/ดอกเบี้ย/ปันผล → ภ.ง.ด.2
  return 'PND3';                               // บุคคล + บริการ/เช่า/วิชาชีพ → ภ.ง.ด.3
}

// validate a (possibly caller-supplied) rate for an income type. Accepts the standard rate, or any
// rate in (0, 0.30] when the income type has no fixed standard (salary/other) — keeps it flexible for
// rate changes / temporary reduced e-WHT rates while rejecting nonsense.
export function isAllowedWhtRate(code: string, kind: PayeeKind, rate: number): boolean {
  if (!(rate > 0 && rate <= 0.3)) return false;
  const std = defaultWhtRate(code, kind);
  if (std == null) return true;            // no fixed standard → trust caller within bound
  if (Math.abs(rate - std) < 1e-9) return true;
  // allow a small set of common alternates (e-WHT 1% promo, interbank interest 1%, etc.)
  return [0.01, 0.02, 0.03, 0.05].some((r) => Math.abs(rate - r) < 1e-9);
}

export const PND_LABELS: Record<PndType, string> = {
  PND1K: 'ภ.ง.ด.1ก', PND1KS: 'ภ.ง.ด.1ก พิเศษ', PND2: 'ภ.ง.ด.2', PND2K: 'ภ.ง.ด.2ก',
  PND3: 'ภ.ง.ด.3', PND3K: 'ภ.ง.ด.3ก', PND53: 'ภ.ง.ด.53',
};

export const WHT_CONDITION_LABELS: Record<string, string> = {
  withhold: 'หัก ณ ที่จ่าย',
  absorb_always: 'ออกให้ตลอดไป',
  absorb_once: 'ออกให้ครั้งเดียว',
  other: 'อื่นๆ',
};
