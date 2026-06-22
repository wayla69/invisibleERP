import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { ServiceService } from './service.service';
import { ServiceController } from './service.controller';

@Module({ imports: [LedgerModule], providers: [ServiceService], controllers: [ServiceController], exports: [ServiceService] })
export class ServiceModule {}
