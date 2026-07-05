import { Module } from '@nestjs/common';
import { RfqController } from './rfq.controller';
import { RfqService } from './rfq.service';
import { RfqPdfService } from './rfq-pdf.service';
import { ProcurementModule } from '../procurement/procurement.module';

// RFQ / sourcing — award delegates to ProcurementService.createPo (imported from ProcurementModule).
@Module({
  imports: [ProcurementModule],
  controllers: [RfqController],
  providers: [RfqService, RfqPdfService],
})
export class SourcingModule {}
