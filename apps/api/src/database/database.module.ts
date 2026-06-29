import { Global, Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { tenantALS } from '../common/tenant-context';

export const DRIZZLE = Symbol('DRIZZLE');
export type DrizzleDb = PostgresJsDatabase<typeof schema>;

// Route every query to the per-request tenant transaction (RLS-scoped) when present,
// else the base pool. Services keep injecting DRIZZLE unchanged — isolation is transparent.
// Exported so tests can wrap a PGlite db the same way (required for the interceptor's
// per-request tx + the handler's queries to share one connection).
export function tenantAwareProxy(base: DrizzleDb): DrizzleDb {
  return new Proxy(base, {
    get(target, prop, receiver) {
      const tx = tenantALS.getStore()?.tx;
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
        const opts: Record<string, unknown> = { max };
        // simple-protocol mode (เช่น ต่อ PGlite-wire/บาง pooler ที่ไม่รองรับ extended protocol/type-fetch)
        if (process.env.DB_SIMPLE === '1') { opts.prepare = false; opts.fetch_types = false; }
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
