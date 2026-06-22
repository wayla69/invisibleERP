import { Controller, Get, Post, Put, Body, Param, ParseIntPipe, Query, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { PlanningService } from './planning.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

const VersionBody = z.object({ name: z.string().min(1), fiscal_year: z.number().int(), notes: z.string().optional() });
const ScenarioBody = z.object({ name: z.string().min(1), description: z.string().optional(), is_default: z.boolean().optional() });
const CloneBody = z.object({ name: z.string().min(1), description: z.string().optional() });
const ForecastLineBody = z.object({ account_code: z.string().min(1), period: z.string().min(1), amount: z.number(), cost_center_code: z.string().optional(), notes: z.string().optional() });
const DriverBody = z.object({ account_code: z.string().min(1), driver_type: z.enum(['percent', 'rate', 'absolute']), rate_value: z.number(), notes: z.string().optional() });
const RunDriversBody = z.object({ periods: z.array(z.string().min(1)).min(1) });

@Controller('api/planning')
export class PlanningController {
  constructor(private readonly planning: PlanningService) {}

  // ── Versions ──

  @Post('versions')
  @Permissions('exec')
  createVersion(@Body(new ZodValidationPipe(VersionBody)) dto: z.infer<typeof VersionBody>, @CurrentUser() user: JwtUser) {
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
  addScenario(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ScenarioBody)) dto: z.infer<typeof ScenarioBody>, @CurrentUser() user: JwtUser) {
    return this.planning.addScenario(id, dto, user);
  }

  @Post('scenarios/:id/clone')
  @Permissions('exec')
  @HttpCode(200)
  cloneScenario(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(CloneBody)) dto: z.infer<typeof CloneBody>, @CurrentUser() user: JwtUser) {
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
  upsertForecastLine(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ForecastLineBody)) dto: z.infer<typeof ForecastLineBody>, @CurrentUser() user: JwtUser) {
    return this.planning.upsertForecastLine(id, dto, user);
  }

  // ── Drivers ──

  @Post('scenarios/:id/drivers')
  @Permissions('exec')
  upsertDriver(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(DriverBody)) dto: z.infer<typeof DriverBody>, @CurrentUser() user: JwtUser) {
    return this.planning.upsertDriver(id, dto, user);
  }

  @Post('scenarios/:id/run-drivers')
  @Permissions('exec')
  @HttpCode(200)
  runDrivers(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RunDriversBody)) dto: z.infer<typeof RunDriversBody>, @CurrentUser() user: JwtUser) {
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
