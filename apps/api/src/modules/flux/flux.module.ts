import { Module } from '@nestjs/common';
import { FluxController } from './flux.controller';
import { FluxService } from './flux.service';

// CLS-01 (GL-25) — Flux / variance analysis with forced explanation + sign-off. A read-only aggregator over
// gl_period_balances plus two governance tables; posts nothing to the GL, so it has no LedgerModule
// dependency.
@Module({
  controllers: [FluxController],
  providers: [FluxService],
  exports: [FluxService],
})
export class FluxModule {}
