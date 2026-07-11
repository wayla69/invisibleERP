import type { Lang } from '../messages';

// GRC-5 (ITGC-AC-22) — SoD-Conflict Register + Compensating-Control governance (/admin/sod). Standing
// conflicts-by-rule dashboard + accepted-conflict register (accept / re-review) + the expired worklist.
// Namespaced `sodreg.*`.
export const CATALOG: Record<string, Partial<Record<Lang, string>>> = {
  'nav.sod_register': { th: 'ทะเบียนความขัดแย้ง SoD', en: 'SoD Conflict Register' },
  'sodreg.title': { th: 'ทะเบียนความขัดแย้ง SoD + มาตรการชดเชย', en: 'SoD Conflict Register + Compensating Controls' },
  'sodreg.subtitle': { th: 'มุมมองความขัดแย้งการแบ่งแยกหน้าที่ทั้งองค์กรตามกฎ พร้อมการยอมรับความเสี่ยงคงเหลืออย่างมีธรรมาภิบาล (มาตรการชดเชย ผู้รับผิดชอบ วันหมดอายุ และการทบทวนตามรอบ) — ควบคุม ITGC-AC-22', en: 'Whole-population Segregation-of-Duties conflicts by rule, with governed residual-risk acceptance (compensating control, owner, expiry and periodic re-review) — control ITGC-AC-22' },

  'sodreg.tab_conflicts': { th: 'ความขัดแย้งปัจจุบัน', en: 'Current conflicts' },
  'sodreg.tab_register': { th: 'ทะเบียนการยอมรับ', en: 'Acceptance register' },
  'sodreg.tab_expired': { th: 'เกินกำหนดทบทวน', en: 'Expired / overdue' },

  'sodreg.kpi_users': { th: 'ผู้ใช้ทั้งหมด', en: 'Total users' },
  'sodreg.kpi_conflicted': { th: 'ผู้ใช้ที่มีความขัดแย้ง', en: 'Users with conflicts' },
  'sodreg.kpi_total': { th: 'ความขัดแย้งทั้งหมด', en: 'Total conflicts' },
  'sodreg.kpi_accepted': { th: 'ยอมรับแล้ว', en: 'Accepted' },
  'sodreg.kpi_ungoverned': { th: 'ยังไม่จัดการ', en: 'Ungoverned' },

  'sodreg.rule': { th: 'กฎ', en: 'Rule' },
  'sodreg.duties': { th: 'หน้าที่ที่ขัดกัน', en: 'Conflicting duties' },
  'sodreg.severity': { th: 'ความรุนแรง', en: 'Severity' },
  'sodreg.risk': { th: 'ความเสี่ยง', en: 'Risk' },
  'sodreg.user': { th: 'ผู้ใช้', en: 'User' },
  'sodreg.role': { th: 'บทบาท', en: 'Role' },
  'sodreg.perms_held': { th: 'สิทธิ์ที่ถือ', en: 'Permissions held' },
  'sodreg.status': { th: 'สถานะ', en: 'Status' },
  'sodreg.disposition_none': { th: 'ยังไม่จัดการ', en: 'Ungoverned' },
  'sodreg.disposition_accepted': { th: 'ยอมรับแล้ว', en: 'Accepted' },

  'sodreg.accept': { th: 'ยอมรับความเสี่ยง', en: 'Accept risk' },
  'sodreg.accept_title': { th: 'ยอมรับความขัดแย้ง SoD', en: 'Accept SoD conflict' },
  'sodreg.compensating_control': { th: 'มาตรการชดเชย', en: 'Compensating control' },
  'sodreg.owner': { th: 'ผู้รับผิดชอบ', en: 'Owner' },
  'sodreg.expiry_date': { th: 'วันหมดอายุ', en: 'Expiry date' },
  'sodreg.notes': { th: 'หมายเหตุ', en: 'Notes' },
  'sodreg.accepted_by': { th: 'ยอมรับโดย', en: 'Accepted by' },
  'sodreg.accepted_at': { th: 'ยอมรับเมื่อ', en: 'Accepted at' },
  'sodreg.last_reviewed': { th: 'ทบทวนล่าสุด', en: 'Last reviewed' },
  'sodreg.review': { th: 'ทบทวน', en: 'Re-review' },
  'sodreg.review_title': { th: 'ทบทวนการยอมรับตามรอบ', en: 'Periodic re-review' },
  'sodreg.expired_reason': { th: 'เหตุผล', en: 'Reason' },
  'sodreg.reason_past_expiry': { th: 'เลยวันหมดอายุ', en: 'Past expiry' },
  'sodreg.reason_review_overdue': { th: 'เกินกำหนดทบทวน', en: 'Review overdue' },
  'sodreg.save': { th: 'บันทึก', en: 'Save' },

  'sodreg.accept_ok': { th: 'บันทึกการยอมรับความขัดแย้งแล้ว', en: 'Conflict acceptance recorded' },
  'sodreg.review_ok': { th: 'บันทึกการทบทวนแล้ว', en: 'Re-review recorded' },
  'sodreg.empty_conflicts': { th: 'ไม่พบความขัดแย้ง SoD ในปัจจุบัน', en: 'No current SoD conflicts' },
  'sodreg.empty_register': { th: 'ยังไม่มีการยอมรับความขัดแย้ง', en: 'No accepted conflicts yet' },
  'sodreg.empty_expired': { th: 'ไม่มีการยอมรับที่เกินกำหนด', en: 'No expired / overdue acceptances' },
};
