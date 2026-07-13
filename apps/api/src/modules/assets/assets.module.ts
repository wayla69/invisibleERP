import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { QrModule } from '../qr/qr.module';
import { AssetsService } from './assets.service';
import { AssetsController } from './assets.controller';
import { AssetsBiReports } from './assets-bi-reports';
import { AssetsApprovalQueues } from './assets-approval-queues';

// Fixed Assets (FI-AA): acquisition / monthly depreciation / disposal, all posting to the GL.
// DocNumberService + DRIZZLE are global (CommonModule / DatabaseModule).
@Module({
  imports: [LedgerModule, QrModule],
  controllers: [AssetsController],
  providers: [AssetsApprovalQueues, AssetsBiReports, AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
