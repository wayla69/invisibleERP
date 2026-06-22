import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ClaimsService } from './claims.service';

const DecideBody = z.object({ decision: z.enum(['approve', 'reject']), reject_reason: z.string().optional() });
const GrClaimBody = z.object({
  gr_no: z.string().optional(), po_no: z.string().optional(), vendor_id: z.number().optional(),
  item_id: z.string().optional(), item_description: z.string().optional(), gr_qty: z.number().optional(), claim_qty: z.number().optional(),
  uom: z.string().optional(), reason: z.string().optional(),
});
const ResolveBody = z.object({ status: z.enum(['Resolved', 'Rejected']), resolution: z.string().optional() });

@Controller('api/claims')
@Permissions('claim_mgt', 'procurement')
export class ClaimsController {
  constructor(private readonly svc: ClaimsService) {}

  // Sales claims
  @Get('sales') @Permissions('claim_mgt') listSales(@Query('status') status?: string) { return this.svc.listSalesClaims(status); }
  @Patch('sales/:id') @Permissions('claim_mgt')
  decide(@Param('id') id: string, @Body(new ZodValidationPipe(DecideBody)) b: z.infer<typeof DecideBody>, @CurrentUser() u: JwtUser) {
    return this.svc.decideSalesClaim(+id, b.decision, b.reject_reason, u);
  }

  // GR / supplier claims
  @Post('gr') @Permissions('procurement') createGr(@Body(new ZodValidationPipe(GrClaimBody)) b: z.infer<typeof GrClaimBody>, @CurrentUser() u: JwtUser) { return this.svc.createGrClaim(b, u); }
  @Get('gr') @Permissions('procurement') listGr(@Query('status') status?: string) { return this.svc.listGrClaims(status); }
  @Patch('gr/:claimNo') @Permissions('procurement')
  resolveGr(@Param('claimNo') no: string, @Body(new ZodValidationPipe(ResolveBody)) b: z.infer<typeof ResolveBody>, @CurrentUser() u: JwtUser) {
    return this.svc.resolveGrClaim(no, b.status, b.resolution, u);
  }
}
