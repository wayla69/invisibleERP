import { Module } from '@nestjs/common';
import { TaxUtpService } from './tax-utp.service';
import { TaxUtpController } from './tax-utp.controller';
import { LedgerModule } from '../ledger/ledger.module';

// TAX-12 — DTA valuation allowance (posts the contra-DTA to 1700/5950 via LedgerService) + Uncertain Tax
// Positions (FIN 48) memo register. DocNumberService comes from the global CommonModule; DRIZZLE is global.
@Module({
  imports: [LedgerModule],
  controllers: [TaxUtpController],
  providers: [TaxUtpService],
  exports: [TaxUtpService],
})
export class TaxUtpModule {}
