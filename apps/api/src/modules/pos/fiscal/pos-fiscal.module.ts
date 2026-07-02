import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { EtaxService } from './etax.service';
import { JournalController, EtaxController } from './pos-fiscal.controller';

@Module({
  controllers: [JournalController, EtaxController],
  providers: [JournalService, EtaxService],
  exports: [JournalService, EtaxService],
})
export class PosFiscalModule {}
