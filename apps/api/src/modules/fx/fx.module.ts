import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { FxService } from './fx.service';
import { FxController } from './fx.controller';

// FX revaluation. DRIZZLE is global; LedgerService for the revaluation GL postings.
@Module({
  imports: [LedgerModule],
  controllers: [FxController],
  providers: [FxService],
  exports: [FxService],
})
export class FxModule {}
