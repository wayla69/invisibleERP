import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { CpqService } from './cpq.service';
import { CpqController } from './cpq.controller';

@Module({ imports: [LedgerModule], providers: [CpqService], controllers: [CpqController], exports: [CpqService] })
export class CpqModule {}
