import { Module } from '@nestjs/common';
import { DemandForecastService } from './demand-forecast.service';
import { DemandMlController } from './demand-ml.controller';

// Phase D4 — demand ML: multi-model forecasting + walk-forward backtesting (WAPE/MASE) over POS history.
// Read-only over sales; persists forecast runs (tenant-scoped). No GL impact.
@Module({
  controllers: [DemandMlController],
  providers: [DemandForecastService],
  exports: [DemandForecastService],
})
export class DemandMlModule {}
