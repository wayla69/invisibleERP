import { Module } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { MessagingController } from './messaging.controller';

// CRM customer messaging (LINE / SMS / email) — provider-agnostic, mock by default. DRIZZLE is global.
@Module({
  controllers: [MessagingController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
