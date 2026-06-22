import { Module } from '@nestjs/common';
import { MasterDataService } from './masterdata.service';
import { MasterDataController } from './masterdata.controller';

@Module({
  controllers: [MasterDataController],
  providers: [MasterDataService],
  exports: [MasterDataService],
})
export class MasterDataModule {}
