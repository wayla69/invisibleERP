import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RevenueModule } from '../revenue/revenue.module';
import { RevModificationService } from './rev-modification.service';
import { RevModificationController } from './rev-modification.controller';

// Track D — Wave 3 (REV-26): contract modifications (TFRS 15 / IFRS 15 / ASC 606 §18-21). Extends the REV-19
// recognition engine (RevenueModule exports RevRecService, REUSED for create/allocate/schedule/sumRecognized).
// LedgerModule for the cumulative-catch-up GL post.
@Module({
  imports: [LedgerModule, RevenueModule],
  controllers: [RevModificationController],
  providers: [RevModificationService],
  exports: [RevModificationService],
})
export class RevModificationModule {}
