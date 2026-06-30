import { Module } from '@nestjs/common';
import { IcReconService } from './ic-recon.service';
import { IcReconController } from './ic-recon.controller';

// REC-03 — per-period intercompany reconciliation sign-off. Independent of ConsolidationModule (it reads the
// GL + IC tables directly); consolidation reads the ic_recon_periods table for its gate, so there is no
// circular dependency between the two modules.
@Module({
  providers: [IcReconService],
  controllers: [IcReconController],
  exports: [IcReconService],
})
export class IcReconModule {}
