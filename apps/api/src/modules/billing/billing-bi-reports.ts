import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { BillingService } from './billing.service';
import { SaasLifecycleService } from './saas-lifecycle.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class BillingBiReports implements BiReportSource {
  constructor(private readonly billing: BillingService, private readonly lifecycle: SaasLifecycleService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        // A2 — the daily SaaS lifecycle sweep (trial reminders → grace → auto-suspend; PastDue dunning
        // ladder). Idempotent via saas_lifecycle_events dedup keys, so any schedule cadence is safe.
        type: 'saas_lifecycle',
        generate: async () => {
          const r = await this.lifecycle.runDaily();
          const acts = Object.entries(r.actions).map(([k, n]) => `${k}=${n}`).join(', ') || 'none';
          return { data: r, summary: `SaaS lifecycle: ${r.total_actions} action(s) over ${r.subscriptions} subscription(s) — ${acts}`, summaryTh: `วงจรสถานะลูกค้า SaaS: ${r.total_actions} รายการจาก ${r.subscriptions} subscription — ${acts}` };
        },
      },
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
