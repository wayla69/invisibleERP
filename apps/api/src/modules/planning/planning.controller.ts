import { Controller, Get, Post, Put, Body, Param, ParseIntPipe, Query, HttpCode } from '@nestjs/common';
import { PlanningService } from './planning.service';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

@Controller('api/planning')
export class PlanningController {
  constructor(private readonly planning: PlanningService) {}

  // ── Versions ──

  @Post('versions')
  @Permissions('exec')
  createVersion(@Body() dto: any, @CurrentUser() user: JwtUser) {
    return this.planning.createVersion(dto, user);
  }

  @Get('versions')
  @Permissions('exec')
  listVersions(@CurrentUser() user: JwtUser) {
    return this.planning.listVersions(user);
  }

  @Get('versions/:id')
  @Permissions('exec')
  getVersion(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.planning.getVersion(id, user);
  }

  @Post('versions/:id/submit')
  @Permissions('exec')
  @HttpCode(200)
  submitVersion(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.planning.submitVersion(id, user);
  }

  @Post('versions/:id/approve')
  @Permissions('approvals')
  @HttpCode(200)
  approveVersion(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.planning.approveVersion(id, user);
  }

  @Post('versions/:id/baseline')
  @Permissions('approvals')
  @HttpCode(200)
  baselineVersion(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.planning.baselineVersion(id, user);
  }

  // ── Scenarios ──

  @Post('versions/:id/scenarios')
  @Permissions('exec')
  addScenario(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: JwtUser) {
    return this.planning.addScenario(id, dto, user);
  }

  @Post('scenarios/:id/clone')
  @Permissions('exec')
  @HttpCode(200)
  cloneScenario(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: JwtUser) {
    return this.planning.cloneScenario(id, dto, user);
  }

  @Get('scenarios/:id/lines')
  @Permissions('exec')
  getScenarioLines(@Param('id', ParseIntPipe) id: number, @Query('period') period: string | undefined, @CurrentUser() user: JwtUser) {
    return this.planning.getScenarioLines(id, period, user);
  }

  // ── Forecast Lines ──

  @Put('scenarios/:id/lines')
  @Permissions('exec')
  @HttpCode(200)
  upsertForecastLine(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: JwtUser) {
    return this.planning.upsertForecastLine(id, dto, user);
  }

  // ── Drivers ──

  @Post('scenarios/:id/drivers')
  @Permissions('exec')
  upsertDriver(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: JwtUser) {
    return this.planning.upsertDriver(id, dto, user);
  }

  @Post('scenarios/:id/run-drivers')
  @Permissions('exec')
  @HttpCode(200)
  runDrivers(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: JwtUser) {
    return this.planning.runDrivers(id, dto, user);
  }

  // ── 3-Way Variance ──

  @Get('versions/:id/variance')
  @Permissions('exec')
  threeWayVariance(
    @Param('id', ParseIntPipe) id: number,
    @Query('scenario_id') scenarioId: string,
    @Query('period') period: string,
    @CurrentUser() user: JwtUser,
  ) {
    if (!scenarioId || !period) throw new Error('scenario_id and period are required query params');
    return this.planning.threeWayVariance(id, parseInt(scenarioId, 10), period, user);
  }
}
