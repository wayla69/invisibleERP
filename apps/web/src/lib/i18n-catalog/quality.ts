import type { Lang } from '../messages';

// QMS quality catalogs — QC-01 Non-Conformance register (/quality/ncr) + QC-03 Certificate of Analysis (/quality/coa).
// Namespaced `qc.*`. NCR keys `qc.ncr.*`, CoA keys `qc.coa.*`.
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

  'qc.coa.title': { th: 'ใบรับรองผลวิเคราะห์ (CoA)', en: 'Certificate of Analysis (CoA)' },
  'qc.coa.subtitle': { th: 'บันทึกผลตรวจคุณภาพต่อล็อต และอนุมัติการปล่อยล็อตที่ไม่ผ่านสเปก (แบ่งแยกหน้าที่ ผู้บันทึก ≠ ผู้อนุมัติ)', en: 'Capture quality results per lot and approve the release of an out-of-spec lot (maker-checker: recorder ≠ approver)' },
  'qc.coa.tab_coa': { th: 'ใบรับรอง', en: 'Certificates' },
  'qc.coa.tab_specs': { th: 'สเปกคุณภาพ', en: 'Quality specs' },
  'qc.coa.tab_oos': { th: 'ทะเบียนเบี่ยงเบน', en: 'Deviation register' },

  'qc.coa.item': { th: 'รหัสสินค้า', en: 'Item' },
  'qc.coa.characteristic': { th: 'คุณลักษณะ', en: 'Characteristic' },
  'qc.coa.uom': { th: 'หน่วย', en: 'UoM' },
  'qc.coa.min': { th: 'ต่ำสุด', en: 'Min' },
  'qc.coa.max': { th: 'สูงสุด', en: 'Max' },
  'qc.coa.target': { th: 'ค่าเป้าหมาย', en: 'Target' },
  'qc.coa.range': { th: 'ช่วงสเปก', en: 'Spec range' },
  'qc.coa.actual': { th: 'ค่าที่วัดได้', en: 'Actual' },
  'qc.coa.result': { th: 'ผล', en: 'Result' },
  'qc.coa.lot': { th: 'เลขล็อต', en: 'Lot' },
  'qc.coa.source': { th: 'แหล่งที่มา', en: 'Source' },
  'qc.coa.source_incoming': { th: 'รับเข้า', en: 'Incoming' },
  'qc.coa.source_production': { th: 'ผลิต', en: 'Production' },
  'qc.coa.overall': { th: 'ผลรวม', en: 'Overall' },
  'qc.coa.status': { th: 'สถานะการปล่อย', en: 'Release status' },
  'qc.coa.recorder': { th: 'ผู้บันทึก', en: 'Recorded by' },
  'qc.coa.approver': { th: 'ผู้อนุมัติปล่อย', en: 'Released by' },
  'qc.coa.deviation': { th: 'เหตุผลเบี่ยงเบน', en: 'Deviation' },

  'qc.coa.new_spec': { th: 'เพิ่มสเปกคุณภาพ', en: 'New quality spec' },
  'qc.coa.add_spec': { th: 'บันทึกสเปก', en: 'Add spec' },
  'qc.coa.spec_created': { th: 'บันทึกสเปกแล้ว', en: 'Spec created' },
  'qc.coa.no_specs': { th: 'ยังไม่มีสเปก', en: 'No specs yet' },
  'qc.coa.col_spec_no': { th: 'เลขที่สเปก', en: 'Spec no.' },

  'qc.coa.new_coa': { th: 'เปิดใบรับรองต่อล็อต', en: 'New CoA for a lot' },
  'qc.coa.add_coa': { th: 'เปิดใบรับรอง', en: 'Create CoA' },
  'qc.coa.coa_created': { th: 'เปิดใบรับรองแล้ว', en: 'CoA created' },
  'qc.coa.no_coa': { th: 'ยังไม่มีใบรับรอง', en: 'No certificates yet' },
  'qc.coa.col_coa_no': { th: 'เลขที่ใบรับรอง', en: 'CoA no.' },

  'qc.coa.add_result': { th: 'เพิ่มผลตรวจวัด', en: 'Add measured result' },
  'qc.coa.result_added': { th: 'บันทึกผลแล้ว', en: 'Result recorded' },
  'qc.coa.no_results': { th: 'ยังไม่มีผลตรวจวัด', en: 'No results yet' },
  'qc.coa.evaluate': { th: 'ประเมินผล', en: 'Evaluate' },
  'qc.coa.evaluated_pass': { th: 'ประเมินแล้ว: ผ่าน', en: 'Evaluated: pass' },
  'qc.coa.evaluated_fail': { th: 'ประเมินแล้ว: ไม่ผ่าน (นอกสเปก)', en: 'Evaluated: fail (out of spec)' },
  'qc.coa.release': { th: 'ปล่อยล็อต', en: 'Release lot' },
  'qc.coa.release_deviation': { th: 'อนุมัติปล่อยแบบเบี่ยงเบน', en: 'Approve deviation release' },
  'qc.coa.released': { th: 'ปล่อยล็อตแล้ว', en: 'Lot released' },
  'qc.coa.reject': { th: 'ปฏิเสธ', en: 'Reject' },
  'qc.coa.rejected': { th: 'ปฏิเสธแล้ว', en: 'Rejected' },
  'qc.coa.deviation_reason': { th: 'เหตุผลการเบี่ยงเบน (จำเป็นสำหรับล็อตนอกสเปก)', en: 'Deviation reason (required for an out-of-spec lot)' },
  'qc.coa.deviation_hint': { th: 'ล็อตนี้ไม่ผ่านสเปก การปล่อยต้องทำโดยผู้อนุมัติที่ต่างจากผู้บันทึก พร้อมระบุเหตุผลการเบี่ยงเบน (QC-03)', en: 'This lot is out of spec — release requires a different approver than the recorder, with a documented deviation reason (QC-03)' },

  'qc.coa.oos_hint': { th: 'ทะเบียนตัวอย่างสำหรับตรวจสอบ: ล็อตที่ไม่ผ่านสเปกแต่ถูกปล่อยแบบเบี่ยงเบน', en: 'Audit sample register: lots that failed spec yet were released under a deviation' },
  'qc.coa.no_oos': { th: 'ไม่มีการปล่อยแบบเบี่ยงเบน', en: 'No deviation releases' },
};
