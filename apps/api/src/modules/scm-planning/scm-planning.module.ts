import { Module } from '@nestjs/common';
import { DemandMlModule } from '../demand-ml/demand-ml.module';
import { JobsModule } from '../jobs/jobs.module';
import { ProcurementModule } from '../procurement/procurement.module';
import { ScmAccuracyService } from './scm-accuracy.service';
import { ScmApprovalQueues } from './scm-approval-queues';
import { ScmBiReports } from './scm-bi-reports';
import { ScmEngineClientService } from './scm-engine-client.service';
import { ScmLiveService } from './scm-live.service';
import { ScmPlanJobsService } from './scm-plan-jobs.service';
import { ScmPlanningController } from './scm-planning.controller';
import { ScmPlanningService } from './scm-planning.service';
import { ScmSpikeService } from './scm-spike.service';

// docs/54 — Dynamic Supply Chain & Demand Forecasting.
//
// Registered in SupplyChainDomainModule (never app.module directly). Peer modules are imported for
// their public services only: ProcurementModule for createPr (the loose-coupling handoff), JobsModule
// for the background queue, DemandMlModule for the in-process fallback forecaster.
//
// ScmApprovalQueues and ScmBiReports need no wiring beyond being providers — they are discovered at
// boot by ApprovalQueueRegistrarService / BiReportRegistrarService.

@Module({
  imports: [JobsModule, ProcurementModule, DemandMlModule],
  controllers: [ScmPlanningController],
  providers: [
    ScmLiveService,
    ScmAccuracyService,
    ScmEngineClientService,
    ScmPlanningService,
    ScmSpikeService,
    ScmPlanJobsService,
    ScmApprovalQueues,
    ScmBiReports,
  ],
  // ScmEngineClientService is exported so ScmNetworkModule (docs/57 B2) reuses the ONE engine client
  // (HMAC signing, retries, contract version) rather than standing up a second one — docs/57 §4.1.
  exports: [ScmPlanningService, ScmSpikeService, ScmEngineClientService],
})
export class ScmPlanningModule {}
