import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { RetentionService } from './retention.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class RetentionBiReports implements BiReportSource {
  constructor(private readonly retention: RetentionService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'retention_release_due',
        generate: async () => {
          const r = await this.retention.runDueReleases(); // idempotent per tranche
          return { data: r, summary: `Retention release: released ${r.released} of ${r.scanned} due tranches (${r.amount})`, summaryTh: `คืนเงินประกันผลงาน: ${r.released} จาก ${r.scanned} งวด (${r.amount})` };
        },
      },
    ];
  }
}
