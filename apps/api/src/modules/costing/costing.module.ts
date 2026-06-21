import { Module } from '@nestjs/common';
import { CostingController } from './costing.controller';
import { CostingService } from './costing.service';
import { AtpService } from './atp.service';
import { LedgerModule } from '../ledger/ledger.module';

// Inventory costing (FIFO/AVG/STD) + valuation + ATP. Exported so GR/sale/return paths can opt in.
@Module({
  imports: [LedgerModule],
  controllers: [CostingController],
  providers: [CostingService, AtpService],
  exports: [CostingService, AtpService],
})
export class CostingModule {}
