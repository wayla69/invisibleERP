import { Controller, Get, Post, Put, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { LoyaltyTierService } from './loyalty-tier.service';
import { HouseAccountService } from './house-account.service';
import { GiftCardExtraService } from './giftcard-extra.service';
import { TimeClockService } from './timeclock.service';
import { ScheduleService, type CreateShiftDto } from './schedule.service';
import { qint, qintOpt } from '../../../common/query';

const TierBody = z.object({ id: z.number().optional(), tier: z.string().min(1), min_lifetime: z.number().optional(), earn_mult: z.number().optional(), redeem_mult: z.number().optional() });
const HouseBody = z.object({ sale_no: z.string().min(1), amount: z.number().positive(), due_date: z.string().optional() });
const PinBody = z.object({ pin: z.string().min(1) });
const ReloadBody = z.object({ amount: z.number().positive(), pin: z.string().optional() });
const ClockBody = z.object({ emp_code: z.string().min(1), break_minutes: z.number().int().optional() });
const ClockInBody = z.object({ emp_code: z.string().min(1), method: z.enum(['PIN', 'QR', 'FACE_HASH']).optional(), lat: z.number().optional(), lng: z.number().optional(), branch_id: z.number().int().optional() });
const OverrideBody = z.object({ emp_code: z.string().min(1), reason: z.string().min(1) });
const ZoneBody = z.object({ branch_id: z.number().int().optional(), lat: z.number(), lng: z.number(), radius_m: z.number().int().positive().optional() });
const ShiftBody = z.object({ emp_code: z.string().min(1), shift_date: z.string().min(8), start_time: z.string().min(4), end_time: z.string().min(4), hourly_rate: z.number().nonnegative().optional(), position: z.string().max(60).optional(), notes: z.string().max(300).optional() });
const OT_TYPES = ['REGULAR_OT', 'HOLIDAY', 'HOLIDAY_OT', 'NIGHT'] as const;
const OtRuleBody = z.object({ rule_type: z.enum(OT_TYPES), multiplier: z.number().min(1).max(5), daily_trigger_hours: z.number().int().optional(), weekly_trigger_hours: z.number().int().optional() });
const OtPayBody = z.object({ rule_type: z.enum(OT_TYPES).optional(), ot_hours: z.number().nonnegative(), hourly_rate: z.number().nonnegative(), week_hours_already: z.number().nonnegative().optional() });
const AlertCheckBody = z.object({ from: z.string().min(8), to: z.string().min(8), threshold: z.number().optional(), branch_id: z.number().int().optional() });

@Controller('api/loyalty')
@Permissions('loyalty', 'marketing', 'pos', 'exec')
export class LoyaltyTierController {
  constructor(private readonly svc: LoyaltyTierService) {}
  @Get('tiers') tiers() { return this.svc.listTiers(); }
  @Post('tiers') upsert(@Body(new ZodValidationPipe(TierBody)) b: z.infer<typeof TierBody>, @CurrentUser() u: JwtUser) { return this.svc.upsertTier(b, u); }
  @Get('members/:id/earn-quote') earnQuote(@Param('id') id: string, @Query('spend') spend?: string) { return this.svc.quoteEarn(+id, qint('spend', spend, 0)); }
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
  constructor(private readonly svc: TimeClockService, private readonly schedule: ScheduleService) {}
  @Post('clock-in') clockIn(@Body(new ZodValidationPipe(ClockInBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.clockIn(b.emp_code, u, { method: b.method, lat: b.lat, lng: b.lng, branch_id: b.branch_id }); }
  @Post('clock-out') clockOut(@Body(new ZodValidationPipe(ClockBody)) b: z.infer<typeof ClockBody>) { return this.svc.clockOut(b.emp_code, b.break_minutes); }
  @Get('report') report() { return this.svc.report(); }
  @Get('productivity') productivity(@Query('date') date?: string) { return this.svc.productivity(date); }
  // Step 9 — clock-in integrity: supervisor override + geofence zone config
  @Post('clock-in/override') clockOverride(@Body(new ZodValidationPipe(OverrideBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.supervisorOverride(b.emp_code, b.reason, u); }
  @Get('geofence-zones') listZones(@CurrentUser() u: JwtUser) { return this.svc.listGeofenceZones(u); }
  @Put('geofence-zones') setZone(@Body(new ZodValidationPipe(ZoneBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setGeofenceZone(b, u); }

  // W4 — shift scheduling / roster + labor %
  @Post('shifts') createShift(@Body(new ZodValidationPipe(ShiftBody)) b: CreateShiftDto, @CurrentUser() u: JwtUser) { return this.schedule.createShift(b, u); }
  @Get('shifts') listShifts(@Query('from') from: string | undefined, @Query('to') to: string | undefined, @CurrentUser() u: JwtUser) { return this.schedule.list({ from, to }, u); }
  @Post('shifts/:id/cancel') cancelShift(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.schedule.cancelShift(+id, u); }
  @Get('labor-summary') laborSummary(@Query('from') from: string, @Query('to') to: string, @CurrentUser() u: JwtUser) { return this.schedule.laborSummary({ from, to }, u); }

  // Step 8 — tiered OT rules (Thai LPA) + labor-% alerts
  @Get('ot-rules') getOtRules(@CurrentUser() u: JwtUser) { return this.schedule.getOtRules(u); }
  @Put('ot-rules') upsertOtRule(@Body(new ZodValidationPipe(OtRuleBody)) b: any, @CurrentUser() u: JwtUser) { return this.schedule.upsertOtRule(b, u); }
  @Post('ot-pay') otPay(@Body(new ZodValidationPipe(OtPayBody)) b: any, @CurrentUser() u: JwtUser) { return this.schedule.computeOtPay(b, u); }
  @Post('labor-alert/check') checkAlert(@Body(new ZodValidationPipe(AlertCheckBody)) b: any, @CurrentUser() u: JwtUser) { return this.schedule.checkLaborAlert(b, u); }
  @Get('alerts') listAlerts(@Query('resolved') resolved: string | undefined, @CurrentUser() u: JwtUser) { return this.schedule.listAlerts(u, { resolved: resolved == null ? undefined : resolved === 'true' }); }
  @Post('alerts/:id/resolve') resolveAlert(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.schedule.resolveAlert(+id, u); }
}
