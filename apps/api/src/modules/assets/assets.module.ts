import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { AssetsService } from './assets.service';
import { AssetsController } from './assets.controller';

// Fixed Assets (FI-AA): acquisition / monthly depreciation / disposal, all posting to the GL.
// DocNumberService + DRIZZLE are global (CommonModule / DatabaseModule).
@Module({
  imports: [LedgerModule],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
