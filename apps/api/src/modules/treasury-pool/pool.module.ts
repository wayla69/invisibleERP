import { Module } from '@nestjs/common';
import { PoolController } from './pool.controller';
import { PoolService } from './pool.service';
import { LedgerModule } from '../ledger/ledger.module';

// Cash pooling / in-house bank / intercompany-loan register (Track C Wave 4) — control TRE-05. Depends on
// LedgerModule for postEntry (IC-loan drawdown Dr 1155 / Cr 1010 creditor + Dr 1010 / Cr 2155 debtor; EIR
// interest Dr 1155 / Cr 4700 creditor + Dr 5900 / Cr 2155 debtor; physical sweep Dr header / Cr member; notional
// interest allocation zero-sum). The consolidation-elimination integrity of the 1155/2155 pair + the 4700/5900
// IC interest is the control core (extended in consolidation.service). DRIZZLE + DocNumberService are global.
// Own dir (outside the unit-coverage glob; harness-tested by cutover/treasury-pool).
@Module({
  imports: [LedgerModule],
  controllers: [PoolController],
  providers: [PoolService],
  exports: [PoolService],
})
export class TreasuryPoolModule {}
