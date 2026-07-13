import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { BillingService } from './billing.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class BillingBiReports implements BiReportSource {
  constructor(private readonly billing: BillingService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'ai_overage_billing',
        generate: async (f, user) => {
          const r = await this.billing.runAiOverageBilling(user, f.month); // idempotent per (tenant, month)
          return { data: r, summary: `AI overage billing ${r.month}: charged ${r.processed_count} tenant(s), total ${r.total_amount} THB`, summaryTh: `เรียกเก็บค่า AI ส่วนเกิน ${r.month}: ${r.processed_count} ร้าน รวม ${r.total_amount} บาท` };
        },
      },
      {
        type: 'usage_overage_billing',
        generate: async (f, user) => {
          const r = await this.billing.runUsageOverageBilling(user, f.month); // idempotent per (tenant, meter, month)
          return { data: r, summary: `Usage overage billing ${r.month}: charged ${r.processed_count} meter-tenant(s), total ${r.total_amount} THB`, summaryTh: `เรียกเก็บค่าใช้งานส่วนเกิน ${r.month}: ${r.processed_count} รายการ รวม ${r.total_amount} บาท` };
        },
      },
    ];
  }
}
