import { Module } from '@nestjs/common';
import { InvestmentController } from './investment.controller';
import { InvestmentService } from './investment.service';
import { LedgerModule } from '../ledger/ledger.module';

// Investment & Securities register (Track C Wave 2) — control TRE-03 (classification + valuation maker-checker;
// MTM only from Approved prices). Depends on LedgerModule for postEntry (buy Dr 1350|1360|1370 / Cr 1010; FVOCI
// MTM → OCI reserve 3500; FVTPL MTM → P&L 5430; interest/dividend → 4700; ECL Dr 5440 / Cr 1355) + alreadyPosted
// (MTM/ECL/accrual idempotency). DRIZZLE + DocNumberService are global. Own dir (outside the unit-coverage glob).
@Module({
  imports: [LedgerModule],
  controllers: [InvestmentController],
  providers: [InvestmentService],
  exports: [InvestmentService],
})
export class TreasuryInvestModule {}
