import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { NpsService } from './nps.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class NpsBiReports implements BiReportSource {
  constructor(private readonly nps: NpsService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'nps_post_purchase',
        generate: async (f, user) => {
          const r = await this.nps.sendDue(user, Number(f.window_days) > 0 ? Number(f.window_days) : 1); // idempotent per member × sale (unique index)
          return { data: r, summary: `NPS surveys: sent ${r.sent} of ${r.orders} recent paid orders (${r.skipped} skipped/already surveyed)`, summaryTh: `แบบสอบถาม NPS: ส่ง ${r.sent} จาก ${r.orders} บิลล่าสุด` };
        },
      },
    ];
  }
}
