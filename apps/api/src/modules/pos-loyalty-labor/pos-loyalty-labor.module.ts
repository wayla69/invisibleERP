import { Module } from '@nestjs/common';
import { LoyaltyTierService } from './loyalty-tier.service';
import { HouseAccountService } from './house-account.service';
import { GiftCardExtraService } from './giftcard-extra.service';
import { TimeClockService } from './timeclock.service';
import { LoyaltyTierController, PosBillingController, LaborController } from './pos-loyalty-labor.controller';

@Module({
  controllers: [LoyaltyTierController, PosBillingController, LaborController],
  providers: [LoyaltyTierService, HouseAccountService, GiftCardExtraService, TimeClockService],
  exports: [LoyaltyTierService, HouseAccountService, GiftCardExtraService, TimeClockService],
})
export class PosLoyaltyLaborModule {}
