import { Module } from '@nestjs/common';
import { DebtController } from './debt.controller';
import { DebtService } from './debt.service';
import { LedgerModule } from '../ledger/ledger.module';

// Debt & Borrowings register (Track C Wave 1) — TRE-01 facility/drawdown maker-checker + idempotent EIR
// amortized-cost accrual, TRE-02 covenant-breach monitor. Depends on LedgerModule for postEntry (drawdown
// Dr 1010 / Cr 2500|2550, EIR accrual Dr 5900 / Cr 2450, repayment) + alreadyPosted (accrual idempotency).
// DRIZZLE + DocNumberService are global. Kept in its own dir (outside the unit-coverage glob).
@Module({
  imports: [LedgerModule],
  controllers: [DebtController],
  providers: [DebtService],
  exports: [DebtService],
})
export class TreasuryDebtModule {}
