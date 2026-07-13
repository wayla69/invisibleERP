import { Injectable } from '@nestjs/common';
import { ymd } from '../../database/queries';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { MenuEngineeringService } from './menu-engineering.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class AnalyticsBiReports implements BiReportSource {
  constructor(private readonly menuEng: MenuEngineeringService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'menu_affinity',
        generate: async (f, user) => {
          // scheduled runs default to a trailing window (days, default 30) on the business clock
          const days = Math.min(Math.max(Number(f.days ?? 30) || 30, 1), 365);
          const to = f.to ?? ymd();
          const from = f.from ?? ymd(new Date(Date.now() - days * 86_400_000));
          const r = await this.menuEng.menuAffinity(user, { from, to, branch_id: f.branch_id, min_pair_count: f.min_pair_count, top: f.top });
          const topPair = r.pairs[0];
          return {
            data: r,
            summary: `Menu affinity (${r.from}..${r.to}): ${r.summary.baskets} basket(s), ${r.summary.pairs_returned} pair(s)${topPair ? `; top ${topPair.name_a} + ${topPair.name_b} (lift ${topPair.lift})` : ''}`,
            summaryTh: `คู่เมนูขายด้วยกัน (${r.from}..${r.to}): ${r.summary.baskets} บิล · ${r.summary.pairs_returned} คู่${topPair ? ` · เด่นสุด ${topPair.name_a}+${topPair.name_b} (lift ${topPair.lift})` : ''}`,
          };
        },
      },
    ];
  }
}
