import { Module } from '@nestjs/common';
import { PrintingModule } from '../printing/printing.module';
import { PaymentsModule } from '../payments/payments.module';
import { PeripheralsService } from './peripherals.service';
import { PeripheralsController } from './peripherals.controller';

// Phase 5 — POS hardware peripherals: device registry, cash-drawer kick (via the print queue) + audit,
// customer-facing display state, and weighing-scale capture. DRIZZLE is global.
@Module({
  imports: [PrintingModule, PaymentsModule],
  controllers: [PeripheralsController],
  providers: [PeripheralsService],
  exports: [PeripheralsService],
})
export class PeripheralsModule {}
