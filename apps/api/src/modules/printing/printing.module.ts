import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { ReceiptService } from './receipt.service';
import { PrintService } from './print.service';
import { PrintController } from './print.controller';

// Phase 4 — Receipts & printing: server-rendered receipts (HTML + ESC/POS) + a pull-based print-job queue,
// out-of-band receipt delivery (via MessagingModule), and the receipt↔fiscal tie-out control. DRIZZLE is global.
@Module({
  imports: [MessagingModule],
  controllers: [PrintController],
  providers: [ReceiptService, PrintService],
  exports: [PrintService, ReceiptService],
})
export class PrintingModule {}
