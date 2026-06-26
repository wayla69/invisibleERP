import { Controller, Get, Post, Delete, Body, Param, Query, ParseIntPipe, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { ConsolidationService } from './consolidation.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

const CreateGroupBody = z.object({ name: z.string().min(1), fiscal_year: z.number().int(), base_currency: z.string().optional(), notes: z.string().optional() });
const AddEntityBody = z.object({ entity_tenant_id: z.number().int(), ownership_pct: z.number().min(0).max(100).optional(), entity_currency: z.string().optional() });
const RunBody = z.object({ period: z.string().min(1) });
const RuleBody = z.object({ group_id: z.number().int(), name: z.string().min(1), rule_type: z.enum(['ic_balance', 'ic_revenue', 'investment', 'manual']).optional(), match_account_pattern: z.string().optional(), debit_account: z.string().optional(), credit_account: z.string().optional() });
const SegmentBody = z.object({ code: z.string().min(1), name: z.string().min(1), dimension: z.enum(['branch', 'project', 'department', 'entity']).optional(), member_keys: z.array(z.union([z.number(), z.string()])).optional() });

@Controller('api/consolidation')
export class ConsolidationController {
  constructor(private readonly svc: ConsolidationService) {}

  @Post('groups')
  @Permissions('exec')
  createGroup(@Body(new ZodValidationPipe(CreateGroupBody)) dto: z.infer<typeof CreateGroupBody>, @CurrentUser() user: JwtUser) {
    return this.svc.createGroup(dto, user);
  }

  @Get('groups')
  @Permissions('exec')
  listGroups(@CurrentUser() user: JwtUser) {
    return this.svc.listGroups(user);
  }

  @Get('groups/:groupId/entities')
  @Permissions('exec')
  listEntities(@Param('groupId', ParseIntPipe) groupId: number, @CurrentUser() user: JwtUser) {
    return this.svc.listEntities(groupId, user);
  }

  @Post('groups/:groupId/entities')
  @Permissions('exec')
  addEntity(@Param('groupId', ParseIntPipe) groupId: number, @Body(new ZodValidationPipe(AddEntityBody)) dto: z.infer<typeof AddEntityBody>, @CurrentUser() user: JwtUser) {
    return this.svc.addEntity(groupId, dto, user);
  }

  @Delete('groups/:groupId/entities/:entityTenantId')
  @Permissions('exec')
  removeEntity(@Param('groupId', ParseIntPipe) groupId: number, @Param('entityTenantId', ParseIntPipe) entityTenantId: number, @CurrentUser() user: JwtUser) {
    return this.svc.removeEntity(groupId, entityTenantId, user);
  }

  @Post('groups/:groupId/run')
  @Permissions('approvals')
  @HttpCode(200)
  run(@Param('groupId', ParseIntPipe) groupId: number, @Body(new ZodValidationPipe(RunBody)) dto: z.infer<typeof RunBody>, @CurrentUser() user: JwtUser) {
    return this.svc.runConsolidation(groupId, dto, user);
  }

  @Get('groups/:groupId/runs')
  @Permissions('exec')
  listRuns(@Param('groupId', ParseIntPipe) groupId: number, @CurrentUser() user: JwtUser) {
    return this.svc.listRuns(groupId, user);
  }

  @Get('runs/:runId/lines')
  @Permissions('exec')
  getRunLines(@Param('runId', ParseIntPipe) runId: number, @CurrentUser() user: JwtUser) {
    return this.svc.getRunLines(runId, user);
  }

  // ── WS3.3: maker-checker post (CON-03) ──
  @Post('runs/:runId/post')
  @Permissions('approvals')
  @HttpCode(200)
  postRun(@Param('runId', ParseIntPipe) runId: number, @CurrentUser() user: JwtUser) {
    return this.svc.postConsolidation(runId, { postedBy: user.username }, user);
  }

  // ── WS3.3: elimination rules ──
  @Post('rules')
  @Permissions('exec')
  defineRule(@Body(new ZodValidationPipe(RuleBody)) dto: z.infer<typeof RuleBody>, @CurrentUser() user: JwtUser) {
    return this.svc.defineEliminationRule(dto, user);
  }

  @Get('rules')
  @Permissions('exec')
  listRules(@Query('group_id', ParseIntPipe) groupId: number, @CurrentUser() user: JwtUser) {
    return this.svc.listRules(groupId, user);
  }

  // ── WS3.3: segment definitions + segment report (CON-04) ──
  @Post('segments')
  @Permissions('exec')
  defineSegment(@Body(new ZodValidationPipe(SegmentBody)) dto: z.infer<typeof SegmentBody>, @CurrentUser() user: JwtUser) {
    return this.svc.defineSegment(dto, user);
  }

  @Get('segments')
  @Permissions('exec')
  listSegments(@CurrentUser() user: JwtUser) {
    return this.svc.listSegments(user);
  }

  @Get('segment-report')
  @Permissions('exec')
  segmentReport(@Query('period') period: string, @Query('dimension') dimension: string | undefined, @CurrentUser() user: JwtUser) {
    return this.svc.segmentReport({ period, dimension }, user);
  }
}
