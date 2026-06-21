import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RevenueService } from './revenue.service';
import { RevenueController } from './revenue.controller';

// Revenue recognition / deferred revenue. DocNumberService + DRIZZLE are global; LedgerService for GL.
@Module({
  imports: [LedgerModule],
  controllers: [RevenueController],
  providers: [RevenueService],
  exports: [RevenueService],
})
export class RevenueModule {}
