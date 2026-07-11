import { Controller, Post, Patch, Body, Param, ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { CoaService } from './coa.service';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

// Canonical-universe write bodies (docs/40 step 2 — the /chart-of-accounts manage UI posts these).
// Codes are the 4-digit universe convention; type drives normal-balance defaulting in the service.
const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] as const;
const CreateAccountBody = z.object({
  code: z.string().regex(/^\d{4}$/, 'Account code must be 4 digits'),
  name: z.string().min(1),
  nameTh: z.string().optional(),
  type: z.enum(ACCOUNT_TYPES),
  parentCode: z.string().regex(/^\d{4}$/).optional(),
  accountGroupId: z.number().int().optional(),
  normalBalance: z.enum(['D', 'C']).optional(),
  isPostable: z.boolean().optional(),
  requireDimension: z.record(z.boolean()).optional(),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().optional(),
});
type CreateAccountBodyT = z.infer<typeof CreateAccountBody>;
const UpdateAccountBody = z
  .object({
    name: z.string().min(1).optional(),
    nameTh: z.string().optional(),
    accountGroupId: z.number().int().optional(),
    isPostable: z.boolean().optional(),
    requireDimension: z.record(z.boolean()).optional(),
    effectiveFrom: z.string().optional(),
    effectiveTo: z.string().optional(),
    active: z.enum(['true', 'false']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' });
type UpdateAccountBodyT = z.infer<typeof UpdateAccountBody>;

// Per-tenant chart curation body — at least one field must be present (a no-op PATCH is rejected).
const OverlayBody = z
  .object({
    active: z.boolean().optional(),
    display_name: z.string().nullable().optional(),
    display_name_th: z.string().nullable().optional(),
    group_label: z.string().nullable().optional(),
    sort_order: z.number().int().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' });
type OverlayBodyT = z.infer<typeof OverlayBody>;

// GL-11 — Chart-of-Accounts change control. Two write surfaces, two distinct duties:
//
//  • CANONICAL universe (`accounts` — GLOBAL, no tenant_id; the posting engine hard-references its codes,
//    SHARED by every tenant). Creating/editing/retiring a canonical account changes the universe for ALL
//    tenants, so it is a PLATFORM / head-office duty: restricted to role 'Admin' (HQ) IN ADDITION to the
//    `gl_coa` permission. A tenant's own gl_coa holder (e.g. FinancialController) is intentionally blocked
//    (COA_ADMIN_ONLY) so it can never silently mutate the canonical chart other tenants post against.
//
//  • PER-TENANT overlay (`tenant_accounts` — RLS-scoped by tenant_id). Curating *which* canonical accounts a
//    tenant sees as active and *how* they are named/grouped/ordered on its own chart is a tenant duty:
//    `gl_coa`, scoped to the caller's tenant by the tenant context + RLS (a tenant can never touch another's
//    chart). The overlay NEVER gates postings — it only shapes the picker / CoA view (LedgerService.listAccounts).
//
// The reachable list `GET /api/ledger/accounts` is served by LedgerController.accounts (tenant-curated);
// this controller owns only the WRITE surfaces. Base is 'api/ledger/accounts' — the app has no global prefix,
// so every controller embeds `api/` itself (cf. LedgerController = @Controller('api/ledger')).
@Controller('api/ledger/accounts')
@Permissions('gl_coa')
export class CoaController {
  constructor(private readonly coa: CoaService) {}

  // Canonical writes govern the SHARED universe → platform Admin/HQ only (defence-in-depth atop @Permissions).
  private assertPlatformAdmin(u: JwtUser) {
    if (u.role !== 'Admin')
      throw new ForbiddenException({
        code: 'COA_ADMIN_ONLY',
        message:
          'Canonical Chart-of-Accounts changes are restricted to the platform administrator (HQ) — the account universe is shared across all tenants. Use the per-tenant overlay to curate your own chart.',
        messageTh:
          'การแก้ไขผังบัญชีกลางสงวนไว้สำหรับผู้ดูแลระบบ (สำนักงานใหญ่) เท่านั้น เนื่องจากเป็นผังบัญชีที่ใช้ร่วมกันทุกกิจการ โปรดใช้การปรับแต่งผังบัญชีเฉพาะกิจการแทน',
      });
  }

  // ── Canonical universe (Admin/HQ) ──
  @Post()
  create(@Body(new ZodValidationPipe(CreateAccountBody)) dto: CreateAccountBodyT, @CurrentUser() u: JwtUser) {
    this.assertPlatformAdmin(u);
    return this.coa.createAccount(dto);
  }

  @Patch(':code')
  update(@Param('code') code: string, @Body(new ZodValidationPipe(UpdateAccountBody)) dto: UpdateAccountBodyT, @CurrentUser() u: JwtUser) {
    this.assertPlatformAdmin(u);
    return this.coa.updateAccount(code, dto);
  }

  @Post(':code/deactivate')
  deactivate(@Param('code') code: string, @CurrentUser() u: JwtUser) {
    this.assertPlatformAdmin(u);
    return this.coa.deactivateAccount(code);
  }

  // ── Per-tenant overlay curation (gl_coa; RLS-scoped to the caller's own tenant) ──
  @Patch(':code/overlay')
  curate(@Param('code') code: string, @Body(new ZodValidationPipe(OverlayBody)) b: OverlayBodyT) {
    return this.coa.curateOverlay(code, {
      active: b.active,
      displayName: b.display_name,
      displayNameTh: b.display_name_th,
      groupLabel: b.group_label,
      sortOrder: b.sort_order,
    });
  }
}
