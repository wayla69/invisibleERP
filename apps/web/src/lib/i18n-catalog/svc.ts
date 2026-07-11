import type { Lang } from '../messages';

// SVC-3 — Service Contract Renewal & Expiry management (/service/renewals). Renewal queue (approve/reject,
// SVC-02 maker-checker) + expiring-contract worklist. Namespaced `svc.*`.
export const CATALOG: Record<string, Partial<Record<Lang, string>>> = {
  'svc.ren.title': { th: 'ต่ออายุสัญญาบริการ', en: 'Service Contract Renewals' },
  'svc.ren.subtitle': { th: 'คิวคำขอต่ออายุ (แบ่งแยกหน้าที่ ผู้เสนอ ≠ ผู้อนุมัติ) และรายการสัญญาที่ใกล้หมดอายุ', en: 'Renewal queue (maker-checker: proposer ≠ approver) and the expiring-contract worklist' },
  'svc.ren.tab_queue': { th: 'คิวต่ออายุ', en: 'Renewal queue' },
  'svc.ren.tab_expiring': { th: 'ใกล้หมดอายุ', en: 'Expiring' },

  'svc.ren.col_renewal_no': { th: 'เลขที่คำขอ', en: 'Renewal no.' },
  'svc.ren.col_base': { th: 'มูลค่าฐาน', en: 'Base value' },
  'svc.ren.col_uplift': { th: 'ปรับราคา %', en: 'Uplift %' },
  'svc.ren.col_new_value': { th: 'มูลค่าใหม่', en: 'New value' },
  'svc.ren.col_term': { th: 'ระยะสัญญาใหม่', en: 'New term' },
  'svc.ren.col_status': { th: 'สถานะ', en: 'Status' },
  'svc.ren.col_requested_by': { th: 'ผู้เสนอ', en: 'Proposed by' },
  'svc.ren.col_actions': { th: 'การทำงาน', en: 'Actions' },

  'svc.ren.col_contract_no': { th: 'เลขที่สัญญา', en: 'Contract no.' },
  'svc.ren.col_customer': { th: 'ลูกค้า', en: 'Customer' },
  'svc.ren.col_end_date': { th: 'วันหมดอายุ', en: 'End date' },
  'svc.ren.col_days': { th: 'เหลือ (วัน)', en: 'Days left' },
  'svc.ren.col_monthly': { th: 'มูลค่า/เดือน', en: 'Monthly value' },
  'svc.ren.col_auto_renew': { th: 'ต่ออัตโนมัติ', en: 'Auto-renew' },

  'svc.ren.status_pending': { th: 'รออนุมัติ', en: 'Pending' },
  'svc.ren.status_approved': { th: 'อนุมัติแล้ว', en: 'Approved' },
  'svc.ren.status_rejected': { th: 'ปฏิเสธ', en: 'Rejected' },

  'svc.ren.btn_approve': { th: 'อนุมัติ', en: 'Approve' },
  'svc.ren.btn_reject': { th: 'ปฏิเสธ', en: 'Reject' },
  'svc.ren.approved_ok': { th: 'อนุมัติต่ออายุแล้ว — สร้างสัญญาใหม่', en: 'Renewal approved — successor contract created' },
  'svc.ren.rejected_ok': { th: 'ปฏิเสธคำขอต่ออายุแล้ว', en: 'Renewal rejected' },
  'svc.ren.days_horizon': { th: 'ภายในกี่วัน', en: 'Within days' },
  'svc.ren.empty_queue': { th: 'ไม่มีคำขอต่ออายุที่รออนุมัติ', en: 'No pending renewals' },
  'svc.ren.empty_expiring': { th: 'ไม่มีสัญญาที่ใกล้หมดอายุโดยไม่มีคำขอต่ออายุ', en: 'No expiring contracts without a renewal in flight' },
  'svc.ren.expired_badge': { th: 'หมดอายุแล้ว', en: 'Expired' },
};
