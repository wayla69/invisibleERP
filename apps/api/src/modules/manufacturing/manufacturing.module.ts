import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { ManufacturingController } from './manufacturing.controller';
import { ManufacturingService } from './manufacturing.service';

// Phase 18 — Manufacturing: work orders against a BOM with WIP costing + GL.
// DocNumberService is global (CommonModule); LedgerService from LedgerModule for the WIP/FG entries.
@Module({
  imports: [LedgerModule],
  controllers: [ManufacturingController],
  providers: [ManufacturingService],
})
export class ManufacturingModule {}
