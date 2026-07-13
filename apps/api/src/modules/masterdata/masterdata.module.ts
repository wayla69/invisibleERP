import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { MasterDataService } from './masterdata.service';
import { MasterDataController } from './masterdata.controller';
import { MasterdataChangeService } from './masterdata-change.service';
import { MasterdataChangeController } from './masterdata-change.controller';
import { MasterdataApprovalQueues } from './masterdata-approval-queues';

@Module({
  imports: [LedgerModule],
  controllers: [MasterDataController, MasterdataChangeController],
  providers: [MasterdataApprovalQueues, MasterDataService, MasterdataChangeService],
  exports: [MasterDataService, MasterdataChangeService],
})
export class MasterDataModule {}
