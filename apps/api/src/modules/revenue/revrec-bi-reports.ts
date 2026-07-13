import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { RevRecService } from './revrec.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class RevRecBiReports implements BiReportSource {
  constructor(private readonly revrec: RevRecService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'rev_rec_recognize',
        generate: async (_f, user) => {
          // Recognize every TFRS-15 schedule due through the current period for the caller's tenant. Idempotent:
          // an already-recognized schedule is skipped (the REVREC JE is alreadyPosted-guarded).
          const period = new Date().toISOString().slice(0, 7); // YYYY-MM
          const r = await this.revrec.recognize({ period }, user, user.tenantId ?? null);
          return { data: r, summary: `Revenue recognition ${period}: recognized ${r.recognized_count} schedule(s), total ${r.total_recognized}`, summaryTh: `รับรู้รายได้งวด ${period}: ${r.recognized_count} รายการ รวม ${r.total_recognized}` };
        },
      },
    ];
  }
}
