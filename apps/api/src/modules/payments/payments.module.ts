import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsController } from './payments.controller';
import { PaymentService } from './payments.service';

@Module({
  imports: [LedgerModule],
  controllers: [PaymentsController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentsModule {}
