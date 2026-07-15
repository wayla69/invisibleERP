import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { GovernanceService } from './governance.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class GovernanceBiReports implements BiReportSource {
  constructor(private readonly governance: GovernanceService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'governance_readiness',
        generate: async (f, user) => {
          const r = await this.governance.readiness(user, f.policy_version || '1.0'); // read-only snapshot
          const summary = r.ready
            ? `Governance ready: acknowledgement ${r.ethics.coverage_pct}%, oversight current, ${r.hotline.open_cases} open case(s)`
            : `Governance attention: ${r.alerts.join(' · ')}`;
          return { data: r, summary, summaryTh: r.ready ? `ธรรมาภิบาลพร้อม: ยอมรับจรรยาบรรณ ${r.ethics.coverage_pct}%` : `ต้องดำเนินการ: ${r.alerts.length} รายการ` };
        },
      },
      {
        // SME-01 (docs/49) — self-approval review: the detective compensating control for the SME
        // single-user edition. Schedule it (monthly) to the external accountant + the platform owner.
        type: 'sme_self_approval_review',
        generate: async (f, user) => {
          const r = await this.governance.selfApprovalReview(user, Number(f?.days) || 31);
          const summary = r.count
            ? `SME self-approval review: ${r.count} self-approved item(s) in ${r.window_days}d, total ฿${r.total_amount.toLocaleString()} — review each reason`
            : `SME self-approval review: no self-approvals in the last ${r.window_days}d`;
          const summaryTh = r.count
            ? `ทบทวนการอนุมัติด้วยตนเอง (SME-01): ${r.count} รายการใน ${r.window_days} วัน รวม ฿${r.total_amount.toLocaleString()} — โปรดทบทวนเหตุผลทุกรายการ`
            : `ทบทวนการอนุมัติด้วยตนเอง (SME-01): ไม่มีรายการใน ${r.window_days} วันที่ผ่านมา`;
          return { data: r, summary, summaryTh };
        },
      },
    ];
  }
}
