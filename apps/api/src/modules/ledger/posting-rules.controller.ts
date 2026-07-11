import { Controller, Get, Post, Body, Param, Query, HttpCode, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { PostingService } from './posting.service';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { POSTING_EVENTS } from './posting-events';

// GL-24 (docs/43 PR-1): a posting-rule override re-routes financial statements, so the write surface is
// governed — Zod-validated body, registry/tier/account validation in the service (fail-closed), a
// maker-checker approve by a DIFFERENT user, and an append-only audit trail. `gl_posting_rules` is the
// maintenance duty; approve additionally allows `exec` so a controller can clear the queue.
const UpsertRuleBody = z.object({
  eventType: z.string().min(1),
  legOrder: z.number().int().min(1).max(99),
  role: z.string().min(1),
  side: z.enum(['DR', 'CR']),
  accountCode: z.string().regex(/^\d{4}$/, 'Account code must be 4 digits'),
  dimensionSource: z.string().optional(),
  condition: z.record(z.unknown()).optional(),
});
type UpsertRuleBodyT = z.infer<typeof UpsertRuleBody>;

@Controller('api/ledger/posting-rules')
export class PostingRulesController {
  constructor(private readonly posting: PostingService) {}

  @Get('event-types')
  @Permissions('gl_coa', 'gl_posting_rules', 'exec', 'gl_post')
  listEventTypes() {
    return this.posting.listEventTypes();
  }

  // The registry view: every event with its roles, REAL default account, side and override tier — the
  // /setup/posting-rules screen renders "default vs override" from this (docs/43 PR-9 builds on it).
  @Get('registry')
  @Permissions('gl_coa', 'gl_posting_rules', 'exec', 'gl_post')
  registry() {
    return { events: POSTING_EVENTS };
  }

  @Get('audit')
  @Permissions('gl_coa', 'gl_posting_rules', 'exec')
  listAudit() {
    return this.posting.listRuleAudit();
  }

  @Get()
  @Permissions('gl_coa', 'gl_posting_rules', 'exec', 'gl_post')
  listRules(@Query('eventType') eventType?: string) {
    return this.posting.listRules({ eventType });
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Permissions('gl_posting_rules', 'exec')
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.posting.approveRule(id, u);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Permissions('gl_posting_rules', 'exec')
  reject(@Param('id', ParseIntPipe) id: number, @Body() b: { reason?: string }, @CurrentUser() u: JwtUser) {
    return this.posting.rejectRule(id, u, b?.reason);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @Permissions('gl_posting_rules', 'exec')
  deactivate(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.posting.deactivateRule(id, u);
  }

  @Post('preview')
  @HttpCode(200)
  @Permissions('gl_posting_rules', 'gl_post', 'exec')
  preview(@Body() body: { eventType: string; amounts: Record<string, number> }) {
    return this.posting.preview(body.eventType, {
      source: 'PREVIEW', createdBy: 'system', amounts: body.amounts,
    });
  }

  @Post()
  @Permissions('gl_posting_rules')
  upsertRule(@Body(new ZodValidationPipe(UpsertRuleBody)) dto: UpsertRuleBodyT, @CurrentUser() u: JwtUser) {
    return this.posting.upsertRule(dto, u);
  }
}
