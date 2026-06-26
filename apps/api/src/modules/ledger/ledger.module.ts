import { Module } from '@nestjs/common';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { CostCentersController } from './cost-centers.controller';
import { CostCentersService } from './cost-centers.service';
import { CoaController } from './coa.controller';
import { CoaService } from './coa.service';
import { PostingService } from './posting.service';
import { PostingRulesController } from './posting-rules.controller';

// LedgerService is exported so other modules (POS, AR, AP, Payments) can post into the GL.
@Module({
  controllers: [LedgerController, CostCentersController, CoaController, PostingRulesController],
  providers: [LedgerService, CostCentersService, CoaService, PostingService],
  exports: [LedgerService, CostCentersService, CoaService, PostingService],
})
export class LedgerModule {}
