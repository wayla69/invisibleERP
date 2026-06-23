import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxModule } from '../tax/tax.module';
import { PaymentsDepthService } from './payments-depth.service';
import { PaymentsDepthController } from './payments-depth.controller';

// Phase 8 — payments depth: customer deposits, house/charge accounts (credit + FX settlement) and card
// surcharge. Each movement posts its own balanced JE via LedgerService. DRIZZLE + DocNumberService are global.
@Module({
  imports: [LedgerModule, TaxModule],
  controllers: [PaymentsDepthController],
  providers: [PaymentsDepthService],
  exports: [PaymentsDepthService],
})
export class PaymentsDepthModule {}
