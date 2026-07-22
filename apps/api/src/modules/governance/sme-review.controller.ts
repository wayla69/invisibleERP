import { Controller, Get, Post, Body, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AuditRead, Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SmeReviewService, type RegistryFilters } from './sme-review.service';

const SignoffBody = z.object({ period: z.string().max(7).optional(), note: z.string().max(500).optional() });

const registryFilters = (q: Record<string, string | undefined>): RegistryFilters =>
  ({ from: q.from, to: q.to, event: q.event, q: q.q, limit: q.limit ? Number(q.limit) : undefined });

// SME-02 (docs/49) — the independent-review attestation surface for the SME single-user edition. A user
// holding the `sme_review` duty (the external accountant) signs as 'accountant'; a platform owner acting-as
// the tenant signs as 'platform' (leg derived from the principal in the service, never from the body).
// Reads/writes are gated to `sme_review` (plus the compliance/exec functions that already oversee SME-01).
@Controller('api/sme-review')
export class SmeReviewController {
  constructor(private readonly svc: SmeReviewService) {}

  // Attest that this period's self-approvals were reviewed (idempotent per reviewer leg).
  @Post('signoff') @Permissions('sme_review', 'exec', 'users')
  signoff(@Body(new ZodValidationPipe(SignoffBody)) b: z.infer<typeof SignoffBody>, @CurrentUser() u: JwtUser) {
    return this.svc.signoff(u, b);
  }

  // Per-period status: reviewed count + which legs signed + which are outstanding.
  @Get('status') @Permissions('sme_review', 'exec', 'users')
  status(@Query('period') period: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.status(u, period);
  }

  // The self-approvals in a period (the evidence the reviewer signs off).
  @Get('items') @Permissions('sme_review', 'exec', 'users')
  items(@Query('period') period: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.items(u, period);
  }

  // Registry — cross-period, filterable browse of every self-approval (owner/auditor evidence view).
  @Get('registry') @Permissions('sme_review', 'exec', 'users')
  registry(@Query() q: Record<string, string | undefined>, @CurrentUser() u: JwtUser) {
    return this.svc.registry(u, registryFilters(q));
  }

  // Registry CSV export (auditor download).
  @AuditRead('sme_self_approval_registry_csv')
  @Get('registry/export') @Permissions('sme_review', 'exec', 'users')
  async registryExport(@Query() q: Record<string, string | undefined>, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const csv = await this.svc.registryCsv(u, registryFilters(q));
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="sme-self-approvals.csv"').send(csv);
  }

  // Recent attestations (audit browse).
  @Get('signoffs') @Permissions('sme_review', 'exec', 'users')
  list(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.list(u, Number(limit) || 100);
  }
}
