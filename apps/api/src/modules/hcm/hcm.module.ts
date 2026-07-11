import { Module } from '@nestjs/common';
import { HcmController } from './hcm.controller';
import { HcmService } from './hcm.service';
import { HcmLeaveController } from './hcm-leave.controller';
import { HcmLeaveService } from './hcm-leave.service';
import { ProjectsModule } from '../projects/projects.module';
import { MessagingModule } from '../messaging/messaging.module';

// Phase 19 — HCM: attendance/timesheets (OT → payroll) + leave (unpaid → payroll deduction).
// ProjectsModule: approved timesheets post project labor cost (PPM P3 — PROJ-04).
// HR-2 (docs/42): HcmLeaveService — leave accrual engine + policies (control HR-02); exported so the BI
// scheduler (hr_leave_accrual report type) can run the accrual monthly.
@Module({
  imports: [ProjectsModule, MessagingModule],
  controllers: [HcmController, HcmLeaveController],
  providers: [HcmService, HcmLeaveService],
  exports: [HcmLeaveService],
})
export class HcmModule {}
