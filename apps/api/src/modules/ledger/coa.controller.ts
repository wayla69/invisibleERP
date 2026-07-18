import { Controller, Get, Post, Patch, Body, Param, Query, ForbiddenException, HttpCode, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { CoaService } from './coa.service';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';

// Canonical-universe write bodies (docs/42 step 2 — the /chart-of-accounts manage UI posts these).
// Codes are the 4-digit universe convention for control/summary accounts; SUB-ACCOUNTS extend the parent
// with one or two extra digits (e.g. 5150 → 51501/51502), so a code is 4–6 digits. `type` drives
// normal-balance defaulting in the service; a sub-account's type is validated ⊆ its parent's (coa.service).
const ACCOUNT_CODE_RE = /^\d{4,6}$/;
const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] as const;
const CreateAccountBody = z.object({
  code: z.string().regex(ACCOUNT_CODE_RE, 'Account code must be 4–6 digits'),
  name: z.string().min(1),
  nameTh: z.string().optional(),
  type: z.enum(ACCOUNT_TYPES),
  parentCode: z.string().regex(ACCOUNT_CODE_RE).optional(),
  accountGroupId: z.number().int().optional(),
  normalBalance: z.enum(['D', 'C']).optional(),
  isPostable: z.boolean().optional(),
  requireDimension: z.record(z.boolean()).optional(),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().optional(),
  // docs/43 PR-8: SCF bucket + current/non-current self-declaration (fallback = CF_CLASSIFY / metric lists).
  cfBucket: z.enum(['operating', 'investing', 'financing', 'addback']).optional(),
  cfLabel: z.string().optional(),
  isCurrent: z.boolean().optional(),
  // 0438: Balance-Sheet / Income-Statement section binding (fallback = canonical default map / type).
  bsGroup: z.enum(['current_asset', 'noncurrent_asset', 'current_liability', 'noncurrent_liability', 'equity']).optional(),
  isGroup: z.enum(['revenue', 'cogs', 'selling_admin', 'other_income', 'other_expense', 'finance_cost', 'tax']).optional(),
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
    cfBucket: z.enum(['operating', 'investing', 'financing', 'addback']).nullable().optional(),
    cfLabel: z.string().nullable().optional(),
    isCurrent: z.boolean().nullable().optional(),
    bsGroup: z.enum(['current_asset', 'noncurrent_asset', 'current_liability', 'noncurrent_liability', 'equity']).nullable().optional(),
    isGroup: z.enum(['revenue', 'cogs', 'selling_admin', 'other_income', 'other_expense', 'finance_cost', 'tax']).nullable().optional(),
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

  // ── Canonical universe (Admin/HQ) — GL-27 maker-checker (COA follow-up C) ──
  // Every canonical write is validated fail-closed NOW, then staged PendingApproval for a DIFFERENT
  // Admin — unless the system has exactly one active Admin (single-Admin exception: applied
  // immediately, recorded as AutoApplied). See coa.service.ts requestChange.
  @Post()
  create(@Body(new ZodValidationPipe(CreateAccountBody)) dto: CreateAccountBodyT, @CurrentUser() u: JwtUser) {
    this.assertPlatformAdmin(u);
    return this.coa.requestChange('create', dto.code, dto, u);
  }

  @Patch(':code')
  update(@Param('code') code: string, @Body(new ZodValidationPipe(UpdateAccountBody)) dto: UpdateAccountBodyT, @CurrentUser() u: JwtUser) {
    this.assertPlatformAdmin(u);
    return this.coa.requestChange('update', code, dto, u);
  }

  @Post(':code/deactivate')
  deactivate(@Param('code') code: string, @CurrentUser() u: JwtUser) {
    this.assertPlatformAdmin(u);
    return this.coa.requestChange('deactivate', code, undefined, u);
  }

  // GL-27 queue: list / approve (distinct Admin, SOD_VIOLATION on self) / reject.
  @Get('change-requests')
  listChanges(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) {
    this.assertPlatformAdmin(u);
    return this.coa.listChanges(status);
  }

  @Post('change-requests/:id/approve')
  @HttpCode(200)
  approveChange(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    this.assertPlatformAdmin(u);
    return this.coa.approveChange(id, u, b?.self_approval_reason);
  }

  @Post('change-requests/:id/reject')
  @HttpCode(200)
  rejectChange(@Param('id', ParseIntPipe) id: number, @Body() b: { reason?: string }, @CurrentUser() u: JwtUser) {
    this.assertPlatformAdmin(u);
    return this.coa.rejectChange(id, u, b?.reason);
  }

  // COA follow-up B — read-only where-used report (config masters referencing this code). Not Admin-gated:
  // any gl_coa holder may check impact before requesting a change; tenant tables are RLS-narrowed anyway.
  @Get(':code/where-used')
  whereUsed(@Param('code') code: string) {
    return this.coa.whereUsed(code);
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
