import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { RealEstateService } from './realestate.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class RealEstateBiReports implements BiReportSource {
  constructor(private readonly realestate: RealEstateService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 're_booking_expire',
        generate: async () => {
          const r = await this.realestate.expireDueBookings(); // frees the unit back to available
          return { data: r, summary: `Booking expiry: expired ${r.expired} of ${r.scanned} lapsed bookings`, summaryTh: `ยกเลิกการจองหมดอายุ: ${r.expired} จาก ${r.scanned} รายการ` };
        },
      },
      {
        type: 're_installment_overdue',
        generate: async () => {
          const r = await this.realestate.overdueInstallments(); // detective — surfaces the overdue worklist
          return { data: r, summary: `Overdue installments: ${r.overdue} pending (${r.total})`, summaryTh: `งวดผ่อนเกินกำหนด: ${r.overdue} งวด (${r.total})` };
        },
      },
    ];
  }
}
