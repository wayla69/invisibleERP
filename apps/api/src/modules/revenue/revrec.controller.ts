import { Controller, Get, Post, Param, Query, Body, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RevRecService } from './revrec.service';

const PoSchema = z.object({
  name: z.string().min(1),
  ssp: z.number().nonnegative(),
  method: z.enum(['point_in_time', 'over_time']).optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});
const CreateContractBody = z.object({
  contract_no: z.string().optional(),
  customer_id: z.number().int().optional(),
  contract_date: z.string().optional(),
  currency: z.string().optional(),
  total_price: z.number().positive(),
  description: z.string().optional(),
  obligations: z.array(PoSchema).min(1),
});
type CreateContractBodyT = z.infer<typeof CreateContractBody>;

const RecognizeBody = z.object({ contract_id: z.number().int().optional(), period: z.string().regex(/^\d{4}-\d{2}$/) });
type RecognizeBodyT = z.infer<typeof RecognizeBody>;

const RefundBody = z.object({ expected_refund_rate: z.number().min(0).max(1), as_of_date: z.string().optional() });
type RefundBodyT = z.infer<typeof RefundBody>;

// TFRS 15 / IFRS 15 revenue recognition (REV-19). Deferred revenue (2410) released as POs are satisfied.
@Controller('api/revenue/contracts')
@Permissions('exec', 'ar', 'fin_report')
export class RevRecController {
  constructor(private readonly svc: RevRecService) {}

  @Post()
  create(@Body(new ZodValidationPipe(CreateContractBody)) b: CreateContractBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.createContract(b, u);
  }

  @Get()
  list(@CurrentUser() u: JwtUser) { return this.svc.listContracts(u); }

  // Static routes BEFORE the ':id' param route so 'recognize' isn't captured as an id.
  @Post('recognize')
  recognize(@Body(new ZodValidationPipe(RecognizeBody)) b: RecognizeBodyT, @Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.recognize({ contractId: b.contract_id, period: b.period }, u, tenantId != null && tenantId !== '' ? Number(tenantId) : null);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) { return this.svc.getContract(id); }

  @Post(':id/allocate')
  allocate(@Param('id', ParseIntPipe) id: number) { return this.svc.allocateBySSP(id); }

  @Post(':id/schedule')
  schedule(@Param('id', ParseIntPipe) id: number) { return this.svc.buildSchedule(id); }

  @Post(':id/activate')
  activate(@Param('id', ParseIntPipe) id: number, @Body() b: { date?: string }, @CurrentUser() u: JwtUser) {
    return this.svc.activate(id, b ?? {}, u);
  }

  @Post(':id/refund-liability')
  refund(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RefundBody)) b: RefundBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.accrueRefundLiability({ contractId: id, expectedRefundRate: b.expected_refund_rate, asOfDate: b.as_of_date }, u);
  }
}
