/**
 * C5 — LINE OA member CRM: enrol/link a POS member from a verified LINE identity, look up by LINE userId,
 * and push LINE messages to the member's LINE userId (not their phone). Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover line-crm
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'line-secret';
process.env.NODE_ENV = 'test';
process.env.LINE_CHANNEL_TOKEN = 'test-line-push-token'; // makes the LINE push gateway "configured" → real(stubbed) fetch
// LINE_LOGIN_CHANNEL_ID intentionally unset → verifyLineIdToken uses the dev mock:<userId>[:<name>] path

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

const linePushes: { to: string; auth: string; text: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  if (url.includes('api.line.me/v2/bot/message/push')) {
    const body = JSON.parse(init?.body ?? '{}');
    linePushes.push({ to: body.to, auth: String(init?.headers?.Authorization ?? ''), text: body.messages?.[0]?.text ?? '' });
    return { ok: true, status: 200, headers: { get: () => 'req-1' }, text: async () => '' } as any;
  }
  return realFetch(input, init);
}) as any;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true }]).onConflictDoNothing();
  const t1 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'T1')))[0].id);
  await db.insert(s.users).values([{ username: 'boss', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 }]).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: true, pointsPerBaht: '1', bahtPerPoint: '1', minRedeem: '0' }).onConflictDoNothing();

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
  const token = (await inj('POST', '/api/login', undefined, { username: 'boss', password: 'pw' })).json.token as string;

  // ── 1. enrol via LINE → creates a member carrying the LINE identity ──
  const e1 = await inj('POST', '/api/loyalty/members/enroll-line', token, { id_token: 'mock:Ualice:Alice' });
  ok('enroll-line → member created with line_user_id + name from LINE profile',
    (e1.status === 200 || e1.status === 201) && e1.json.created === true && e1.json.line_user_id === 'Ualice' && e1.json.name === 'Alice',
    JSON.stringify({ created: e1.json.created, line: e1.json.line_user_id }));
  const aliceId = e1.json.id;

  // ── 2. enrol again with the same LINE account → idempotent (no duplicate) ──
  const e2 = await inj('POST', '/api/loyalty/members/enroll-line', token, { id_token: 'mock:Ualice:Alice' });
  ok('enroll-line again → idempotent (same member, created:false)', e2.json.created === false && e2.json.id === aliceId, JSON.stringify({ created: e2.json.created, same: e2.json.id === aliceId }));

  // ── 3. link a LINE identity to an existing phone member ──
  const bob = await inj('POST', '/api/loyalty/members', token, { name: 'Bob', phone: '0810000002' });
  const link = await inj('POST', `/api/loyalty/members/${bob.json.id}/link-line`, token, { id_token: 'mock:Ubob:Bob' });
  ok('link-line → existing phone member gains line_user_id', link.json.line_user_id === 'Ubob', JSON.stringify({ line: link.json.line_user_id }));

  // ── 4. a LINE account already linked to another member is rejected ──
  const dup = await inj('POST', `/api/loyalty/members/${bob.json.id}/link-line`, token, { id_token: 'mock:Ualice' });
  ok('link-line with an already-linked LINE id → 409 LINE_ALREADY_LINKED', dup.status === 409 && dup.json.error?.code === 'LINE_ALREADY_LINKED', JSON.stringify({ s: dup.status, code: dup.json.error?.code }));

  // ── 5. lookup by LINE userId ──
  const lk = await inj('GET', '/api/loyalty/members/lookup?line_user_id=Ualice', token);
  ok('lookup by line_user_id → resolves the member', lk.status === 200 && lk.json.id === aliceId, JSON.stringify({ id: lk.json.id }));

  // ── 6. LINE push addresses the member's LINE userId (not their phone) ──
  linePushes.length = 0;
  const send = await inj('POST', '/api/messaging/send', token, { member_id: aliceId, channel: 'line', body: 'สวัสดีค่ะ คุณได้รับ 50 แต้ม' });
  const push = linePushes[linePushes.length - 1];
  ok('messaging LINE push → sent to the LINE userId with Bearer token (not phone)',
    send.json.status === 'sent' && send.json.recipient === 'Ualice' && push?.to === 'Ualice' && push?.auth === 'Bearer test-line-push-token',
    JSON.stringify({ status: send.json.status, to: push?.to }));

  // ── 7. a member with no LINE identity can't receive a LINE push ──
  const carol = await inj('POST', '/api/loyalty/members', token, { name: 'Carol', phone: '0810000003' });
  const sendNo = await inj('POST', '/api/messaging/send', token, { member_id: carol.json.id, channel: 'line', body: 'hi' });
  ok('LINE push to a member without a linked LINE account → failed (no recipient)', sendNo.json.status === 'failed', JSON.stringify({ status: sendNo.json.status, err: sendNo.json.error }));

  // ── 8. opted-out member is skipped (consent respected) ──
  await inj('PATCH', `/api/loyalty/members/${aliceId}`, token, { marketing_opt_in: false });
  const before = linePushes.length;
  const skipped = await inj('POST', '/api/messaging/send', token, { member_id: aliceId, channel: 'line', body: 'promo' });
  ok('opted-out member → skipped, no LINE push sent', skipped.json.status === 'skipped' && linePushes.length === before, JSON.stringify({ status: skipped.json.status }));

  console.log('\n── C5 — LINE OA member CRM (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} LINE-CRM checks failed` : `\n✅ All ${checks.length} LINE-CRM checks passed`);
  globalThis.fetch = realFetch;
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
