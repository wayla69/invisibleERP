import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { MembershipService } from './membership.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class MembershipBiReports implements BiReportSource {
  constructor(private readonly membership: MembershipService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'membership_revenue_recognize',
        generate: async (_f, user) => {
          const r = await this.membership.recognizeDue(user); // idempotent per (membership, month) via the JE dedup
          return { data: r, summary: `VIP recognition: posted ${r.posted} month(s), ฿${r.amount} across ${r.scanned} membership(s)`, summaryTh: `รับรู้รายได้ VIP: ${r.posted} งวด ฿${r.amount}` };
        },
      },
    ];
  }
}
