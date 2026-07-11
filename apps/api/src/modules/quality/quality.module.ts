import { Module } from '@nestjs/common';
import { ScarService } from './scar.service';
import { ScarController } from './scar.controller';

// QMS-4 — Supplier quality / corrective-action (SCAR / 8D). Standalone read/write module over the existing
// supplier claim + scorecard spine (procurement); it references gr_claims/vendors and never recomputes a
// scorecard. Control QC-04 (SCAR closure maker-checker + overdue detective read).
@Module({
  providers: [ScarService],
  controllers: [ScarController],
  exports: [ScarService],
})
export class QualityModule {}
