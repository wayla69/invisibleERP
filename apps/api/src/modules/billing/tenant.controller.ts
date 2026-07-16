import { Body, Controller, Get, Inject, Param, Patch, Post, HttpCode, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants, branches, users, menuItems, tenantProfileChangeRequests } from '../../database/schema';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { assertMakerChecker, SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { BillingService } from './billing.service';
import { StarterPackService } from './starter-pack.service';
import { TaxService } from '../tax/tax.service';
import { isValidPromptPayTarget } from '../payments/promptpay-qr';

// Company identity / tax profile for the current tenant — backs the setup wizard. RLS scopes a tenant
// admin to their own row; HQ/Admin edits their own tenant (we resolve the id from the user explicitly).
const ProfileBody = z.object({
  legal_name: z.string().optional(),
  name: z.string().optional(),
  tax_id: z.string().optional(),
  branch_code: z.string().optional(),
  vat_registered: z.boolean().optional(),
  vat_rate: z.number().min(0).max(1).optional(),
  tax_country: z.string().length(2).optional(),
  phone: z.string().optional(),
  fax: z.string().optional(),
  email: z.string().email().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  sub_district: z.string().optional(),
  district: z.string().optional(),
  province: z.string().optional(),
  postal_code: z.string().optional(),
  // PromptPay merchant id — mobile (0xxxxxxxxx) or 13-digit national/tax id; '' clears it.
  promptpay_id: z.string().refine((v) => v === '' || isValidPromptPayTarget(v), 'invalid PromptPay id').optional(),
  default_language: z.enum(['th', 'en']).optional(), // customer-facing output language
  // ── Branding (Phase 9) ── logo is a pasted https URL or a small image data-URI; '' clears it.
  logo_url: z.string().max(500_000).refine((v) => v === '' || ((/^https:\/\//i.test(v) || /^data:image\/(png|jpe?g|svg\+xml|webp);base64,/i.test(v)) && !/["'<>]/.test(v)), 'logo_url must be an https URL or an image data-URI').optional(),
  tagline: z.string().max(200).optional(),
  branding_prefs: z.record(z.unknown()).optional(),
});
type ProfileBody = z.infer<typeof ProfileBody>;

@Controller('api/tenant')
export class TenantController {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly billing: BillingService,
    private readonly tax: TaxService,
    private readonly starterPackSvc: StarterPackService,
  ) {}

  @Get('profile')
  @Permissions('users')
  async getProfile(@CurrentUser() user: JwtUser) {
    const id = await this.billing.resolveTenantId({ username: user.username, customerName: user.customerName });
    const [t] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return this.fmt(t);
  }

  @Patch('profile')
  @Permissions('users')
  async updateProfile(@Body(new ZodValidationPipe(ProfileBody)) b: ProfileBody, @CurrentUser() user: JwtUser) {
    const id = await this.billing.resolveTenantId({ username: user.username, customerName: user.customerName });
    const [cur] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    // G15 (maker-checker): tax_id and promptpay_id are payment-integrity / legal-identity fields — the
    // PromptPay id decides which target RECEIVES customer QR payments — so a *change* to either is NOT applied
    // here; it is staged for a distinct approver (see stageProfileChange). All other profile fields (address,
    // phone, branding, VAT flags) still apply immediately. A no-op (same value) never stages.
    const patch: Record<string, unknown> = {};
    const map: Record<string, string> = {
      legal_name: 'legalName', name: 'name', branch_code: 'branchCode',
      vat_registered: 'vatRegistered', tax_country: 'taxCountry', phone: 'phone', fax: 'fax', email: 'email',
      address_line1: 'addressLine1', address_line2: 'addressLine2', sub_district: 'subDistrict',
      district: 'district', province: 'province', postal_code: 'postalCode',
      default_language: 'defaultLanguage', logo_url: 'logoUrl', tagline: 'tagline',
    };
    for (const [k, col] of Object.entries(map)) if (b[k as keyof ProfileBody] !== undefined) patch[col] = b[k as keyof ProfileBody];
    if (b.vat_rate !== undefined) patch.vatRate = String(b.vat_rate);
    if (b.branding_prefs !== undefined) patch.brandingPrefs = b.branding_prefs;
    if (Object.keys(patch).length) await this.db.update(tenants).set(patch).where(eq(tenants.id, id));
    if (b.vat_rate !== undefined || b.tax_country !== undefined) this.tax.invalidateTenantTax(id); // drop stale cache

    // Stage the sensitive fields if either is genuinely changing.
    const newTaxId = b.tax_id !== undefined && b.tax_id !== (cur?.taxId ?? null) ? b.tax_id : undefined;
    const newPromptpay = b.promptpay_id !== undefined && b.promptpay_id !== (cur?.promptpayId ?? null) ? b.promptpay_id : undefined;
    let pendingChange: { req_no: string; fields: string[] } | undefined;
    if (newTaxId !== undefined || newPromptpay !== undefined) {
      pendingChange = await this.stageProfileChange(id, user, cur, newTaxId, newPromptpay);
    }
    const [t] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return { ...this.fmt(t), ...(pendingChange ? { pending_change: pendingChange } : {}) };
  }

  // G15 helper: park a change to tax_id / promptpay_id as PendingApproval (one open request per tenant).
  private async stageProfileChange(tenantId: number, user: JwtUser, cur: any, taxId?: string, promptpayId?: string) {
    // Supersede any earlier still-open request for this tenant so the queue holds only the latest.
    await this.db.update(tenantProfileChangeRequests)
      .set({ status: 'Superseded' })
      .where(and(eq(tenantProfileChangeRequests.tenantId, tenantId), eq(tenantProfileChangeRequests.status, 'PendingApproval')));
    const [row] = await this.db.insert(tenantProfileChangeRequests).values({
      tenantId, reqNo: 'TPC-PENDING',
      promptpayId: promptpayId ?? null, taxId: taxId ?? null,
      prevPromptpayId: cur?.promptpayId ?? null, prevTaxId: cur?.taxId ?? null,
      status: 'PendingApproval', requestedBy: user.username,
    }).returning({ id: tenantProfileChangeRequests.id });
    const reqNo = `TPC-${String(Number(row!.id)).padStart(5, '0')}`;
    await this.db.update(tenantProfileChangeRequests).set({ reqNo }).where(eq(tenantProfileChangeRequests.id, Number(row!.id)));
    const fields = [taxId !== undefined ? 'tax_id' : null, promptpayId !== undefined ? 'promptpay_id' : null].filter(Boolean) as string[];
    return { req_no: reqNo, fields };
  }

  // Checker queue — profile changes awaiting approval.
  @Get('profile-approvals')
  @Permissions('users', 'exec', 'approvals')
  async pendingProfileChanges(@CurrentUser() user: JwtUser) {
    const id = await this.billing.resolveTenantId({ username: user.username, customerName: user.customerName });
    const rows = await this.db.select().from(tenantProfileChangeRequests)
      .where(and(eq(tenantProfileChangeRequests.tenantId, id), eq(tenantProfileChangeRequests.status, 'PendingApproval')))
      .orderBy(desc(tenantProfileChangeRequests.id));
    return { pending: rows.map((r: any) => ({ req_no: r.reqNo, tax_id: r.taxId, promptpay_id: r.promptpayId, prev_tax_id: r.prevTaxId, prev_promptpay_id: r.prevPromptpayId, requested_by: r.requestedBy, requested_at: r.requestedAt })), count: rows.length };
  }

  // Approve a staged profile change (checker; approver ≠ requester → 403 SOD_VIOLATION). Applies to `tenants`.
  @Post('profile-approvals/:reqNo/approve')
  @HttpCode(200)
  @Permissions('exec', 'approvals')
  async approveProfileChange(@Param('reqNo') reqNo: string, @CurrentUser() user: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    const id = await this.billing.resolveTenantId({ username: user.username, customerName: user.customerName });
    const [r] = await this.db.select().from(tenantProfileChangeRequests)
      .where(and(eq(tenantProfileChangeRequests.tenantId, id), eq(tenantProfileChangeRequests.reqNo, reqNo))).limit(1);
    if (!r || r.status !== 'PendingApproval') throw new NotFoundException({ code: 'NO_PENDING_PROFILE_CHANGE', message: 'No profile change pending approval', messageTh: 'ไม่พบคำขอเปลี่ยนข้อมูลที่รออนุมัติ' });
    await assertMakerChecker(this.db, { user, maker: r.requestedBy, event: 'tenant.profile-change.approve', ref: reqNo, reason: b?.self_approval_reason, code: 'SOD_VIOLATION', message: 'The requester cannot approve their own profile change', messageTh: 'ผู้ขอไม่สามารถอนุมัติคำขอของตนเองได้' });
    const patch: Record<string, unknown> = {};
    if (r.taxId !== null) patch.taxId = r.taxId;
    if (r.promptpayId !== null) patch.promptpayId = r.promptpayId;
    if (Object.keys(patch).length) await this.db.update(tenants).set(patch).where(eq(tenants.id, id));
    await this.db.update(tenantProfileChangeRequests).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() }).where(eq(tenantProfileChangeRequests.id, Number(r.id)));
    const [t] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return { req_no: reqNo, status: 'Approved', approved_by: user.username, requested_by: r.requestedBy, profile: this.fmt(t) };
  }

  @Post('profile-approvals/:reqNo/reject')
  @HttpCode(200)
  @Permissions('exec', 'approvals')
  async rejectProfileChange(@Param('reqNo') reqNo: string, @Body(new ZodValidationPipe(z.object({ reason: z.string().optional() }))) body: { reason?: string }, @CurrentUser() user: JwtUser) {
    const id = await this.billing.resolveTenantId({ username: user.username, customerName: user.customerName });
    const [r] = await this.db.select().from(tenantProfileChangeRequests)
      .where(and(eq(tenantProfileChangeRequests.tenantId, id), eq(tenantProfileChangeRequests.reqNo, reqNo))).limit(1);
    if (!r || r.status !== 'PendingApproval') throw new NotFoundException({ code: 'NO_PENDING_PROFILE_CHANGE', message: 'No profile change pending approval', messageTh: 'ไม่พบคำขอเปลี่ยนข้อมูลที่รออนุมัติ' });
    await this.db.update(tenantProfileChangeRequests).set({ status: 'Rejected', rejectReason: body.reason ?? null }).where(eq(tenantProfileChangeRequests.id, Number(r.id)));
    return { req_no: reqNo, status: 'Rejected', rejected_by: user.username };
  }

  // Onboarding checklist (ITGC-AC-18 #4) — the setup wizard's data backbone. Reports which first-run steps
  // a new company has completed + the next one, so the UI can guide it to a productive state.
  @Get('onboarding-status')
  @Permissions('users')
  async onboardingStatus(@CurrentUser() user: JwtUser) {
    const id = await this.billing.resolveTenantId({ username: user.username, customerName: user.customerName });
    const [t] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    const countOf = async (tbl: any, col: any) => Number((await this.db.select({ n: sql<number>`count(*)` }).from(tbl).where(eq(col, id)))[0]?.n ?? 0);
    const profileComplete = !!(t?.legalName && t?.taxId && t?.addressLine1 && t?.province);
    const [branchN, userN, menuN] = await Promise.all([
      countOf(branches, branches.tenantId), countOf(users, users.tenantId), countOf(menuItems, menuItems.tenantId),
    ]);
    const steps = [
      { key: 'profile', label_th: 'กรอกข้อมูลบริษัท/ภาษี (ชื่อจดทะเบียน เลขภาษี ที่อยู่)', done: profileComplete, action: 'PATCH /api/tenant/profile' },
      { key: 'branch', label_th: 'ตั้งสาขา/สำนักงานใหญ่', done: branchN > 0, action: 'POST /api/tenant/starter-pack (สร้าง HQ ให้อัตโนมัติ) หรือเพิ่มสาขาเอง' },
      { key: 'staff', label_th: 'เพิ่มผู้ใช้พนักงาน', done: userN > 1, action: 'เพิ่มผู้ใช้ในเมนู Administration' },
      { key: 'catalog', label_th: 'เพิ่มสินค้า/เมนู', done: menuN > 0, action: 'เพิ่มเมนู/สินค้าใน POS/Inventory' },
    ];
    const done = steps.filter((s) => s.done).length;
    return { tenant_id: id, steps, done, total: steps.length, percent: Math.round((done / steps.length) * 100), complete: done === steps.length, next: steps.find((s) => !s.done)?.key ?? null };
  }

  // Industry starter (ITGC-AC-18 #4 + docs/50 B3) — idempotent: gives a brand-new company its HQ branch,
  // and an SME company additionally a small industry kit (sample menu/tables/warehouse/project) so the B1
  // industry nav lands on non-empty screens. Logic in StarterPackService; safe to call repeatedly.
  @Post('starter-pack')
  @Permissions('users')
  async starterPack(@CurrentUser() user: JwtUser) {
    const id = await this.billing.resolveTenantId({ username: user.username, customerName: user.customerName });
    return this.starterPackSvc.apply(id, user.username);
  }

  private fmt(t: any) {
    if (!t) return null;
    // setup is "complete" once the legal essentials for issuing tax invoices are present
    const setupComplete = !!(t.legalName && t.taxId && t.addressLine1 && t.province);
    return {
      id: Number(t.id), code: t.code, name: t.name, legal_name: t.legalName, tax_id: t.taxId,
      branch_code: t.branchCode, branch_label_th: t.branchLabelTh,
      vat_registered: !!t.vatRegistered, vat_rate: t.vatRate != null ? Number(t.vatRate) : 0.07, tax_country: t.taxCountry ?? 'TH',
      phone: t.phone, fax: t.fax, email: t.email,
      address_line1: t.addressLine1, address_line2: t.addressLine2, sub_district: t.subDistrict,
      district: t.district, province: t.province, postal_code: t.postalCode,
      promptpay_id: t.promptpayId ?? null,
      default_language: t.defaultLanguage ?? 'th',
      logo_url: t.logoUrl ?? null,
      tagline: t.tagline ?? null,
      branding_prefs: t.brandingPrefs ?? {},
      setup_complete: setupComplete,
    };
  }
}
