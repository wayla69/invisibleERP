import type { Lang } from '../messages';

// QMS-4 — Supplier Corrective Action Request (SCAR / 8D) register (/quality/scar). Raise + 8D response +
// closure maker-checker (QC-04: closer ≠ raiser) + the overdue SCAR worklist. Namespaced `scar.*`.
export const CATALOG: Record<string, Partial<Record<Lang, string>>> = {
  'nav.supplier_scar': { th: 'SCAR ผู้ขาย (8D)', en: 'Supplier SCAR (8D)' },
  'scar.title': { th: 'ใบร้องขอการแก้ไขจากผู้ขาย (SCAR / 8D)', en: 'Supplier Corrective Action (SCAR / 8D)' },
  'scar.subtitle': { th: 'ออกใบ SCAR ต่อผู้ขาย ติดตามการตอบกลับ 8D และปิดงานแบบแบ่งแยกหน้าที่ (ผู้ปิด ≠ ผู้เปิด) ก่อนคืนสถานะผู้ขาย', en: 'Issue a SCAR to a vendor, track the 8D response, and close with maker-checker (closer ≠ raiser) before requalifying the supplier' },
  'scar.tab_register': { th: 'ทะเบียน SCAR', en: 'SCAR register' },
  'scar.tab_overdue': { th: 'เกินกำหนด', en: 'Overdue' },

  'scar.col_no': { th: 'เลขที่ SCAR', en: 'SCAR no.' },
  'scar.col_vendor': { th: 'ผู้ขาย', en: 'Vendor' },
  'scar.col_defect': { th: 'ข้อบกพร่อง', en: 'Defect' },
  'scar.col_severity': { th: 'ความรุนแรง', en: 'Severity' },
  'scar.col_source_claim': { th: 'อ้างอิงใบเคลม', en: 'Source claim' },
  'scar.col_status': { th: 'สถานะ', en: 'Status' },
  'scar.col_due': { th: 'ครบกำหนด', en: 'Due' },
  'scar.col_raised_by': { th: 'ผู้เปิด', en: 'Raised by' },
  'scar.col_effectiveness': { th: 'ผลลัพธ์', en: 'Effectiveness' },
  'scar.col_days_overdue': { th: 'เกิน (วัน)', en: 'Days overdue' },
  'scar.col_actions': { th: 'การทำงาน', en: 'Actions' },

  'scar.status_open': { th: 'เปิด', en: 'Open' },
  'scar.status_supplier_responded': { th: 'ผู้ขายตอบกลับ', en: 'Supplier responded' },
  'scar.status_pending_closure': { th: 'รอปิดงาน', en: 'Pending closure' },
  'scar.status_closed': { th: 'ปิดแล้ว', en: 'Closed' },
  'scar.status_rejected': { th: 'ปฏิเสธ', en: 'Rejected' },

  'scar.sev_minor': { th: 'เล็กน้อย', en: 'Minor' },
  'scar.sev_major': { th: 'สำคัญ', en: 'Major' },
  'scar.sev_critical': { th: 'วิกฤต', en: 'Critical' },

  'scar.eff_effective': { th: 'ได้ผล', en: 'Effective' },
  'scar.eff_ineffective': { th: 'ไม่ได้ผล', en: 'Ineffective' },

  'scar.raise_title': { th: 'เปิด SCAR ใหม่', en: 'Raise a SCAR' },
  'scar.f_vendor_id': { th: 'รหัสผู้ขาย', en: 'Vendor ID' },
  'scar.f_source_claim': { th: 'เลขที่ใบเคลม (ถ้ามี)', en: 'Source claim no. (optional)' },
  'scar.f_defect': { th: 'สรุปข้อบกพร่อง', en: 'Defect summary' },
  'scar.f_severity': { th: 'ความรุนแรง', en: 'Severity' },
  'scar.f_due': { th: 'ครบกำหนด', en: 'Due date' },
  'scar.raise_btn': { th: 'เปิด SCAR', en: 'Raise SCAR' },
  'scar.raised_ok': { th: 'เปิด SCAR {no} แล้ว', en: 'SCAR {no} raised' },

  'scar.respond_title': { th: 'บันทึกการตอบกลับ 8D', en: 'Record 8D response' },
  'scar.f_containment': { th: 'D3 การควบคุมชั่วคราว', en: 'D3 Containment' },
  'scar.f_root_cause': { th: 'D4 สาเหตุรากเหง้า', en: 'D4 Root cause' },
  'scar.f_corrective': { th: 'D5/D6 การแก้ไข', en: 'D5/D6 Corrective action' },
  'scar.f_preventive': { th: 'D7 การป้องกัน', en: 'D7 Preventive action' },
  'scar.respond_btn': { th: 'บันทึกการตอบกลับ', en: 'Save response' },
  'scar.responded_ok': { th: 'บันทึกการตอบกลับแล้ว', en: 'Response recorded' },

  'scar.submit_btn': { th: 'ส่งปิดงาน', en: 'Submit for closure' },
  'scar.submitted_ok': { th: 'ส่งปิดงานแล้ว', en: 'Submitted for closure' },

  'scar.close_title': { th: 'ปิด SCAR (ตรวจสอบการปิด)', en: 'Close SCAR (closure review)' },
  'scar.f_effectiveness': { th: 'ผลลัพธ์การแก้ไข', en: 'Corrective-action effectiveness' },
  'scar.close_btn': { th: 'ปิดงาน', en: 'Close' },
  'scar.closed_ok': { th: 'ปิด SCAR แล้ว', en: 'SCAR closed' },
  'scar.reject_btn': { th: 'ปฏิเสธ', en: 'Reject' },
  'scar.f_reject_reason': { th: 'เหตุผลการปฏิเสธ', en: 'Rejection reason' },
  'scar.rejected_ok': { th: 'ปฏิเสธ SCAR แล้ว', en: 'SCAR rejected' },

  'scar.days_horizon': { th: 'ช่วงเวลา (วัน)', en: 'Horizon (days)' },
  'scar.empty_register': { th: 'ยังไม่มี SCAR', en: 'No SCARs yet' },
  'scar.empty_overdue': { th: 'ไม่มี SCAR เกินกำหนด', en: 'No overdue SCARs' },
  'scar.overdue_badge': { th: 'เกินกำหนด', en: 'Overdue' },
  'scar.requalifies': { th: 'คืนสถานะผู้ขายได้', en: 'Supplier may be requalified' },
};
