import { Controller, Get, Post, Patch, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PeripheralsService } from './peripherals.service';

const DeviceBody = z.object({ device_code: z.string().min(1), kind: z.enum(['printer', 'cash_drawer', 'display', 'scale']), terminal: z.string().optional(), printer_id: z.string().optional(), config: z.any().optional() });
const KickBody = z.object({ terminal: z.string().optional(), reason: z.enum(['sale', 'no_sale', 'refund', 'paid_in', 'paid_out', 'manual']).optional(), sale_no: z.string().optional(), amount: z.number().nonnegative().optional(), printer_id: z.string().optional() });
const DisplayBody = z.object({ message: z.string().optional(), lines: z.array(z.object({ name: z.string(), qty: z.number().optional(), amount: z.number().optional() })).optional(), subtotal: z.number().optional(), total: z.number().optional(), amount_due: z.number().optional(), change: z.number().optional() });
const ScaleBody = z.object({ sku: z.string().min(1), gross_weight: z.number().positive(), tare_weight: z.number().nonnegative().optional(), terminal: z.string().optional(), device_code: z.string().optional(), sale_no: z.string().optional(), order_no: z.string().optional() });
const WeighedBody = z.object({ sold_by_weight: z.boolean(), weight_unit: z.enum(['kg', 'g']).optional() });

@Controller('api/peripherals')
@Permissions('pos')
export class PeripheralsController {
  constructor(private readonly svc: PeripheralsService) {}

  // device registry
  @Post('devices') @Permissions('pos', 'order_mgt', 'masterdata') register(@Body(new ZodValidationPipe(DeviceBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.registerDevice(b, u); }
  @Get('devices') devices(@CurrentUser() u: JwtUser) { return this.svc.listDevices(u); }
  @Post('devices/:code/heartbeat') heartbeat(@Param('code') c: string, @CurrentUser() u: JwtUser) { return this.svc.heartbeat(c, u); }

  // cash drawer
  @Post('drawer/kick') kick(@Body(new ZodValidationPipe(KickBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.kickDrawer(b, u); }
  @Get('drawer/events') events(@Query('reason') r: string | undefined, @Query('limit') l: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.drawerEventsList(u, { reason: r || undefined, limit: l ? +l : 100 }); }
  @Get('drawer/reconciliation') recon(@Query('since') s: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.drawerReconciliation(u, s || undefined); }

  // customer-facing display
  @Post('display/:terminal') setDisplay(@Param('terminal') t: string, @Body(new ZodValidationPipe(DisplayBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setDisplay(t, b, u); }
  @Get('display/:terminal') getDisplay(@Param('terminal') t: string, @CurrentUser() u: JwtUser) { return this.svc.getDisplay(t, u); }

  // weighing scale
  @Post('scale/read') read(@Body(new ZodValidationPipe(ScaleBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.readScale(b, u); }
  @Patch('scale/items/:sku') @Permissions('pos', 'order_mgt', 'masterdata') weighed(@Param('sku') s: string, @Body(new ZodValidationPipe(WeighedBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setWeighed(s, b, u); }
}
