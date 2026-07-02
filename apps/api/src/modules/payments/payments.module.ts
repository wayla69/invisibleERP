import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsController } from './payments.controller';
import { PaymentService } from './payments.service';
import { PosAuditModule } from '../pos-audit/pos-audit.module';
import { PosFiscalModule } from '../pos-fiscal/pos-fiscal.module';
import { QrModule } from '../qr/qr.module';
import { PaymentsDepthModule } from './depth/payments-depth.module';

// Payments is the ONE owning module for the payment domain (docs/28 consolidation PR #1):
// the former standalone payments-depth (deposits, house accounts, surcharge — a phase name, not a
// boundary) now lives under ./depth and is imported + re-exported here. Routes, permissions and GL
// postings are unchanged — a folder move with an umbrella import, nothing else.
@Module({
  imports: [LedgerModule, PosAuditModule, PosFiscalModule, QrModule, PaymentsDepthModule],
  controllers: [PaymentsController],
  providers: [PaymentService],
  exports: [PaymentService, PaymentsDepthModule],
})
export class PaymentsModule {}
