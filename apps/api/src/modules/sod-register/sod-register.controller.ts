import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SodRegisterService } from './sod-register.service';

// GRC-5 (ITGC-AC-22): SoD-Conflict Register + Compensating-Control governance. Reads gate users/exec (the
// access-governance duties). Accepting/re-reviewing a conflict is an approver action (the same admin duties);
// the acceptor/reviewer is recorded on the row as evidence. Enforcement (ITGC-AC-09) is unchanged.
const AcceptBody = z.object({
  rule_id: z.string().min(1),
  username: z.string().min(1),
  compensating_control: z.string().optional(),
  owner: z.string().optional(),
  expiry_date: z.string().optional(),
  status: z.enum(['open', 'accepted', 'mitigated', 'resolved']).optional(),
  notes: z.string().max(2000).optional(),
});
const ReviewBody = z.object({
  notes: z.string().max(2000).optional(),
  status: z.enum(['open', 'accepted', 'mitigated', 'resolved']).optional(),
  expiry_date: z.string().optional(),
});

@Controller('api/admin/sod')
@Permissions('users', 'exec')
export class SodRegisterController {
  constructor(private readonly svc: SodRegisterService) {}

  // Standing detective dashboard — current conflicts across the whole population, grouped by rule.
  @Get('conflicts') conflicts() { return this.svc.conflicts(); }

  // Accepted-conflict register.
  @Get('dispositions') listDispositions(@Query('status') status?: string) { return this.svc.listDispositions(status); }
  // Detective worklist — accepted conflicts past expiry or overdue for re-review.
  @Get('dispositions/expired') expired() { return this.svc.expired(); }
  // Accept (govern) a conflict — mandatory compensating control + owner + expiry; acceptor recorded.
  @Post('dispositions') accept(@Body(new ZodValidationPipe(AcceptBody)) b: z.infer<typeof AcceptBody>, @CurrentUser() u: JwtUser) { return this.svc.accept(b, u); }
  // Periodic re-review — stamps last_reviewed_at (and may adjust status / extend expiry).
  @Post('dispositions/:id/review') review(@Param('id') id: string, @Body(new ZodValidationPipe(ReviewBody)) b: z.infer<typeof ReviewBody>, @CurrentUser() u: JwtUser) { return this.svc.review(+id, b, u); }
}
