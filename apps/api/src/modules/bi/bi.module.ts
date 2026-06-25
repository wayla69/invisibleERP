import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { FinanceModule } from '../finance/finance.module';
import { EamModule } from '../eam/eam.module';
import { LedgerModule } from '../ledger/ledger.module';
import { BiService } from './bi.service';
import { BiController } from './bi.controller';

// MessagingModule supplies MessagingService for scheduled-report email delivery (Phase 4). FinanceModule
// (CollectionsService), EamModule (EamService) and LedgerModule (LedgerService) supply the scheduled
// ar_collections_dunning, eam_pm_generate and gl_recurring_journals action jobs. DRIZZLE is global.
@Module({ imports: [MessagingModule, FinanceModule, EamModule, LedgerModule], providers: [BiService], controllers: [BiController], exports: [BiService] })
export class BiModule {}
