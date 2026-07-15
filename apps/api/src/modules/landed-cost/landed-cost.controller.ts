import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { LandedCostService } from './landed-cost.service';

const ChargeSchema = z.object({
  freight: z.number().nonnegative().optional(),
  duty: z.number().nonnegative().optional(),
  insurance: z.number().nonnegative().optional(),
  broker: z.number().nonnegative().optional(),
});
const LineSchema = z.object({
  gr_no: z.string().optional(),
  item_id: z.string().min(1),
  location_id: z.string().optional(),
  qty: z.number().positive(),
  weight: z.number().nonnegative().optional(),
  base_value: z.number().nonnegative().optional(),
});
const CreateBody = z.object({
  voucher_date: z.string().optional(),
  basis: z.enum(['value', 'qty', 'weight']).optional(),
  currency: z.string().optional(),
  charges: ChargeSchema.optional(),
  memo: z.string().optional(),
  lines: z.array(LineSchema).min(1),
});
type CreateBodyT = z.infer<typeof CreateBody>;

// INV-1 — Landed-cost allocation (COST-01). Create a voucher, preview the apportionment, and post it
// (maker-checker: poster ≠ preparer). Reads are open to procurement/warehouse/planner/finance duties;
// creating/allocating uses the receiving/procurement duties; posting (books GL) uses the GL-posting duty.
@Controller('api/costing/landed-cost')
export class LandedCostController {
  constructor(private readonly svc: LandedCostService) {}

  @Post()
  @Permissions('procurement', 'wh_receive', 'exec')
  create(@Body(new ZodValidationPipe(CreateBody)) b: CreateBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.create(b, u);
  }

  @Get()
  @Permissions('procurement', 'wh_receive', 'wh_count', 'planner', 'fin_report', 'exec')
  list(@CurrentUser() u: JwtUser) {
    return this.svc.get(u);
  }

  @Get(':no')
  @Permissions('procurement', 'wh_receive', 'wh_count', 'planner', 'fin_report', 'exec')
  get(@Param('no') no: string, @CurrentUser() u: JwtUser) {
    return this.svc.get(u, no);
  }

  @Post(':no/allocate')
  @HttpCode(200)
  @Permissions('procurement', 'wh_receive', 'exec')
  allocate(@Param('no') no: string, @CurrentUser() u: JwtUser) {
    return this.svc.allocate(no, u);
  }

  // Maker-checker: books the capitalisation GL + adjusts perpetual cost. Poster must differ from preparer.
  @Post(':no/post')
  @HttpCode(200)
  @Permissions('gl_post', 'exec')
  post(@Param('no') no: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.post(no, u, b?.self_approval_reason);
  }
}
