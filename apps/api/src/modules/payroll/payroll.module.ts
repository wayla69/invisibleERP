import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';

// Payroll (เงินเดือน) — employees, monthly run with SSO + PIT withholding, balanced GL posting, ภ.ง.ด.1.
// LedgerModule provides LedgerService for the payroll journal entry.
@Module({
  imports: [LedgerModule],
  controllers: [PayrollController],
  providers: [PayrollService],
})
export class PayrollModule {}
