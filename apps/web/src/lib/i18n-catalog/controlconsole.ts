import type { Lang } from '../messages';

// GRC-1 / ITGC-MON-01 — Control Console (auditor-facing RCM + ToE evidence) at /controls/rcm. Browse the
// ~240-control RCM catalogue (filter by family/status), open a control drawer (17 fields + latest/historical
// ToE test-runs + linked CCM findings + audit evidence), and record a test-of-effectiveness run. Namespaced
// `cc.*`.
export const CATALOG: Record<string, Partial<Record<Lang, string>>> = {
  'nav.control_console': { th: 'คอนโซลการควบคุม (RCM)', en: 'Control Console (RCM)' },
  'cc.title': { th: 'คอนโซลการควบคุม — RCM', en: 'Control Console — RCM' },
  'cc.subtitle': { th: 'ทะเบียนความเสี่ยงและการควบคุม (RCM) ทั้งหมด สถานะ ผลการทดสอบประสิทธิผล (ToE) และหลักฐาน สำหรับผู้ตรวจสอบ', en: 'The full Risk & Control Matrix (RCM), each control\'s status, test-of-effectiveness (ToE) results and evidence — for auditors' },

  'cc.stat_total': { th: 'การควบคุมทั้งหมด', en: 'Total controls' },
  'cc.stat_implemented': { th: 'ดำเนินการแล้ว', en: 'Implemented' },
  'cc.stat_partial': { th: 'บางส่วน', en: 'Partial' },
  'cc.stat_gap': { th: 'ช่องว่าง', en: 'Gap' },
  'cc.stat_tested': { th: 'ทดสอบ ToE แล้ว', en: 'ToE tested' },

  'cc.filter_family': { th: 'สายงาน / กระบวนการ', en: 'Family / process' },
  'cc.filter_status': { th: 'สถานะ', en: 'Status' },
  'cc.filter_all': { th: 'ทั้งหมด', en: 'All' },
  'cc.search_ph': { th: 'ค้นหารหัส/ความเสี่ยง/คำอธิบาย…', en: 'Search id / risk / description…' },

  'cc.col_id': { th: 'รหัสการควบคุม', en: 'Control ID' },
  'cc.col_family': { th: 'สายงาน', en: 'Family' },
  'cc.col_category': { th: 'ประเภท', en: 'Category' },
  'cc.col_risk': { th: 'ความเสี่ยง', en: 'Risk' },
  'cc.col_owner': { th: 'ผู้รับผิดชอบ', en: 'Owner' },
  'cc.col_status': { th: 'สถานะ', en: 'Status' },
  'cc.col_toe': { th: 'ToE ล่าสุด', en: 'Latest ToE' },
  'cc.toe_none': { th: 'ยังไม่ทดสอบ', en: 'Not tested' },

  'cc.status_implemented': { th: 'ดำเนินการแล้ว', en: 'Implemented' },
  'cc.status_partial': { th: 'บางส่วน', en: 'Partial' },
  'cc.status_gap': { th: 'ช่องว่าง', en: 'Gap' },

  'cc.result_pass': { th: 'ผ่าน', en: 'Pass' },
  'cc.result_fail': { th: 'ไม่ผ่าน', en: 'Fail' },
  'cc.result_na': { th: 'ไม่เกี่ยวข้อง', en: 'N/A' },

  // detail drawer
  'cc.d_risk': { th: 'ความเสี่ยง — สิ่งที่อาจผิดพลาด', en: 'Risk — what could go wrong' },
  'cc.d_assertion': { th: 'ข้อยืนยัน', en: 'Assertion(s)' },
  'cc.d_description': { th: 'คำอธิบายการควบคุม', en: 'Control description' },
  'cc.d_nature': { th: 'ลักษณะ', en: 'Nature' },
  'cc.d_frequency': { th: 'ความถี่', en: 'Frequency' },
  'cc.d_prevdet': { th: 'ป้องกัน / ตรวจจับ', en: 'Prev / Det' },
  'cc.d_coso': { th: 'หลักการ COSO', en: 'COSO principle' },
  'cc.d_owner': { th: 'ผู้รับผิดชอบ', en: 'Control owner' },
  'cc.d_fsli': { th: 'บัญชีที่มีนัยสำคัญ (FSLI)', en: 'FSLI / significant account' },
  'cc.d_coderef': { th: 'อ้างอิงระบบ / โค้ด', en: 'System / code reference' },
  'cc.d_tod': { th: 'การทดสอบการออกแบบ (TOD)', en: 'Test of design (TOD)' },
  'cc.d_toe': { th: 'การทดสอบประสิทธิผล (TOE)', en: 'Test of operating effectiveness (TOE)' },
  'cc.d_evidence': { th: 'หลักฐานสำคัญ', en: 'Key evidence' },

  'cc.d_runs_title': { th: 'ประวัติการทดสอบ ToE', en: 'ToE test-run history' },
  'cc.d_runs_empty': { th: 'ยังไม่มีการบันทึกผลการทดสอบสำหรับการควบคุมนี้', en: 'No test-runs recorded for this control yet' },
  'cc.d_run_result': { th: 'ผล', en: 'Result' },
  'cc.d_run_harness': { th: 'ชุดทดสอบ', en: 'Harness' },
  'cc.d_run_checks': { th: 'ผ่าน / ทั้งหมด', en: 'Passed / total' },
  'cc.d_run_evidence': { th: 'อ้างอิงหลักฐาน', en: 'Evidence ref' },
  'cc.d_run_by': { th: 'บันทึกโดย', en: 'Recorded by' },
  'cc.d_run_at': { th: 'เมื่อ', en: 'When' },
  'cc.d_run_notes': { th: 'หมายเหตุ', en: 'Notes' },

  'cc.d_ccm_title': { th: 'สิ่งที่ตรวจพบจากการเฝ้าระวังต่อเนื่อง (CCM)', en: 'Continuous-monitoring findings (CCM)' },
  'cc.d_audit_title': { th: 'หลักฐานจากบันทึกตรวจสอบล่าสุด', en: 'Recent audit-log evidence' },

  'cc.record_title': { th: 'บันทึกผลการทดสอบ ToE', en: 'Record a ToE test-run' },
  'cc.record_btn': { th: 'บันทึกผลการทดสอบ', en: 'Record test-run' },
  'cc.record_result': { th: 'ผลการทดสอบ', en: 'Result' },
  'cc.record_harness': { th: 'ชุดทดสอบ / วิธี', en: 'Harness / method' },
  'cc.record_harness_ph': { th: 'เช่น compliance, basics, manual', en: 'e.g. compliance, basics, manual' },
  'cc.record_passed': { th: 'จำนวนที่ผ่าน', en: 'Checks passed' },
  'cc.record_total': { th: 'จำนวนทั้งหมด', en: 'Checks total' },
  'cc.record_evidence': { th: 'อ้างอิงหลักฐาน (ลิงก์/รหัส)', en: 'Evidence ref (link/id)' },
  'cc.record_notes': { th: 'หมายเหตุ', en: 'Notes' },
  'cc.record_ok': { th: 'บันทึกผลการทดสอบ {id} แล้ว', en: 'Recorded test-run for {id}' },
  'cc.saving': { th: 'กำลังบันทึก…', en: 'Saving…' },

  'cc.empty_title': { th: 'ไม่พบการควบคุม', en: 'No controls found' },
  'cc.empty_desc': { th: 'ปรับตัวกรองสายงาน/สถานะหรือคำค้นหา', en: 'Adjust the family/status filter or search term' },
};
