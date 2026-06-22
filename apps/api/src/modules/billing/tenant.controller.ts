import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants } from '../../database/schema';
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
    const [t] = await (this.db as any).select().from(tenants).where(eq(tenants.id, id)).limit(1);
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
    };
    for (const [k, col] of Object.entries(map)) if (b[k as keyof ProfileBody] !== undefined) patch[col] = b[k as keyof ProfileBody];
    if (b.vat_rate !== undefined) patch.vatRate = String(b.vat_rate);
    if (Object.keys(patch).length) await (this.db as any).update(tenants).set(patch).where(eq(tenants.id, id));
    if (b.vat_rate !== undefined || b.tax_country !== undefined) this.tax.invalidateTenantTax(id); // drop stale cache
    const [t] = await (this.db as any).select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return this.fmt(t);
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
      setup_complete: setupComplete,
    };
  }
}
