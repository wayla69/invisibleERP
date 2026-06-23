import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { DemandForecastService, type DemandForecastDto, type BacktestDto } from './demand-forecast.service';
import { qint, qintOpt } from '../../common/query';

const ForecastBody = z.object({ item_id: z.string().min(1), horizon: z.number().int().positive().optional(), algorithm: z.string().optional(), test_size: z.number().int().positive().optional() });
const BacktestBody = z.object({ item_id: z.string().min(1), test_size: z.number().int().positive().optional() });

// ── Demand ML (Phase D4) ──
// Multi-model demand forecasting with a walk-forward backtest (WAPE/MASE). Planning permission like MRP.
@Controller('api/demand')
@Permissions('planner', 'exec', 'warehouse')
export class DemandMlController {
  constructor(private readonly svc: DemandForecastService) {}
  // Forecast the horizon with the auto-selected (lowest-WAPE) model; persists the run.
  @Post('forecast') forecast(@Body(new ZodValidationPipe(ForecastBody)) b: DemandForecastDto, @CurrentUser() u: JwtUser) { return this.svc.forecast(b, u); }
  // Backtest all candidate models and compare accuracy (no persistence).
  @Post('backtest') backtest(@Body(new ZodValidationPipe(BacktestBody)) b: BacktestDto, @CurrentUser() u: JwtUser) { return this.svc.backtest(b, u); }
  // Recent persisted forecast runs (own tenant).
  @Get('forecasts') list(@CurrentUser() u: JwtUser, @Query('limit') limit?: string) { return this.svc.list(u, qint('limit', limit, 50)); }
  // Forecast-accuracy KPI for the analytics plane (avg WAPE/MASE, overall + per algorithm).
  @Get('accuracy') accuracy(@CurrentUser() u: JwtUser) { return this.svc.accuracy(u); }
}
