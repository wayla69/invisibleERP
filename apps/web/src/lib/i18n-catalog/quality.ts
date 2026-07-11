import type { Lang } from '../messages';

// QMS-1 (QC-01) — Non-Conformance (NCR) register with maker-checker disposition (/quality/ncr). NCR register +
// raise + disposition-approve (SOD_SELF_APPROVAL: raiser ≠ disposition approver) + defect-code lookup.
// Namespaced `qc.*`.
export const CATALOG: Record<string, Partial<Record<Lang, string>>> = {
  'qc.ncr.title': { th: 'ทะเบียนของไม่เป็นไปตามข้อกำหนด (NCR)', en: 'Non-Conformance Register (NCR)' },
  'qc.ncr.subtitle': { th: 'บันทึกของไม่ผ่าน แล้วอนุมัติการจัดการทางการเงิน (ทิ้ง/ใช้ตามสภาพ/ส่งคืน) โดยผู้ที่ไม่ใช่ผู้ออก (แบ่งแยกหน้าที่)', en: 'Log non-conformances and approve the financial disposition (scrap / use-as-is / return) by a different user than the raiser (maker-checker)' },

  'qc.ncr.tab_register': { th: 'ทะเบียน NCR', en: 'NCR register' },
  'qc.ncr.tab_raise': { th: 'ออก NCR', en: 'Raise NCR' },
  'qc.ncr.tab_defects': { th: 'รหัสข้อบกพร่อง', en: 'Defect codes' },

  // register columns
  'qc.ncr.col_no': { th: 'เลขที่ NCR', en: 'NCR no.' },
  'qc.ncr.col_source': { th: 'แหล่ง', en: 'Source' },
  'qc.ncr.col_item': { th: 'สินค้า', en: 'Item' },
  'qc.ncr.col_defect': { th: 'ข้อบกพร่อง', en: 'Defect' },
  'qc.ncr.col_severity': { th: 'ความรุนแรง', en: 'Severity' },
  'qc.ncr.col_qty': { th: 'จำนวน', en: 'Qty' },
  'qc.ncr.col_disposition': { th: 'การจัดการ', en: 'Disposition' },
  'qc.ncr.col_status': { th: 'สถานะ', en: 'Status' },
  'qc.ncr.col_writeoff': { th: 'มูลค่าตัดจำหน่าย', en: 'Write-off' },
  'qc.ncr.col_raised_by': { th: 'ผู้ออก', en: 'Raised by' },
  'qc.ncr.col_actions': { th: 'การทำงาน', en: 'Actions' },

  // status labels
  'qc.ncr.status_open': { th: 'เปิด', en: 'Open' },
  'qc.ncr.status_pending': { th: 'รอจัดการ', en: 'Pending disposition' },
  'qc.ncr.status_dispositioned': { th: 'จัดการแล้ว', en: 'Dispositioned' },
  'qc.ncr.status_closed': { th: 'ปิด', en: 'Closed' },

  // source labels
  'qc.ncr.source_incoming': { th: 'รับเข้า', en: 'Incoming' },
  'qc.ncr.source_in_process': { th: 'ระหว่างผลิต', en: 'In-process' },
  'qc.ncr.source_customer': { th: 'ลูกค้า', en: 'Customer' },
  'qc.ncr.source_supplier': { th: 'ผู้ขาย', en: 'Supplier' },

  // severity labels
  'qc.ncr.sev_minor': { th: 'เล็กน้อย', en: 'Minor' },
  'qc.ncr.sev_major': { th: 'สำคัญ', en: 'Major' },
  'qc.ncr.sev_critical': { th: 'วิกฤต', en: 'Critical' },

  // disposition labels
  'qc.ncr.disp_scrap': { th: 'ทิ้ง (Scrap)', en: 'Scrap' },
  'qc.ncr.disp_use_as_is': { th: 'ใช้ตามสภาพ', en: 'Use as-is' },
  'qc.ncr.disp_return': { th: 'ส่งคืน', en: 'Return' },
  'qc.ncr.disp_rework': { th: 'แก้ไขใหม่', en: 'Rework' },
  'qc.ncr.disp_none': { th: '—', en: '—' },

  // actions
  'qc.ncr.btn_approve': { th: 'อนุมัติจัดการ', en: 'Approve disposition' },
  'qc.ncr.btn_reject': { th: 'ปฏิเสธ', en: 'Reject' },
  'qc.ncr.btn_close': { th: 'ปิด', en: 'Close' },
  'qc.ncr.approved_ok': { th: 'จัดการ NCR แล้ว', en: 'NCR dispositioned' },
  'qc.ncr.rejected_ok': { th: 'ปฏิเสธการจัดการแล้ว', en: 'Disposition rejected' },
  'qc.ncr.closed_ok': { th: 'ปิด NCR แล้ว', en: 'NCR closed' },
  'qc.ncr.empty': { th: 'ไม่มีรายการ NCR', en: 'No NCRs' },

  // raise form
  'qc.ncr.f_source': { th: 'แหล่งที่พบ', en: 'Source' },
  'qc.ncr.f_ref_type': { th: 'อ้างอิงประเภท (WO/GR)', en: 'Ref type (WO/GR)' },
  'qc.ncr.f_ref_doc': { th: 'เลขที่เอกสารอ้างอิง', en: 'Ref document' },
  'qc.ncr.f_item': { th: 'รหัสสินค้า', en: 'Item id' },
  'qc.ncr.f_defect': { th: 'รหัสข้อบกพร่อง', en: 'Defect code' },
  'qc.ncr.f_severity': { th: 'ความรุนแรง', en: 'Severity' },
  'qc.ncr.f_qty': { th: 'จำนวน', en: 'Qty' },
  'qc.ncr.f_unit_cost': { th: 'ต้นทุนต่อหน่วย', en: 'Unit cost' },
  'qc.ncr.f_disposition': { th: 'เสนอการจัดการ', en: 'Proposed disposition' },
  'qc.ncr.f_description': { th: 'รายละเอียด', en: 'Description' },
  'qc.ncr.f_submit': { th: 'ออก NCR', en: 'Raise NCR' },
  'qc.ncr.raised_ok': { th: 'ออก NCR แล้ว', en: 'NCR raised' },
  'qc.ncr.hint_financial': { th: 'การเสนอ ทิ้ง/ใช้ตามสภาพ/ส่งคืน จะเข้าคิวรออนุมัติจากผู้ที่ไม่ใช่ผู้ออก', en: 'Proposing scrap / use-as-is / return queues it for approval by a different user' },

  // defect codes
  'qc.ncr.dc_code': { th: 'รหัส', en: 'Code' },
  'qc.ncr.dc_name': { th: 'ชื่อ', en: 'Name' },
  'qc.ncr.dc_category': { th: 'หมวด', en: 'Category' },
  'qc.ncr.dc_add': { th: 'เพิ่มรหัส', en: 'Add code' },
  'qc.ncr.dc_added_ok': { th: 'เพิ่มรหัสข้อบกพร่องแล้ว', en: 'Defect code added' },
  'qc.ncr.dc_empty': { th: 'ยังไม่มีรหัสข้อบกพร่อง', en: 'No defect codes yet' },
};
