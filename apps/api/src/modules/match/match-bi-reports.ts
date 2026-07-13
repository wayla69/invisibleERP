import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { ThreeWayMatchService } from './three-way-match.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class MatchBiReports implements BiReportSource {
  constructor(private readonly match: ThreeWayMatchService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'ap_automatch_rerun',
        generate: async (_f, user) => {
          const r = await this.match.rematchBlocked(user); // idempotent: re-verdicts from current PO/GR state; overrides untouched
          return { data: r, summary: `Auto re-match: released ${r.released} of ${r.swept} blocked invoice(s)`, summaryTh: `จับคู่ซ้ำอัตโนมัติ: ปลดล็อก ${r.released} จาก ${r.swept} ใบที่ถูกระงับ` };
        },
      },
    ];
  }
}
