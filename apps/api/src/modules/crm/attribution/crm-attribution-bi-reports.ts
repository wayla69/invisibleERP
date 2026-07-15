import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../../bi/report-registry';
import { CrmAttributionService } from './crm-attribution.service';

// CRM-15: schedulable multi-touch attribution report (discovered at boot by BiReportRegistrarService — the
// provider only needs to sit in a module's providers array). Mirrors CrmDqBiReports. Filters may carry a
// `model` (first_touch|last_touch|linear|u_shaped, default linear) and `months` window (default 6).
@Injectable()
export class CrmAttributionBiReports implements BiReportSource {
  constructor(private readonly svc: CrmAttributionService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'crm_attribution',
        generate: async (f: any, user) => {
          const r = await this.svc.attribution(user, { model: f?.model, months: f?.months != null ? Number(f.months) : undefined });
          return {
            data: r,
            summary: `Multi-touch attribution (${r.model}, ${r.window_months}mo): ${r.totals.total_attributed} across ${r.totals.campaign_count} campaign(s)`,
            summaryTh: `การระบุที่มาแบบหลายจุดสัมผัส (${r.model}, ${r.window_months} เดือน): ${r.totals.total_attributed} จาก ${r.totals.campaign_count} แคมเปญ`,
          };
        },
      },
    ];
  }
}
