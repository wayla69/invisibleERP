import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { FinanceModule } from '../finance/finance.module';
import { BiService } from './bi.service';
import { BiController } from './bi.controller';

// MessagingModule supplies MessagingService for scheduled-report email delivery (Phase 4). FinanceModule
// supplies CollectionsService for the scheduled ar_collections_dunning job. DRIZZLE is global.
@Module({ imports: [MessagingModule, FinanceModule], providers: [BiService], controllers: [BiController], exports: [BiService] })
export class BiModule {}
