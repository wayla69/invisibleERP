import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { DocumentTemplatesModule } from '../document-templates/document-templates.module';
import { CpqService } from './cpq.service';
import { CpqController } from './cpq.controller';
import { QuotePdfService } from './quote-pdf.service';

@Module({ imports: [LedgerModule, DocumentTemplatesModule], providers: [CpqService, QuotePdfService], controllers: [CpqController], exports: [CpqService] })
export class CpqModule {}
