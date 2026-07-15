import { Controller, Get, Put, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { LoyaltyService, type LoyaltyConfigDto, type RedeemDto } from './loyalty.service';
import { MemberService } from './member.service';
import { MembershipService } from './membership.service';
import { ReceiptSubmissionsService } from './receipt-submissions.service';
import { WalletPassService } from '../wallet-pass/wallet-pass.service';
import { ChannelCustomerRefsService } from '../channel-adapter/channel-customer-refs.service';

const ConfigBody = z.object({
  enabled: z.boolean().optional(),
  points_per_baht: z.number().nonnegative().optional(),
  baht_per_point: z.number().nonnegative().optional(),
  min_redeem: z.number().nonnegative().optional(),
  expiry_days: z.number().int().nonnegative().optional(),
  transfer_day_cap: z.number().int().nonnegative().optional(), // W1 LYL-18 (0 disables transfers)
});
// W1 LYL-18 — staff-side P2P transfer (sender = :id path param; recipient by id or phone).
const TransferBody = z.object({ to_member_id: z.number().int().positive().optional(), to_phone: z.string().min(4).optional(), points: z.number().int().positive(), note: z.string().max(200).optional() })
  .refine((d) => d.to_member_id != null || d.to_phone, { message: 'to_member_id or to_phone required' });
// V4 LYL-21 — paid VIP membership plans + sale.
const PlanBody = z.object({ id: z.number().int().positive().optional(), code: z.string().min(1).max(20), name: z.string().min(1), tier: z.string().min(1), price: z.number().positive(), period_months: z.number().int().positive().max(60).optional(), active: z.boolean().optional() });
const SellMembershipBody = z.object({ member_id: z.number().int().positive(), plan_id: z.number().int().positive(), sale_ref: z.string().max(60).optional(), start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

const RedeemBody = z.object({ points: z.number().positive() });
const bday = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const EnrollBody = z.object({ name: z.string().optional(), phone: z.string().optional(), card_no: z.string().optional(), email: z.string().optional(), birthday: bday.optional(), marketing_opt_in: z.boolean().optional() })
  .refine((d) => d.phone || d.card_no, { message: 'phone or card_no required' });
const UpdateMemberBody = z.object({ name: z.string().optional(), phone: z.string().optional(), email: z.string().optional(), birthday: bday.nullable().optional(), marketing_opt_in: z.boolean().optional(), tier: z.string().optional(), active: z.boolean().optional() });
const ListQuery = z.object({
  q: z.string().optional(), segment: z.string().optional(), tier: z.string().optional(),
  active: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});
const ConsentBody = z.object({
  purpose: z.enum(['marketing', 'profiling', 'line', 'sms', 'email', 'dining_profile']),
  granted: z.boolean(),
  channel: z.string().optional(),
  source: z.string().optional(),
});
// tenant_id is required only for HQ/Admin callers with no tenant context (else inferred from the JWT).
const LiabilityPostBody = z.preprocess((v) => v ?? {}, z.object({ tenant_id: z.coerce.number().int().positive().optional() }));
const EnrollLineBody = z.object({ id_token: z.string().min(1), name: z.string().optional(), phone: z.string().optional(), marketing_opt_in: z.boolean().optional() });
const LinkLineBody = z.object({ id_token: z.string().min(1) });
const ReceiptQueueQuery = z.object({ status: z.string().optional() });
const RejectReceiptBody = z.preprocess((v) => v ?? {}, z.object({ reason: z.string().optional() }));
// G1 (MKT-13) — staff link of a marketplace buyer ref to a member. marketing_opt_in is REQUIRED: staff
// attests the customer's explicit consent decision (recorded source='pos'); there is no default.
const ChannelRefsQuery = z.object({ linked: z.coerce.boolean().optional(), limit: z.coerce.number().int().positive().max(500).optional() });
const ChannelRefLinkBody = z.object({ member_id: z.number().int().positive(), marketing_opt_in: z.boolean() });

@Controller('api/loyalty')
export class LoyaltyController {
  constructor(private readonly svc: LoyaltyService, private readonly member: MemberService, private readonly membership: MembershipService, private readonly receipts: ReceiptSubmissionsService, private readonly walletPasses: WalletPassService, private readonly channelRefs: ChannelCustomerRefsService) {}

  @Get('config') @Permissions('loyalty', 'marketing')
  getConfig() { return this.svc.getConfig(); }

  @Put('config') @Permissions('loyalty', 'marketing')
  updateConfig(@Body(new ZodValidationPipe(ConfigBody)) b: LoyaltyConfigDto) { return this.svc.updateConfig(b); }

  @Get('me') @Permissions('loyalty')
  me(@CurrentUser() u: JwtUser) { return this.svc.me(u); }

  @Post('redeem') @Permissions('loyalty')
  redeem(@Body(new ZodValidationPipe(RedeemBody)) b: RedeemDto, @CurrentUser() u: JwtUser) { return this.svc.redeem(b, u); }

  // ── CRM Phase 1: member directory, points-liability tie-out, PDPA consent ──
  @Get('members') @Permissions('loyalty', 'marketing', 'crm')
  listMembers(@Query(new ZodValidationPipe(ListQuery)) q: any, @CurrentUser() u: JwtUser) { return this.member.list(q, u); }
  @Get('liability') @Permissions('loyalty', 'marketing', 'exec', 'gl_post')
  liability(@Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) { return this.member.liability(u, tenantId != null ? Number(tenantId) : null); }
  // Post the points-liability accrual to the GL (TFRS 15). Finance action → gl_post / exec.
  @Post('liability/post') @Permissions('gl_post', 'exec')
  postLiability(@Body(new ZodValidationPipe(LiabilityPostBody)) b: any, @CurrentUser() u: JwtUser) { return this.member.postLiability(u, b?.tenant_id ?? null); }
  // Expire aged points (breakage). Writes 'Expire' ledger rows; the next accrual releases 2250 → 5700.
  @Post('expire') @Permissions('crm_points_adjust', 'loyalty', 'exec')
  expire(@Body(new ZodValidationPipe(LiabilityPostBody)) b: any, @CurrentUser() u: JwtUser) { return this.member.expirePoints(u, b?.tenant_id ?? null); }
  // Cron-callable maintenance sweep — expire aged points + re-accrue the liability for every tenant
  // (Admin ⇒ all tenants; tenant user ⇒ own; pass tenant_id to limit). Wire to an external scheduler.
  @Post('maintenance/run') @Permissions('exec', 'gl_post', 'masterdata')
  runMaintenance(@Body(new ZodValidationPipe(LiabilityPostBody)) b: any, @CurrentUser() u: JwtUser) { return this.member.sweepMaintenance(u, b?.tenant_id ?? null); }
  @Get('members/:id/consents') @Permissions('loyalty', 'marketing', 'crm')
  getConsents(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.member.getConsents(+id, u); }
  @Post('members/:id/consents') @Permissions('loyalty', 'crm')
  setConsent(@Param('id') id: string, @Body(new ZodValidationPipe(ConsentBody)) b: any, @CurrentUser() u: JwtUser) { return this.member.setConsent(+id, b, u); }

  // ── G1 (MKT-13): marketplace buyer refs (hashed) → member linkage ──
  @Get('channel-refs') @Permissions('crm_member', 'loyalty', 'crm')
  listChannelRefs(@Query(new ZodValidationPipe(ChannelRefsQuery)) q: any, @CurrentUser() u: JwtUser) { return this.channelRefs.listRefs(u, q); }
  // Staff link (e.g. the customer identifies their Grab account at the counter). Consent is captured in
  // the SAME request tx as the link — the endpoint refuses a link without an explicit consent decision.
  @Post('channel-refs/:id/link') @Permissions('crm_member', 'loyalty')
  async linkChannelRef(@Param('id') id: string, @Body(new ZodValidationPipe(ChannelRefLinkBody)) b: z.infer<typeof ChannelRefLinkBody>, @CurrentUser() u: JwtUser) {
    const res = await this.channelRefs.staffLink(+id, b.member_id, u);
    await this.member.setConsent(b.member_id, { purpose: 'marketing', granted: b.marketing_opt_in, channel: `channel:${res.platform}`, source: 'pos' }, u);
    return { ...res, marketing_opt_in: b.marketing_opt_in };
  }

  // ── Tiers (CRM Phase 3): journey view + auto-recompute (also run by the maintenance sweep) ──
  @Get('members/:id/tier') @Permissions('loyalty', 'marketing', 'crm', 'pos')
  tierJourney(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.member.tierJourney(u, +id); }
  // V5 (docs/29) — staff view of a member's wallet-pass registrations (issue itself is member-self-scoped).
  @Get('members/:id/wallet-pass') @Permissions('loyalty', 'marketing', 'crm')
  memberWalletPass(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.walletPasses.forMember(u, +id); }
  @Post('tiers/recompute') @Permissions('loyalty', 'marketing', 'exec')
  recomputeTiers(@Body(new ZodValidationPipe(LiabilityPostBody)) b: any, @CurrentUser() u: JwtUser) { return this.member.recomputeTiers(u, b?.tenant_id ?? null); }

  // ── POS members (สมาชิก/แต้มที่จุดขาย) ──
  @Post('members') @Permissions('crm_member', 'loyalty', 'pos')
  enroll(@Body(new ZodValidationPipe(EnrollBody)) b: any, @CurrentUser() u: JwtUser) { return this.member.enroll(b, u); }
  // Enrol or return a member from a verified LINE identity (LIFF / LINE Login id token). Idempotent.
  @Post('members/enroll-line') @Permissions('loyalty', 'pos')
  enrollLine(@Body(new ZodValidationPipe(EnrollLineBody)) b: any, @CurrentUser() u: JwtUser) { return this.member.enrollViaLine(b, u); }
  // Link a verified LINE identity to an existing member.
  @Post('members/:id/link-line') @Permissions('loyalty', 'pos')
  linkLine(@Param('id') id: string, @Body(new ZodValidationPipe(LinkLineBody)) b: { id_token: string }, @CurrentUser() u: JwtUser) { return this.member.linkLine(+id, b.id_token, u); }
  @Get('members/lookup') @Permissions('loyalty', 'pos')
  lookup(@Query('phone') phone: string | undefined, @Query('card') card: string | undefined, @Query('code') code: string | undefined, @Query('line_user_id') lineUserId: string | undefined, @CurrentUser() u: JwtUser) { return this.member.lookup({ phone, card, code, line_user_id: lineUserId }, u); }
  @Get('members/birthdays') @Permissions('loyalty', 'marketing', 'crm')
  birthdays(@Query('window') window: string | undefined, @CurrentUser() u: JwtUser) { return this.member.birthdays(window === 'today' ? 'today' : 'month', u); }
  @Patch('members/:id') @Permissions('crm_member', 'loyalty', 'pos')
  update(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateMemberBody)) b: any, @CurrentUser() u: JwtUser) { return this.member.update(+id, b, u); }
  @Get('members/:id') @Permissions('loyalty', 'pos')
  getMember(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.member.balance(+id, u); }
  @Get('members/:id/history') @Permissions('loyalty', 'pos')
  history(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.member.history(+id, u); }
  // W1 LYL-18 — staff-assisted P2P point transfer (atomic two-row ledger move; net-zero on the 2250
  // liability). Points-adjust duty, same gate as manual adjustments — a cashier cannot move points around.
  @Post('members/:id/transfer') @Permissions('crm_points_adjust', 'loyalty', 'exec')
  transfer(@Param('id') id: string, @Body(new ZodValidationPipe(TransferBody)) b: any, @CurrentUser() u: JwtUser) { return this.member.transferPoints(u, +id, b, 'staff'); }
  // G13 maker-checker: a staff transfer over the approval threshold is staged; a DISTINCT approver
  // (approver ≠ requester → 403 SOD_VIOLATION) releases it via these routes.
  @Get('transfers/pending') @Permissions('approvals', 'exec')
  pendingTransfers(@CurrentUser() u: JwtUser) { return this.member.listPendingTransfers(u); }
  @Post('transfers/:reqNo/approve') @Permissions('approvals', 'exec')
  approveTransfer(@Param('reqNo') reqNo: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) { return this.member.approvePendingTransfer(u, reqNo, b?.self_approval_reason); }
  @Post('transfers/:reqNo/reject') @Permissions('approvals', 'exec')
  rejectTransfer(@Param('reqNo') reqNo: string, @Body(new ZodValidationPipe(RejectReceiptBody)) b: any, @CurrentUser() u: JwtUser) { return this.member.rejectPendingTransfer(u, reqNo, b?.reason); }

  // ── V4 (docs/29, LYL-21): paid VIP membership — plans (marketing), sale (pos/loyalty), recognition (finance) ──
  @Get('membership-plans') @Permissions('loyalty', 'marketing', 'pos')
  listPlans(@CurrentUser() u: JwtUser) { return this.membership.listPlans(u); }
  @Post('membership-plans') @Permissions('marketing', 'exec')
  upsertPlan(@Body(new ZodValidationPipe(PlanBody)) b: any, @CurrentUser() u: JwtUser) { return this.membership.upsertPlan(b, u); }
  @Post('memberships/sell') @Permissions('pos', 'loyalty')
  sellMembership(@Body(new ZodValidationPipe(SellMembershipBody)) b: any, @CurrentUser() u: JwtUser) { return this.membership.sell(u, b); }
  @Post('memberships/recognize') @Permissions('gl_post', 'exec')
  recognizeMemberships(@Body(new ZodValidationPipe(LiabilityPostBody)) b: any, @CurrentUser() u: JwtUser) { return this.membership.recognizeDue(u, b?.tenant_id ?? null); }

  // ── Receipt-upload-for-points review queue (LYL-17). Members submit via /api/member/receipts;
  // staff review here. Approve grants points through the same earnInTx path POS checkout uses. ──
  @Get('receipts') @Permissions('loyalty', 'marketing', 'crm')
  receiptQueue(@Query(new ZodValidationPipe(ReceiptQueueQuery)) q: any, @CurrentUser() u: JwtUser) { return this.receipts.queue(u, q); }
  @Post('receipts/:id/approve') @Permissions('crm_points_adjust', 'loyalty', 'exec')
  approveReceipt(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.receipts.approve(+id, u); }
  @Post('receipts/:id/reject') @Permissions('crm_points_adjust', 'loyalty', 'exec')
  rejectReceipt(@Param('id') id: string, @Body(new ZodValidationPipe(RejectReceiptBody)) b: any, @CurrentUser() u: JwtUser) { return this.receipts.reject(+id, u, b?.reason); }
}
