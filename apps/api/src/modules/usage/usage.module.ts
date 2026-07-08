import { Module } from '@nestjs/common';
import { UsageMeterService } from './usage-meter.service';

// Thin, dependency-light module so any feature module (tax e-Tax, POS) can inject UsageMeterService to record
// a billable event without pulling in the billing module. The billing/overage logic lives in BillingService.
@Module({
  providers: [UsageMeterService],
  exports: [UsageMeterService],
})
export class UsageModule {}
