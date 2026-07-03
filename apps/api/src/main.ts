import 'reflect-metadata';
import cluster from 'node:cluster';
import { cpus } from 'node:os';

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
  // rawBody: true — retain the exact request bytes so signed webhooks (PSP callbacks) can verify their
  // HMAC over the raw payload, not a re-serialized object (key reordering would break the signature).
  // bodyLimit 16 MB (default 1 MB) — the AP-intake upload channel (EXP-10) carries an image/PDF as a
  // base64 data: URL in the JSON body (object-storage convention, no multipart); per-type size caps
  // are enforced in ap-intake.service (FILE_TOO_LARGE) below this transport ceiling.
  // Production logger: 'log'-level Nest bootstrap noise (RouterExplorer maps THOUSANDS of route lines as
  // the app has grown) floods Railway's 500 logs/sec replica cap — Railway drops the overflow ("Messages
  // dropped"), which can swallow the real error of a failing boot, and the synchronous log storm slows
  // startup toward the deploy healthcheck window. Keep error/warn (EnvValidation fail-closed warnings
  // still surface); the structured pino ops logger writes to stdout independently and is unaffected.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ maxParamLength: 500, bodyLimit: 16 * 1024 * 1024 }), {
    rawBody: true,
    logger: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : undefined,
  });

  // CORS = explicit origins (เลิก wildcard "*" ของ V1)
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim());
  // credentials: true → browser sends the httpOnly auth cookie; allow the CSRF + auth headers explicitly.
  app.enableCors({ origin: origins, credentials: true, allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'] });

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
  new Logger('Bootstrap').log(`Invisible ERP V2 API listening on http://0.0.0.0:${port} (pid ${process.pid})`);
}

// Opt-in multi-process clustering. A single Node process is single-threaded for JS and saturates ~1 core
// (the load test showed throughput capped there while other cores sat idle). Set WEB_CONCURRENCY>1 (or 'auto'
// for one worker per core) to fork N workers sharing the listen socket — ~N× throughput. Default 1 = current
// single-process behaviour (no change). Each worker opens its own DB pool, so keep WEB_CONCURRENCY×DB_POOL_MAX
// under Postgres max_connections. Migrations/seeds are idempotent, so worker overlap on boot is safe.
function resolveConcurrency(): number {
  const v = process.env.WEB_CONCURRENCY;
  if (!v || v === '1') return 1;
  if (v === 'auto') return Math.max(1, cpus().length);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

const concurrency = resolveConcurrency();
if (concurrency > 1 && cluster.isPrimary) {
  const log = new Logger('Cluster');
  log.log(`Primary ${process.pid} forking ${concurrency} workers`);
  for (let i = 0; i < concurrency; i++) cluster.fork();
  cluster.on('exit', (worker) => { log.warn(`worker ${worker.process.pid} died — reforking`); cluster.fork(); });
} else {
  void bootstrap();
}
