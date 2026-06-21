import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { GiftCardService } from './gift-card.service';
import { GiftCardController } from './gift-card.controller';

@Module({
  imports: [LedgerModule],
  controllers: [GiftCardController],
  providers: [GiftCardService],
  exports: [GiftCardService],
})
export class GiftCardsModule {}
