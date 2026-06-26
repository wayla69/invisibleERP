import { Module } from '@nestjs/common';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { CostCentersController } from './cost-centers.controller';
import { CostCentersService } from './cost-centers.service';
import { CoaController } from './coa.controller';
import { CoaService } from './coa.service';
import { PostingService } from './posting.service';
import { PostingRulesController } from './posting-rules.controller';
import { SubledgerTieoutController } from './subledger-tieout.controller';
import { SubledgerTieoutService } from './subledger-tieout.service';
import { CloseController } from './close.controller';
import { CloseService } from './close.service';

// LedgerService is exported so other modules (POS, AR, AP, Payments) can post into the GL.
@Module({
  controllers: [LedgerController, CostCentersController, CoaController, PostingRulesController, SubledgerTieoutController, CloseController],
  providers: [LedgerService, CostCentersService, CoaService, PostingService, SubledgerTieoutService, CloseService],
  exports: [LedgerService, CostCentersService, CoaService, PostingService, SubledgerTieoutService, CloseService],
})
export class LedgerModule {}
