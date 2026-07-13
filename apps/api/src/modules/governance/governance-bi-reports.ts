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
    ];
  }
}
