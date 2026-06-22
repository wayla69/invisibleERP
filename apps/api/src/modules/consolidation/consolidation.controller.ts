import { Controller, Get, Post, Delete, Body, Param, ParseIntPipe, HttpCode } from '@nestjs/common';
import { ConsolidationService } from './consolidation.service';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

@Controller('api/consolidation')
export class ConsolidationController {
  constructor(private readonly svc: ConsolidationService) {}

  @Post('groups')
  @Permissions('exec')
  createGroup(@Body() dto: any, @CurrentUser() user: JwtUser) {
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
  addEntity(@Param('groupId', ParseIntPipe) groupId: number, @Body() dto: any, @CurrentUser() user: JwtUser) {
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
  run(@Param('groupId', ParseIntPipe) groupId: number, @Body() dto: any, @CurrentUser() user: JwtUser) {
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
