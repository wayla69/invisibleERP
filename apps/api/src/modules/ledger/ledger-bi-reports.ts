import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { LedgerService } from './ledger.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical). The scheduled GL action jobs
// (GL-08 recurring, GL-09 prepaid, GL-23 allocations) ride the facade's delegators.
@Injectable()
export class LedgerBiReports implements BiReportSource {
  constructor(private readonly ledger: LedgerService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'gl_recurring_journals',
        generate: async (_f, user) => {
          const r = await this.ledger.runDueRecurring(user); // idempotent: next_run_date advanced + ux_je_idem
          return { data: r, summary: `Recurring journals: posted ${r.posted} of ${r.scanned} due templates`, summaryTh: `ลงรายการบัญชีตั้งเวลา: ${r.posted} จาก ${r.scanned} แม่แบบ` };
        },
      },
      {
        type: 'gl_prepaid_amortize',
        generate: async (_f, user) => {
          const r = await this.ledger.runDuePrepaid(user); // idempotent per (schedule, period)
          return { data: r, summary: `Prepaid amortization: posted ${r.posted} of ${r.scanned} due schedules`, summaryTh: `ตัดจ่ายค่าใช้จ่ายล่วงหน้า: ${r.posted} จาก ${r.scanned} รายการ` };
        },
      },
      {
        type: 'gl_allocation_run',
        generate: async (_f, user) => {
          const r = await this.ledger.runDueAllocations(user); // idempotent per period: next_run_date advanced + ux_je_idem
          return { data: r, summary: `Allocation cycles: posted ${r.posted} of ${r.scanned} due cycles`, summaryTh: `ปันส่วนต้นทุน: ${r.posted} จาก ${r.scanned} รอบ` };
        },
      },
    ];
  }
}
