import { Module } from '@nestjs/common';
import { HcmController } from './hcm.controller';
import { HcmService } from './hcm.service';
import { HcmPerfController } from './hcm-perf.controller';
import { HcmPerfService } from './hcm-perf.service';
import { HcmOrgController } from './hcm-org.controller';
import { HcmOrgService } from './hcm-org.service';
import { ProjectsModule } from '../projects/projects.module';
import { MessagingModule } from '../messaging/messaging.module';

// Phase 19 — HCM: attendance/timesheets (OT → payroll) + leave (unpaid → payroll deduction).
// ProjectsModule: approved timesheets post project labor cost (PPM P3 — PROJ-04).
// HR-3 (docs/42): performance management — cycles/goals/reviews with the HR-03 sign-off SoD.
// HR-1 (docs/42): organisation structure, positions & effective-dated assignments with the HR-01
// headcount-governance control (StatusLogService is provided globally by CommonModule).
@Module({
  imports: [ProjectsModule, MessagingModule],
  controllers: [HcmController, HcmPerfController, HcmOrgController],
  providers: [HcmService, HcmPerfService, HcmOrgService],
})
export class HcmModule {}
