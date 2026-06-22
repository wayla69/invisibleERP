import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsController } from './payments.controller';
import { PaymentService } from './payments.service';
import { PosAuditModule } from '../pos-audit/pos-audit.module';
import { PosFiscalModule } from '../pos-fiscal/pos-fiscal.module';

@Module({
  imports: [LedgerModule, PosAuditModule, PosFiscalModule],
  controllers: [PaymentsController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentsModule {}
