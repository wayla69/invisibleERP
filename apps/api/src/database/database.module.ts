import { Global, Module, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { tenantALS } from '../common/tenant-context';

export const DRIZZLE = Symbol('DRIZZLE');
export type DrizzleDb = PostgresJsDatabase<typeof schema>;

// SOX-ICFR #2 — fail-closed proxy (staged behind STRICT_TENANT_PROXY). The tenant-scoping state
// (SET LOCAL ROLE + app.* GUCs) is transaction-local, so it can never survive a COMMIT onto a reused
// pooled connection — the pool-return leak is structurally impossible on the request path. The residual
// exposure is a DIRECT query issued with NO tenant context at all (a service method invoked outside a
// request / runInTenantContext), which silently falls through to the BASE pool with no GUCs. When the flag
// is on, such a query throws TENANT_CONTEXT_MISSING instead — a loud failure rather than a silent
// cross-tenant read. Legitimately-global work (login-lockout style, cross-tenant platform reads on the base
// pool) declares itself via runGlobalDb(); genuine per-tenant work already runs inside runInTenantContext.
export const globalDbALS = new AsyncLocalStorage<{ reason: string }>();
/** Explicit, grep-able escape hatch: run `fn` in a context where a base-pool DB query is intentional. */
export function runGlobalDb<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return globalDbALS.run({ reason }, fn);
}

// Direct query entry points guarded when there is no tenant context. `transaction` is deliberately NOT
// guarded — runInTenantContext / RealtimeScope / the guards call db.transaction() precisely to OPEN the
// scoping tx before any ALS store exists, so guarding it would break context establishment itself.
const GUARDED_OPS = new Set(['select', 'insert', 'update', 'delete', 'execute', 'query', '$count']);
// STRICT_TENANT_PROXY: '1' = enforce (throw TENANT_CONTEXT_MISSING), 'warn' = audit-only (log the call site
// + short stack, then fall through to the base pool — used during rollout to enumerate every un-wrapped
// base-pool read without breaking the run), anything else = off (legacy fallback). See docs/ops/tenancy-model §1ter.
const proxyMode = (): '1' | 'warn' | 'off' => {
  const v = process.env.STRICT_TENANT_PROXY;
  return v === '1' ? '1' : v === 'warn' ? 'warn' : 'off';
};

// Route every query to the per-request tenant transaction (RLS-scoped) when present,
// else the base pool. Services keep injecting DRIZZLE unchanged — isolation is transparent.
// Exported so tests can wrap a PGlite db the same way (required for the interceptor's
// per-request tx + the handler's queries to share one connection).
export function tenantAwareProxy(base: DrizzleDb): DrizzleDb {
  return new Proxy(base, {
    get(target, prop, receiver) {
      const tx = tenantALS.getStore()?.tx;
      if (!tx && typeof prop === 'string' && GUARDED_OPS.has(prop) && !globalDbALS.getStore()) {
        const mode = proxyMode();
        if (mode === '1') {
          throw new ServiceUnavailableException({
            code: 'TENANT_CONTEXT_MISSING',
            message: `DB ${prop}() ran outside a tenant context (no request tx / runInTenantContext / runGlobalDb)`,
            messageTh: 'มีการเข้าถึงฐานข้อมูลนอกบริบทผู้เช่า',
          });
        }
        if (mode === 'warn') {
          const site = (new Error().stack ?? '').split('\n').slice(2, 7).join('\n');
          // eslint-disable-next-line no-console
          console.error(`[tenant-proxy] base-pool ${prop}() with NO tenant context:\n${site}`);
        }
      }
      const active: any = tx ?? target;
      const val = active[prop];
      return typeof val === 'function' ? val.bind(active) : val ?? Reflect.get(target, prop, receiver);
    },
  }) as DrizzleDb;
}

// The raw postgres-js client (the tagged-template fn). Exposed so auth-infra code can run AUTOCOMMIT
// statements OUTSIDE the per-request tenant transaction (e.g. the login-lockout counter, which must persist
// even when the request itself rolls back on a 401). Shares the one pool with DRIZZLE.
export const PG_CLIENT = Symbol('PG_CLIENT');
export type PgClient = ReturnType<typeof postgres>;

@Global()
@Module({
  providers: [
    {
      provide: PG_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PgClient => {
        const logger = new Logger('Database');
        const url = config.get<string>('DATABASE_URL');
        // postgres-js connect แบบ lazy (ไม่ต่อจน query แรก) → server boot ได้แม้ยังไม่ตั้ง DB.
        // health/config ใช้งานได้; endpoint ที่ query จะ error ตอน request ถ้า DB ยังไม่พร้อม.
        if (!url) {
          logger.warn('DATABASE_URL not set — server boots, but DB-backed endpoints will fail until configured.');
        } else if (url.startsWith('postgres://')) {
          logger.warn('DATABASE_URL uses postgres:// — ควรใช้ postgresql:// (parity note from V1 user_store)');
        }
        // Pool size per process. Default 20 (was 10 — too low for a single Node process: the load test showed
        // throughput pinned at ~400 rps with the pool saturated). Size so that (replicas × DB_POOL_MAX) stays
        // under Postgres max_connections; with WEB_CONCURRENCY workers each worker opens its own pool.
        const max = Number(process.env.DB_POOL_MAX ?? 20);
        // Connection hygiene (postgres-js, seconds): close idle conns so a burst doesn't leave the pool
        // pinned; fail fast when the DB is unreachable instead of hanging the request; recycle conns
        // periodically so a leaked/half-dead socket can't sit in the pool forever (the audit flagged "a
        // hung query idles until timeout, no recycling"). All env-tunable.
        const idleTimeout = Number(process.env.DB_IDLE_TIMEOUT ?? 30);
        const connectTimeout = Number(process.env.DB_CONNECT_TIMEOUT ?? 10);
        const maxLifetime = Number(process.env.DB_MAX_LIFETIME ?? 1800);
        const opts: Record<string, unknown> = { max, idle_timeout: idleTimeout, connect_timeout: connectTimeout, max_lifetime: maxLifetime };
        // simple-protocol mode (เช่น ต่อ PGlite-wire/บาง pooler ที่ไม่รองรับ extended protocol/type-fetch)
        // Round-2 ARC NEW-1: transaction-mode pgbouncer breaks server-side prepared statements under
        // connection reuse, and the coupling was documented-but-unenforced. Detect the pooler by its
        // conventional port (6432 — tools/ops/pgbouncer/pgbouncer.ini) and auto-enable simple protocol;
        // DB_SIMPLE=1 still forces it, DB_SIMPLE=0 explicitly opts out of the auto-detection.
        const viaPgbouncer = /:6432(\/|$)/.test(url ?? '');
        const simple = process.env.DB_SIMPLE === '1' || (viaPgbouncer && process.env.DB_SIMPLE !== '0');
        if (simple) { opts.prepare = false; opts.fetch_types = false; }
        if (viaPgbouncer && process.env.DB_SIMPLE == null) logger.log('pgbouncer port detected (6432) — prepared statements disabled automatically (set DB_SIMPLE=0 to override)');
        // Boot-time visibility of the effective pool config (deeper utilization / wait-queue-depth metrics
        // need an external pooler + exporter — pgbouncer + Prometheus — tracked as an ops follow-up).
        if (url) logger.log(`PG pool: max=${max}, idle_timeout=${idleTimeout}s, connect_timeout=${connectTimeout}s, max_lifetime=${maxLifetime}s`);
        return postgres(url ?? 'postgresql://localhost:5432/_unconfigured', opts);
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_CLIENT],
      useFactory: (client: PgClient): DrizzleDb => tenantAwareProxy(drizzle(client, { schema })),
    },
  ],
  exports: [DRIZZLE, PG_CLIENT],
})
export class DatabaseModule {}
