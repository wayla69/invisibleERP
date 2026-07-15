import { ConflictException, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { eq, sql, and, desc, gt, isNull } from 'drizzle-orm';
import { randomBytes, createHash } from 'node:crypto';
import type { DrizzleDb } from '../../database/database.module';
import { plans, subscriptions, tenants, users, signupInvites, signupRequests, platformSmeDefaults } from '../../database/schema';
import { reportSubscriptions } from '../../database/schema/bi';
import { PasswordService } from '../auth/password.service';
import { LedgerService } from '../ledger/ledger.service';
import { isIndustryKey } from '../ledger/coa-templates';
import { ymd } from '../../database/queries';
import { normalizeUsername } from '../../common/username';
import { isPlatformAdmin } from '../../common/decorators';
import { isUniqueViolation } from '../../common/db-error';
import { logger } from '../../observability/logger';
import { PlatformNotificationsService } from '../platform-notifications/platform-notifications.module';
import { wipeTenantRefs, tenantIdColumns } from './tenant-wipe';

// Public self-serve signup gate (ITGC-AC-18). In PRODUCTION, self-service company provisioning is
// DISABLED unconditionally — only the platform owner ("god", godmimi) opens a new company (directly via
// POST /api/admin/tenants, by issuing an invite token, or by approving a request from the public
// request-access queue POST /api/auth/signup-requests). The legacy PUBLIC_SIGNUP_ENABLED escape hatch no
// longer re-opens self-serve provisioning in prod; it is retained only so an operator flag is not a hard
// boot error, and is a no-op for provisioning. Outside production (dev + harnesses run NODE_ENV=test) the
// path stays open so tests can mint tenants directly. Pure + env-injectable for unit testing.
export function isSignupAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production';
}

// What a factory reset MUST NOT touch. Identity (logins keep working so the company restarts real usage
// without re-provisioning), billing/plan state, the ITGC-AC-16 tamper-evident audit chain, and the
// operator's usage/AI-spend billing evidence. Everything else with a tenant_id column is wiped.
const FACTORY_RESET_PRESERVE = new Set([
  'users', 'user_permissions', 'user_prefs',
  'subscriptions',
  'audit_log',
  'ai_token_usage', 'ai_overage_billing_runs',
  'usage_events', 'usage_overage_billing_runs',
]);

export interface SignupDto {
  company_name: string;
  tenant_code: string;
  admin_username: string;
  admin_password: string;
  email: string;
  plan_code?: string;
  // industry CoA template the company picks at signup (GL-10): restaurant|retail|distribution|services|
  // general. Falls back to 'general' (full canonical chart) when omitted/unknown.
  industry?: string;
  // optional tax identity (the setup wizard can fill these later via PATCH /api/tenant/profile)
  legal_name?: string;
  tax_id?: string;
  vat_registered?: boolean;
  vat_rate?: number;
  // Invite-link onboarding (#2): a valid single-use token lets a company sign up even when public signup
  // is disabled. Consumed on success. Absent ⇒ normal PUBLIC_SIGNUP_ENABLED gate applies.
  invite_token?: string;
  // SME single-user edition (docs/49) — the control environment chosen AT CREATION (default 'enterprise').
  // Honoured only from the @PlatformAdmin create-company path; the public signup/request paths always
  // provision 'enterprise' (a self-served outsider must not opt out of maker-checker).
  control_profile?: 'enterprise' | 'sme';
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const TRIAL_DAYS = 14;

// docs/46 Phase 4c cut 2 — the tenant LIFECYCLE side of billing (self-serve signup gate, invite +
// approval-queue onboarding, core provisioning, factory reset, tenant resolution — ITGC-AC-18 and security
// review L-4 verbatim), moved out of billing.service.ts. A plain class constructed in the BillingService
// constructor BODY (docs/38 recipe); the facade keeps thin delegators + re-exports, so the public API is
// byte-identical.
export class TenantProvisioningService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly password: PasswordService,
    private readonly ledger?: LedgerService,
    private readonly platformNotifs?: PlatformNotificationsService,
  ) {}

  // ───────────────────── PUBLIC self-serve signup ─────────────────────
  // Atomic provisioning: tenant + admin user + trialing subscription.
  async signup(dto: SignupDto) {
    // ITGC-AC-18. Two ways in: (a) a valid single-use INVITE token (onboarding #2) lets this company through
    // even when public signup is disabled; else (b) the PUBLIC_SIGNUP_ENABLED gate applies — fail-closed in
    // prod (dev + harnesses NODE_ENV=test always allowed). See docs/ops/tenancy-model.md.
    const invite = dto.invite_token ? await this.validateInvite(dto.invite_token) : null;
    if (!invite && !isSignupAllowed()) {
      throw new ForbiddenException({
        code: 'SIGNUP_DISABLED',
        message: 'Public self-service signup is disabled — contact the administrator to be onboarded.',
        messageTh: 'ปิดรับสมัครบัญชีใหม่แบบสาธารณะ — โปรดติดต่อผู้ดูแลระบบเพื่อเปิดบัญชี',
      });
    }
    // Public signup NEVER honours control_profile (docs/49) — only the god create-company path may set 'sme'.
    const result = await this.provisionTenant({ ...dto, control_profile: undefined, plan_code: dto.plan_code ?? invite?.planCode ?? undefined });
    if (invite) await this.consumeInvite(invite.id, result.tenant_id);
    return result;
  }

  // ── Invite-link onboarding (#2) — platform-owner-issued, single-use, expiring tokens ──
  // Create an invite (returns the RAW token once — only its hash is stored). ttl_hours default 72.
  async createSignupInvite(opts: { createdBy: string; company_name?: string; plan_code?: string; email?: string; ttl_hours?: number }) {
    const rawToken = randomBytes(24).toString('hex'); // 48 hex chars
    const ttl = Math.min(Math.max(Number(opts.ttl_hours ?? 72), 1), 24 * 30); // 1h..30d
    const expiresAt = new Date(Date.now() + ttl * 60 * 60 * 1000);
    const [row] = await this.db.insert(signupInvites).values({
      tokenHash: sha256(rawToken), createdBy: opts.createdBy,
      companyName: opts.company_name ?? null, planCode: opts.plan_code ?? null, email: opts.email ?? null,
      expiresAt,
    }).returning({ id: signupInvites.id });
    return { id: Number(row!.id), invite_token: rawToken, expires_at: expiresAt.toISOString(),
      company_name: opts.company_name ?? null, email: opts.email ?? null };
  }

  // List invites with a computed status (pending | used | expired) for the console.
  async listSignupInvites() {
    const rows = await this.db.select().from(signupInvites).orderBy(desc(signupInvites.id)).limit(200);
    const now = Date.now();
    return {
      invites: rows.map((r: any) => ({
        id: Number(r.id), created_by: r.createdBy, company_name: r.companyName, email: r.email,
        expires_at: r.expiresAt, used_at: r.usedAt, used_tenant_id: r.usedTenantId != null ? Number(r.usedTenantId) : null,
        status: r.usedAt ? 'used' : (new Date(r.expiresAt).getTime() < now ? 'expired' : 'pending'),
      })),
    };
  }

  // Validate an invite token: must exist (by hash), be unused, and unexpired. Throws 400 INVALID_INVITE.
  private async validateInvite(rawToken: string) {
    const [inv] = await this.db.select({ id: signupInvites.id, planCode: signupInvites.planCode })
      .from(signupInvites)
      .where(and(eq(signupInvites.tokenHash, sha256(rawToken.trim())), isNull(signupInvites.usedAt), gt(signupInvites.expiresAt, new Date())))
      .limit(1);
    if (!inv) throw new BadRequestException({ code: 'INVALID_INVITE', message: 'Invite is invalid, already used, or expired', messageTh: 'ลิงก์เชิญไม่ถูกต้อง ถูกใช้ไปแล้ว หรือหมดอายุ' });
    return { id: Number(inv.id), planCode: inv.planCode as string | null };
  }

  // Mark an invite consumed (single-use guard: only if still unused).
  private async consumeInvite(id: number, tenantId: number) {
    await this.db.update(signupInvites).set({ usedAt: new Date(), usedTenantId: tenantId })
      .where(and(eq(signupInvites.id, id), isNull(signupInvites.usedAt)));
  }

  // ── Approval-queue onboarding (#3) — a PUBLIC request creates a PENDING row (no tenant); a platform
  // owner approves (→ provisions) or rejects. The requester's password is stored HASHED here. ──
  async createSignupRequest(dto: SignupDto) {
    const code = dto.tenant_code.trim();
    const username = normalizeUsername(dto.admin_username);
    // never queue a request for a reserved platform-owner username (security review L-4; mirrors provisionTenant)
    if (isPlatformAdmin(username))
      throw new BadRequestException({ code: 'RESERVED_USERNAME', message: 'This username is reserved and cannot be used for a company admin', messageTh: 'ชื่อผู้ใช้นี้สงวนไว้ ไม่สามารถใช้เป็นผู้ดูแลบริษัทได้' });
    // fail fast on collisions with an existing LIVE tenant/user (the partial unique indexes block dup PENDING)
    const [t] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, code)).limit(1);
    if (t) throw new ConflictException({ code: 'CONFLICT', message: 'Tenant code already taken', messageTh: 'รหัสร้านนี้ถูกใช้แล้ว' });
    const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (u) throw new ConflictException({ code: 'CONFLICT', message: 'Username already taken', messageTh: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' });
    const industry = isIndustryKey(dto.industry) ? dto.industry : 'general';
    try {
      const [row] = await this.db.insert(signupRequests).values({
        companyName: dto.company_name, tenantCode: code, adminUsername: username,
        passwordHash: await this.password.hash(dto.admin_password), email: dto.email, industry, status: 'pending',
      }).returning({ id: signupRequests.id });
      await this.platformNotifs?.emit({ type: 'signup_request', title: `คำขอเปิดบริษัทใหม่: ${dto.company_name}`, body: `รหัส ${code} · ผู้ดูแล ${username}${dto.email ? ` · ${dto.email}` : ''}`, refType: 'signup_request', refId: String(row!.id) });
      return { request_id: Number(row!.id), status: 'pending' };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'REQUEST_PENDING', message: 'A pending request already exists for this company/username', messageTh: 'มีคำขอเปิดบัญชีนี้รออนุมัติอยู่แล้ว' });
      throw e;
    }
  }

  async listSignupRequests(status?: string) {
    const rows = await this.db.select().from(signupRequests)
      .where(status ? eq(signupRequests.status, status) : undefined)
      .orderBy(desc(signupRequests.id)).limit(200);
    return {
      requests: rows.map((r: any) => ({
        id: Number(r.id), company_name: r.companyName, tenant_code: r.tenantCode, admin_username: r.adminUsername,
        email: r.email, industry: r.industry, status: r.status, reject_reason: r.rejectReason,
        reviewed_by: r.reviewedBy, reviewed_at: r.reviewedAt, requested_at: r.requestedAt,
        created_tenant_id: r.createdTenantId != null ? Number(r.createdTenantId) : null,
      })),
    };
  }

  // Approve a pending request → provision the company with the stored (already-hashed) password. Marks the
  // row approved atomically (only if still pending) to avoid a double-provision race.
  async approveSignupRequest(id: number, reviewedBy: string) {
    const [req] = await this.db.select().from(signupRequests).where(eq(signupRequests.id, id)).limit(1);
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Request not found', messageTh: 'ไม่พบคำขอ' });
    if (req.status !== 'pending') throw new ConflictException({ code: 'REQUEST_NOT_PENDING', message: `Request already ${req.status}`, messageTh: 'คำขอนี้ถูกดำเนินการไปแล้ว' });
    // claim the row first (pending → approved); if 0 rows updated, someone else took it.
    const claimed = await this.db.update(signupRequests).set({ status: 'approved', reviewedBy, reviewedAt: new Date() })
      .where(and(eq(signupRequests.id, id), eq(signupRequests.status, 'pending'))).returning({ id: signupRequests.id });
    if (!claimed.length) throw new ConflictException({ code: 'REQUEST_NOT_PENDING', message: 'Request already handled', messageTh: 'คำขอนี้ถูกดำเนินการไปแล้ว' });
    const result = await this.provisionTenant(
      { company_name: req.companyName, tenant_code: req.tenantCode, admin_username: req.adminUsername, admin_password: '', email: req.email, industry: req.industry ?? undefined },
      { passwordHash: req.passwordHash },
    );
    await this.db.update(signupRequests).set({ createdTenantId: result.tenant_id }).where(eq(signupRequests.id, id));
    return { ...result, request_id: id, status: 'approved' };
  }

  async rejectSignupRequest(id: number, reviewedBy: string, reason?: string) {
    const claimed = await this.db.update(signupRequests).set({ status: 'rejected', reviewedBy, reviewedAt: new Date(), rejectReason: reason ?? null })
      .where(and(eq(signupRequests.id, id), eq(signupRequests.status, 'pending'))).returning({ id: signupRequests.id });
    if (!claimed.length) throw new ConflictException({ code: 'REQUEST_NOT_PENDING', message: 'Request not pending', messageTh: 'คำขอนี้ไม่อยู่ในสถานะรออนุมัติ' });
    return { request_id: id, status: 'rejected' };
  }

  // ── Tenant factory-reset (god-only, SUSPENDED companies only) — wipes a pilot company's TEST DATA so it
  // can start real usage clean, without re-provisioning logins. Permanent lifecycle operation, made safe by
  // a mandatory two-step: the company must be SUSPENDED first (its users are already blocked), so an
  // actively-used company can never be wiped in one click — suspend → reset → reactivate. Deletes the
  // tenant's rows across every tenant-scoped table EXCEPT the preserve-set above, then re-seeds the
  // fresh-tenant defaults (fiscal year + industry CoA) exactly like provisionTenant. FK-safe: fixpoint
  // delete passes with a savepoint per table (children clear first naturally; blocked tables retry next
  // pass). If a table can never clear — e.g. a future preserved-table FK into wiped data — the whole
  // request tx ROLLS BACK: atomic, never a partial wipe. Requires typing the company code (confirm). ──
  async factoryResetTenant(id: number, by: string, confirm: string) {
    const [t] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found', messageTh: 'ไม่พบบริษัท' });
    if (!t.suspendedAt)
      throw new ConflictException({ code: 'TENANT_NOT_SUSPENDED', message: 'Suspend the company first — factory reset only runs on a suspended company (suspend → reset → reactivate)', messageTh: 'ต้องระงับบริษัทก่อนจึงจะล้างข้อมูลได้ (ระงับ → ล้างข้อมูล → คืนสถานะ)' });
    if ((confirm ?? '').trim() !== t.code)
      throw new BadRequestException({ code: 'CONFIRM_MISMATCH', message: 'Type the company code exactly to confirm the reset', messageTh: `พิมพ์รหัสบริษัท "${t.code}" ให้ตรงเพื่อยืนยันการล้างข้อมูล` });

    // Same runtime enumeration the RLS loop migrations use — every BASE TABLE carrying a tenant_id column
    // is tenant-scoped by convention (platform tables name theirs about_tenant_id/created_tenant_id).
    const { targeted, rowsDeleted } = await wipeTenantRefs(
      this.db, id, await tenantIdColumns(this.db), FACTORY_RESET_PRESERVE, 'FACTORY_RESET_BLOCKED',
      (names) => `Reset blocked — tables still referenced: ${names}`,
      () => 'ล้างข้อมูลไม่สำเร็จ — มีตารางที่ยังถูกอ้างอิงจากข้อมูลที่ระบบต้องเก็บไว้',
    );

    // Re-seed the fresh-tenant defaults so the company is immediately usable (mirrors provisionTenant).
    const industry = isIndustryKey((t as { industry?: string }).industry) ? (t as { industry?: string }).industry! : 'general';
    if (this.ledger) {
      await this.ledger.provisionFiscalYear(Number(ymd().slice(0, 4)), id);
      await this.ledger.provisionTenantCoA(id, industry);
    }

    logger.warn({ event: 'tenant_factory_reset', tenant_id: id, by, tables: targeted, rows: rowsDeleted }, 'company factory reset');
    await this.platformNotifs?.emit({ type: 'tenant_factory_reset', title: `ล้างข้อมูลบริษัท #${id} (${t.code})`, body: `โดย ${by} — ลบ ${rowsDeleted} แถวจาก ${targeted} ตาราง แล้วตั้งค่าเริ่มต้นใหม่`, tenantId: id, refType: 'tenant', refId: String(id) });
    return { tenant_id: id, status: 'reset', tables_wiped: targeted, rows_deleted: rowsDeleted };
  }

  // Core provisioning — tenant + its OWN org + an Admin + a trialing subscription + fiscal year + industry
  // CoA — shared by the PUBLIC signup path (gated above) and the AUTHENTICATED platform-admin create-company
  // endpoint (POST /api/admin/tenants). No public-signup gate here; each caller gates as appropriate. Runs
  // under whatever RLS scope the request carries: public signup is pre-auth (bypass); the admin endpoint
  // runs with the platform-admin bypass granted by PlatformAdminGuard (both can write a brand-new tenant_id).
  async provisionTenant(dto: SignupDto, opts?: { passwordHash?: string }) {
    const db = this.db;
    const code = dto.tenant_code.trim();
    const username = normalizeUsername(dto.admin_username);
    const planCode = dto.plan_code?.trim() || 'free';

    // A provisioned Admin whose username is on PLATFORM_ADMIN_USERNAMES would silently gain the god
    // cross-tenant bypass (isPlatformAdmin is membership-by-username alone). Refuse it — a platform owner
    // is never provisioned through the tenant-signup path (security review L-4). Checked FIRST so the reason
    // is RESERVED_USERNAME, not the generic "username taken".
    if (isPlatformAdmin(username))
      throw new BadRequestException({ code: 'RESERVED_USERNAME', message: 'This username is reserved and cannot be used for a company admin', messageTh: 'ชื่อผู้ใช้นี้สงวนไว้ ไม่สามารถใช้เป็นผู้ดูแลบริษัทได้' });

    // tenant code must be unique
    const [existsTenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, code)).limit(1);
    if (existsTenant) throw new ConflictException({ code: 'CONFLICT', message: 'Tenant code already taken', messageTh: 'รหัสร้านนี้ถูกใช้แล้ว' });

    // username must be unique (users.username is globally unique)
    const [existsUser] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existsUser) throw new ConflictException({ code: 'CONFLICT', message: 'Username already taken', messageTh: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' });

    // plan must exist
    const [plan] = await db.select().from(plans).where(eq(plans.code, planCode)).limit(1);
    if (!plan) throw new BadRequestException({ code: 'BAD_REQUEST', message: `Unknown plan: ${planCode}`, messageTh: 'ไม่พบแพ็กเกจที่เลือก' });

    const passwordHash = opts?.passwordHash ?? await this.password.hash(dto.admin_password);
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const industry = isIndustryKey(dto.industry) ? dto.industry : 'general';
    // SME single-user edition (docs/49) — the edition chosen at creation. An SME company is stamped with
    // a per-tenant COPY of the platform SME defaults (hidden nav groups, SME-01 accountant routing), so
    // later default changes affect only future companies. Transition is upgrade-only afterwards.
    const controlProfile = dto.control_profile === 'sme' ? 'sme' : 'enterprise';
    let smePrefs: Record<string, unknown> = {};
    if (controlProfile === 'sme') {
      const [d] = await db.select().from(platformSmeDefaults).where(eq(platformSmeDefaults.id, 1)).limit(1);
      smePrefs = {
        hidden_nav_groups: Array.isArray(d?.hiddenNavGroups) ? d!.hiddenNavGroups : [],
        accountant_email: d?.accountantEmail ?? null,
      };
    }

    const tenant = await db.transaction(async (tx: any) => {
      const [t] = await tx.insert(tenants).values({
        code, name: dto.company_name, contactName: username, email: dto.email, industry,
        controlProfile, smePrefs,
        // tax identity — legalName defaults to the company name; the rest the setup wizard completes
        legalName: dto.legal_name ?? dto.company_name,
        taxId: dto.tax_id ?? null,
        vatRegistered: dto.vat_registered ?? false,
        vatRate: dto.vat_rate != null ? String(dto.vat_rate) : '0.0700',
      }).returning({ id: tenants.id, code: tenants.code, name: tenants.name });

      // Multi-company tenancy (ITGC-AC-18): give each new company its OWN org — org_id = its own tenant id.
      // Under TENANCY_MODE=multi-company this keeps the new Admin org-scoped to just this company (isolated
      // from every other tenant), and lets future sibling accounts join by sharing this org_id. It also
      // means new signups never need the org_id backfill the multi-company boot warning asks about.
      const orgId = Number(t.id);
      await tx.update(tenants).set({ orgId }).where(eq(tenants.id, orgId));

      await tx.insert(users).values({
        username, passwordHash, role: 'Admin', tenantId: Number(t.id), orgId,
      });

      await tx.insert(subscriptions).values({
        tenantId: Number(t.id), planCode, status: 'Trialing', trialEndsAt,
      });

      return t;
    });

    // provision the current fiscal year's periods so the new tenant can post immediately (A4),
    // then materialise the chosen industry Chart-of-Accounts template into the tenant's overlay (GL-10).
    if (this.ledger) {
      await this.ledger.provisionFiscalYear(Number(ymd().slice(0, 4)), Number(tenant.id));
      await this.ledger.provisionTenantCoA(Number(tenant.id), industry);
    }

    // SME-01 auto-schedule (docs/49 v1.2, audit gap G2) — the detective compensating control must OPERATE
    // by design, not by someone remembering to configure it: every SME company is born with an ACTIVE
    // monthly `sme_self_approval_review` subscription. Recipients = the stamped external-accountant email
    // (when the platform defaults carry one); the in-app notification always fires per run, and the
    // governance generator additionally raises a god-inbox platform notification when self-approvals exist
    // (the platform-owner leg). nextRunAt=now ⇒ the first sweep runs on the next scheduler tick.
    if (controlProfile === 'sme') {
      const accountantEmail = (smePrefs as { accountant_email?: string | null }).accountant_email ?? null;
      await db.insert(reportSubscriptions).values({
        tenantId: Number(tenant.id), name: 'ทบทวนการอนุมัติด้วยตนเอง (SME-01)', reportType: 'sme_self_approval_review',
        filters: { days: 31 }, frequency: 'monthly', recipients: accountantEmail ? [{ email: accountantEmail }] : [],
        isActive: true, nextRunAt: new Date(), createdBy: username,
      });
    }

    // Onboarding #5 — operator-visible provisioning signal (the audit_log already records the mutation +
    // actor; this is the ops "a new company was created" notification). A user-facing welcome email/LINE to
    // the new admin is a follow-on — it needs the admin's channel, which isn't set up yet at provision time.
    logger.info({ event: 'tenant_provisioned', tenant_id: Number(tenant.id), code: tenant.code, admin: username, industry }, 'company provisioned');
    await this.platformNotifs?.emit({ type: 'company_provisioned', title: `เปิดบริษัทใหม่: ${tenant.name}`, body: `รหัส ${tenant.code} · แพ็กเกจ ${planCode} · ผู้ดูแล ${username}`, tenantId: Number(tenant.id), refType: 'tenant', refId: String(tenant.id) });
    return {
      tenant_id: Number(tenant.id),
      tenant_code: tenant.code,
      tenant_name: tenant.name,
      admin_username: username,
      plan: planCode,
      industry,
      control_profile: controlProfile,
      trial_ends_at: trialEndsAt.toISOString(),
      fiscal_year_provisioned: Number(ymd().slice(0, 4)),
    };
  }

  // Resolve the tenantId for an authenticated user. Admins created via signup carry
  // tenantId on their users row; customer users carry it via customerName (tenant code).
  async resolveTenantId(user: { username: string; customerName: string | null }): Promise<number> {
    const db = this.db;
    if (user.customerName) {
      const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, user.customerName)).limit(1);
      if (t) return Number(t.id);
    }
    const [u] = await db.select({ tenantId: users.tenantId }).from(users).where(eq(users.username, user.username)).limit(1);
    if (!u || u.tenantId == null) throw new NotFoundException({ code: 'NO_TENANT', message: 'No tenant resolved for user', messageTh: 'ไม่พบร้านของผู้ใช้' });
    return Number(u.tenantId);
  }
}
