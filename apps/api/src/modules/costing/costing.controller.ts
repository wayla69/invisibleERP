import { Controller, Get, Put, Post, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CostingService } from './costing.service';
import { AtpService } from './atp.service';

const ConfigBody = z.object({ item_id: z.string().nullable().optional(), method: z.enum(['FIFO', 'AVG', 'STD']), standard_cost: z.number().nonnegative().nullable().optional() });
const CheckBody = z.object({ item_id: z.string().min(1), qty: z.number().positive(), date: z.string().min(1) });
const AllocBody = z.object({ item_id: z.string().min(1), qty: z.number().positive(), ref_doc: z.string().min(1), need_by: z.string().optional() });

@Controller('api/costing')
export class CostingController {
  constructor(private readonly costing: CostingService, private readonly atp: AtpService) {}

  @Put('config') @Permissions('masterdata')
  setMethod(@Body(new ZodValidationPipe(ConfigBody)) b: any, @CurrentUser() u: JwtUser) { return this.costing.setMethod(u.tenantId as number, b.item_id ?? null, b.method, b.standard_cost ?? null, u); }
  @Get('config') @Permissions('planner', 'procurement', 'masterdata')
  listConfig(@CurrentUser() u: JwtUser) { return this.costing.listConfig(u); }
  @Get('valuation') @Permissions('exec', 'planner')
  valuation(@CurrentUser() u: JwtUser) { return this.costing.valuation(u.tenantId as number); }

  @Get('atp') @Permissions('cust_inventory', 'planner', 'pos', 'procurement')
  atpGet(@Query('item_id') itemId: string, @Query('need_by') needBy: string, @CurrentUser() u: JwtUser) { return this.atp.atp(u.tenantId as number, itemId, needBy); }
  @Post('atp/check') @Permissions('cust_pos', 'order_cust', 'planner', 'pos')
  check(@Body(new ZodValidationPipe(CheckBody)) b: any, @CurrentUser() u: JwtUser) { return this.atp.canPromise(u.tenantId as number, b.item_id, b.qty, b.date); }
  @Post('allocate') @Permissions('cust_pos', 'planner', 'pos')
  allocate(@Body(new ZodValidationPipe(AllocBody)) b: any, @CurrentUser() u: JwtUser) { return this.atp.allocate(u.tenantId as number, b.item_id, b.qty, b.ref_doc, b.need_by, u); }
}
