import { Module } from '@nestjs/common';
import { HcmController } from './hcm.controller';
import { HcmService } from './hcm.service';

// Phase 19 — HCM: attendance/timesheets (OT → payroll) + leave (unpaid → payroll deduction).
@Module({
  controllers: [HcmController],
  providers: [HcmService],
})
export class HcmModule {}
