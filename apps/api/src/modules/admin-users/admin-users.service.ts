import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException, UnprocessableEntityException, ForbiddenException, Logger } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users, userPermissions, tenants, accessReviews, accessReviewItems, accessGrantExceptions } from '../../database/schema';
import { PasswordService } from '../auth/password.service';
import { BillingService } from '../billing/billing.service';
import { DocNumberService } from '../../common/doc-number.service';
import { resolvePermissions, detectSodConflicts, type Role, type Permission } from '@ierp/shared';
import { appendAuditMeta } from '../../common/tenant-context';
import { assertMakerChecker } from '../../common/control-profile';
import { isPlatformAdmin, type JwtUser } from '../../common/decorators';
import { normalizeUsername } from '../../common/username';

export interface CreateUserDto { username: string; password: string; role: string; customer_name?: string; permissions?: string[]; allow_sod_override?: boolean; sod_reason?: string }
export interface UpdateUserDto { role?: string; customer_name?: string; permissions?: string[]; allow_sod_override?: boolean; sod_reason?: string }

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger('AdminUsers');
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly passwords: PasswordService,
    private readonly billing: BillingService,
    private readonly docNo: DocNumberService,
  ) {}

  // Detective log for a GRANDFATHERED role-default conflict (legacy coarse roles in transition): a bare
  // role assignment (no per-user override) is not blocked, but the outstanding conflict is surfaced for the
  // quarterly UAR. A per-user override REPLACES the role default (resolvePermissions precedence), so when an
  // override IS supplied the override set is what we evaluate (see sodConflictOrThrow).
  private logGrandfatheredRoleConflict(username: string, role: string | undefined) {
    if (!role) return;
    const roleConflicts = detectSodConflicts(resolvePermissions(role as Role));
    if (roleConflicts.length) this.logger.warn(`Grandfathered SoD conflict on role "${role}" for "${username}" — rules ${roleConflicts.map((c) => c.ruleId).join(',')}; tracked by quarterly UAR.`);
  }

  // Preventive SoD guard (ITGC-AC-09): a per-user permission OVERRIDE holding duties on both sides of a
  // conflict rule is BLOCKED (422 SOD_CONFLICT) unless the admin supplies allow_sod_override + a reason.
  // Returns the conflicts (empty if none). When it returns a NON-empty list, the caller must NOT apply the
  // grant directly — per audit G11 a SoD exception is a two-person control: it is STAGED for approval by a
  // DIFFERENT admin (stageException) rather than self-authorized by the grantor.
  private sodConflictOrThrow(perms: string[] | undefined, allowOverride?: boolean, reason?: string) {
    const conflicts = perms?.length ? detectSodConflicts(perms as Permission[]) : [];
    if (!conflicts.length) return conflicts;
    if (!allowOverride || !reason?.trim()) {
      throw new UnprocessableEntityException({
        code: 'SOD_CONFLICT',
        message: `Permission set creates SoD conflict(s): ${conflicts.map((c) => `${c.ruleId} (${c.dutyA} ✗ ${c.dutyB})`).join('; ')}. To proceed, set allow_sod_override=true with a sod_reason — the exception is then routed to a second admin for approval.`,
        messageTh: 'ชุดสิทธิ์ขัดกับการแบ่งแยกหน้าที่ (SoD) — ต้องระบุเหตุผลและยืนยันการข้าม แล้วส่งให้ผู้ดูแลอีกคนอนุมัติ',
        conflicts,
      });
    }
    return conflicts;
  }

  // Stage a SoD-conflicting grant as a PendingApproval exception (G11 two-person control). The grant does
  // NOT take effect until a DIFFERENT admin approves it (approveException). For a new user the password is
  // hashed and held here until approval (mirrors signup_requests).
  private async stageException(p: { isNewUser: boolean; targetUsername: string; role?: string; permissions: string[]; customerName?: string; passwordHash?: string; reason: string; rules: string[]; tenantId?: number | null }, actor: JwtUser) {
    const reqNo = await this.docNo.nextDaily('AGE');
    const tenantId = p.tenantId !== undefined ? p.tenantId : await this.tenantIdFor(p.customerName);
    await this.db.insert(accessGrantExceptions).values({
      tenantId: tenantId ?? null, reqNo, targetUsername: p.targetUsername, isNewUser: p.isNewUser ? 'true' : 'false',
      passwordHash: p.passwordHash ?? null, role: p.role ?? null, permissions: JSON.stringify(p.permissions),
      customerName: p.customerName ?? null, sodRules: p.rules.join(','), reason: p.reason, status: 'PendingApproval', requestedBy: actor.username,
    });
    this.logger.warn(`SoD exception ${reqNo} STAGED for "${p.targetUsername}" by "${actor.username}" — rules ${p.rules.join(',')}; awaiting independent approval.`);
    return { access_exception_req_no: reqNo, status: 'PendingApproval', pending: true, sod_rules: p.rules, target: p.targetUsername, message: 'SoD-conflict grant staged for independent approval by a different admin' };
  }

  // Apply a user CREATE (shared by the no-conflict create path and an approved exception).
  private async applyCreate(p: { username: string; password?: string; passwordHash?: string; role?: string; customerName?: string; permissions?: string[] }) {
    const db = this.db;
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.username, p.username)).limit(1);
    if (exists) throw new ConflictException({ code: 'USER_EXISTS', message: `User ${p.username} already exists`, messageTh: 'มีผู้ใช้นี้แล้ว' });
    const tenantId = await this.tenantIdFor(p.customerName);
    // Enforce the plan's maxUsers ceiling before inserting (PLAN_USER_LIMIT). Admin principal (tenantId=null)
    // is cross-tenant HQ — no limit applies.
    if (tenantId != null) await this.billing.checkUserLimit(tenantId);
    const hash = p.passwordHash ?? await this.passwords.hash(p.password!);
    const [u] = await db.insert(users).values({ username: p.username, passwordHash: hash, role: p.role as typeof users.$inferInsert.role, tenantId, mustChangePassword: true }).returning({ id: users.id });
    if (p.permissions?.length) await db.insert(userPermissions).values(p.permissions.map((perm) => ({ userId: Number(u!.id), perm }))).onConflictDoNothing();
    return { username: p.username, role: p.role, created: true };
  }

  // Apply a user UPDATE (shared by the no-conflict update path and an approved exception).
  private async applyUpdate(u: typeof users.$inferSelect, dto: { role?: string; customer_name?: string; permissions?: string[] }) {
    const db = this.db;
    const set: any = {};
    if (dto.role) set.role = dto.role;
    if (dto.customer_name !== undefined) set.tenantId = await this.tenantIdFor(dto.customer_name || undefined);
    // docs/27 R2-2 / AUD-SEC-02 — an authorization change takes effect IMMEDIATELY: bumping tokens_valid_from
    // rejects every earlier-issued token at the next request so the user re-authenticates with the fresh set.
    if (dto.role || dto.permissions) set.tokensValidFrom = new Date();
    if (Object.keys(set).length) await db.update(users).set(set).where(eq(users.id, u.id));
    if (dto.permissions) {
      await db.delete(userPermissions).where(eq(userPermissions.userId, Number(u.id)));
      if (dto.permissions.length) await db.insert(userPermissions).values(dto.permissions.map((perm) => ({ userId: Number(u.id), perm }))).onConflictDoNothing();
    }
    return { username: u.username, updated: true, sessions_revoked: !!(dto.role || dto.permissions) };
  }

  // Preventive privilege-escalation guard (ITGC-AC-02 authorization / ITGC-AC-09 SoD-on-provisioning):
  // ONLY the platform owner ("god", PLATFORM_ADMIN_USERNAMES — e.g. godmimi) may grant the Admin role.
  // Rationale: the Admin role carries the RLS bypass (HQ "sees all") and, in single-company mode, full
  // cross-tenant visibility — so minting an Admin is a platform-level privileged-access grant, not a
  // per-company one. Previously any company Admin could create another Admin; now that authority is
  // reserved to god so privileged access cannot proliferate inside a tenant (and a tenant-scoped
  // AccessAdmin holding `users` still cannot escalate). Applies equally to the SCIM provisioning principal.
  private assertCanGrantRole(role: string | undefined, actor: JwtUser | undefined) {
    if (role === 'Admin' && !isPlatformAdmin(actor?.username)) {
      throw new ForbiddenException({
        code: 'ADMIN_GRANT_DENIED',
        message: 'Only the platform owner may grant the Admin role',
        messageTh: 'เฉพาะเจ้าของแพลตฟอร์ม (godmimi) เท่านั้นที่สามารถให้สิทธิ์ Admin ได้',
      });
    }
  }

  private async tenantIdFor(code?: string): Promise<number | null> {
    if (!code) return null;
    const db = this.db;
    const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, code)).limit(1);
    if (!t) throw new BadRequestException({ code: 'BAD_TENANT', message: `Unknown company/tenant: ${code}`, messageTh: 'ไม่พบบริษัท/ผู้เช่า' });
    return Number(t.id);
  }

  async list() {
    const db = this.db;
    const rows = await db
      .select({ username: users.username, role: users.role, tenantId: users.tenantId, code: tenants.code, mustChange: users.mustChangePassword })
      .from(users).leftJoin(tenants, eq(users.tenantId, tenants.id)).orderBy(users.username);
    return { users: rows.map((r: any) => ({ username: r.username, role: r.role, customer_name: r.code ?? null, must_change_password: !!r.mustChange })), count: rows.length };
  }

  async create(dto: CreateUserDto, actor: JwtUser) {
    const db = this.db;
    if (!dto.password || dto.password.length < 6) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: 'Password must be ≥6 chars', messageTh: 'รหัสผ่านอย่างน้อย 6 ตัว' });
    const username = normalizeUsername(dto.username);
    if (!username) throw new BadRequestException({ code: 'BAD_USERNAME', message: 'Username is required', messageTh: 'ต้องระบุชื่อผู้ใช้' });
    this.assertCanGrantRole(dto.role, actor);
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (exists) throw new ConflictException({ code: 'USER_EXISTS', message: `User ${username} already exists`, messageTh: 'มีผู้ใช้นี้แล้ว' });
    // G11: a SoD-conflicting override is staged for a DIFFERENT admin to approve — not applied here.
    const conflicts = this.sodConflictOrThrow(dto.permissions, dto.allow_sod_override, dto.sod_reason);
    if (conflicts.length) {
      return this.stageException({ isNewUser: true, targetUsername: username, role: dto.role, permissions: dto.permissions!, customerName: dto.customer_name, passwordHash: await this.passwords.hash(dto.password), reason: dto.sod_reason!.trim(), rules: conflicts.map((c) => c.ruleId) }, actor);
    }
    this.logGrandfatheredRoleConflict(username, dto.role);
    return this.applyCreate({ username, password: dto.password, role: dto.role, customerName: dto.customer_name, permissions: dto.permissions });
  }

  async update(username: string, dto: UpdateUserDto, actor: JwtUser) {
    username = normalizeUsername(username);
    const db = this.db;
    const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    this.assertCanGrantRole(dto.role, actor);
    // G11: a SoD-conflicting override is staged for a DIFFERENT admin to approve — not applied here.
    const conflicts = this.sodConflictOrThrow(dto.permissions, dto.allow_sod_override, dto.sod_reason);
    if (conflicts.length) {
      return this.stageException({ isNewUser: false, targetUsername: username, role: dto.role, permissions: dto.permissions!, customerName: dto.customer_name, reason: dto.sod_reason!.trim(), rules: conflicts.map((c) => c.ruleId), tenantId: u.tenantId ?? null }, actor);
    }
    this.logGrandfatheredRoleConflict(username, dto.role ?? (u.role as string));
    return this.applyUpdate(u, { role: dto.role, customer_name: dto.customer_name, permissions: dto.permissions });
  }

  // ── ITGC-AC-09 (audit G11): two-person control over a SoD exception ──────────
  // List staged SoD-exception requests (the pending maker-checker queue + history).
  async listExceptions(status?: string) {
    const db = this.db;
    const rows = await db.select().from(accessGrantExceptions)
      .where(status ? eq(accessGrantExceptions.status, status) : undefined)
      .orderBy(desc(accessGrantExceptions.id)).limit(200);
    return {
      exceptions: rows.map((r: any) => ({
        req_no: r.reqNo, target_username: r.targetUsername, is_new_user: r.isNewUser === 'true', role: r.role,
        permissions: r.permissions ? JSON.parse(r.permissions) : [], customer_name: r.customerName,
        sod_rules: (r.sodRules ?? '').split(',').filter(Boolean), reason: r.reason, status: r.status,
        requested_by: r.requestedBy, requested_at: r.requestedAt, approved_by: r.approvedBy, approved_at: r.approvedAt, reject_reason: r.rejectReason,
      })),
      count: rows.length,
    };
  }

  private async pendingException(reqNo: string) {
    const [ex] = await this.db.select().from(accessGrantExceptions).where(and(eq(accessGrantExceptions.reqNo, reqNo), eq(accessGrantExceptions.status, 'PendingApproval'))).limit(1);
    if (!ex) throw new NotFoundException({ code: 'NOT_PENDING', message: `No access exception pending approval for ${reqNo}`, messageTh: 'ไม่มีคำขอข้ามสิทธิ์ที่รออนุมัติ' });
    return ex;
  }

  // Approve a staged SoD exception — the checker must differ from the requester AND from the affected user
  // (a grantor cannot self-authorize, and no one can approve granting themselves). Applies the grant on approval.
  async approveException(reqNo: string, actor: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const ex = await this.pendingException(reqNo);
    await assertMakerChecker(db, { user: actor, maker: ex.requestedBy, event: 'itgc.sod-exception.approve', ref: reqNo, reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve an access exception you requested', messageTh: 'แยกหน้าที่: ผู้ขอไม่สามารถอนุมัติคำขอข้ามสิทธิ์ของตนเองได้' });
    // Self-benefit authorization (approving an exception that grants YOURSELF) stays a hard block even under docs/49 SME mode — it is not plain maker-checker.
    if (ex.targetUsername === actor.username) throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve an access exception that grants yourself', messageTh: 'แยกหน้าที่: อนุมัติการให้สิทธิ์แก่ตนเองไม่ได้' });
    const permissions: string[] = ex.permissions ? JSON.parse(ex.permissions) : [];
    // ITGC-AC-09 evidence: persist WHO requested, WHO approved, WHY, and the rules into the hash-chained audit row.
    appendAuditMeta({ sod_override: { username: ex.targetUsername, requested_by: ex.requestedBy, approved_by: actor.username, reason: ex.reason, rules: (ex.sodRules ?? '').split(',').filter(Boolean) } });
    const applied = ex.isNewUser === 'true'
      ? await this.applyCreate({ username: ex.targetUsername, passwordHash: ex.passwordHash ?? undefined, role: ex.role ?? undefined, customerName: ex.customerName ?? undefined, permissions })
      : await (async () => {
          const [u] = await db.select().from(users).where(eq(users.username, ex.targetUsername)).limit(1);
          if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
          return this.applyUpdate(u, { role: ex.role ?? undefined, customer_name: ex.customerName ?? undefined, permissions });
        })();
    await db.update(accessGrantExceptions).set({ status: 'Approved', approvedBy: actor.username, approvedAt: new Date() }).where(eq(accessGrantExceptions.id, Number(ex.id)));
    return { req_no: reqNo, status: 'Approved', approved_by: actor.username, requested_by: ex.requestedBy, target: ex.targetUsername, ...applied };
  }

  async rejectException(reqNo: string, actor: JwtUser, reason?: string) {
    const db = this.db;
    const ex = await this.pendingException(reqNo);
    await db.update(accessGrantExceptions).set({ status: 'Rejected', approvedBy: actor.username, approvedAt: new Date(), rejectReason: reason ?? null }).where(eq(accessGrantExceptions.id, Number(ex.id)));
    return { req_no: reqNo, status: 'Rejected', rejected_by: actor.username };
  }

  async resetPassword(username: string, newPassword: string) {
    if (!newPassword || newPassword.length < 6) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: 'Password must be ≥6 chars', messageTh: 'รหัสผ่านอย่างน้อย 6 ตัว' });
    username = normalizeUsername(username);
    const db = this.db;
    const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    const hash = await this.passwords.hash(newPassword);
    await db.update(users).set({ passwordHash: hash, mustChangePassword: true }).where(eq(users.id, u.id));
    return { username, reset: true };
  }

  // ── ITGC-AC-08: User Access Review ──────────────────────────────────────────
  // Build the recertification dataset: every user with role, effective (resolved+expanded) permissions,
  // and any SoD conflicts — the population a reviewer signs off each quarter.
  private async buildReview() {
    const db = this.db;
    const us = await db.select({ id: users.id, username: users.username, role: users.role, code: tenants.code })
      .from(users).leftJoin(tenants, eq(users.tenantId, tenants.id)).orderBy(users.username);
    const ups = await db.select({ userId: userPermissions.userId, perm: userPermissions.perm }).from(userPermissions);
    const byUser = new Map<number, string[]>();
    for (const r of ups) { const k = Number(r.userId); const arr = byUser.get(k) ?? []; arr.push(r.perm); byUser.set(k, arr); }
    return us.map((u: any) => {
      const overrides = byUser.get(Number(u.id)) ?? [];
      const effective = resolvePermissions(u.role as Role, overrides.length ? (overrides as Permission[]) : null);
      const conflicts = detectSodConflicts(effective);
      return {
        username: u.username, role: u.role, customer_name: u.code ?? null,
        has_override: overrides.length > 0,
        permission_count: effective.length,
        permissions: [...effective].sort(),
        sod_conflict_count: conflicts.length,
        sod_conflicts: conflicts.map((c) => c.ruleId),
      };
    });
  }

  async accessReview() {
    const rows = await this.buildReview();
    return {
      report: 'User Access Review (effective permissions + SoD conflicts)',
      generated: true,
      summary: { total_users: rows.length, users_with_conflicts: rows.filter((r: any) => r.sod_conflict_count > 0).length, users_with_override: rows.filter((r: any) => r.has_override).length },
      users: rows,
    };
  }

  // CSV export for the reviewer to annotate keep/revoke and retain as audit evidence.
  async exportReviewCsv(): Promise<string> {
    const rows = await this.buildReview();
    const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = ['username', 'role', 'customer_name', 'has_override', 'permission_count', 'sod_conflict_count', 'sod_conflicts', 'permissions', 'decision_keep_revoke', 'reviewer_note'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([r.username, r.role, r.customer_name, r.has_override, r.permission_count, r.sod_conflict_count, r.sod_conflicts.join('|'), r.permissions.join('|'), '', ''].map(esc).join(','));
    }
    return lines.join('\n');
  }

  // Record the periodic recertification sign-off (attestation evidence).
  async certifyReview(dto: { period: string; notes?: string }, user: JwtUser) {
    const db = this.db;
    const rows = await this.buildReview();
    const [r] = await db.insert(accessReviews).values({
      period: dto.period, reviewedBy: user.username, tenantId: user.tenantId ?? null, notes: dto.notes ?? null,
      userCount: rows.length, conflictUserCount: rows.filter((x: any) => x.sod_conflict_count > 0).length,
    }).returning({ id: accessReviews.id });
    return { id: Number(r!.id), period: dto.period, reviewed_by: user.username, user_count: rows.length, certified: true };
  }

  async listReviews() {
    const db = this.db;
    const rows = await db.select().from(accessReviews).orderBy(desc(accessReviews.id)).limit(50);
    return { reviews: rows.map((r: any) => ({ id: Number(r.id), period: r.period, reviewed_by: r.reviewedBy, reviewed_at: r.reviewedAt, user_count: r.userCount, conflict_user_count: r.conflictUserCount, status: r.status ?? 'certified', items_total: r.itemsTotal, items_revoked: r.itemsRevoked, notes: r.notes })), count: rows.length };
  }

  // ── ITGC-AC-21: line-item Access Recertification Campaign (closed-loop revocation) ─────────────
  // Open a campaign — snapshot the buildReview() population into access_review_items, each 'pending'. The
  // reviewer then keeps/revokes every user in-app (decideItem), and certifyCampaign finalizes it: each
  // 'revoke' decision ACTUALLY removes that user's permission grants (actioned=true; the closed loop).
  async openCampaign(dto: { period: string; notes?: string }, user: JwtUser) {
    const db = this.db;
    const rows = await this.buildReview();
    const tenantId = user.tenantId ?? null;
    const [rev] = await db.insert(accessReviews).values({
      period: dto.period, reviewedBy: user.username, tenantId, notes: dto.notes ?? null,
      userCount: rows.length, conflictUserCount: rows.filter((x: any) => x.sod_conflict_count > 0).length,
      status: 'open', itemsTotal: rows.length,
    }).returning({ id: accessReviews.id });
    const reviewId = Number(rev!.id);
    if (rows.length) {
      await db.insert(accessReviewItems).values(rows.map((r) => ({
        tenantId, reviewId, username: r.username, role: r.role as string | null,
        currentPerms: JSON.stringify(r.permissions), decision: 'pending',
      })));
    }
    return { id: reviewId, period: dto.period, status: 'open', items_total: rows.length, opened_by: user.username };
  }

  private async campaignOrThrow(id: number) {
    const [rev] = await this.db.select().from(accessReviews).where(eq(accessReviews.id, id)).limit(1);
    if (!rev) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND', message: `Access-review campaign ${id} not found`, messageTh: 'ไม่พบแคมเปญทบทวนสิทธิ์' });
    return rev;
  }

  // The line items of a campaign (the keep/revoke worklist + evidence).
  async getCampaign(id: number) {
    const db = this.db;
    const rev = await this.campaignOrThrow(id);
    const items = await db.select().from(accessReviewItems).where(eq(accessReviewItems.reviewId, id)).orderBy(accessReviewItems.username);
    return {
      id, period: rev.period, status: rev.status, opened_by: rev.reviewedBy, opened_at: rev.reviewedAt,
      items_total: rev.itemsTotal, items_revoked: rev.itemsRevoked, notes: rev.notes,
      pending: items.filter((i: any) => i.decision === 'pending').length,
      items: items.map((i: any) => ({
        username: i.username, role: i.role, decision: i.decision, reviewer: i.reviewer, decided_at: i.decidedAt,
        actioned: i.actioned, notes: i.notes, current_perms: i.currentPerms ? JSON.parse(i.currentPerms) : [],
      })),
    };
  }

  // Disposition one user's line: keep or revoke (+ optional note). A certified campaign is frozen.
  async decideItem(campaignId: number, username: string, dto: { decision: string; notes?: string }, user: JwtUser) {
    const db = this.db;
    username = normalizeUsername(username);
    const decision = dto.decision;
    if (decision !== 'keep' && decision !== 'revoke') throw new BadRequestException({ code: 'BAD_DECISION', message: "decision must be 'keep' or 'revoke'", messageTh: "ต้องเป็น 'keep' หรือ 'revoke'" });
    const rev = await this.campaignOrThrow(campaignId);
    if (rev.status === 'certified') throw new UnprocessableEntityException({ code: 'CAMPAIGN_CERTIFIED', message: 'Campaign already certified — line items are frozen', messageTh: 'แคมเปญรับรองแล้ว — ไม่สามารถแก้ไขรายการได้' });
    const [item] = await db.select().from(accessReviewItems).where(and(eq(accessReviewItems.reviewId, campaignId), eq(accessReviewItems.username, username))).limit(1);
    if (!item) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: `No line for ${username} in campaign ${campaignId}`, messageTh: 'ไม่พบรายการผู้ใช้ในแคมเปญ' });
    await db.update(accessReviewItems).set({ decision, reviewer: user.username, decidedAt: new Date(), notes: dto.notes ?? null }).where(eq(accessReviewItems.id, Number(item.id)));
    if (rev.status === 'open') await db.update(accessReviews).set({ status: 'in_review' }).where(eq(accessReviews.id, campaignId));
    return { campaign_id: campaignId, username, decision, reviewer: user.username };
  }

  // Finalize the campaign (ITGC-AC-21): every line must be decided (ITEMS_PENDING otherwise), and for each
  // 'revoke' the user's permission grants are ACTUALLY removed — the closed loop — recording actioned=true.
  async certifyCampaign(id: number, user: JwtUser) {
    const db = this.db;
    const rev = await this.campaignOrThrow(id);
    if (rev.status === 'certified') throw new UnprocessableEntityException({ code: 'CAMPAIGN_CERTIFIED', message: 'Campaign already certified', messageTh: 'แคมเปญนี้รับรองแล้ว' });
    const items = await db.select().from(accessReviewItems).where(eq(accessReviewItems.reviewId, id));
    const pending = items.filter((i: any) => i.decision === 'pending');
    if (pending.length) throw new UnprocessableEntityException({ code: 'ITEMS_PENDING', message: `${pending.length} line item(s) still pending a keep/revoke decision`, messageTh: `ยังมี ${pending.length} รายการที่ยังไม่ได้ตัดสิน (keep/revoke)`, pending: pending.map((i: any) => i.username) });
    const toRevoke = items.filter((i: any) => i.decision === 'revoke');
    for (const item of toRevoke) {
      const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, item.username)).limit(1);
      if (u) {
        // Closed loop: drop the user's permission overrides and bump the token watermark so the narrowing
        // takes effect immediately (mirrors applyUpdate / docs/27 R2-2), then stamp the line actioned.
        await db.delete(userPermissions).where(eq(userPermissions.userId, Number(u.id)));
        await db.update(users).set({ tokensValidFrom: new Date() }).where(eq(users.id, u.id));
      }
      await db.update(accessReviewItems).set({ actioned: true }).where(eq(accessReviewItems.id, Number(item.id)));
    }
    await db.update(accessReviews).set({ status: 'certified', reviewedBy: user.username, reviewedAt: new Date(), itemsRevoked: toRevoke.length }).where(eq(accessReviews.id, id));
    return { id, period: rev.period, status: 'certified', certified_by: user.username, items_total: items.length, items_kept: items.length - toRevoke.length, items_revoked: toRevoke.length, revoked_users: toRevoke.map((i: any) => i.username) };
  }

  async remove(username: string, actor: JwtUser) {
    username = normalizeUsername(username);
    if (username === actor.username) throw new BadRequestException({ code: 'SELF_DELETE', message: 'Cannot delete yourself', messageTh: 'ลบบัญชีตัวเองไม่ได้' });
    const db = this.db;
    const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    await db.delete(userPermissions).where(eq(userPermissions.userId, Number(u.id)));
    await db.delete(users).where(eq(users.id, u.id));
    return { username, deleted: true };
  }
}
