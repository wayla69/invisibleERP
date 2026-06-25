import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsController } from './payments.controller';
import { PaymentService } from './payments.service';
import { PosAuditModule } from '../pos-audit/pos-audit.module';
import { PosFiscalModule } from '../pos-fiscal/pos-fiscal.module';
import { QrModule } from '../qr/qr.module';

@Module({
  imports: [LedgerModule, PosAuditModule, PosFiscalModule, QrModule],
  controllers: [PaymentsController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentsModule {}
