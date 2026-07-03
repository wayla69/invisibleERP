// LP-3 (docs/31) — the LINE daily-digest KPI catalog. Each KPI declares the permission(s) (ANY-of)
// a recipient needs to SEE it: the digest job computes every KPI once per tenant, then delivery
// filters PER RECIPIENT by their effective permissions at send time (permission-at-send — a perm
// revoked after subscribing silently drops the KPI from that person's message). An empty perms list
// = the LC-4 baseline trio, visible to every subscriber (the subscribe gate already requires
// dashboard/fin_report/exec). Values are read-only aggregates on the Asia/Bangkok business day.
export const DIGEST_KPIS: Record<string, { perms: string[]; th: string; money?: boolean }> = {
  pending_approvals: { perms: [], th: 'รออนุมัติ' },
  open_prs: { perms: [], th: 'PR ค้าง' },
  alerts_24h: { perms: [], th: 'แจ้งเตือน 24 ชม.' },
  sales_yesterday: { perms: ['dashboard', 'exec'], th: 'ยอดขายเมื่อวาน', money: true },
  cash_position: { perms: ['fin_report', 'exec'], th: 'เงินสดคงเหลือ', money: true },
  ar_overdue: { perms: ['fin_report', 'exec'], th: 'ลูกหนี้เกินกำหนด', money: true },
  low_stock: { perms: ['stock', 'planner', 'exec'], th: 'สินค้าใกล้หมด (รายการ)' },
};

/** Bare `subscribe digest` keeps the LC-4 baseline trio. */
export const DEFAULT_DIGEST_KPIS = ['pending_approvals', 'open_prs', 'alerts_24h'];

/** KPI keys the given effective permission set may see (catalog order). */
export function allowedDigestKpis(perms: string[]): string[] {
  return Object.keys(DIGEST_KPIS).filter((k) => {
    const need = DIGEST_KPIS[k]!.perms;
    return need.length === 0 || need.some((p) => perms.includes(p));
  });
}
