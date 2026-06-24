import { Module } from '@nestjs/common';
import { ControlsService } from './controls.service';
import { ControlsController } from './controls.controller';

// Continuous controls monitoring (Phase 19 — B5). SQL detectors over tenant-scoped AP + vendor data; findings
// surfaced for human review. Read-only, no GL. DRIZZLE is global.
@Module({
  controllers: [ControlsController],
  providers: [ControlsService],
})
export class ControlsModule {}
