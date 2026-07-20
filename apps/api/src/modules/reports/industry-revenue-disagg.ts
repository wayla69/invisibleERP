// ───────────────── TFRS 15 (IFRS 15) per-industry revenue disaggregation (FIN-4, P10) ─────────────────
// TFRS 15 §114–115 requires revenue from contracts with customers to be disaggregated into categories that
// depict how the nature, amount, timing and uncertainty of revenue and cash flows are affected by economic
// factors. The two canonical categories the standard names are (a) by TYPE of good/service and (b) by TIMING
// OF TRANSFER — point in time vs over time. We disaggregate the tenant's OWN posted revenue accounts (so the
// note always ties to the income statement's revenue) by account (the "by type" axis) and classify each
// account's timing per industry (the "over time vs point in time" axis).

export type RevTiming = 'point_in_time' | 'over_time';

// Which revenue accounts an industry recognises OVER TIME (percentage-of-completion / as-the-service-is-rendered
// / as-access-is-provided). Everything else defaults to point-in-time (control transfers at a moment — the
// canonical sale of goods). `allOverTime` covers contract-centric verticals whose whole revenue is over-time.
interface RevTimingRule {
  allOverTime?: boolean;
  overTimeAccounts?: string[];
  overTimePrefixes?: string[];
}

const INDUSTRY_REV_TIMING: Record<string, RevTimingRule> = {
  // Construction / real-estate development: contract revenue recognised over time by stage of completion.
  construction: { allOverTime: true },
  // Professional / other services: performance obligations satisfied over the service period.
  services: { allOverTime: true },
  professional: { allOverTime: true },
  // Hospitality: room & other accommodation service is provided over the stay; F&B transfers at the point of sale.
  hospitality: { overTimeAccounts: ['430001', '430002'] },
  // Education: tuition is earned over the term; registration/exam/activity fees are point-in-time.
  education: { overTimeAccounts: ['430020'] },
  // Healthcare: in-patient care is delivered over the admission; OPD visits & lab tests are point-in-time.
  healthcare: { overTimeAccounts: ['430011'] },
  // Real-estate leasing: rental income accrues over the lease term (note: lease income is TFRS 16, shown here
  // for completeness of the revenue picture).
  realestate: { overTimePrefixes: ['4610'] },
  // Nonprofit: grant income is recognised as conditions are met over time; donations are point-in-time.
  nonprofit: { overTimeAccounts: ['430030'] },
  // Goods verticals (manufacturing / retail / distribution / ecommerce / agriculture / automotive / logistics)
  // transfer control at a point in time → no over-time rule (all point-in-time by default).
};

// A per-industry, human-readable disclosure note for the disaggregation schedule (TH + EN).
const INDUSTRY_DISAGG_POLICY: Record<string, { en: string; th: string }> = {
  construction: {
    en: 'Contract revenue is recognised over time by reference to the stage of completion of each construction contract (TFRS 15).',
    th: 'รายได้งานก่อสร้างรับรู้ตลอดช่วงเวลาตามขั้นความสำเร็จของงานแต่ละสัญญา (TFRS 15).',
  },
  hospitality: {
    en: 'Accommodation and related services are recognised over the period of the guest stay; food, beverage and retail sales are recognised at the point of sale.',
    th: 'รายได้ค่าห้องพักและบริการที่เกี่ยวข้องรับรู้ตลอดช่วงการเข้าพัก ส่วนรายได้อาหาร เครื่องดื่มและการขายรับรู้ ณ จุดขาย.',
  },
  services: {
    en: 'Service revenue is recognised over time as the services are rendered to the customer (TFRS 15).',
    th: 'รายได้ค่าบริการรับรู้ตลอดช่วงเวลาที่ให้บริการแก่ลูกค้า (TFRS 15).',
  },
  education: {
    en: 'Tuition is recognised over the academic term; registration, examination and activity fees are recognised at the point the service is delivered.',
    th: 'รายได้ค่าเล่าเรียนรับรู้ตลอดภาคการศึกษา ส่วนค่าลงทะเบียน ค่าสอบและค่ากิจกรรมรับรู้เมื่อให้บริการ.',
  },
  healthcare: {
    en: 'In-patient care is recognised over the period of admission; out-patient visits and laboratory services are recognised at the point of service.',
    th: 'รายได้ผู้ป่วยในรับรู้ตลอดช่วงการรักษาตัว ส่วนผู้ป่วยนอกและบริการห้องปฏิบัติการรับรู้ ณ จุดให้บริการ.',
  },
  nonprofit: {
    en: 'Grant income with performance conditions is recognised as those conditions are met over time; unconditional donations are recognised when received.',
    th: 'รายได้ทุนสนับสนุนที่มีเงื่อนไขรับรู้เมื่อปฏิบัติตามเงื่อนไขตลอดช่วงเวลา ส่วนเงินบริจาคที่ไม่มีเงื่อนไขรับรู้เมื่อได้รับ.',
  },
};

const DEFAULT_POLICY = {
  en: 'Revenue from the sale of goods is recognised at the point in time when control of the goods transfers to the customer (TFRS 15).',
  th: 'รายได้จากการขายสินค้ารับรู้ ณ เวลาที่ควบคุมในสินค้าโอนไปยังลูกค้า (TFRS 15).',
};

// Classify one revenue account's timing of transfer for the given industry.
export function revenueTiming(industry: string | null, accountCode: string): RevTiming {
  const rule = industry ? INDUSTRY_REV_TIMING[industry] : undefined;
  if (!rule) return 'point_in_time';
  if (rule.allOverTime) return 'over_time';
  if (rule.overTimeAccounts?.includes(accountCode)) return 'over_time';
  if (rule.overTimePrefixes?.some((p) => accountCode.startsWith(p))) return 'over_time';
  return 'point_in_time';
}

export function disaggPolicy(industry: string | null): { en: string; th: string } {
  return (industry ? INDUSTRY_DISAGG_POLICY[industry] : undefined) ?? DEFAULT_POLICY;
}
