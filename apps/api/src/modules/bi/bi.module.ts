import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { BiService } from './bi.service';
import { BiController } from './bi.controller';

// MessagingModule supplies MessagingService for scheduled-report email delivery (Phase 4). DRIZZLE is global.
@Module({ imports: [MessagingModule], providers: [BiService], controllers: [BiController], exports: [BiService] })
export class BiModule {}
