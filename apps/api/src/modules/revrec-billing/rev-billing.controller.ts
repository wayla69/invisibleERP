import { Controller, Get, Post, Param, Body, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RevBillingService } from './rev-billing.service';

const MilestoneSchema = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), amount: z.number().positive() });
const DefineScheduleBody = z.object({ milestones: z.array(MilestoneSchema).min(1), replace: z.boolean().optional() });
type DefineScheduleBodyT = z.infer<typeof DefineScheduleBody>;

const BillBody = z.object({ billing_schedule_id: z.number().int().positive(), invoice_ref: z.string().optional(), date: z.string().optional(), self_approval_reason: z.string().max(500).optional() });
type BillBodyT = z.infer<typeof BillBody>;

// Track D — Wave 1 (REV-24): independent billing schedule + contract-asset / contract-liability split under
// TFRS 15 / IFRS 15 / ASC 606 §105-107. Extends the REV-19 contract at /api/revenue/contracts/:id. Gated with
// the same exec/ar/fin_report duties (no new duty invented). Maker-checker (SoD) is enforced in the service.
@Controller('api/revenue/contracts')
@Permissions('exec', 'ar', 'fin_report')
export class RevBillingController {
  constructor(private readonly svc: RevBillingService) {}

  // Define the invoice milestones/periods (maker). Independent of the recognition schedule.
  @Post(':id/billing-schedule')
  defineSchedule(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(DefineScheduleBody)) b: DefineScheduleBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.defineBillingSchedule(id, b, u);
  }

  @Get(':id/billing-schedule')
  getSchedule(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getSchedule(id);
  }

  // Raise an invoice for a scheduled milestone (checker; must differ from the maker). Reclasses 1265→1100,
  // parks any over-billing in 2410.
  @Post(':id/bill')
  bill(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(BillBody)) b: BillBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.bill(id, b, u, b.self_approval_reason);
  }

  // Cumulative recognized vs billed with the derived contract-asset / contract-liability balance.
  @Get(':id/position')
  position(@Param('id', ParseIntPipe) id: number) {
    return this.svc.position(id);
  }
}
