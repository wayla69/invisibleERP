import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { LoyaltyTierService } from './loyalty-tier.service';
import { HouseAccountService } from './house-account.service';
import { GiftCardExtraService } from './giftcard-extra.service';
import { TimeClockService } from './timeclock.service';

const TierBody = z.object({ id: z.number().optional(), tier: z.string().min(1), min_lifetime: z.number().optional(), earn_mult: z.number().optional(), redeem_mult: z.number().optional() });
const HouseBody = z.object({ sale_no: z.string().min(1), amount: z.number().positive(), due_date: z.string().optional() });
const PinBody = z.object({ pin: z.string().min(1) });
const ReloadBody = z.object({ amount: z.number().positive(), pin: z.string().optional() });
const ClockBody = z.object({ emp_code: z.string().min(1), break_minutes: z.number().int().optional() });

@Controller('api/loyalty')
@Permissions('loyalty', 'marketing', 'pos', 'exec')
export class LoyaltyTierController {
  constructor(private readonly svc: LoyaltyTierService) {}
  @Get('tiers') tiers() { return this.svc.listTiers(); }
  @Post('tiers') upsert(@Body(new ZodValidationPipe(TierBody)) b: z.infer<typeof TierBody>, @CurrentUser() u: JwtUser) { return this.svc.upsertTier(b, u); }
  @Get('members/:id/earn-quote') earnQuote(@Param('id') id: string, @Query('spend') spend?: string) { return this.svc.quoteEarn(+id, spend ? +spend : 0); }
  @Get('members/:id/redeemable') redeemable(@Param('id') id: string) { return this.svc.redeemable(+id); }
}

@Controller('api/pos')
@Permissions('pos', 'order_mgt', 'ar', 'exec')
export class PosBillingController {
  constructor(private readonly house: HouseAccountService, private readonly gift: GiftCardExtraService) {}
  @Post('house-account') charge(@Body(new ZodValidationPipe(HouseBody)) b: z.infer<typeof HouseBody>, @CurrentUser() u: JwtUser) { return this.house.charge(b, u); }
  @Get('house-account') open() { return this.house.openBalance(); }
  @Post('giftcards/:cardNo/pin') setPin(@Param('cardNo') c: string, @Body(new ZodValidationPipe(PinBody)) b: z.infer<typeof PinBody>) { return this.gift.setPin(c, b.pin); }
  @Post('giftcards/:cardNo/reload') reload(@Param('cardNo') c: string, @Body(new ZodValidationPipe(ReloadBody)) b: z.infer<typeof ReloadBody>, @CurrentUser() u: JwtUser) { return this.gift.reload(c, b.amount, b.pin, u); }
  @Get('giftcards/:cardNo/balance') bal(@Param('cardNo') c: string, @Query('pin') pin?: string) { return this.gift.balanceWithPin(c, pin); }
}

@Controller('api/pos/labor')
@Permissions('pos', 'users', 'exec')
export class LaborController {
  constructor(private readonly svc: TimeClockService) {}
  @Post('clock-in') clockIn(@Body(new ZodValidationPipe(ClockBody)) b: z.infer<typeof ClockBody>, @CurrentUser() u: JwtUser) { return this.svc.clockIn(b.emp_code, u); }
  @Post('clock-out') clockOut(@Body(new ZodValidationPipe(ClockBody)) b: z.infer<typeof ClockBody>) { return this.svc.clockOut(b.emp_code, b.break_minutes); }
  @Get('report') report() { return this.svc.report(); }
  @Get('productivity') productivity(@Query('date') date?: string) { return this.svc.productivity(date); }
}
