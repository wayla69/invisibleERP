import type { Lang } from '../messages';

// QMS-3 — Certificate of Analysis (CoA) capture + out-of-spec release approval (/quality/coa, QC-03).
// Specs / CoA capture+results / out-of-spec deviation release maker-checker. Namespaced `qc.*`.
export const CATALOG: Record<string, Partial<Record<Lang, string>>> = {
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
