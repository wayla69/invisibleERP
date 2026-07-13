import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { JourneysService } from './journeys.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class JourneysBiReports implements BiReportSource {
  constructor(private readonly journeys: JourneysService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'journey_runner',
        generate: async (_f, user) => {
          const r = await this.journeys.runDueAll(user); // at-most-once per step: each enrollment-step is claimed before delivery
          return { data: r, summary: `Journeys: sent ${r.sent}, skipped ${r.skipped} across ${r.tenants_processed} tenant(s)`, summaryTh: `เจอร์นีย์: ส่ง ${r.sent} ข้าม ${r.skipped} ใน ${r.tenants_processed} ร้าน` };
        },
      },
    ];
  }
}
