import { Module } from '@nestjs/common';
import { CrmService } from './crm.service';
import { CrmController } from './crm.controller';
import { CrmPipelineModule } from './pipeline/crm-pipeline.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { CrmAccountsModule } from './accounts/crm-accounts.module';
import { CrmAccountDepthModule } from './account-depth/crm-account-depth.module';
import { CrmAccountHealthModule } from './account-health/crm-account-health.module';
import { CrmInboundModule } from './inbound/crm-inbound.module';
import { FinanceModule } from '../finance/finance.module';
import { CrmBiReports } from './crm-bi-reports';

// Umbrella CRM module: accounts/360 core + the UNIFIED pipeline (CRM-1, migration 0293). The deferred
// service-level merge (docs/28 PR #3) is now done: CrmPipelineModule owns the ONE opportunity spine
// (crm_opportunities + tenant-configurable pipeline_stages + crm_stage_history), PipelineModule's
// /api/pipeline routes are thin adapters over it (the Batch 2A `opportunities`/`opportunity_activities`
// tables are read-legacy — data-migrated in 0293), and CrmAccountsModule adds the party model
// (crm_accounts/crm_contacts with duplicate governance + audited merge). Re-exported so importers (bi)
// can keep resolving.
@Module({
  imports: [CrmPipelineModule, PipelineModule, CrmAccountsModule, CrmAccountDepthModule, CrmAccountHealthModule, CrmInboundModule, FinanceModule],
  controllers: [CrmController],
  providers: [CrmBiReports, CrmService],
  exports: [CrmService, CrmPipelineModule, PipelineModule, CrmAccountsModule, CrmAccountDepthModule, CrmAccountHealthModule, CrmInboundModule],
})
export class CrmModule {}
