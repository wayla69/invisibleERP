import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { ScheduledChangesService } from './scheduled-changes.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class ScheduledChangesBiReports implements BiReportSource {
  constructor(private readonly scheduledChanges: ScheduledChangesService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'apply_scheduled_master_changes',
        generate: async (_f, user) => {
          const r = await this.scheduledChanges.applyDue(user); // idempotent: only `scheduled` rows due today; applied rows skip
          return { data: r, summary: `Date-effective master changes: applied ${r.applied} of ${r.scanned} due (as of ${r.as_of})`, summaryTh: `ปรับข้อมูลหลักตามวันที่มีผล: ${r.applied} จาก ${r.scanned} รายการ (ณ ${r.as_of})` };
        },
      },
    ];
  }
}
