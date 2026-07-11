import { Module } from '@nestjs/common';
import { CoaService } from './coa.service';
import { CoaController } from './coa.controller';
import { ScarService } from './scar.service';
import { ScarController } from './scar.controller';

// QMS quality module — QMS-3 Certificate of Analysis (CoA) capture + out-of-spec release approval (QC-03,
// read-only over the lot ledger via lot_no) and QMS-4 Supplier Corrective Action Request (SCAR / 8D) closure
// control (QC-04, over the existing supplier claim + scorecard spine; it references gr_claims/vendors and
// never recomputes a scorecard).
@Module({
  controllers: [CoaController, ScarController],
  providers: [CoaService, ScarService],
  exports: [CoaService, ScarService],
})
export class QualityModule {}
