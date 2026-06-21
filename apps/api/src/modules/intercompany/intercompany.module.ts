import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { IntercompanyService } from './intercompany.service';
import { IntercompanyController } from './intercompany.controller';

// Intercompany. DocNumberService + DRIZZLE are global; LedgerService posts the two mirrored legs.
@Module({
  imports: [LedgerModule],
  controllers: [IntercompanyController],
  providers: [IntercompanyService],
  exports: [IntercompanyService],
})
export class IntercompanyModule {}
