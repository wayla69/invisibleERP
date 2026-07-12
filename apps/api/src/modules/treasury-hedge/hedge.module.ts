import { Module } from '@nestjs/common';
import { HedgeController } from './hedge.controller';
import { HedgeService } from './hedge.service';
import { LedgerModule } from '../ledger/ledger.module';

// Hedge accounting register (Track C Wave 3) — control TRE-04 (IFRS 9 / TFRS 9 · ASC 815; designation +
// effectiveness + valuation maker-checker). Depends on LedgerModule for postEntry (derivative FV change Dr 1380 /
// Cr 2460; CF-hedge effective portion → OCI reserve 3550, ineffective → P&L 5450; FV-hedge basis-adjusts the
// hedged item + P&L 5450; reclassification Dr 3550 / Cr the hedged-item revenue line). DRIZZLE + DocNumberService
// are global. Own dir (outside the unit-coverage glob; harness-tested by cutover/treasury-hedge).
@Module({
  imports: [LedgerModule],
  controllers: [HedgeController],
  providers: [HedgeService],
  exports: [HedgeService],
})
export class TreasuryHedgeModule {}
