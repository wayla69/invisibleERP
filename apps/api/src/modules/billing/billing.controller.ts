import { Controller, Get, Post, Body, Query, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Public, Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { BillingService, type SignupDto } from './billing.service';
import { SaasMetricsService } from './saas-metrics.service';

const SignupBody = z.object({
  company_name: z.string().min(1),
  tenant_code: z.string().min(1),
  admin_username: z.string().min(1),
  admin_password: z.string().min(8),
  email: z.string().email(),
  plan_code: z.string().optional(),
  industry: z.enum(['restaurant', 'retail', 'distribution', 'services', 'general']).optional(),
  legal_name: z.string().optional(),
  tax_id: z.string().optional(),
  vat_registered: z.boolean().optional(),
  vat_rate: z.number().optional(),
});

const CheckoutBody = z.object({ plan_code: z.string().min(1) });
const ChangePlanBody = z.object({ plan_code: z.string().min(1) });

@Controller('api')
export class BillingController {
  constructor(
    private readonly svc: BillingService,
    private readonly metrics: SaasMetricsService,
  ) {}

  // SaaS business metrics for the platform operator (MRR/ARR, plan mix, churn, DAU/MAU). Cross-tenant —
  // gated by `exec`; an HQ/Admin caller (RLS bypass) sees the whole book, a tenant-scoped exec only its own.
  @Get('billing/saas-metrics') @Permissions('exec')
  saasMetrics(@CurrentUser() u: JwtUser) { return this.metrics.overview(u); }

  // PUBLIC self-serve signup — provisions tenant + admin user + trialing subscription
  @Post('auth/signup') @Public()
  signup(@Body(new ZodValidationPipe(SignupBody)) b: SignupDto) {
    return this.svc.signup(b);
  }

  // PUBLIC plan catalogue
  @Get('billing/plans') @Public()
  plans() {
    return this.svc.listPlans();
  }

  @Get('billing/subscription') @Permissions('users')
  async subscription(@CurrentUser() u: JwtUser) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.getSubscription(tenantId);
  }

  // Per-tenant AI token consumption (cost visibility): today's usage vs the plan's daily limit + a 30-day
  // total. The daily budget itself is enforced in AgentService (AI_BUDGET_EXCEEDED); this is the read view.
  @Get('billing/ai-usage') @Permissions('users', 'exec')
  async aiUsage(@CurrentUser() u: JwtUser) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.aiUsage(tenantId);
  }

  // AI overage invoice line for a month (YYYY-MM, default current). Prices the metered overage tokens at
  // the plan's overage rate — the billable line a monthly invoice run appends (panel #3: meter → price).
  @Get('billing/ai-overage') @Permissions('users', 'exec')
  async aiOverage(@CurrentUser() u: JwtUser, @Query('month') month?: string) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.aiOverageInvoice(tenantId, month);
  }

  // AI-overage charge history for the tenant (read view of ai_overage_billing_runs).
  @Get('billing/ai-overage/runs') @Permissions('users', 'exec')
  async aiOverageRuns(@CurrentUser() u: JwtUser, @Query('month') month?: string) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.listOverageRuns(tenantId, month);
  }

  // Run the monthly AI-overage billing job (operator/HQ): append a Stripe invoice item per tenant for the
  // month's metered overage, idempotent per (tenant, month). Also runs unattended via the BI scheduler
  // (report type 'ai_overage_billing'). Default month = the just-closed Bangkok month.
  @Post('billing/ai-overage/run') @Permissions('exec') @HttpCode(200)
  async runAiOverage(@CurrentUser() u: JwtUser, @Query('month') month?: string) {
    return this.svc.runAiOverageBilling(u, month);
  }

  @Post('billing/checkout') @Permissions('users')
  async checkout(@Body(new ZodValidationPipe(CheckoutBody)) b: { plan_code: string }, @CurrentUser() u: JwtUser) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.createCheckoutSession(tenantId, b.plan_code);
  }

  @Post('billing/change-plan') @Permissions('users')
  async changePlan(@Body(new ZodValidationPipe(ChangePlanBody)) b: { plan_code: string }, @CurrentUser() u: JwtUser) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.changePlan(tenantId, b.plan_code);
  }
}
