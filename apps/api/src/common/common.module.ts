import { Global, Module } from '@nestjs/common';
import { DocNumberService } from './doc-number.service';
import { StatusLogService } from './status-log.service';
import { WebhookIdempotencyService } from './webhook-idempotency.service';

@Global()
@Module({
  providers: [DocNumberService, StatusLogService, WebhookIdempotencyService],
  exports: [DocNumberService, StatusLogService, WebhookIdempotencyService],
})
export class CommonModule {}
