import { Controller, Get, Post, Param, Body, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { RevModificationService } from './rev-modification.service';

const ModPoSchema = z.object({
  name: z.string().min(1),
  ssp: z.number().nonnegative(),
  method: z.enum(['point_in_time', 'over_time']).optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});
const ModifyBody = z.object({
  added_price: z.number(),
  distinct_flag: z.boolean(),
  at_ssp_flag: z.boolean(),
  obligations: z.array(ModPoSchema).optional(),
  as_of: z.string().optional(),
  note: z.string().optional(),
});
type ModifyBodyT = z.infer<typeof ModifyBody>;

// Track D — Wave 3 (REV-26): contract modifications under TFRS 15 / IFRS 15 / ASC 606 §18-21. Extends the
// REV-19 contract at /api/revenue/contracts/:id. Gated with the same exec/ar/fin_report duties (no new duty).
// The classification is the control and the modification maker-checker (SoD) is enforced in the service.
@Controller('api/revenue/contracts')
@Permissions('exec', 'ar', 'fin_report')
export class RevModificationController {
  constructor(private readonly svc: RevModificationService) {}

  // Record + classify a modification (maker). Pending until a different user approves it; drives nothing yet.
  @Post(':id/modify')
  modify(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ModifyBody)) b: ModifyBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.modify(id, b, u);
  }

  // Approve a modification (checker; must differ from the maker → 403 SOD_SELF_APPROVAL). Approval APPLIES
  // the §18-21 effect (separate contract / prospective re-allocation / cumulative catch-up).
  @Post(':id/modifications/:modId/approve')
  approve(@Param('id', ParseIntPipe) id: number, @Param('modId', ParseIntPipe) modId: number, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.approve(id, modId, u, b?.self_approval_reason);
  }

  // List the contract's modifications (newest first).
  @Get(':id/modifications')
  list(@Param('id', ParseIntPipe) id: number) {
    return this.svc.listModifications(id);
  }
}
