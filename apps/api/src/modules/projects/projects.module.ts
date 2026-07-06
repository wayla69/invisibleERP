import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { BiLiveModule } from '../bi/bi-live.module';
import { CommitmentsModule } from '../commitments/commitments.module';
import { RetentionModule } from '../retention/retention.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

// Phase 18 — Projects / PPM: project costing (→ WIP) + billing (→ revenue, relieve WIP to COGS).
// BiLiveModule supplies the shared real-time bus so the action center (PMO-1) can proactively push a
// `project_action` SSE event when a project goes red or an unmitigated-high risk is logged.
// CommitmentsModule (M1, PROJ-12) supplies the BoQ-line encumbrance ledger so getBoq can show
// budget/committed/remaining per line and expose the project commitments read model.
@Module({
  imports: [LedgerModule, BiLiveModule, CommitmentsModule, RetentionModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
