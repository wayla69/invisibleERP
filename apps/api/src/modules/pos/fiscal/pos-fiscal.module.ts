import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { EtaxService } from './etax.service';
import { JournalController, EtaxController } from './pos-fiscal.controller';
import { UsageModule } from '../../usage/usage.module';

@Module({
  imports: [UsageModule],
  controllers: [JournalController, EtaxController],
  providers: [JournalService, EtaxService],
  exports: [JournalService, EtaxService],
})
export class PosFiscalModule {}
