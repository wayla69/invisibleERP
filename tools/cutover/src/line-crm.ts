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
import { eq, and } from 'drizzle-orm';
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

const linePushes: { to: string; auth: string; text: string; type?: string; altText?: string; ref?: string }[] = [];
const lineBroadcasts: { auth: string; text: string; type?: string; altText?: string }[] = [];
let pushSeq = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  if (url.includes('api.line.me/v2/bot/message/push')) {
    const body = JSON.parse(init?.body ?? '{}');
    const m = body.messages?.[0] ?? {};
    const reqId = `req-${++pushSeq}`; // unique x-line-request-id per push → the provider_ref we store
    linePushes.push({ to: body.to, auth: String(init?.headers?.Authorization ?? ''), text: m.text ?? '', type: m.type, altText: m.altText, ref: reqId });
    return { ok: true, status: 200, headers: { get: () => reqId }, text: async () => '' } as any;
  }
  if (url.includes('api.line.me/v2/bot/message/broadcast')) {
    const body = JSON.parse(init?.body ?? '{}');
    const m = body.messages?.[0] ?? {};
    lineBroadcasts.push({ auth: String(init?.headers?.Authorization ?? ''), text: m.text ?? '', type: m.type, altText: m.altText });
    return { ok: true, status: 200, headers: { get: () => 'req-b' }, text: async () => '' } as any;
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

  // ── 9. LINE OA broadcast — one message to all followers (no per-member list; audit-logged) ──
  const bcBefore = lineBroadcasts.length;
  const bc = await inj('POST', '/api/messaging/broadcast-oa', token, { body: 'ร้านเปิดสาขาใหม่! 🎉', campaign: 'grand_open' });
  ok('LINE OA broadcast → sent, hit the broadcast endpoint with Bearer token (no recipient list)',
    bc.json.status === 'sent' && lineBroadcasts.length === bcBefore + 1 && lineBroadcasts.at(-1)!.auth.includes('test-line-push-token') && lineBroadcasts.at(-1)!.text.includes('สาขาใหม่'),
    JSON.stringify({ status: bc.json.status, provider: bc.json.provider }));
  // audit: the broadcast is logged in message_log with the synthetic recipient
  const logRows = await inj('GET', '/api/messaging/log?limit=10', token);
  ok('LINE OA broadcast is audit-logged (recipient oa:broadcast, campaign grand_open)',
    (logRows.json.messages ?? []).some((m: any) => m.recipient === 'oa:broadcast' && m.campaign === 'grand_open' && m.status === 'sent'),
    JSON.stringify({ n: (logRows.json.messages ?? []).length }));

  // ── 10. Per-tenant messaging provider: the tenant's own LINE token overrides the platform env token ──
  const setProv = await inj('PUT', '/api/messaging/providers/line', token, { creds: { token: 'tenant-line-tok-999' }, enabled: true });
  ok('set per-tenant LINE provider → configured', setProv.status === 200 && setProv.json.configured === true, JSON.stringify({ s: setProv.status }));
  const provs = await inj('GET', '/api/messaging/providers', token);
  const lineProv = (provs.json.channels ?? []).find((c: any) => c.channel === 'line');
  ok('GET providers → line configured+enabled, secret never returned',
    lineProv?.configured === true && lineProv?.enabled === true && !JSON.stringify(provs.json).includes('tenant-line-tok-999'),
    JSON.stringify({ configured: lineProv?.configured, leaked: JSON.stringify(provs.json).includes('tenant-line-tok-999') }));
  // Bob is LINE-linked and not opted out — his push must now carry the TENANT token, not the env token.
  const pushBefore = linePushes.length;
  const sendBob = await inj('POST', '/api/messaging/send', token, { member_id: bob.json.id, channel: 'line', body: 'ทดสอบ per-tenant' });
  const lastPush = linePushes.at(-1);
  ok('per-tenant LINE token overrides env: Bob push used the tenant token (not test-line-push-token)',
    sendBob.json.status === 'sent' && linePushes.length === pushBefore + 1 && lastPush!.auth.includes('tenant-line-tok-999') && !lastPush!.auth.includes('test-line-push-token'),
    JSON.stringify({ status: sendBob.json.status, usedTenant: lastPush?.auth.includes('tenant-line-tok-999') }));

  // ── 11. Provider "send test" — delivers a canned message via the resolved (tenant) provider ──
  const testBefore = linePushes.length;
  const testRes = await inj('POST', '/api/messaging/providers/line/test', token, { to: 'Utest-recipient' });
  ok('provider test-send → sent via the tenant provider (captured push to the given recipient)',
    testRes.json.status === 'sent' && linePushes.length === testBefore + 1 && linePushes.at(-1)!.to === 'Utest-recipient' && linePushes.at(-1)!.auth.includes('tenant-line-tok-999'),
    JSON.stringify({ status: testRes.json.status, to: linePushes.at(-1)?.to }));

  // ── 12. LINE flex (rich) messages — broadcast + targeted push ──
  const flexContents = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'โปรใหม่!' }] } };
  const bcFlexBefore = lineBroadcasts.length;
  const bcFlex = await inj('POST', '/api/messaging/broadcast-oa', token, { flex: flexContents, alt_text: 'โปรโมชั่นใหม่', campaign: 'flex_promo' });
  ok('LINE OA broadcast (flex) → sent as a flex message with altText',
    bcFlex.json.status === 'sent' && lineBroadcasts.length === bcFlexBefore + 1 && lineBroadcasts.at(-1)!.type === 'flex' && lineBroadcasts.at(-1)!.altText === 'โปรโมชั่นใหม่',
    JSON.stringify({ status: bcFlex.json.status, type: lineBroadcasts.at(-1)?.type }));
  const pushFlexBefore = linePushes.length;
  const pushFlex = await inj('POST', '/api/messaging/line/flex', token, { member_id: bob.json.id, alt_text: 'การ์ดสมาชิก', flex: flexContents });
  ok('LINE flex push to a member → sent as flex to their LINE userId',
    pushFlex.json.status === 'sent' && linePushes.length === pushFlexBefore + 1 && linePushes.at(-1)!.type === 'flex' && linePushes.at(-1)!.to === 'Ubob',
    JSON.stringify({ status: pushFlex.json.status, type: linePushes.at(-1)?.type, to: linePushes.at(-1)?.to }));

  // ── 13. LINE follow/unfollow webhook — auto-enrol on follow, log on unfollow, reject unknown tenant ──
  const follow = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'follow', source: { userId: 'Ufollower1' } }] });
  const [enrolled] = await db.select().from(s.posMembers).where(and(eq(s.posMembers.tenantId, t1), eq(s.posMembers.lineUserId, 'Ufollower1')));
  ok('LINE webhook follow → auto-enrols a member keyed by LINE userId (active, member code)',
    follow.json.received === true && follow.json.followed === 1 && !!enrolled && enrolled.active === true && String(enrolled.memberCode).startsWith('M-'),
    JSON.stringify({ followed: follow.json.followed, code: enrolled?.memberCode }));
  const unfollow = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'unfollow', source: { userId: 'Ufollower1' } }] });
  const unfollowLog = await db.select().from(s.messageLog).where(and(eq(s.messageLog.tenantId, t1), eq(s.messageLog.campaign, 'oa_unfollow')));
  ok('LINE webhook unfollow → logged (member kept, not deactivated)',
    unfollow.json.unfollowed === 1 && unfollowLog.length >= 1 && enrolled.active === true,
    JSON.stringify({ unfollowed: unfollow.json.unfollowed, logged: unfollowLog.length }));
  const badTenant = await inj('POST', '/api/line/webhook/NOPE', undefined, { events: [] });
  ok('LINE webhook → unknown shop code rejected (401)', badTenant.status === 401, JSON.stringify({ s: badTenant.status, code: badTenant.json?.error?.code ?? badTenant.json?.code }));

  // ── 14. Delivery-status callback (E2) — a provider POSTs the final state of a message it accepted; we
  //        correlate by provider_ref and flip the message_log row's status. Token-guarded, tenant-scoped. ──
  // Configure the tenant's LINE provider with a callbackToken (creds are replaced wholesale, so re-supply token).
  await inj('PUT', '/api/messaging/providers/line', token, { creds: { token: 'tenant-line-tok-999', callbackToken: 'cb-secret-line' }, enabled: true });
  // Send a fresh LINE push → captures a unique provider_ref (x-line-request-id) on the message_log row.
  const dcSend = await inj('POST', '/api/messaging/send', token, { member_id: bob.json.id, channel: 'line', body: 'ยืนยันการจัดส่ง' });
  const dcRef = dcSend.json.provider_ref as string;
  ok('send returns a provider_ref to correlate a delivery callback', dcSend.json.status === 'sent' && typeof dcRef === 'string' && dcRef.length > 0, JSON.stringify({ ref: dcRef }));

  // 14a. Unknown shop code → 401 (no leak of whether the ref exists).
  const dcBadTenant = await inj('POST', '/api/messaging/delivery-callback/NOPE', undefined, { channel: 'line', ref: dcRef, status: 'delivered' });
  ok('delivery-callback → unknown shop code rejected (401 UNKNOWN_TENANT)', dcBadTenant.status === 401 && dcBadTenant.json.error?.code === 'UNKNOWN_TENANT', JSON.stringify({ s: dcBadTenant.status, code: dcBadTenant.json.error?.code }));

  // 14b. Missing/wrong callback token → 401 (the row is NOT updated).
  const dcBadTok = await app.inject({ method: 'POST', url: '/api/messaging/delivery-callback/T1', headers: { 'x-callback-token': 'wrong' }, payload: { channel: 'line', ref: dcRef, status: 'delivered' } });
  let dcBadTokJson: any = {}; try { dcBadTokJson = dcBadTok.json(); } catch { /* */ }
  const rowAfterBad = (await db.select().from(s.messageLog).where(and(eq(s.messageLog.tenantId, t1), eq(s.messageLog.providerRef, dcRef))))[0];
  ok('delivery-callback → wrong callback token rejected (401), row status unchanged',
    dcBadTok.statusCode === 401 && dcBadTokJson.error?.code === 'BAD_CALLBACK_TOKEN' && rowAfterBad?.status === 'sent',
    JSON.stringify({ s: dcBadTok.statusCode, code: dcBadTokJson.error?.code, status: rowAfterBad?.status }));

  // 14c. Valid token → the message_log row flips sent → delivered (correlated by provider_ref).
  const dcOk = await app.inject({ method: 'POST', url: '/api/messaging/delivery-callback/T1', headers: { 'x-callback-token': 'cb-secret-line' }, payload: { channel: 'line', ref: dcRef, status: 'delivered' } });
  let dcOkJson: any = {}; try { dcOkJson = dcOk.json(); } catch { /* */ }
  const rowDelivered = (await db.select().from(s.messageLog).where(and(eq(s.messageLog.tenantId, t1), eq(s.messageLog.providerRef, dcRef))))[0];
  ok('delivery-callback (valid token) → message_log row updated sent → delivered',
    (dcOk.statusCode === 200 || dcOk.statusCode === 201) && dcOkJson.updated === 1 && dcOkJson.status === 'delivered' && rowDelivered?.status === 'delivered',
    JSON.stringify({ updated: dcOkJson.updated, status: rowDelivered?.status }));

  // 14d. An unrecognised provider status normalises to 'undelivered' (never crashes the row).
  const dcSend2 = await inj('POST', '/api/messaging/send', token, { member_id: bob.json.id, channel: 'line', body: 'สอง' });
  const dcRef2 = dcSend2.json.provider_ref as string;
  const dcUndel = await app.inject({ method: 'POST', url: '/api/messaging/delivery-callback/T1', headers: { 'x-callback-token': 'cb-secret-line' }, payload: { channel: 'line', ref: dcRef2, status: 'bounced', error: 'mailbox full' } });
  const rowUndel = (await db.select().from(s.messageLog).where(and(eq(s.messageLog.tenantId, t1), eq(s.messageLog.providerRef, dcRef2))))[0];
  ok('delivery-callback → unknown status normalises to undelivered (with provider error captured)',
    rowUndel?.status === 'undelivered' && rowUndel?.error === 'mailbox full',
    JSON.stringify({ status: rowUndel?.status, error: rowUndel?.error }));

  // ── 15. Go-live readiness panel (F3) — resolved provider per channel + last delivery, secrets never leak ──
  // line: tenant creds set (checks 10/14) → 'tenant' + callback token flag; sms/email: no tenant creds and no
  // env (only LINE_CHANNEL_TOKEN is set in this harness) → 'mock'; the LINE last-send info reflects check 14.
  const health1 = await inj('GET', '/api/messaging/providers', token);
  const hLine = (health1.json.channels ?? []).find((c: any) => c.channel === 'line');
  const hSms = (health1.json.channels ?? []).find((c: any) => c.channel === 'sms');
  const healthRaw = JSON.stringify(health1.json);
  ok('providers health: line resolved=tenant (+callback flag, last send recorded); sms resolved=mock; secrets never returned',
    hLine?.resolved_provider === 'tenant' && hLine?.callback_token_set === true && hLine?.last_status != null && hLine?.last_send_at != null
      && hSms?.resolved_provider === 'mock' && hSms?.last_send_at === null
      && !healthRaw.includes('tenant-line-tok-999') && !healthRaw.includes('cb-secret-line'),
    JSON.stringify({ line: hLine?.resolved_provider, cb: hLine?.callback_token_set, last: hLine?.last_status, sms: hSms?.resolved_provider, leaked: healthRaw.includes('tenant-line-tok-999') || healthRaw.includes('cb-secret-line') }));
  // Connecting the shop's own SMS provider flips the channel mock → tenant (the go-live transition).
  await inj('PUT', '/api/messaging/providers/sms', token, { creds: { apiKey: 'sms-key-1', apiUrl: 'https://sms.example/send' }, enabled: true });
  const health2 = await inj('GET', '/api/messaging/providers', token);
  const hSms2 = (health2.json.channels ?? []).find((c: any) => c.channel === 'sms');
  ok('providers health: connecting own SMS creds flips resolved mock → tenant (go-live visible)',
    hSms2?.resolved_provider === 'tenant' && hSms2?.configured === true && !JSON.stringify(health2.json).includes('sms-key-1'),
    JSON.stringify({ sms: hSms2?.resolved_provider, configured: hSms2?.configured }));

  console.log('\n── C5 — LINE OA member CRM (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} LINE-CRM checks failed` : `\n✅ All ${checks.length} LINE-CRM checks passed`);
  globalThis.fetch = realFetch;
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
