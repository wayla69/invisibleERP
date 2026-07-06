import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TendersService, type CreateTenderDto, type TenderLineDto, type OutcomeDto, type AwardDto } from './tenders.service';

const LineBody = z.object({
  category: z.enum(['material', 'labor', 'subcon', 'other']).optional(),
  description: z.string().optional(),
  uom: z.string().optional(),
  qty: z.number().positive(),
  unit_cost: z.number().nonnegative(),
  markup_pct: z.number().min(0).optional(),
});
const CreateBody = z.object({
  crm_opp_no: z.string().optional(),
  title: z.string().min(1),
  customer_name: z.string().optional(),
  project_code: z.string().optional(),
  markup_pct: z.number().min(0).optional(),
  lines: z.array(LineBody).optional(),
});
const OutcomeBody = z.object({ outcome: z.enum(['won', 'lost']), reason: z.string().optional() });
const AwardBody = z.object({ project_code: z.string().optional() });

// Tender / estimating → award (docs/35 P3, PROJ-18). An estimator (proj_tender) builds a priced estimate,
// submits it, records the win/loss, and — on a WIN — awards it, which seeds a project + a DRAFT BoQ from the
// tender lines (the seeded BoQ's own maker-checker approve controls the budget baseline). Read surfaces power
// the tender register / win-rate.
@Controller('api/tenders')
export class TendersController {
  constructor(private readonly svc: TendersService) {}

  @Post()
  @Permissions('proj_tender', 'marketing', 'exec')
  create(@Body(new ZodValidationPipe(CreateBody)) b: CreateTenderDto, @CurrentUser() u: JwtUser) {
    return this.svc.createTender(b, u);
  }

  @Get()
  @Permissions('proj_tender', 'marketing', 'exec', 'planner')
  list() {
    return this.svc.list();
  }

  @Post(':tenderNo/lines')
  @Permissions('proj_tender', 'marketing', 'exec')
  addLine(@Param('tenderNo') tenderNo: string, @Body(new ZodValidationPipe(LineBody)) b: TenderLineDto, @CurrentUser() u: JwtUser) {
    return this.svc.addLine(tenderNo, b, u);
  }

  @Post(':tenderNo/submit')
  @Permissions('proj_tender', 'marketing', 'exec')
  submit(@Param('tenderNo') tenderNo: string, @CurrentUser() u: JwtUser) {
    return this.svc.submit(tenderNo, u);
  }

  @Post(':tenderNo/outcome')
  @Permissions('proj_tender', 'marketing', 'exec')
  outcome(@Param('tenderNo') tenderNo: string, @Body(new ZodValidationPipe(OutcomeBody)) b: OutcomeDto, @CurrentUser() u: JwtUser) {
    return this.svc.setOutcome(tenderNo, b, u);
  }

  // Award a won tender → seed project + draft BoQ (authorised act, PROJ-18).
  @Post(':tenderNo/award')
  @Permissions('proj_tender', 'exec')
  award(@Param('tenderNo') tenderNo: string, @Body(new ZodValidationPipe(AwardBody)) b: AwardDto, @CurrentUser() u: JwtUser) {
    return this.svc.award(tenderNo, b, u);
  }

  @Get(':tenderNo')
  @Permissions('proj_tender', 'marketing', 'exec', 'planner')
  get(@Param('tenderNo') tenderNo: string) {
    return this.svc.get(tenderNo);
  }
}
