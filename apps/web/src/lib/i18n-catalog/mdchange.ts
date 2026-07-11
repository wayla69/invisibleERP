import type { Lang } from '../messages';

// GRC-3 — Sensitive master-data single-record maker-checker (/masterdata/change-requests, control MDM-01).
// Propose a change to a sensitive vendor field (bank account / credit limit / payment terms) → a DISTINCT
// user approves it before the master is written. Namespaced `mdc.*`.
export const CATALOG: Record<string, Partial<Record<Lang, string>>> = {
  'nav.masterdata_changes': { th: 'อนุมัติการเปลี่ยนข้อมูลหลัก', en: 'Master-data changes' },
  'mdc.title': { th: 'คำขอเปลี่ยนข้อมูลหลักที่อ่อนไหว', en: 'Sensitive master-data change requests' },
  'mdc.subtitle': { th: 'การแก้ไขฟิลด์อ่อนไหว (บัญชีธนาคารผู้ขาย / วงเงินเครดิต / เงื่อนไขชำระเงิน) ต้องผ่านการอนุมัติจากผู้ใช้อีกคน (ผู้อนุมัติ ≠ ผู้ขอ) ก่อนบันทึกลงข้อมูลหลัก', en: 'A change to a sensitive field (vendor bank account / credit limit / payment terms) applies to the master only after a DISTINCT user approves it (approver ≠ requester)' },
  'mdc.tab_queue': { th: 'รออนุมัติ', en: 'Pending queue' },
  'mdc.tab_new': { th: 'เสนอการเปลี่ยนแปลง', en: 'Propose a change' },

  'mdc.col_req_no': { th: 'เลขที่คำขอ', en: 'Request no.' },
  'mdc.col_entity': { th: 'ประเภท', en: 'Entity' },
  'mdc.col_entity_id': { th: 'รหัส', en: 'ID' },
  'mdc.col_field': { th: 'ฟิลด์', en: 'Field' },
  'mdc.col_old': { th: 'ค่าเดิม', en: 'Current' },
  'mdc.col_new': { th: 'ค่าใหม่', en: 'Requested' },
  'mdc.col_reason': { th: 'เหตุผล', en: 'Reason' },
  'mdc.col_requested_by': { th: 'ผู้ขอ', en: 'Requested by' },
  'mdc.col_actions': { th: 'การทำงาน', en: 'Actions' },

  'mdc.status_pending': { th: 'รออนุมัติ', en: 'Pending' },
  'mdc.status_approved': { th: 'อนุมัติแล้ว', en: 'Approved' },
  'mdc.status_rejected': { th: 'ปฏิเสธ', en: 'Rejected' },

  'mdc.entity_vendor': { th: 'ผู้ขาย', en: 'Vendor' },
  'mdc.field_bank_account': { th: 'เลขที่บัญชีธนาคาร', en: 'Bank account no.' },
  'mdc.field_bank_name': { th: 'ชื่อธนาคาร', en: 'Bank name' },
  'mdc.field_bank_account_name': { th: 'ชื่อบัญชีผู้รับเงิน', en: 'Bank account name' },
  'mdc.field_credit_limit': { th: 'วงเงินเครดิต', en: 'Credit limit' },
  'mdc.field_payment_terms': { th: 'เงื่อนไขการชำระเงิน', en: 'Payment terms' },

  'mdc.f_vendor': { th: 'ผู้ขาย', en: 'Vendor' },
  'mdc.f_field': { th: 'ฟิลด์ที่ต้องการเปลี่ยน', en: 'Field to change' },
  'mdc.f_new_value': { th: 'ค่าใหม่', en: 'New value' },
  'mdc.f_reason': { th: 'เหตุผล', en: 'Reason' },
  'mdc.submit': { th: 'ส่งขออนุมัติ', en: 'Submit for approval' },
  'mdc.approve': { th: 'อนุมัติ', en: 'Approve' },
  'mdc.reject': { th: 'ปฏิเสธ', en: 'Reject' },
  'mdc.reject_prompt': { th: 'เหตุผลการปฏิเสธ', en: 'Reason for rejection' },

  'mdc.staged': { th: 'ส่งคำขอเรียบร้อย — รอผู้ใช้อีกคนอนุมัติ', en: 'Change staged — awaiting a distinct approver' },
  'mdc.approved_ok': { th: 'อนุมัติและบันทึกลงข้อมูลหลักแล้ว', en: 'Approved — applied to the master' },
  'mdc.rejected_ok': { th: 'ปฏิเสธคำขอแล้ว — ข้อมูลหลักไม่เปลี่ยน', en: 'Rejected — the master is unchanged' },
  'mdc.empty': { th: 'ไม่มีคำขอที่รออนุมัติ', en: 'No changes pending approval' },
  'mdc.pick_vendor': { th: 'เลือกผู้ขาย', en: 'Select a vendor' },

  // Shown on the supplier profile dialog where payment_terms is now read-only (routes through this queue).
  'mdc.vp_terms_hint': { th: 'ฟิลด์อ่อนไหว — เปลี่ยนผ่านหน้าอนุมัติการเปลี่ยนข้อมูลหลัก', en: 'Sensitive — change via Master-data changes (maker-checker)' },
};
