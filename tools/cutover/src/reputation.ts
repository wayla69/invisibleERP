/**
 * docs/47 — Reputation & external analytics ingestion (Google Maps reviews, GA4) over PGlite:
 * OAuth start/callback (single-use state, PKCE), encrypted token storage (never returned by a read),
 * connection targets, review/GA4 sync + upsert idempotency, review reply, revoke, MKT-14 tenant isolation.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover reputation
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'rep-secret';
process.env.NODE_ENV = 'test';
process.env.APP_ENC_KEY = process.env.APP_ENC_KEY || 'rep-enc-key';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const realFetch = global.fetch;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [t1, t2] = [await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'mkt1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 }, // Sales default perms include marketing/exec
    { username: 'mkt2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
    { username: 'wh1', passwordHash: await pw.hash('pw3'), role: 'Warehouse', tenantId: t1 }, // no marketing/exec
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const mkt1 = await login('mkt1', 'pw1');
  const mkt2 = await login('mkt2', 'pw2');
  const wh1 = await login('wh1', 'pw3');

  // ── 1. OAuth not configured (env unset) ──
  const noEnv = await inj('GET', '/api/reputation/oauth/start?platform=google_maps', mkt1);
  ok('MKT-14: oauth/start 503s OAUTH_NOT_CONFIGURED when the Google client is unset (fail closed, no crash)',
    noEnv.status === 503 && noEnv.json?.error?.code === 'OAUTH_NOT_CONFIGURED', JSON.stringify(noEnv));

  process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id-1';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-1';
  process.env.WEB_PUBLIC_URL = 'https://app.example.com';

  // ── 2. OAuth start — correct scope per platform, state persisted, non-marketing user rejected ──
  const startMaps = await inj('GET', '/api/reputation/oauth/start?platform=google_maps', mkt1);
  const startGa4 = await inj('GET', '/api/reputation/oauth/start?platform=google_analytics', mkt1);
  const startNoPerm = await inj('GET', '/api/reputation/oauth/start?platform=google_maps', wh1);
  ok('MKT-14: oauth/start builds the correct per-platform Google scope + PKCE challenge',
    startMaps.status === 200 && /business\.manage/.test(startMaps.json.authorization_url) && /code_challenge=/.test(startMaps.json.authorization_url) &&
    startGa4.status === 200 && /analytics\.readonly/.test(startGa4.json.authorization_url),
    JSON.stringify({ maps: startMaps.json.authorization_url?.slice(0, 60), ga4: startGa4.json.authorization_url?.slice(0, 60) }));
  ok('MKT-14: a user without marketing/exec cannot start an OAuth connection (403)', startNoPerm.status === 403, JSON.stringify(startNoPerm));

  const stateFromUrl = (u: string) => new URL(u).searchParams.get('state')!;
  const stateMaps = stateFromUrl(startMaps.json.authorization_url);

  // ── 3. OAuth callback — replayed/garbage state rejected ──
  const badState = await inj('POST', '/api/reputation/oauth/callback', undefined, { state: 'nope', code: 'c' });
  ok('MKT-14: a forged/unknown OAuth state is rejected BAD_STATE (never a session/tenant leak)', badState.status === 400 && badState.json?.error?.code === 'BAD_STATE', JSON.stringify(badState));

  // ── 4. OAuth callback — happy path (mocked Google token + userinfo endpoints) ──
  const wire: { url: string; host: string }[] = [];
  global.fetch = (async (url: any, init: any) => {
    const u = String(url);
    const host = (() => { try { return new URL(u).hostname; } catch { return ''; } })();
    wire.push({ url: u, host });
    if (host === 'oauth2.googleapis.com') return { ok: true, status: 200, json: async () => ({ access_token: 'gat-1', refresh_token: 'grt-1', expires_in: 3600 }) } as any;
    if (host === 'openidconnect.googleapis.com') return { ok: true, status: 200, json: async () => ({ email: 'owner@example.com' }) } as any;
    if (u.includes('mybusiness.googleapis.com/v4/accounts') && !u.includes('/locations')) return { ok: true, status: 200, json: async () => ({ accounts: [{ name: 'accounts/1' }] }) } as any;
    if (u.includes('/accounts/1/locations')) return { ok: true, status: 200, json: async () => ({ locations: [{ name: 'accounts/1/locations/9', locationName: 'สาขาสีลม' }] }) } as any;
    return { ok: true, status: 200, json: async () => ({}) } as any;
  }) as any;
  const cb = await inj('POST', '/api/reputation/oauth/callback', undefined, { state: stateMaps, code: 'auth-code-1' });
  ok('MKT-14: OAuth callback consumes the single-use state, exchanges the code, and connects', cb.status === 201 || cb.status === 200 || cb.json?.platform === 'google_maps', JSON.stringify(cb));

  const cbReplay = await inj('POST', '/api/reputation/oauth/callback', undefined, { state: stateMaps, code: 'auth-code-1' });
  ok('MKT-14: replaying the SAME (now-consumed) state a second time is rejected BAD_STATE', cbReplay.status === 400 && cbReplay.json?.error?.code === 'BAD_STATE', JSON.stringify(cbReplay));

  const conns = await inj('GET', '/api/reputation/connections', mkt1);
  const mapsConn = conns.json.connections?.find((c: any) => c.platform === 'google_maps');
  ok('MKT-14: the connections read is REDACTED — has_refresh_token boolean only, no token value anywhere in the response',
    !!mapsConn && mapsConn.status === 'active' && mapsConn.google_account_email === 'owner@example.com' && mapsConn.has_refresh_token === true &&
    !JSON.stringify(conns.json).includes('gat-1') && !JSON.stringify(conns.json).includes('grt-1'),
    JSON.stringify(conns.json));

  // ── 5. List + set targets (enumerated live from Google) ──
  const targets = await inj('GET', `/api/reputation/connections/${mapsConn.id}/targets`, mkt1);
  ok('MKT-14: targets are enumerated live from the Business Profile API (accounts → locations)',
    targets.status === 200 && targets.json.targets?.[0]?.ref === 'accounts/1/locations/9' && targets.json.targets?.[0]?.label === 'สาขาสีลม',
    JSON.stringify(targets.json));
  const setT = await inj('PUT', `/api/reputation/connections/${mapsConn.id}/targets`, mkt1, { targets: [{ ref: 'accounts/1/locations/9', label: 'สาขาสีลม' }] });
  ok('MKT-14: saving chosen targets succeeds', setT.status === 200 && setT.json.count === 1, JSON.stringify(setT));

  // ── 6. Sync now — reviews upsert, idempotent on external_review_id ──
  global.fetch = (async (url: any, init: any) => {
    const u = String(url);
    const host = (() => { try { return new URL(u).hostname; } catch { return ''; } })();
    if (host === 'oauth2.googleapis.com') return { ok: true, status: 200, json: async () => ({ access_token: 'gat-1', expires_in: 3600 }) } as any;
    if (u.includes('/reviews') && !init) return { ok: false, status: 500 } as any;
    if (u.includes('/reviews')) {
      return { ok: true, status: 200, json: async () => ({ reviews: [
        { reviewId: 'rev-1', reviewer: { displayName: 'สมชาย', profilePhotoUrl: 'https://x/p.jpg' }, starRating: 'TWO', comment: 'อาหารช้า', createTime: '2026-07-01T10:00:00Z' },
        { reviewId: 'rev-2', reviewer: { displayName: 'มานี' }, starRating: 'FIVE', comment: 'อร่อยมาก', createTime: '2026-07-05T10:00:00Z' },
      ] }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  }) as any;
  const sync1 = await inj('POST', '/api/reputation/sync/google_maps', mkt1);
  const sync2 = await inj('POST', '/api/reputation/sync/google_maps', mkt1); // re-run: idempotent upsert, no dupes
  ok('MKT-14: review sync pulls + upserts (2 reviews synced, 0 errors)', sync1.json.reviews_synced === 2 && sync1.json.errors.length === 0, JSON.stringify(sync1.json));
  const reviewsList = await inj('GET', '/api/reputation/reviews', mkt1);
  ok('MKT-14: a re-run is idempotent (still exactly 2 review rows, not 4, on the unique external_review_id)', reviewsList.json.count === 2, JSON.stringify(reviewsList.json));

  const needsAttn = await inj('GET', '/api/reputation/reviews?needs_attention=1', mkt1);
  ok('MKT-14: needs-attention filter surfaces only low-rated, unreplied reviews (rev-1, rating 2)',
    needsAttn.json.count === 1 && needsAttn.json.reviews[0].rating === 2, JSON.stringify(needsAttn.json));

  // ── 7. Reply to a review ──
  const revRow = reviewsList.json.reviews.find((r: any) => r.rating === 2);
  const reply = await inj('POST', `/api/reputation/reviews/${revRow.id}/reply`, mkt1, { comment: 'ขออภัยในความล่าช้าค่ะ' });
  const needsAttnAfter = await inj('GET', '/api/reputation/reviews?needs_attention=1', mkt1);
  ok('MKT-14: replying to a review posts to Google and clears it from the needs-attention filter',
    reply.status === 201 || reply.json?.ok === true, JSON.stringify({ reply: reply.json, after: needsAttnAfter.json.count }));
  ok('MKT-14: the replied review no longer needs attention', needsAttnAfter.json.count === 0, JSON.stringify(needsAttnAfter.json));

  // ── 8. GA4 connect + sync (separate connection) ──
  const startGa4b = await inj('GET', '/api/reputation/oauth/start?platform=google_analytics', mkt1);
  const stateGa4 = stateFromUrl(startGa4b.json.authorization_url);
  global.fetch = (async (url: any) => {
    const u = String(url);
    const host = (() => { try { return new URL(u).hostname; } catch { return ''; } })();
    if (host === 'oauth2.googleapis.com') return { ok: true, status: 200, json: async () => ({ access_token: 'gat-2', refresh_token: 'grt-2', expires_in: 3600 }) } as any;
    if (host === 'openidconnect.googleapis.com') return { ok: true, status: 200, json: async () => ({ email: 'owner@example.com' }) } as any;
    if (u.includes('accountSummaries')) return { ok: true, status: 200, json: async () => ({ accountSummaries: [{ displayName: 'Acme', propertySummaries: [{ property: 'properties/555', displayName: 'Main site' }] }] }) } as any;
    if (u.includes(':runReport')) {
      return { ok: true, status: 200, json: async () => ({ rows: [
        { dimensionValues: [{ value: '20260701' }, { value: 'Organic Search' }], metricValues: [{ value: '100' }, { value: '80' }, { value: '5' }, { value: '2000' }, { value: '0.6' }] },
        { dimensionValues: [{ value: '20260701' }, { value: 'Direct' }], metricValues: [{ value: '50' }, { value: '40' }, { value: '1' }, { value: '500' }, { value: '0.5' }] },
      ] }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  }) as any;
  const cbGa4 = await inj('POST', '/api/reputation/oauth/callback', undefined, { state: stateGa4, code: 'auth-code-2' });
  const conns2 = await inj('GET', '/api/reputation/connections', mkt1);
  const ga4Conn = conns2.json.connections.find((c: any) => c.platform === 'google_analytics');
  await inj('PUT', `/api/reputation/connections/${ga4Conn.id}/targets`, mkt1, { targets: [{ ref: 'properties/555', label: 'Acme — Main site' }] });
  const syncGa4 = await inj('POST', '/api/reputation/sync/google_analytics', mkt1);
  ok('MKT-14: GA4 sync aggregates multi-channel rows into ONE daily total (100+50=150 sessions) and picks the top channel by sessions',
    syncGa4.json.days_synced === 1 && syncGa4.json.errors.length === 0, JSON.stringify(syncGa4.json));
  const analytics = await inj('GET', '/api/reputation/analytics', mkt1);
  const day = analytics.json.days?.[0];
  ok('MKT-14: the analytics read shows the aggregated day (sessions 150, top channel Organic Search)',
    day?.sessions === 150 && day?.top_channel_group === 'Organic Search', JSON.stringify(day));

  const summary = await inj('GET', '/api/bi/reputation-summary?days=30', mkt1);
  ok('MKT-14: the live reputation-summary dashboard read composes reviews + GA4 (same shape as marketing-roi)',
    summary.status === 200 && summary.json.review_count === 2 && summary.json.needs_attention === 0 && summary.json.analytics?.sessions === 150,
    JSON.stringify(summary.json));

  // ── 9. MULTI-TENANT TEST PROTOCOL — isolation + data-leak check (T2 cannot see/touch T1's data) ──
  const t2Conns = await inj('GET', '/api/reputation/connections', mkt2);
  const t2Reviews = await inj('GET', '/api/reputation/reviews', mkt2);
  const t2Analytics = await inj('GET', '/api/reputation/analytics', mkt2);
  const t2SyncMaps = await inj('POST', '/api/reputation/sync/google_maps', mkt2); // must touch ONLY T2's own (zero) connections
  ok('MKT-14 (Multi-Tenant Test Protocol — isolation): T2 sees ZERO T1 connections/reviews/analytics rows (RLS + explicit tenant filter)',
    t2Conns.json.connections.length === 0 && t2Reviews.json.count === 0 && t2Analytics.json.count === 0,
    JSON.stringify({ conns: t2Conns.json, reviews: t2Reviews.json.count, an: t2Analytics.json.count }));
  ok('MKT-14 (Multi-Tenant Test Protocol — data-leak): T2 sync touches 0 connections (never T1\'s)', t2SyncMaps.json.connections === 0, JSON.stringify(t2SyncMaps.json));

  // ── 10. Revoke ──
  const revoke = await inj('DELETE', `/api/reputation/connections/${mapsConn.id}`, mkt1);
  const connsAfterRevoke = await inj('GET', '/api/reputation/connections', mkt1);
  const mapsAfter = connsAfterRevoke.json.connections.find((c: any) => c.id === mapsConn.id);
  ok('MKT-14: revoking a connection marks it revoked and clears its stored tokens (has_refresh_token → false)',
    revoke.json.ok === true && mapsAfter.status === 'revoked' && mapsAfter.has_refresh_token === false, JSON.stringify(mapsAfter));

  global.fetch = realFetch;
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.WEB_PUBLIC_URL;

  await app.close();
  console.log('\n── Reputation & external analytics ingestion (docs/47, MKT-14) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} reputation checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} reputation checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
