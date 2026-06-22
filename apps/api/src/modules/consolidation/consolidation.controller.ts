import { Controller, Get, Post, Delete, Body, Param, ParseIntPipe, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { ConsolidationService } from './consolidation.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

const CreateGroupBody = z.object({ name: z.string().min(1), fiscal_year: z.number().int(), base_currency: z.string().optional(), notes: z.string().optional() });
const AddEntityBody = z.object({ entity_tenant_id: z.number().int(), ownership_pct: z.number().min(0).max(100).optional(), entity_currency: z.string().optional() });
const RunBody = z.object({ period: z.string().min(1) });

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
}
