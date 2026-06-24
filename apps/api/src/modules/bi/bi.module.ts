import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { FinanceModule } from '../finance/finance.module';
import { EamModule } from '../eam/eam.module';
import { BiService } from './bi.service';
import { BiController } from './bi.controller';

// MessagingModule supplies MessagingService for scheduled-report email delivery (Phase 4). FinanceModule
// (CollectionsService) and EamModule (EamService) supply the scheduled ar_collections_dunning and
// eam_pm_generate action jobs. DRIZZLE is global.
@Module({ imports: [MessagingModule, FinanceModule, EamModule], providers: [BiService], controllers: [BiController], exports: [BiService] })
export class BiModule {}
