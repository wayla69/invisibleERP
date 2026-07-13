import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { LeasesService } from './leases.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class LeasesBiReports implements BiReportSource {
  constructor(private readonly leases: LeasesService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'lease_periodic_run',
        generate: async (_f, user) => {
          const r = await this.leases.runDueLeases(user); // idempotent per (lease, period)
          return { data: r, summary: `Lease run: posted ${r.posted} of ${r.scanned} due leases`, summaryTh: `ลงรายการสัญญาเช่า: ${r.posted} จาก ${r.scanned} สัญญา` };
        },
      },
    ];
  }
}
