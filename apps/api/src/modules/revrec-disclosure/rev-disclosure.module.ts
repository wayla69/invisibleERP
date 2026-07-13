import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RevFinancingService } from './rev-financing.service';
import { RevDisclosureService } from './rev-disclosure.service';
import { RevDisclosureController } from './rev-disclosure.controller';
import { RevDisclosureBiReports } from './rev-disclosure-bi-reports';

// Track D — Wave 4 (REV-27, FINAL): significant financing component (TFRS 15 / IFRS 15 / ASC 606 §60-65) +
// revenue disclosure pack (§120). Extends the REV-19 recognition engine + Wave 1 billing (contract asset 1265
// / liability 2410 balances feed the rollforward). LedgerModule for the financing-component GL post. The
// disclosure aggregators are read-only over the GL + the recognition schedule (no new table). Exported so the
// BI report scheduler can wire the two disclosure report types (contract_liability_rollforward / rpo_backlog).
@Module({
  imports: [LedgerModule],
  controllers: [RevDisclosureController],
  providers: [RevDisclosureBiReports, RevFinancingService, RevDisclosureService],
  exports: [RevFinancingService, RevDisclosureService],
})
export class RevDisclosureModule {}
