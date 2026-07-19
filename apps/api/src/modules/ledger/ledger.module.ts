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
import { FxRevalController } from './fx-reval.controller';
import { FxRevalService } from './fx-reval.service';
import { DeferredTaxController } from './deferred-tax.controller';
import { DeferredTaxService } from './deferred-tax.service';
import { AccountDeterminationService } from './account-determination.service';
import { LedgerBiReports } from './ledger-bi-reports';
import { LedgerApprovalQueues } from './ledger-approval-queues';
import { LedgerReadService } from './ledger-read.service';
import { LedgerJeAnomalyService } from './ledger-je-anomaly.service';
import { LedgerJeAnomalyController } from './ledger-je-anomaly.controller';

// LedgerService is exported so other modules (POS, AR, AP, Payments) can post into the GL.
// LedgerJeAnomalyService is exported for the finance Close-Cockpit pillar (GL-28 tile).
@Module({
  controllers: [LedgerController, CostCentersController, CoaController, PostingRulesController, SubledgerTieoutController, CloseController, FxRevalController, DeferredTaxController, LedgerJeAnomalyController],
  providers: [LedgerApprovalQueues, LedgerReadService, LedgerBiReports, LedgerService, CostCentersService, CoaService, PostingService, SubledgerTieoutService, CloseService, FxRevalService, DeferredTaxService, AccountDeterminationService, LedgerJeAnomalyService],
  exports: [LedgerReadService, LedgerService, CostCentersService, CoaService, PostingService, SubledgerTieoutService, CloseService, FxRevalService, DeferredTaxService, AccountDeterminationService, LedgerJeAnomalyService],
})
export class LedgerModule {}
