import { Controller, Get, Post, Query, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { LeasesService, type LeaseDto } from './leases.service';

const LeaseBody = z.object({
  name: z.string().min(1),
  lessor: z.string().optional(),
  term_months: z.number().int().positive(),
  monthly_payment: z.number().positive(),
  annual_rate_pct: z.number().nonnegative().optional(),
  tenant_id: z.number().optional(),
  start_date: z.string().optional(),
});

// Lease accounting (IFRS 16 / TFRS 16) — control LSE-01. gl_post books the GL effect.
@Controller('api/leases')
@Permissions('gl_post', 'exec')
export class LeasesController {
  constructor(private readonly svc: LeasesService) {}

  @Post()
  create(@Body(new ZodValidationPipe(LeaseBody)) b: z.infer<typeof LeaseBody>, @CurrentUser() u: JwtUser) {
    const dto: LeaseDto = { name: b.name, lessor: b.lessor, termMonths: b.term_months, monthlyPayment: b.monthly_payment, annualRatePct: b.annual_rate_pct, tenantId: u.role === 'Admin' ? (b.tenant_id ?? null) : null, startDate: b.start_date };
    return this.svc.createLease(dto, u);
  }

  @Get()
  @Permissions('gl_post', 'gl_close', 'exec')
  list(@Query('tenant_id') tenantId?: string) { return this.svc.listLeases(tenantId ? Number(tenantId) : undefined); }

  // Post every due lease period now (cron-callable; also rides the scheduler as `lease_periodic_run`).
  @Post('run')
  @HttpCode(200)
  run(@CurrentUser() u: JwtUser) { return this.svc.runDueLeases(u); }
}
