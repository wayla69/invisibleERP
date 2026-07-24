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
import { assertTenancyBootSafe, assertRlsBackstop, allowSingleCompanyMultiTenant, allowRlsBypassBaseRole } from './common/tenancy-boot-check';
import { DRIZZLE, PG_CLIENT, runGlobalDb, type DrizzleDb, type PgClient } from './database/database.module';
import { tenants } from './database/schema';
import { count } from 'drizzle-orm';
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
  // trustProxy (security review L-8): behind a reverse proxy `req.ip` is otherwise the PROXY's address, so the
  // per-IP edge rate-limiter buckets EVERY client together (one shared limit). Trust the configured number of
  // proxy hops so Fastify derives the real client IP from X-Forwarded-For → correct per-client limiting. Default
  // 0 ⇒ trustProxy off (direct-socket peer, unchanged). Shares the TRUSTED_PROXY_HOPS knob with the audit-IP fix.
  const trustProxyHops = Math.max(0, Math.floor(Number(process.env.TRUSTED_PROXY_HOPS ?? 0)) || 0);
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ routerOptions: { maxParamLength: 500 }, bodyLimit: 16 * 1024 * 1024, trustProxy: trustProxyHops > 0 ? trustProxyHops : false }), {
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

  // Data-isolation boot check (4.2 / H-4): refuse (default) if several companies run under single-company
  // mode, where every tenant Admin would have a global RLS bypass. Best-effort read; only a `refuse` throws.
  try {
    const db = app.get<DrizzleDb>(DRIZZLE);
    await assertTenancyBootSafe({
      isProd: process.env.NODE_ENV === 'production',
      mode: process.env.TENANCY_MODE ?? 'single-company',
      allowOptOut: allowSingleCompanyMultiTenant(),
      // Global boot read (no tenant context yet) — declare it so STRICT_TENANT_PROXY=1 permits the base-pool
      // count instead of throwing TENANT_CONTEXT_MISSING (which the catch below would swallow, silently
      // skipping this H-4 check).
      countTenants: () => runGlobalDb('boot:count-tenants', async () => { const r = await db.select({ n: count() }).from(tenants); return Number(r[0]?.n ?? 0); }),
      logger: new Logger('TenancyBoot'),
    });
  } catch (e) {
    if (/Refusing to boot/.test((e as Error).message)) throw e;
    new Logger('TenancyBoot').warn(`tenancy boot check skipped: ${(e as Error).message}`);
  }

  // RLS-backstop boot check (H-3): refuse (default) if the base DB connection role bypasses RLS (superuser
  // or BYPASSRLS), which leaves the @NoTx / SSE / raw / background-job surface with no DB-level tenant
  // backstop. Best-effort probe; only a `refuse` throws. Fix: connect as a non-superuser owner role.
  try {
    const sql = app.get<PgClient>(PG_CLIENT);
    await assertRlsBackstop({
      isProd: process.env.NODE_ENV === 'production',
      allowOptOut: allowRlsBypassBaseRole(),
      probe: async () => {
        const rows: any = await sql`select (current_setting('is_superuser') = 'on')::text as super, coalesce((select rolbypassrls from pg_roles where rolname = current_user), false)::text as bypass`;
        const r = rows[0] ?? {};
        return { isSuperuser: r.super === 'true', bypassRls: r.bypass === 'true' };
      },
      logger: new Logger('RlsBackstop'),
    });
  } catch (e) {
    if (/Refusing to boot/.test((e as Error).message)) throw e;
    new Logger('RlsBackstop').warn(`RLS backstop check skipped: ${(e as Error).message}`);
  }

  const port = Number(process.env.PORT ?? 8000);
  // Bind dual-stack ('::' accepts IPv6 AND IPv4-mapped connections) so Railway PRIVATE networking —
  // which is IPv6-only (*.railway.internal) — can reach the API; an IPv4-only bind ('0.0.0.0') forces the
  // web service's same-origin /api proxy out through the public edge (slower, counted egress). Hosts
  // without an IPv6 stack (some containers/CI) reject '::' with EAFNOSUPPORT/EADDRNOTAVAIL — fall back to
  // the old IPv4 bind so this change can never brick a boot. BIND_HOST overrides both when set.
  const preferredHost = process.env.BIND_HOST ?? '::';
  let boundHost = preferredHost;
  try {
    await app.listen({ port, host: preferredHost });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? '';
    if (preferredHost === '::' && (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL')) {
      boundHost = '0.0.0.0';
      new Logger('Bootstrap').warn(`IPv6 dual-stack bind unavailable (${code}) — falling back to IPv4 0.0.0.0`);
      await app.listen({ port, host: boundHost });
    } else {
      throw e;
    }
  }
  new Logger('Bootstrap').log(`Invisible ERP API listening on http://${boundHost === '::' ? '[::]' : boundHost}:${port} (pid ${process.pid})`);
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
