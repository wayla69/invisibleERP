import { Module } from '@nestjs/common';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { CostCentersController } from './cost-centers.controller';
import { CostCentersService } from './cost-centers.service';

// LedgerService is exported so other modules (POS, AR, AP, Payments) can post into the GL.
@Module({
  controllers: [LedgerController, CostCentersController],
  providers: [LedgerService, CostCentersService],
  exports: [LedgerService, CostCentersService],
})
export class LedgerModule {}
