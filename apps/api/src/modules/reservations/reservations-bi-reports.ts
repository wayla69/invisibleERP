import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { ReservationsService } from './reservations.service';

// docs/50 Wave 1 A2 — module-owned action job (docs/46 Phase 1 pattern, discovered by
// BiReportRegistrarService): release stock reservations held past their TTL so stale holds stop
// starving other projects' available-to-issue. Schedule filters: { max_age_days } (default 30).
@Injectable()
export class ReservationsBiReports implements BiReportSource {
  constructor(private readonly reservations: ReservationsService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'reservation_stale_release',
        generate: async (f, user) => {
          const r = await this.reservations.expireStale(user, Number(f?.max_age_days ?? 30)); // idempotent: released rows leave the held set
          return {
            data: r,
            summary: `Stale reservation sweep: released ${r.released} hold(s) older than ${r.max_age_days}d`,
            summaryTh: `เก็บกวาดการจองค้าง: ปล่อย ${r.released} รายการที่ค้างเกิน ${r.max_age_days} วัน`,
          };
        },
      },
    ];
  }
}
