/**
 * Closed-loop concurrent-session load test against REAL Postgres over real HTTP — the repeatable
 * version of the 2026-06-28 report's tester (docs/security/2026-06-28-security-and-load-test-report.md §3),
 * which was never committed. Each "session" is one keep-alive TCP connection issuing the same mixed
 * authenticated read workload as that report (/api/auth/me, /api/ledger/accounts, /api/dashboard,
 * /api/ledger/trial-balance, /api/finance/ar/aging, /api/loyalty/members), so results are comparable
 * run-over-run: every request pays the full auth guard + per-request tenant transaction.
 *
 * Usage (from tools/cutover):
 *   LOAD_PG_URL=postgres://user:pw@127.0.0.1:5432/ierp_load pnpm --filter @ierp/cutover load:sessions
 *
 * Knobs: LOAD_SESSIONS="1,10,25,50,100,200" levels · LOAD_SECS=15 measured seconds per level ·
 * LOAD_WEB_CONCURRENCY / LOAD_DB_POOL_MAX forwarded to the API child (defaults 1 / unset→app default).
 * The target DB is DROPPED and re-migrated + seeded every run — point it ONLY at a disposable DB.
 * The API is booted as a REAL child process from apps/api/dist (not app.inject) so numbers include the
 * HTTP/TCP stack, the shared listen socket, and (with LOAD_WEB_CONCURRENCY>1) the cluster module.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { eq } from 'drizzle-orm';
import * as s from '../../../apps/api/dist/database/schema/index';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';
import { harnessDb } from './harness-db';

const PG_URL = process.env.LOAD_PG_URL;
if (!PG_URL) { console.error('❌ set LOAD_PG_URL to a DISPOSABLE Postgres database (it is dropped and re-created)'); process.exit(1); }
const PORT = Number(process.env.LOAD_PORT ?? 3111);
const BASE = `http://127.0.0.1:${PORT}`;
const LEVELS = (process.env.LOAD_SESSIONS ?? '1,10,25,50,100,200').split(',').map(Number).filter(Boolean);
const SECS = Number(process.env.LOAD_SECS ?? 15);
// LOAD_API_DIST lets an A/B run point at a DIFFERENT build (e.g. a pre-refactor worktree's dist) while
// setup/seeding still runs from the current tree — same DB, same tester, only the measured code differs.
const API_DIST = process.env.LOAD_API_DIST
  ? resolve(process.env.LOAD_API_DIST, 'main.js')
  : resolve(process.cwd(), '../../apps/api/dist/main.js');

const grpOf = (k: string) => Object.entries(PERM_GROUPS).find(([, ks]) => (ks as string[]).includes(k))?.[0] ?? null;

// Same modest world as load-smoke: enough rows that the list endpoints do real work.
async function seed(db: any) {
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k, grp: grpOf(k) }))).onConflictDoNothing();
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((perms as string[]).map((perm) => ({ role: role as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  await db.insert(s.users).values({ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id }).onConflictDoNothing();
  const now = new Date();
  for (let i = 0; i < 200; i++) {
    const id = `LOAD-${String(i).padStart(4, '0')}`;
    await db.insert(s.items).values({ itemId: id, itemDescription: `Load item ${i} สินค้าโหลดเทสต์`, uom: 'EA', unitPrice: String(10 + (i % 90)) }).onConflictDoNothing();
    await db.insert(s.stockSnapshots).values({ generateDate: now, itemId: id, itemDescription: `Load item ${i}`, uom: 'EA', avQty: String(i % 50), totalStock: String(i % 50) });
  }
}

// One keep-alive request on a session's dedicated agent; resolves to [statusCode, ms].
function fire(agent: http.Agent, method: string, path: string, token?: string, payload?: unknown): Promise<[number, number]> {
  return new Promise((res) => {
    const t0 = performance.now();
    const body = payload ? JSON.stringify(payload) : undefined;
    const req = http.request(`${BASE}${path}`, {
      method, agent,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (r) => { r.resume(); r.on('end', () => res([r.statusCode ?? 0, performance.now() - t0])); });
    req.on('error', () => res([0, performance.now() - t0]));
    if (body) req.write(body);
    req.end();
  });
}

const WORKLOAD = [
  '/api/auth/me',
  '/api/ledger/accounts',
  '/api/dashboard',
  '/api/ledger/trial-balance',
  '/api/finance/ar/aging',
  '/api/loyalty/members',
];

const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

async function runLevel(sessions: number, token: string) {
  const durations: number[] = [];
  let errors = 0; let stop = false;
  const workers = Array.from({ length: sessions }, async (_, w) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); // one connection = one "session"
    let i = w; // stagger starting offsets so sessions don't hit the same endpoint in lockstep
    while (!stop) {
      const [status, ms] = await fire(agent, 'GET', WORKLOAD[i++ % WORKLOAD.length]!, token);
      durations.push(ms);
      if (status !== 200) errors++;
    }
    agent.destroy();
  });
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, SECS * 1000));
  stop = true;
  await Promise.all(workers);
  const wall = (performance.now() - t0) / 1000;
  return {
    sessions,
    rps: +(durations.length / wall).toFixed(0),
    p50: +pct(durations, 50).toFixed(1),
    p90: +pct(durations, 90).toFixed(1),
    p99: +pct(durations, 99).toFixed(1),
    max: +Math.max(...durations).toFixed(1),
    errors,
  };
}

async function waitReady(deadlineMs = 60_000): Promise<void> {
  const t0 = Date.now();
  const agent = new http.Agent();
  while (Date.now() - t0 < deadlineMs) {
    const [status] = await fire(agent, 'GET', '/readyz');
    if (status === 200) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API did not become ready in time');
}

async function main() {
  console.log('load-sessions — resetting + migrating + seeding the target DB…');
  process.env.HARNESS_PG_URL = PG_URL; // reuse the shared reset+migrate helper
  const h = await harnessDb();
  await seed(h.db);
  await h.cleanup();

  const webConc = process.env.LOAD_WEB_CONCURRENCY ?? '1';
  const api: ChildProcess = spawn(process.execPath, [API_DIST], {
    env: {
      ...process.env,
      NODE_ENV: 'development', // dev gates: the prod fail-closed checks (superuser role, secrets) don't apply to a disposable bench DB
      DATABASE_URL: PG_URL,
      PORT: String(PORT),
      JWT_SECRET: process.env.JWT_SECRET || 'load-sessions-secret-0123456789abcdef',
      RATE_LIMIT_MAX: '1000000', // measure app capacity, not the edge cap (same as the 2026-06-28 run)
      WEB_CONCURRENCY: webConc,
      ...(process.env.LOAD_DB_POOL_MAX ? { DB_POOL_MAX: process.env.LOAD_DB_POOL_MAX } : {}),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitReady();
    const login = await new Promise<string>((res, rej) => {
      const agent = new http.Agent();
      const req = http.request(`${BASE}/api/login`, { method: 'POST', agent, headers: { 'content-type': 'application/json' } }, (r) => {
        let buf = ''; r.on('data', (c) => (buf += c)); r.on('end', () => {
          const tok = JSON.parse(buf).token; tok ? res(tok) : rej(new Error(`login failed: ${buf}`));
        });
      });
      req.end(JSON.stringify({ username: 'admin', password: 'admin123' }));
    });

    // warm-up (JIT, pool fill, first-query planning) — excluded from measurement
    await runLevel(4, login);

    console.log(`\nworkload: ${WORKLOAD.join(' ')}\nWEB_CONCURRENCY=${webConc} DB_POOL_MAX=${process.env.LOAD_DB_POOL_MAX ?? '(default)'} · ${SECS}s per level\n`);
    console.log('| Sessions | req/s | p50 ms | p90 ms | p99 ms | max ms | errors |');
    console.log('|---------:|------:|-------:|-------:|-------:|-------:|-------:|');
    const results = [];
    for (const lvl of LEVELS) {
      const r = await runLevel(lvl, login);
      results.push(r);
      console.log(`| ${r.sessions} | ${r.rps} | ${r.p50} | ${r.p90} | ${r.p99} | ${r.max} | ${r.errors} |`);
    }
    const totalErrors = results.reduce((a, r) => a + r.errors, 0);
    if (totalErrors > 0) { console.error(`❌ ${totalErrors} request(s) errored — numbers are not trustworthy`); process.exitCode = 1; }
    else console.log('\n✅ 0 errors across all levels');
  } finally {
    api.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));
    if (!api.killed) api.kill('SIGKILL');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
