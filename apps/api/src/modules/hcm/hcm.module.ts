import { Module } from '@nestjs/common';
import { HcmController } from './hcm.controller';
import { HcmService } from './hcm.service';
import { HcmLeaveController } from './hcm-leave.controller';
import { HcmLeaveService } from './hcm-leave.service';
import { HcmPerfController } from './hcm-perf.controller';
import { HcmPerfService } from './hcm-perf.service';
import { HcmOrgController } from './hcm-org.controller';
import { HcmOrgService } from './hcm-org.service';
import { HcmCompController } from './hcm-comp.controller';
import { HcmCompService } from './hcm-comp.service';
import { ProjectsModule } from '../projects/projects.module';
import { MessagingModule } from '../messaging/messaging.module';

// Phase 19 — HCM: attendance/timesheets (OT → payroll) + leave (unpaid → payroll deduction).
// ProjectsModule: approved timesheets post project labor cost (PPM P3 — PROJ-04).
// HR-2 (docs/42): HcmLeaveService — leave accrual engine + policies (control HR-02); exported so the BI
// scheduler (hr_leave_accrual report type) can run the accrual monthly.
// HR-3 (docs/42): performance management — cycles/goals/reviews with the HR-03 sign-off SoD.
// HR-1 (docs/42): organisation structure, positions & effective-dated assignments with the HR-01
// headcount-governance control (StatusLogService is provided globally by CommonModule).
// HR-6 (docs/42, Wave 2): compensation bands + benefits with the HR-06 comp-change maker-checker within band.
@Module({
  imports: [ProjectsModule, MessagingModule],
  controllers: [HcmController, HcmLeaveController, HcmPerfController, HcmOrgController, HcmCompController],
  providers: [HcmService, HcmLeaveService, HcmPerfService, HcmOrgService, HcmCompService],
  exports: [HcmLeaveService],
})
export class HcmModule {}
