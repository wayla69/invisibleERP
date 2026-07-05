import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { CpqService } from './cpq.service';
import { CpqController } from './cpq.controller';
import { QuotePdfService } from './quote-pdf.service';

@Module({ imports: [LedgerModule], providers: [CpqService, QuotePdfService], controllers: [CpqController], exports: [CpqService] })
export class CpqModule {}
