import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { ScheduledChangesService } from './scheduled-changes.service';
import { ScheduledChangesController } from './scheduled-changes.controller';

// Date-effective (future-dated) master-data changes (master-data audit Phase 12). Exports the service so the
// BI scheduler can run the idempotent `apply_scheduled_master_changes` action job (@Optional injection).
@Module({
  imports: [DatabaseModule],
  controllers: [ScheduledChangesController],
  providers: [ScheduledChangesService],
  exports: [ScheduledChangesService],
})
export class ScheduledChangesModule {}
