import { Controller, Get, Post, Body, Query, Param, HttpCode, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Public, Permissions, PlatformAdmin, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { BillingService, type SignupDto } from './billing.service';
import { TenantLifecycleService } from './tenant-lifecycle.service';
import { SaasMetricsService } from './saas-metrics.service';
import { SaasLifecycleService } from './saas-lifecycle.service';
import { SaasReceiptsService } from './saas-receipts.service';
import { EntitlementObservationsService } from './entitlement-observations.service';

const SignupBody = z.object({
  company_name: z.string().min(1),
  tenant_code: z.string().min(1),
  admin_username: z.string().min(1),
  admin_password: z.string().min(8),
  email: z.string().email(),
  plan_code: z.string().optional(),
  industry: z.enum([
    'restaurant', 'retail', 'distribution', 'services', 'manufacturing', 'construction', 'ecommerce',
    'hospitality', 'healthcare', 'professional', 'agriculture', 'automotive', 'logistics', 'education',
    'nonprofit', 'realestate', 'general',
  ]).optional(),
  // SME single-user edition (docs/49) — the control environment chosen AT CREATION. Default 'enterprise'.
  // Only the @PlatformAdmin create-company path may set 'sme' (enforced in provisionTenant, not here,
  // because this body is shared with the public signup/request forms).
  control_profile: z.enum(['enterprise', 'sme']).optional(),
  legal_name: z.string().optional(),
  tax_id: z.string().optional(),
  vat_registered: z.boolean().optional(),
  vat_rate: z.number().optional(),
  invite_token: z.string().optional(),
  // Pack selection carried over from the public /plans configurator (0451). Advisory (shown to the
  // approving platform owner + honoured at provisioning); unknown values are dropped server-side.
  requested_plan: z.string().max(30).optional(),
  requested_billing: z.enum(['monthly', 'annual']).optional(),
  requested_addons: z.array(z.string().max(30)).max(10).optional(),
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
const DeleteTenantBody = z.object({ confirm: z.string().min(1).max(100) });
const PurgeTenantBody = z.object({ confirm: z.string().min(1).max(100) });

const CheckoutBody = z.object({ plan_code: z.string().min(1), interval: z.enum(['monthly', 'annual']).optional(), currency: z.string().length(3).optional(), addons: z.array(z.string().max(30)).max(10).optional() }); // 1.7 — annual billing + multi-currency · A3 — add-on line items
const ChangePlanBody = z.object({ plan_code: z.string().min(1), interval: z.enum(['monthly', 'annual']).optional() });
// 0451 — per-tenant à-la-carte add-ons (ADDON_KEYS in @ierp/shared); the full desired set, not a delta.
const AddonsBody = z.object({ addons: z.array(z.string().max(30)).max(10) });
// A4 — god-recorded offline payment (bank transfer): VAT-inclusive THB amount + optional period/note.
const ManualReceiptBody = z.object({ amount: z.number().positive().max(10_000_000), period: z.string().regex(/^\d{4}-\d{2}$/).optional(), note: z.string().max(300).optional() });
const ExtendTrialBody = z.object({ days: z.number().int().min(1).max(365) });
const TagsBody = z.object({ tags: z.array(z.string()).max(20) });
// docs/49 — control-profile transition is UPGRADE-ONLY, so the only accepted target is 'enterprise'.
const ControlProfileBody = z.object({ control_profile: z.literal('enterprise') });
const SmeDefaultsBody = z.object({
  hidden_nav_groups: z.array(z.string().max(100)).max(50).optional(),
  accountant_email: z.string().email().nullable().optional(),
});

@Controller('api')
export class BillingController {
  constructor(
    private readonly svc: BillingService,
    private readonly metrics: SaasMetricsService,
    private readonly lifecycle: TenantLifecycleService,
    private readonly saasLifecycle: SaasLifecycleService,
    private readonly saasReceipts: SaasReceiptsService,
    private readonly entitlementObs: EntitlementObservationsService,
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
  listTenants(@Query('include_deleted') includeDeleted?: string) {
    return this.svc.listTenants(includeDeleted === '1' || includeDeleted === 'true');
  }

  // Cross-company AI-token usage aggregate (Platform Console AI-spend panel).
  @Get('admin/ai-usage') @PlatformAdmin()
  adminAiUsage() {
    return this.svc.aiUsageByTenant();
  }

  // A2 — run the SaaS lifecycle sweep on demand (the BI scheduler runs the same sweep daily; idempotent
  // via saas_lifecycle_events dedup keys, so a manual run alongside the schedule is always safe).
  @Post('admin/saas-lifecycle/run') @PlatformAdmin() @HttpCode(200)
  runSaasLifecycle() {
    return this.saasLifecycle.runDaily();
  }

  // A4 — own-SaaS receipts. Tenant side: list + printable receipt, hard-scoped to the caller's own
  // tenant (an unknown/foreign receipt number is a 404, never a 403). God side: record an offline
  // bank-transfer payment (creates the receipt + emails the customer) and print any receipt.
  @Get('billing/receipts') @Permissions('users')
  async myReceipts(@CurrentUser() u: JwtUser) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.saasReceipts.listForTenant(tenantId);
  }

  @Get('billing/receipts/:receiptNo/pdf') @Permissions('users')
  async myReceiptPdf(@Param('receiptNo') receiptNo: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const tenantId = await this.svc.resolveTenantId(u);
    const html = await this.saasReceipts.receiptHtml(receiptNo, tenantId);
    const buf = await this.saasReceipts.renderPdf(html);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${receiptNo}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  @Post('admin/tenants/:id/receipts') @PlatformAdmin() @HttpCode(201)
  recordManualReceipt(@Param('id') id: string, @Body(new ZodValidationPipe(ManualReceiptBody)) b: { amount: number; period?: string; note?: string }, @CurrentUser() u: JwtUser) {
    return this.saasReceipts.record({ tenantId: Number(id), source: 'manual', amount: b.amount, period: b.period ?? null, note: b.note ?? null, createdBy: u.username });
  }

  @Get('admin/receipts/:receiptNo/pdf') @PlatformAdmin()
  async adminReceiptPdf(@Param('receiptNo') receiptNo: string, @Res() reply: FastifyReply) {
    const html = await this.saasReceipts.receiptHtml(receiptNo, null);
    const buf = await this.saasReceipts.renderPdf(html);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${receiptNo}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  @Get('admin/saas-lifecycle/events') @PlatformAdmin()
  saasLifecycleEvents(@Query('limit') limit?: string) {
    return this.saasLifecycle.listEvents(limit ? Number(limit) : undefined);
  }

  // B1 — entitlement-enforcement observations: who would break (shadow) / did break (enforce), on what,
  // per tenant. The triage read before moving a tenant into the ENTITLEMENTS_ENFORCE_TENANTS cohort.
  @Get('admin/entitlement-observations') @PlatformAdmin()
  entitlementObservations(@Query('days') days?: string) {
    return this.entitlementObs.list(days ? Number(days) : undefined);
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

  // 0451 — set a company's à-la-carte add-ons (replaces the whole set). Add-on suite keys union into the
  // tenant's entitled suites on top of its plan (resolveEntitledSuites); unknown keys are rejected.
  @Post('admin/tenants/:id/addons') @PlatformAdmin() @HttpCode(200)
  setTenantAddons(@Param('id') id: string, @Body(new ZodValidationPipe(AddonsBody)) b: { addons: string[] }) {
    return this.svc.setTenantAddons(Number(id), b.addons);
  }

  @Post('admin/tenants/:id/tags') @PlatformAdmin() @HttpCode(200)
  setTenantTags(@Param('id') id: string, @Body(new ZodValidationPipe(TagsBody)) b: { tags: string[] }) {
    return this.svc.setTenantTags(Number(id), b.tags);
  }

  // SME single-user edition (docs/49) — UPGRADE-ONLY control-profile transition (sme → enterprise).
  // A downgrade (enterprise → sme) is rejected in the service with 403 PROFILE_DOWNGRADE_FORBIDDEN:
  // an entity that has operated under full SoD may not weaken its control environment later.
  @Post('admin/tenants/:id/control-profile') @PlatformAdmin() @HttpCode(200)
  upgradeControlProfile(@Param('id') id: string, @Body(new ZodValidationPipe(ControlProfileBody)) b: { control_profile: 'enterprise' }, @CurrentUser() u: JwtUser) {
    return this.svc.upgradeControlProfile(Number(id), b.control_profile, u.username);
  }

  // Per-tenant SME prefs (docs/49 v1.2) — edit an EXISTING SME company's stamped accountant routing /
  // hidden nav groups; changing the accountant also re-points its auto-provisioned SME-01 subscription.
  @Post('admin/tenants/:id/sme-prefs') @PlatformAdmin() @HttpCode(200)
  setTenantSmePrefs(@Param('id') id: string, @Body(new ZodValidationPipe(SmeDefaultsBody)) b: { hidden_nav_groups?: string[]; accountant_email?: string | null }, @CurrentUser() u: JwtUser) {
    return this.svc.setTenantSmePrefs(Number(id), b, u.username);
  }

  // Platform-wide SME provisioning defaults (docs/49) — what every NEW SME company is stamped with at
  // creation (tenants.sme_prefs). Changing these affects only future companies.
  @Get('admin/sme-defaults') @PlatformAdmin()
  getSmeDefaults() {
    return this.svc.getSmeDefaults();
  }

  @Post('admin/sme-defaults') @PlatformAdmin() @HttpCode(200)
  setSmeDefaults(@Body(new ZodValidationPipe(SmeDefaultsBody)) b: { hidden_nav_groups?: string[]; accountant_email?: string | null }, @CurrentUser() u: JwtUser) {
    return this.svc.setSmeDefaults(b, u.username);
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

  // Tenant factory-reset — wipes a pilot company's test data (identity/billing/audit preserved, fresh
  // defaults re-seeded) so it can start real usage clean. Permanent lifecycle operation, triple-gated:
  // god-only, the company must be SUSPENDED first (409 TENANT_NOT_SUSPENDED — the two-step that makes an
  // actively-used company unwipeable: suspend → reset → reactivate), and the caller must type the company
  // code (400 CONFIRM_MISMATCH). Audit-logged; the ITGC-AC-16 audit chain itself is never erased.
  @Post('admin/tenants/:id/factory-reset') @PlatformAdmin() @HttpCode(200)
  factoryResetTenant(@Param('id') id: string, @Body(new ZodValidationPipe(FactoryResetBody)) b: { confirm: string }, @CurrentUser() u: JwtUser) {
    return this.svc.factoryResetTenant(Number(id), u.username, b.confirm);
  }

  // Tenant soft-delete (migration 0393) — flags the company row deleted WITHOUT touching business data
  // (lighter than factory-reset). Same two-step safety: SUSPENDED first (409 TENANT_NOT_SUSPENDED), then
  // type the company code (400 CONFIRM_MISMATCH). Deleted companies drop out of listTenants() and their
  // users are permanently blocked (TENANT_DELETED) regardless of suspended_at. Reversible via restore.
  @Post('admin/tenants/:id/delete') @PlatformAdmin() @HttpCode(200)
  deleteTenant(@Param('id') id: string, @Body(new ZodValidationPipe(DeleteTenantBody)) b: { confirm: string }, @CurrentUser() u: JwtUser) {
    return this.lifecycle.deleteTenant(Number(id), u.username, b.confirm);
  }

  @Post('admin/tenants/:id/restore') @PlatformAdmin() @HttpCode(200)
  restoreTenant(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.lifecycle.restoreTenant(Number(id), u.username);
  }

  // Tenant PURGE (migration 0393) — IRREVERSIBLE. Wipes every tenant-scoped row EXCEPT audit_log
  // (ITGC-AC-16 append-only chain — never erased by policy) and the tenants row itself, which survives
  // solely as that chain's anchor. Gated behind an already-soft-deleted company (409 TENANT_NOT_DELETED —
  // delete → purge) so nothing gets permanently erased in one click; typed company-code confirm (400
  // CONFIRM_MISMATCH); 409 TENANT_ALREADY_PURGED on a repeat call.
  @Post('admin/tenants/:id/purge') @PlatformAdmin() @HttpCode(200)
  purgeTenant(@Param('id') id: string, @Body(new ZodValidationPipe(PurgeTenantBody)) b: { confirm: string }, @CurrentUser() u: JwtUser) {
    return this.lifecycle.purgeTenant(Number(id), u.username, b.confirm);
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
  async checkout(@Body(new ZodValidationPipe(CheckoutBody)) b: { plan_code: string; interval?: 'monthly' | 'annual'; currency?: string; addons?: string[] }, @CurrentUser() u: JwtUser) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.createCheckoutSession(tenantId, b.plan_code, b.interval ?? 'monthly', b.currency ?? 'THB', b.addons ?? []);
  }

  // A3 — tenant self-serve add-on purchase/removal (the god path is POST /api/admin/tenants/:id/addons).
  // Always the CALLER'S OWN tenant; entitlement applies immediately, a live Stripe subscription gets its
  // add-on line items reconciled with mid-cycle proration.
  @Post('billing/addons') @Permissions('users') @HttpCode(200)
  setOwnAddons(@Body(new ZodValidationPipe(AddonsBody)) b: { addons: string[] }, @CurrentUser() u: JwtUser) {
    return this.svc.setOwnAddons(u, b.addons);
  }

  @Post('billing/change-plan') @Permissions('users')
  async changePlan(@Body(new ZodValidationPipe(ChangePlanBody)) b: { plan_code: string; interval?: 'monthly' | 'annual' }, @CurrentUser() u: JwtUser) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.changePlan(tenantId, b.plan_code, b.interval);
  }
}
