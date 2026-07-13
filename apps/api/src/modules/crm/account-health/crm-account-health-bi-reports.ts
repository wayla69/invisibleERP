import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../../bi/report-registry';
import { CrmAccountHealthService } from './crm-account-health.service';

// docs/46 Phase 1 — module-owned BI report generator (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class CrmAccountHealthBiReports implements BiReportSource {
  constructor(private readonly svc: CrmAccountHealthService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'crm_account_health',
        generate: async (_f, user) => {
          const r = await this.svc.captureAllHealth(user); // idempotent per (account, date)
          return { data: r, summary: `Account health: captured ${r.captured} of ${r.scanned} account(s) for ${r.as_of}`, summaryTh: `บันทึกสุขภาพบัญชีลูกค้า: ${r.captured} จาก ${r.scanned} บัญชี` };
        },
      },
    ];
  }
}
