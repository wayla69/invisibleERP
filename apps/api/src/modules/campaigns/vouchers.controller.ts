import { Controller, Get, Post, Param, Body, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AuditRead, Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { VouchersService } from './vouchers.service';

const CampaignBody = z.object({
  name: z.string().min(1),
  kind: z.enum(['percent', 'amount']).default('percent'),
  value: z.number().positive(),
  min_spend: z.number().positive().optional(),
  channel: z.enum(['any', 'dine_in', 'takeaway', 'delivery']).optional(),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  per_code_max_uses: z.number().int().min(1).max(1000).optional(),
  max_redemptions: z.number().int().positive().optional(),
});
const GenerateBody = z.object({ count: z.number().int().min(1).max(2000), prefix: z.string().max(8).optional() });
const RejectBody = z.object({ reason: z.string().max(500).optional() });
const VoidBody = z.object({ reason: z.string().max(500).optional() });
const ValidateBody = z.object({ code: z.string().min(1), subtotal: z.number().nonnegative().optional(), channel: z.string().optional(), member_id: z.number().int().positive().optional() });

// POS-3 voucher campaigns. Maintenance rides the R10 split (promo/marketing duties, segregated from
// selling); ACTIVATION is maker-checker — a DIFFERENT user approves (REV-20, mirrors /api/pricing/rules).
// The read-only validate endpoint is open to sellers so the till can preview a code before settling.
@Controller('api/vouchers')
export class VouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @Get('campaigns') @Permissions('promos', 'pricelist', 'marketing', 'exec')
  list(@CurrentUser() u: JwtUser, @Query('status') status?: string) { return this.vouchers.listCampaigns(u, status ? { status } : {}); }

  @Post('campaigns') @Permissions('promos', 'pricelist', 'marketing', 'exec')
  create(@Body(new ZodValidationPipe(CampaignBody)) b: z.infer<typeof CampaignBody>, @CurrentUser() u: JwtUser) { return this.vouchers.createCampaign(u, b); }

  @Post('campaigns/:id/approve') @Permissions('promos', 'pricelist', 'marketing', 'exec', 'approvals')
  approve(@Param('id') id: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) { return this.vouchers.approveCampaign(u, +id, b?.self_approval_reason); }

  @Post('campaigns/:id/reject') @Permissions('promos', 'pricelist', 'marketing', 'exec', 'approvals')
  reject(@Param('id') id: string, @Body(new ZodValidationPipe(RejectBody)) b: z.infer<typeof RejectBody>, @CurrentUser() u: JwtUser) { return this.vouchers.rejectCampaign(u, +id, b.reason); }

  @Post('campaigns/:id/end') @Permissions('promos', 'pricelist', 'marketing', 'exec')
  end(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.vouchers.endCampaign(u, +id); }

  @Post('campaigns/:id/codes') @Permissions('promos', 'pricelist', 'marketing', 'exec')
  generate(@Param('id') id: string, @Body(new ZodValidationPipe(GenerateBody)) b: z.infer<typeof GenerateBody>, @CurrentUser() u: JwtUser) { return this.vouchers.generateCodes(u, +id, b); }

  @Get('campaigns/:id/codes') @Permissions('promos', 'pricelist', 'marketing', 'exec')
  codes(@Param('id') id: string, @CurrentUser() u: JwtUser, @Query('state') state?: string, @Query('limit') limit?: string) { return this.vouchers.listCodes(u, +id, { state, limit: limit ? +limit : undefined }); }

  @AuditRead('voucher_codes_csv')
  @Get('campaigns/:id/codes.csv') @Permissions('promos', 'pricelist', 'marketing', 'exec')
  async codesCsv(@Param('id') id: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const csv = await this.vouchers.exportCodesCsv(u, +id);
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="voucher-codes-${+id}.csv"`).send(csv);
  }

  @Get('campaigns/:id/redemptions') @Permissions('promos', 'pricelist', 'marketing', 'exec')
  redemptions(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.vouchers.redemptions(u, +id); }

  @Post('codes/:code/void') @Permissions('promos', 'pricelist', 'marketing', 'exec')
  voidCode(@Param('code') code: string, @Body(new ZodValidationPipe(VoidBody)) b: z.infer<typeof VoidBody>, @CurrentUser() u: JwtUser) { return this.vouchers.voidCode(u, code, b.reason); }

  // Till-side preview: never throws — { valid, discount, reason }.
  @Post('validate') @Permissions('pos', 'pos_sell', 'order_mgt', 'promos', 'pricelist', 'marketing', 'exec')
  validate(@Body(new ZodValidationPipe(ValidateBody)) b: z.infer<typeof ValidateBody>, @CurrentUser() u: JwtUser) { return this.vouchers.validate(u, b); }
}
