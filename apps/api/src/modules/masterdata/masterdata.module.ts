import { Module } from '@nestjs/common';
import { MasterDataService } from './masterdata.service';
import { MasterDataController } from './masterdata.controller';
import { MasterdataChangeService } from './masterdata-change.service';
import { MasterdataChangeController } from './masterdata-change.controller';

@Module({
  controllers: [MasterDataController, MasterdataChangeController],
  providers: [MasterDataService, MasterdataChangeService],
  exports: [MasterDataService, MasterdataChangeService],
})
export class MasterDataModule {}
