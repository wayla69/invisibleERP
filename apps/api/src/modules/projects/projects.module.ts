import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

// Phase 18 — Projects / PPM: project costing (→ WIP) + billing (→ revenue, relieve WIP to COGS).
@Module({
  imports: [LedgerModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
