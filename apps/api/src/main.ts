import 'reflect-metadata';
// OTel must patch http/pg BEFORE they are required → keep telemetry first (no-op unless env set).
import { startTelemetry, initSentry } from './observability/instrumentation';
startTelemetry();
initSentry();

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { registerEdge } from './common/edge';
import { LedgerService } from './modules/ledger/ledger.service';
import { BillingService } from './modules/billing/billing.service';

async function bootstrap() {
  // maxParamLength 500 (default 100) — QR table-session tokens carry an HMAC and exceed 100 chars.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ maxParamLength: 500 }));

  // CORS = explicit origins (เลิก wildcard "*" ของ V1)
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim());
  app.enableCors({ origin: origins, credentials: true });

  app.useGlobalFilters(new AllExceptionsFilter());
  await registerEdge(app); // helmet + rate-limit

  // seed reference data (best-effort — skip if DB not ready)
  for (const seed of [
    () => app.get(LedgerService).seedChartOfAccounts(),
    () => app.get(LedgerService).seedLedgers(),
    () => app.get(BillingService).seedPlans(),
  ]) {
    try { await seed(); } catch (e) { new Logger('Seed').warn(`seed skipped: ${(e as Error).message}`); }
  }

  const port = Number(process.env.PORT ?? 8000);
  await app.listen({ port, host: '0.0.0.0' });
  new Logger('Bootstrap').log(`Invisible ERP V2 API listening on http://0.0.0.0:${port}`);
}

void bootstrap();
