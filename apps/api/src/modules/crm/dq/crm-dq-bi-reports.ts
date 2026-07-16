import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../../bi/report-registry';
import { CrmDqService } from './crm-dq.service';

// CRM-17: schedulable daily DQ snapshot (discovered at boot by BiReportRegistrarService — provider only needs
// to sit in a module's providers array). Mirrors CrmAccountHealthBiReports.
@Injectable()
export class CrmDqBiReports implements BiReportSource {
  constructor(private readonly svc: CrmDqService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'crm_dq_scan',
        generate: async (_f, user) => {
          const r = await this.svc.captureAllDq(user); // idempotent per (account, date)
          return { data: r, summary: `CRM data-quality: scored ${r.captured} of ${r.scanned} account(s) for ${r.as_of}`, summaryTh: `คุณภาพข้อมูล CRM: ประเมิน ${r.captured} จาก ${r.scanned} บัญชี` };
        },
      },
    ];
  }
}
