import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { PdpaService } from './pdpa.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class PdpaBiReports implements BiReportSource {
  constructor(private readonly pdpa: PdpaService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'pii_retention_sweep',
        generate: async (_f, user) => {
          // Opt-in per tenant (pdpa_retention_policies, enabled=true); idempotent — an already-anonymized member is never a candidate.
          const r = await this.pdpa.runRetentionSweep(user);
          return { data: r, summary: `PII retention sweep: ${r.swept_total} member(s) anonymized across ${r.policies} enabled polic(ies)`, summaryTh: `ลบล้างข้อมูลส่วนบุคคลพ้นระยะเก็บรักษา: ${r.swept_total} ราย จาก ${r.policies} นโยบายที่เปิดใช้` };
        },
      },
    ];
  }
}
