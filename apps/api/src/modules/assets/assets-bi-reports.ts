import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { AssetsService } from './assets.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class AssetsBiReports implements BiReportSource {
  constructor(private readonly assets: AssetsService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'asset_audit',
        generate: async (f, user) => {
          const r = await this.assets.auditReport(user, { limit: f.limit });
          return { data: r, summary: `Asset audits: ${r.totals.audits}, missing ${r.totals.missing}, misplaced ${r.totals.misplaced}; ${r.totals.pending_custody} custody request(s) pending`, summaryTh: `ตรวจนับทรัพย์สิน ${r.totals.audits} ครั้ง · ขาดหาย ${r.totals.missing} · ผิดตำแหน่ง ${r.totals.misplaced} · รออนุมัติย้าย ${r.totals.pending_custody}` };
        },
      },
      {
        type: 'asset_verification_exceptions',
        generate: async (f, user) => {
          const r = await this.assets.unverifiedAssets(user, { days: f.days });
          return { data: r, summary: `${r.count} of ${r.total_active} active assets not verified in ${r.days} days`, summaryTh: `${r.count} จาก ${r.total_active} สินทรัพย์ไม่ได้ตรวจสอบเกิน ${r.days} วัน` };
        },
      },
    ];
  }
}
