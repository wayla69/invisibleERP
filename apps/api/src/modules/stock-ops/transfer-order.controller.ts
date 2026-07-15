import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { TransferOrderService } from './transfer-order.service';
import { qint } from '../../common/query';

const CreateBody = z.object({
  from_location: z.string().min(1),
  to_location: z.string().min(1),
  remarks: z.string().optional(),
  lines: z.array(z.object({
    item_id: z.string().min(1),
    item_description: z.string().optional(),
    uom: z.string().optional(),
    qty: z.number().positive(),
  })).min(1),
});
type CreateBodyT = z.infer<typeof CreateBody>;

// Inter-warehouse/branch transfer orders (INV-2, INV-16) — a two-step ship→receive move with in-transit
// ownership + GL (Dr 1255 on ship / Cr 1255 on receive). Custody duty (wh_custody), mirroring the instant
// stock-ops transfer; SoD (INV-16) rejects a receiver who is also the shipper (SOD_SELF_APPROVAL).
@Controller('api/stock-ops/transfer-orders')
@Permissions('wh_custody')
export class TransferOrderController {
  constructor(private readonly svc: TransferOrderService) {}

  @Post() create(@Body(new ZodValidationPipe(CreateBody)) b: CreateBodyT, @CurrentUser() u: JwtUser) { return this.svc.create(b, u); }
  @Get() list(@CurrentUser() u: JwtUser, @Query('status') status?: string, @Query('limit') limit?: string) { return this.svc.list(u, status, qint('limit', limit, 100)); }

  // Period-end cutoff / in-transit aging report (declared before :no; also visible to dashboard/exec reviewers).
  @Get('in-transit/aging')
  @Permissions('wh_custody', 'dashboard', 'exec')
  aging(@CurrentUser() u: JwtUser, @Query('as_of') asOf?: string) { return this.svc.inTransitAging(u, asOf); }

  @Get(':no') detail(@Param('no') no: string, @CurrentUser() u: JwtUser) { return this.svc.get(no, u); }
  @Post(':no/ship') ship(@Param('no') no: string, @CurrentUser() u: JwtUser) { return this.svc.ship(no, u); }
  @Post(':no/receive') receive(@Param('no') no: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) { return this.svc.receive(no, u, b?.self_approval_reason); }
}
