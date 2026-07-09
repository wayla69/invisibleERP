import { Controller, Get, Post, Body, Query, Param, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Public, Permissions, PlatformAdmin, CurrentUser, type JwtUser } from '../../common/decorators';
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
  invite_token: z.string().optional(),
});

const InviteBody = z.object({
  company_name: z.string().optional(),
  plan_code: z.string().optional(),
  email: z.string().email().optional(),
  ttl_hours: z.number().int().min(1).max(24 * 30).optional(),
});
type InviteDto = z.infer<typeof InviteBody>;

const RejectBody = z.object({ reason: z.string().max(500).optional() });
type RejectDto = z.infer<typeof RejectBody>;

const FactoryResetBody = z.object({ confirm: z.string().min(1).max(100) });

const CheckoutBody = z.object({ plan_code: z.string().min(1), interval: z.enum(['monthly', 'annual']).optional(), currency: z.string().length(3).optional() }); // 1.7 — annual billing + multi-currency
const ChangePlanBody = z.object({ plan_code: z.string().min(1), interval: z.enum(['monthly', 'annual']).optional() });
const ExtendTrialBody = z.object({ days: z.number().int().min(1).max(365) });
const TagsBody = z.object({ tags: z.array(z.string()).max(20) });

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

  // Platform-admin create-company (ITGC-AC-18) — an authenticated PLATFORM owner
  // (PLATFORM_ADMIN_USERNAMES) provisions a new tenant + its Admin WITHOUT toggling public signup.
  // PlatformAdminGuard gates it + grants the RLS bypass; the action is audit-logged (cross-tenant write).
  @Post('admin/tenants') @PlatformAdmin() @HttpCode(201)
  createTenant(@Body(new ZodValidationPipe(SignupBody)) b: SignupDto) {
    return this.svc.provisionTenant(b);
  }

  // Invite-link onboarding (#2) — a platform owner issues a single-use, expiring invite; the raw token is
  // returned ONCE. The invitee then signs up with it (POST /api/auth/signup { invite_token }) even when
  // public signup is disabled. List shows pending/used/expired invites.
  @Post('admin/signup-invites') @PlatformAdmin() @HttpCode(201)
  createInvite(@Body(new ZodValidationPipe(InviteBody)) b: InviteDto, @CurrentUser() u: JwtUser) {
    return this.svc.createSignupInvite({ createdBy: u.username, ...b });
  }

  @Get('admin/signup-invites') @PlatformAdmin()
  listInvites() {
    return this.svc.listSignupInvites();
  }

  // Approval-queue onboarding (#3) — a PUBLIC "request access" form creates a PENDING request (no tenant is
  // provisioned); a platform owner then approves (→ provisions) or rejects it.
  @Post('auth/signup-requests') @Public() @HttpCode(201)
  requestSignup(@Body(new ZodValidationPipe(SignupBody)) b: SignupDto) {
    return this.svc.createSignupRequest(b);
  }

  @Get('admin/signup-requests') @PlatformAdmin()
  listRequests(@Query('status') status: string | undefined) {
    return this.svc.listSignupRequests(status);
  }

  @Post('admin/signup-requests/:id/approve') @PlatformAdmin() @HttpCode(201)
  approveRequest(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.svc.approveSignupRequest(Number(id), u.username);
  }

  @Post('admin/signup-requests/:id/reject') @PlatformAdmin() @HttpCode(200)
  rejectRequest(@Param('id') id: string, @Body(new ZodValidationPipe(RejectBody)) b: RejectDto, @CurrentUser() u: JwtUser) {
    return this.svc.rejectSignupRequest(Number(id), u.username, b.reason);
  }

  // Company directory for the platform owner ("god") — backs the web company-switcher so god can pick a
  // single company to scope its view to (see the X-Act-As-Tenant header in TenantTxInterceptor). Lists ALL
  // tenants (runs under the @PlatformAdmin RLS bypass); non-owners 403 at the guard.
  @Get('admin/tenants') @PlatformAdmin()
  listTenants() {
    return this.svc.listTenants();
  }

  // Cross-company AI-token usage aggregate (Platform Console AI-spend panel).
  @Get('admin/ai-usage') @PlatformAdmin()
  adminAiUsage() {
    return this.svc.aiUsageByTenant();
  }

  // Full detail for one company (Platform Console drawer) — profile + subscription + counts + recent activity.
  @Get('admin/tenants/:id') @PlatformAdmin()
  tenantDetail(@Param('id') id: string) {
    return this.svc.getTenantDetail(Number(id));
  }

  // Platform-level subscription control for one company (no impersonation): change plan / extend trial.
  @Post('admin/tenants/:id/plan') @PlatformAdmin() @HttpCode(200)
  setTenantPlan(@Param('id') id: string, @Body(new ZodValidationPipe(ChangePlanBody)) b: { plan_code: string }) {
    return this.svc.changePlan(Number(id), b.plan_code);
  }

  @Post('admin/tenants/:id/extend-trial') @PlatformAdmin() @HttpCode(200)
  extendTrial(@Param('id') id: string, @Body(new ZodValidationPipe(ExtendTrialBody)) b: { days: number }) {
    return this.svc.extendTrial(Number(id), b.days);
  }

  @Post('admin/tenants/:id/tags') @PlatformAdmin() @HttpCode(200)
  setTenantTags(@Param('id') id: string, @Body(new ZodValidationPipe(TagsBody)) b: { tags: string[] }) {
    return this.svc.setTenantTags(Number(id), b.tags);
  }

  // Tenant lifecycle (#5) — a platform owner suspends a company (its users are then blocked,
  // TENANT_SUSPENDED) or reactivates it. Audit-logged; platform owners are exempt from the block.
  @Post('admin/tenants/:id/suspend') @PlatformAdmin() @HttpCode(200)
  suspendTenant(@Param('id') id: string, @Body(new ZodValidationPipe(RejectBody)) b: RejectDto, @CurrentUser() u: JwtUser) {
    return this.svc.suspendTenant(Number(id), u.username, b.reason);
  }

  @Post('admin/tenants/:id/reactivate') @PlatformAdmin() @HttpCode(200)
  reactivateTenant(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.svc.reactivateTenant(Number(id), u.username);
  }

  // Tenant factory-reset (pre-go-live safety valve) — wipes a pilot company's test data (identity/billing/
  // audit preserved, fresh defaults re-seeded) so it can start real usage clean. Triple-gated: god-only,
  // OFF unless ALLOW_TENANT_FACTORY_RESET=1 (403 FACTORY_RESET_DISABLED), and the caller must type the
  // company code (400 CONFIRM_MISMATCH). The flag is removed again after go-live (see the go-live runbook),
  // which makes the endpoint and its console button disappear.
  @Post('admin/tenants/:id/factory-reset') @PlatformAdmin() @HttpCode(200)
  factoryResetTenant(@Param('id') id: string, @Body(new ZodValidationPipe(FactoryResetBody)) b: { confirm: string }, @CurrentUser() u: JwtUser) {
    return this.svc.factoryResetTenant(Number(id), u.username, b.confirm);
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

  // 1.5 — usage-metering (e-Tax docs + POS transactions): the tenant's live usage snapshot per meter
  // (used / included quota / overage) for a month (default current Bangkok month).
  @Get('billing/usage') @Permissions('users', 'exec')
  async usage(@CurrentUser() u: JwtUser, @Query('month') month?: string) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.usageSummary(tenantId, month);
  }

  // Usage-overage charge history for the tenant (read view of usage_overage_billing_runs).
  @Get('billing/usage-overage/runs') @Permissions('users', 'exec')
  async usageOverageRuns(@CurrentUser() u: JwtUser, @Query('meter') meter?: string, @Query('month') month?: string) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.listUsageOverageRuns(tenantId, meter, month);
  }

  // Run the monthly usage-overage billing job (operator/HQ) across all meters, idempotent per
  // (tenant, meter, month). Also runs unattended via the BI scheduler (report type 'usage_overage_billing').
  @Post('billing/usage-overage/run') @Permissions('exec') @HttpCode(200)
  async runUsageOverage(@CurrentUser() u: JwtUser, @Query('month') month?: string) {
    return this.svc.runUsageOverageBilling(u, month);
  }

  @Post('billing/checkout') @Permissions('users')
  async checkout(@Body(new ZodValidationPipe(CheckoutBody)) b: { plan_code: string; interval?: 'monthly' | 'annual'; currency?: string }, @CurrentUser() u: JwtUser) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.createCheckoutSession(tenantId, b.plan_code, b.interval ?? 'monthly', b.currency ?? 'THB');
  }

  @Post('billing/change-plan') @Permissions('users')
  async changePlan(@Body(new ZodValidationPipe(ChangePlanBody)) b: { plan_code: string; interval?: 'monthly' | 'annual' }, @CurrentUser() u: JwtUser) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.changePlan(tenantId, b.plan_code, b.interval);
  }
}
