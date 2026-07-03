import { Body, Controller, Get, Inject, Patch, Post } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants, branches, users, menuItems } from '../../database/schema';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { BillingService } from './billing.service';
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
    const patch: Record<string, unknown> = {};
    const map: Record<string, string> = {
      legal_name: 'legalName', name: 'name', tax_id: 'taxId', branch_code: 'branchCode',
      vat_registered: 'vatRegistered', tax_country: 'taxCountry', phone: 'phone', email: 'email',
      address_line1: 'addressLine1', address_line2: 'addressLine2', sub_district: 'subDistrict',
      district: 'district', province: 'province', postal_code: 'postalCode', promptpay_id: 'promptpayId',
      default_language: 'defaultLanguage', logo_url: 'logoUrl', tagline: 'tagline',
    };
    for (const [k, col] of Object.entries(map)) if (b[k as keyof ProfileBody] !== undefined) patch[col] = b[k as keyof ProfileBody];
    if (b.vat_rate !== undefined) patch.vatRate = String(b.vat_rate);
    if (b.branding_prefs !== undefined) patch.brandingPrefs = b.branding_prefs;
    if (Object.keys(patch).length) await this.db.update(tenants).set(patch).where(eq(tenants.id, id));
    if (b.vat_rate !== undefined || b.tax_country !== undefined) this.tax.invalidateTenantTax(id); // drop stale cache
    const [t] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return this.fmt(t);
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

  // Minimal industry starter (ITGC-AC-18 #4) — idempotent: gives a brand-new company a head-office branch
  // so it isn't empty (branches are needed for POS/inventory). Safe to call repeatedly.
  @Post('starter-pack')
  @Permissions('users')
  async starterPack(@CurrentUser() user: JwtUser) {
    const id = await this.billing.resolveTenantId({ username: user.username, customerName: user.customerName });
    const created: string[] = [];
    const skipped: string[] = [];
    const branchN = Number((await this.db.select({ n: sql<number>`count(*)` }).from(branches).where(eq(branches.tenantId, id)))[0]?.n ?? 0);
    if (branchN === 0) {
      await this.db.insert(branches).values({ tenantId: id, code: 'HQ', name: 'สำนักงานใหญ่', isHq: true, active: true, createdBy: user.username });
      created.push('hq_branch');
    } else {
      skipped.push('hq_branch');
    }
    return { created, skipped };
  }

  private fmt(t: any) {
    if (!t) return null;
    // setup is "complete" once the legal essentials for issuing tax invoices are present
    const setupComplete = !!(t.legalName && t.taxId && t.addressLine1 && t.province);
    return {
      id: Number(t.id), code: t.code, name: t.name, legal_name: t.legalName, tax_id: t.taxId,
      branch_code: t.branchCode, branch_label_th: t.branchLabelTh,
      vat_registered: !!t.vatRegistered, vat_rate: t.vatRate != null ? Number(t.vatRate) : 0.07, tax_country: t.taxCountry ?? 'TH',
      phone: t.phone, email: t.email,
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
