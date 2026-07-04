import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { FinanceModule } from '../finance/finance.module';
import { EamModule } from '../eam/eam.module';
import { LedgerModule } from '../ledger/ledger.module';
import { LeasesModule } from '../leases/leases.module';
import { RevenueModule } from '../revenue/revenue.module';
import { ProjectsModule } from '../projects/projects.module';
import { CrmPipelineModule } from '../crm/pipeline/crm-pipeline.module';
import { CrmModule } from '../crm/crm.module';
import { BudgetModule } from '../budget/budget.module';
import { ProcurementModule } from '../procurement/procurement.module';
import { MatchModule } from '../match/match.module';
import { BillingModule } from '../billing/billing.module';
import { GovernanceModule } from '../governance/governance.module';
import { TaxJobsModule } from '../tax/tax-jobs.module';
import { JourneysModule } from '../journeys/journeys.module';
import { NpsModule } from '../nps/nps.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { BiService } from './bi.service';
import { BiLiveModule } from './bi-live.module';
import { BiController } from './bi.controller';

// MessagingModule supplies MessagingService for scheduled-report email delivery (Phase 4). FinanceModule
// (CollectionsService), EamModule (EamService), LedgerModule (LedgerService) and LeasesModule (LeasesService)
// supply the scheduled ar_collections_dunning, eam_pm_generate, gl_recurring_journals, gl_prepaid_amortize
// and lease_periodic_run action jobs. ProjectsModule (ProjectsService) + CrmPipelineModule
// (CrmPipelineService) supply the project_evm + crm_win_loss report types. DRIZZLE is global.
// BudgetModule/ProcurementModule/MatchModule supply the residual-gap report types budget_variance,
// supplier_scorecard and the exec_scorecard supply-chain leg (RG-1/2/3).
@Module({ imports: [MessagingModule, FinanceModule, EamModule, LedgerModule, LeasesModule, RevenueModule, ProjectsModule, CrmPipelineModule, CrmModule, BudgetModule, ProcurementModule, MatchModule, BillingModule, GovernanceModule, TaxJobsModule, BiLiveModule, JourneysModule, NpsModule, LoyaltyModule], providers: [BiService], controllers: [BiController], exports: [BiService] })
export class BiModule {}
