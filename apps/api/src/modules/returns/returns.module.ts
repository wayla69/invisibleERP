import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ReturnsService } from './returns.service';
import { ReturnsController } from './returns.controller';

// POS item-level returns. DocNumberService + DRIZZLE are global.
@Module({
  imports: [PaymentsModule, LedgerModule],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
