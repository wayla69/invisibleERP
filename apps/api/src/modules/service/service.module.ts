import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { ServiceService } from './service.service';
import { ServiceController } from './service.controller';
import { ContractRenewalService } from './contract-renewal.service';
import { ContractRenewalController } from './contract-renewal.controller';

@Module({
  imports: [LedgerModule],
  providers: [ServiceService, ContractRenewalService],
  controllers: [ServiceController, ContractRenewalController],
  exports: [ServiceService, ContractRenewalService],
})
export class ServiceModule {}
