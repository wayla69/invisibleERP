import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { PettyCashService } from './petty-cash.service';
import { PettyCashController } from './petty-cash.controller';

// Petty cash imprest float + direct-expense / advance maker-checker (EXP-08). DocNumberService +
// StatusLogService + DRIZZLE are global (CommonModule / DatabaseModule); LedgerService posts the GL.
@Module({
  imports: [LedgerModule],
  controllers: [PettyCashController],
  providers: [PettyCashService],
  exports: [PettyCashService],
})
export class PettyCashModule {}
