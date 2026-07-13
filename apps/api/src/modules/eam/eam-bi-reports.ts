import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { EamService } from './eam.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class EamBiReports implements BiReportSource {
  constructor(private readonly eam: EamService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'eam_pm_generate',
        generate: async (_f, user) => {
          const r = await this.eam.runPmDue(user); // idempotent: a schedule with an open WO is skipped
          return { data: r, summary: `PM generation: raised ${r.generated} of ${r.scanned} schedules`, summaryTh: `สร้างใบสั่งงานซ่อมตามแผน: ${r.generated} จาก ${r.scanned} แผน` };
        },
      },
    ];
  }
}
