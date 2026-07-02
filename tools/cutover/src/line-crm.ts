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
const lineReplies: { replyToken: string; auth: string; text: string }[] = [];
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
  if (url.includes('api.line.me/v2/bot/message/reply')) {
    const body = JSON.parse(init?.body ?? '{}');
    const m = body.messages?.[0] ?? {};
    lineReplies.push({ replyToken: body.replyToken, auth: String(init?.headers?.Authorization ?? ''), text: m.text ?? '' });
    return { ok: true, status: 200, headers: { get: () => `req-r-${lineReplies.length}` }, text: async () => '' } as any;
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

  // ── W3 (docs/27): messaging governance — quiet hours + global weekly marketing cap (marketing only) ──
  const [gmRow] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-GOV1', name: 'กติกา', phone: '0866660001', email: 'gov@example.com', lineUserId: 'U-gov-1', balance: '0', lifetime: '0', active: true }).returning();
  const gmId = Number(gmRow.id);
  const bkkNow = new Date(Date.now() + 7 * 3600_000);
  const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  // Quiet window spanning "now" (one hour either side) → a MARKETING send defers; a RECEIPT still goes out.
  await inj('PUT', '/api/messaging/governance', token, { quiet_start: hhmm(new Date(bkkNow.getTime() - 3600_000)), quiet_end: hhmm(new Date(bkkNow.getTime() + 3600_000)), weekly_cap: 4 });
  const quietMkt = await inj('POST', '/api/messaging/send', token, { member_id: gmId, channel: 'email', body: 'โปรพิเศษ!', campaign: 'blast:all' });
  const quietTxn = await inj('POST', '/api/messaging/send', token, { member_id: gmId, channel: 'email', body: 'ใบเสร็จของคุณ', campaign: 'receipt' });
  ok('W3 governance: quiet hours defer a MARKETING send (skipped + retry_at hint) but a transactional receipt still goes out',
    quietMkt.json.status === 'skipped' && quietMkt.json.error === 'quiet hours' && !!quietMkt.json.retry_at && quietTxn.json.status === 'sent',
    `mkt=${quietMkt.json.status}/${quietMkt.json.error}/retry=${!!quietMkt.json.retry_at} txn=${quietTxn.json.status}`);
  // Quiet window off (equal bounds) + cap 1 → first marketing send goes, second audits 'global cap' —
  // counted ACROSS channels/engines (the cap reads all sent marketing rows in message_log).
  await inj('PUT', '/api/messaging/governance', token, { quiet_start: '00:00', quiet_end: '00:00', weekly_cap: 1 });
  const cap1 = await inj('POST', '/api/messaging/send', token, { member_id: gmId, channel: 'email', body: 'โปร 1', campaign: 'blast:all' });
  const cap2 = await inj('POST', '/api/messaging/send', token, { member_id: gmId, channel: 'line', body: 'โปร 2', campaign: 'automation' });
  const capLog = (await pg.query(`SELECT status, error FROM message_log WHERE member_id=${gmId} AND error='global cap'`)).rows as any[];
  ok('W3 governance: global weekly cap 1 — first marketing send delivers, the second (other channel) audits skipped:global cap; transactional stays exempt',
    cap1.json.status === 'sent' && cap2.json.status === 'skipped' && cap2.json.error === 'global cap' && capLog.length === 1,
    `1st=${cap1.json.status} 2nd=${cap2.json.status}/${cap2.json.error} audited=${capLog.length}`);
  const govGet = await inj('GET', '/api/messaging/governance', token);
  ok('W3 governance: config round-trips on GET /api/messaging/governance', govGet.json.governance?.weekly_cap === 1 && govGet.json.governance?.quiet_start === '00:00', JSON.stringify(govGet.json.governance));
  await inj('PUT', '/api/messaging/governance', token, { quiet_start: '21:00', quiet_end: '09:00', weekly_cap: 4 }); // restore defaults

  // ── 16. LINE chat → PR (0227) — staff link their LINE identity, then raise a Purchase Requisition
  //        from the OA chat. Commands only; free customer chat is ignored. Tenant LINE token (set in
  //        check 10) is used for the reply. ──
  await db.insert(s.users).values([
    { username: 'somchai', passwordHash: await pw.hash('pw'), role: 'Cashier', tenantId: t1 },       // pr_raise via role seed
    { username: 'auditor', passwordHash: await pw.hash('pw'), role: 'AccessAdmin', tenantId: t1 },   // NO pr_raise
    { username: 'shopper', passwordHash: await pw.hash('pw'), role: 'Customer', tenantId: t1 },      // customer portal — excluded
  ]).onConflictDoNothing();
  const somchaiTok = (await inj('POST', '/api/login', undefined, { username: 'somchai', password: 'pw' })).json.token as string;
  const shopperTok = (await inj('POST', '/api/login', undefined, { username: 'shopper', password: 'pw' })).json.token as string;

  // 16a. link-code is a pr_raise surface — customer-portal roles are rejected.
  const codeDenied = await inj('POST', '/api/line/link-code', shopperTok);
  ok('chat-PR: link-code denied for a customer-portal role (403)', codeDenied.status === 403, JSON.stringify({ s: codeDenied.status }));

  // 16b. staff issues a one-time link code (10-min TTL) and starts unlinked.
  const codeRes = await inj('POST', '/api/line/link-code', somchaiTok);
  const linkCode = codeRes.json.code as string;
  const linked0 = await inj('GET', '/api/line/link', somchaiTok);
  ok('chat-PR: staff gets a link code (6 chars, expiry) and is not yet linked',
    (codeRes.status === 200 || codeRes.status === 201) && /^[A-Z2-9]{6}$/.test(linkCode ?? '') && !!codeRes.json.expires_at && linked0.json.linked === false,
    JSON.stringify({ code: linkCode, linked: linked0.json.linked }));

  // 16c. a wrong code is rejected in-chat (reply, no link).
  const badLink = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-0', source: { userId: 'Usomchai' }, message: { id: 'mid-0', type: 'text', text: 'link WRONG9' } }] });
  ok('chat-PR: wrong link code → rejected reply, no identity bound',
    badLink.json.chat === 1 && lineReplies.at(-1)!.text.includes('ไม่ถูกต้อง') && (await inj('GET', '/api/line/link', somchaiTok)).json.linked === false,
    JSON.stringify({ chat: badLink.json.chat, reply: lineReplies.at(-1)?.text.slice(0, 40) }));

  // 16d. `link <code>` binds the LINE account to the staff user; the reply rides the TENANT LINE token.
  const doLink = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-1', source: { userId: 'Usomchai' }, message: { id: 'mid-1', type: 'text', text: `link ${linkCode}` } }] });
  const linked1 = await inj('GET', '/api/line/link', somchaiTok);
  ok('chat-PR: link <code> → LINE account bound to staff user; confirmation replied via tenant token',
    doLink.json.chat === 1 && linked1.json.linked === true && lineReplies.at(-1)!.text.includes('เชื่อมบัญชีสำเร็จ') && lineReplies.at(-1)!.auth.includes('tenant-line-tok-999'),
    JSON.stringify({ linked: linked1.json.linked, auth: lineReplies.at(-1)?.auth.includes('tenant-line-tok-999') }));

  // 16e. `pr <item> <qty> [reason], …` → a real PR: Pending, requested_by the linked staff, 2 lines.
  const chatPr = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-2', source: { userId: 'Usomchai' }, message: { id: 'mid-2', type: 'text', text: 'pr A4-PAPER 10 กระดาษหมด, TONER-85A 2' } }] });
  const prNoM = /PR-\d{8}-\d{3}/.exec(lineReplies.at(-1)?.text ?? '');
  const prNo = prNoM?.[0] ?? '';
  const [prRow] = prNo ? await db.select().from(s.purchaseRequests).where(eq(s.purchaseRequests.prNo, prNo)) : [];
  const prLines = prRow ? await db.select().from(s.prItems).where(eq(s.prItems.prId, Number(prRow.id))) : [];
  ok('chat-PR: pr command → PR created (Pending, requested_by staff, 2 lines) and the PR no. replied',
    chatPr.json.chat === 1 && !!prRow && prRow.status === 'Pending' && prRow.requestedBy === 'somchai' && prLines.length === 2
      && prLines.some((l: any) => l.itemId === 'A4-PAPER' && Number(l.requestQty) === 10 && l.reason === 'กระดาษหมด'),
    JSON.stringify({ prNo, status: prRow?.status, by: prRow?.requestedBy, lines: prLines.length }));

  // 16f. webhook redelivery of the SAME message id is dropped (no duplicate PR).
  const prCountBefore = (await db.select().from(s.purchaseRequests)).length;
  const redeliver = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-2b', source: { userId: 'Usomchai' }, message: { id: 'mid-2', type: 'text', text: 'pr A4-PAPER 10 กระดาษหมด, TONER-85A 2' } }] });
  const prCountAfter = (await db.select().from(s.purchaseRequests)).length;
  ok('chat-PR: redelivered message id → deduped, no second PR raised',
    redeliver.json.chat === 1 && prCountAfter === prCountBefore, JSON.stringify({ before: prCountBefore, after: prCountAfter }));

  // 16g. `status <PR no>` reports the approval state in Thai.
  const st = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-3', source: { userId: 'Usomchai' }, message: { id: 'mid-3', type: 'text', text: `status ${prNo}` } }] });
  ok('chat-PR: status <PR no> → replies the current state (รออนุมัติ)',
    st.json.chat === 1 && lineReplies.at(-1)!.text.includes(prNo) && lineReplies.at(-1)!.text.includes('รออนุมัติ'),
    JSON.stringify({ reply: lineReplies.at(-1)?.text }));

  // 16h. an UNLINKED LINE user issuing a pr command gets the how-to-link guidance and raises nothing.
  const prCount2 = (await db.select().from(s.purchaseRequests)).length;
  const stranger = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-4', source: { userId: 'Ustranger' }, message: { id: 'mid-4', type: 'text', text: 'pr GOLD-BAR 999' } }] });
  ok('chat-PR: unlinked LINE user → guidance reply, no PR raised',
    stranger.json.chat === 1 && lineReplies.at(-1)!.text.includes('ยังไม่ได้เชื่อมบัญชี') && (await db.select().from(s.purchaseRequests)).length === prCount2,
    JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 40) }));

  // 16i. free-form chat (a customer talking to the OA) is NOT a command → ignored: no reply, no log.
  const repliesBefore = lineReplies.length;
  const freeChat = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-5', source: { userId: 'Ualice' }, message: { id: 'mid-5', type: 'text', text: 'สวัสดีค่ะ ขอดูเมนูหน่อย' } }] });
  ok('chat-PR: free customer chat → ignored silently (no reply, chat=0)',
    freeChat.json.chat === 0 && lineReplies.length === repliesBefore, JSON.stringify({ chat: freeChat.json.chat }));

  // 16j. a linked user WITHOUT pr_raise (AccessAdmin) cannot raise — permission enforced in the chat path.
  await db.update(s.users).set({ lineUserId: 'Uauditor' }).where(eq(s.users.username, 'auditor'));
  const prCount3 = (await db.select().from(s.purchaseRequests)).length;
  const noPerm = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-6', source: { userId: 'Uauditor' }, message: { id: 'mid-6', type: 'text', text: 'pr A4-PAPER 1' } }] });
  ok('chat-PR: linked user without pr_raise → refused (no PR)',
    noPerm.json.chat === 1 && lineReplies.at(-1)!.text.includes('ไม่มีสิทธิ์') && (await db.select().from(s.purchaseRequests)).length === prCount3,
    JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 50) }));

  // 16k. a LINE account already bound to another user cannot be re-bound via a second user's code.
  await db.insert(s.users).values([{ username: 'somsri', passwordHash: await pw.hash('pw'), role: 'Cashier', tenantId: t1 }]).onConflictDoNothing();
  const somsriTok = (await inj('POST', '/api/login', undefined, { username: 'somsri', password: 'pw' })).json.token as string;
  const code2 = (await inj('POST', '/api/line/link-code', somsriTok)).json.code as string;
  const dupLink = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-7', source: { userId: 'Usomchai' }, message: { id: 'mid-7', type: 'text', text: `link ${code2}` } }] });
  ok('chat-PR: LINE account already linked to another user → rejected (unique binding kept)',
    dupLink.json.chat === 1 && lineReplies.at(-1)!.text.includes('ถูกเชื่อมกับผู้ใช้อื่น') && (await inj('GET', '/api/line/link', somsriTok)).json.linked === false,
    JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 50) }));

  // 16l. unlink from the web → chat commands stop resolving the identity.
  const unlinkRes = await inj('DELETE', '/api/line/link', somchaiTok);
  const afterUnlink = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-8', source: { userId: 'Usomchai' }, message: { id: 'mid-8', type: 'text', text: 'pr A4-PAPER 1' } }] });
  ok('chat-PR: unlink → subsequent chat pr is treated as unlinked (guidance reply)',
    unlinkRes.json.linked === false && afterUnlink.json.chat === 1 && lineReplies.at(-1)!.text.includes('ยังไม่ได้เชื่อมบัญชี'),
    JSON.stringify({ linked: unlinkRes.json.linked }));

  // ── 17. Chat-PR phase 2 (0228): workflow LINE notifications, approve/reject via chat (engine SoD),
  //        my prs / find / cancel / stock. A real PR workflow definition is activated so the engine path
  //        (not the legacy Admin flip) is exercised end-to-end over LINE. ──
  await db.update(s.users).set({ lineUserId: 'Usomchai' }).where(eq(s.users.username, 'somchai')); // re-link after 16l
  await db.insert(s.users).values([{ username: 'prayut', passwordHash: await pw.hash('pw'), role: 'Procurement', tenantId: t1 }]).onConflictDoNothing();
  await db.update(s.users).set({ lineUserId: 'Uprayut' }).where(eq(s.users.username, 'prayut'));
  const wfDef = await inj('POST', '/api/workflow/definitions', token, { doc_type: 'PR', name: 'PR approval', steps: [{ step_no: 1, approver_role: 'Procurement' }] });
  ok('chat-PR2: PR workflow definition activated (step 1 → Procurement)', wfDef.status === 200 || wfDef.status === 201, JSON.stringify({ s: wfDef.status }));

  // 17a. chat-raised PR → the linked Procurement approver gets a LINE queue-entry PUSH naming the PR.
  const pushesBefore17 = linePushes.length;
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-17a', source: { userId: 'Usomchai' }, message: { id: 'mid-17a', type: 'text', text: 'pr A4-PAPER 3 หมึกใกล้หมด' } }] });
  const pr17 = /PR-\d{8}-\d{3}/.exec(lineReplies.at(-1)?.text ?? '')?.[0] ?? '';
  const queuePush = linePushes.slice(pushesBefore17).find((p) => p.to === 'Uprayut');
  ok('chat-PR2: queue-entry notification — linked approver (role Procurement) pushed the PR no + chat hint',
    !!pr17 && !!queuePush && queuePush.text.includes(pr17) && queuePush.text.includes('approve'),
    JSON.stringify({ pr: pr17, pushed: !!queuePush }));

  // 17b. approver chats `approve <PR no>` → engine approves (maker≠checker), PR flips Approved, and the
  //      REQUESTER gets a LINE decision push.
  const pushesBefore17b = linePushes.length;
  const apr = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-17b', source: { userId: 'Uprayut' }, message: { id: 'mid-17b', type: 'text', text: `approve ${pr17}` } }] });
  const [pr17Row] = await db.select().from(s.purchaseRequests).where(eq(s.purchaseRequests.prNo, pr17));
  const decidePush = linePushes.slice(pushesBefore17b).find((p) => p.to === 'Usomchai');
  ok('chat-PR2: approve via chat → engine approves, PR Approved, requester pushed the ✅ decision',
    apr.json.chat === 1 && lineReplies.at(-1)!.text.includes('อนุมัติแล้ว') && pr17Row?.status === 'Approved' && pr17Row?.approvedBy === 'prayut'
      && !!decidePush && decidePush.text.includes(pr17) && decidePush.text.includes('อนุมัติแล้ว'),
    JSON.stringify({ status: pr17Row?.status, by: pr17Row?.approvedBy, notified: !!decidePush }));

  // 17c. maker-checker binds in chat: the approver cannot approve a PR they raised themselves.
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-17c1', source: { userId: 'Uprayut' }, message: { id: 'mid-17c1', type: 'text', text: 'pr TONER-85A 1 ของตัวเอง' } }] });
  const prOwn = /PR-\d{8}-\d{3}/.exec(lineReplies.at(-1)?.text ?? '')?.[0] ?? '';
  const sodTry = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-17c2', source: { userId: 'Uprayut' }, message: { id: 'mid-17c2', type: 'text', text: `approve ${prOwn}` } }] });
  const [prOwnRow] = await db.select().from(s.purchaseRequests).where(eq(s.purchaseRequests.prNo, prOwn));
  ok('chat-PR2: SoD in chat — approver cannot approve their own PR (SOD_VIOLATION, stays Pending)',
    sodTry.json.chat === 1 && lineReplies.at(-1)!.text.includes('SOD_VIOLATION') && prOwnRow?.status === 'Pending',
    JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 60), status: prOwnRow?.status }));

  // 17d. permission binds in chat: a linked user WITHOUT `procurement` cannot approve.
  const noAuth = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-17d', source: { userId: 'Usomchai' }, message: { id: 'mid-17d', type: 'text', text: `approve ${prOwn}` } }] });
  ok('chat-PR2: approve without procurement permission → refused',
    noAuth.json.chat === 1 && lineReplies.at(-1)!.text.includes('ไม่มีสิทธิ์'), JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 50) }));

  // 17e. reject via chat → PR Rejected + requester pushed the ❌ decision.
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-17e1', source: { userId: 'Usomchai' }, message: { id: 'mid-17e1', type: 'text', text: 'pr GLUE-STICK 12' } }] });
  const prRej = /PR-\d{8}-\d{3}/.exec(lineReplies.at(-1)?.text ?? '')?.[0] ?? '';
  const pushesBefore17e = linePushes.length;
  const rej = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-17e2', source: { userId: 'Uprayut' }, message: { id: 'mid-17e2', type: 'text', text: `reject ${prRej} ซื้อรวมล็อตหน้า` } }] });
  const [prRejRow] = await db.select().from(s.purchaseRequests).where(eq(s.purchaseRequests.prNo, prRej));
  const rejPush = linePushes.slice(pushesBefore17e).find((p) => p.to === 'Usomchai');
  ok('chat-PR2: reject via chat → PR Rejected, requester pushed the ❌ decision',
    rej.json.chat === 1 && prRejRow?.status === 'Rejected' && !!rejPush && rejPush.text.includes(prRej) && rejPush.text.includes('ไม่ได้รับอนุมัติ'),
    JSON.stringify({ status: prRejRow?.status, notified: !!rejPush }));

  // 17f. my prs — the requester's recent PRs with Thai statuses.
  const mine = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-17f', source: { userId: 'Usomchai' }, message: { id: 'mid-17f', type: 'text', text: 'my prs' } }] });
  const mineText = lineReplies.at(-1)?.text ?? '';
  ok('chat-PR2: my prs → lists own recent PRs with statuses',
    mine.json.chat === 1 && mineText.includes(pr17) && mineText.includes('อนุมัติแล้ว') && mineText.includes(prRej) && !mineText.includes(prOwn),
    JSON.stringify({ head: mineText.slice(0, 60) }));

  // 17g. find — item-master search surfaces real item ids.
  await db.insert(s.items).values({ itemId: 'A4-PAPER', itemDescription: 'กระดาษ A4 80 แกรม', uom: 'REAM' }).onConflictDoNothing();
  const found = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-17g', source: { userId: 'Usomchai' }, message: { id: 'mid-17g', type: 'text', text: 'find กระดาษ' } }] });
  ok('chat-PR2: find <keyword> → returns matching item ids', found.json.chat === 1 && lineReplies.at(-1)!.text.includes('A4-PAPER'), JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 60) }));

  // 17h. cancel — own pending PR withdrawn (workflow instance closed); someone else's PR is refused.
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-17h1', source: { userId: 'Usomchai' }, message: { id: 'mid-17h1', type: 'text', text: 'pr STAPLER 2' } }] });
  const prCxl = /PR-\d{8}-\d{3}/.exec(lineReplies.at(-1)?.text ?? '')?.[0] ?? '';
  const cxl = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-17h2', source: { userId: 'Usomchai' }, message: { id: 'mid-17h2', type: 'text', text: `cancel ${prCxl}` } }] });
  const [prCxlRow] = await db.select().from(s.purchaseRequests).where(eq(s.purchaseRequests.prNo, prCxl));
  const [wfCxl] = await db.select().from(s.workflowInstances).where(and(eq(s.workflowInstances.docType, 'PR'), eq(s.workflowInstances.docNo, prCxl)));
  const cxlOther = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-17h3', source: { userId: 'Usomchai' }, message: { id: 'mid-17h3', type: 'text', text: `cancel ${prOwn}` } }] });
  ok('chat-PR2: cancel own pending PR → Cancelled + workflow instance closed; another user\'s PR refused',
    cxl.json.chat === 1 && prCxlRow?.status === 'Cancelled' && wfCxl?.status === 'cancelled'
      && cxlOther.json.chat === 1 && lineReplies.at(-1)!.text.includes('ยกเลิกไม่ได้'),
    JSON.stringify({ pr: prCxlRow?.status, wf: wfCxl?.status }));

  // 17i. stock — read-only on-hand lookup (tenant-scoped).
  await db.insert(s.invBalances).values({ tenantId: t1, itemId: 'A4-PAPER', itemDescription: 'กระดาษ A4 80 แกรม', locationId: 'WH-MAIN', onHandQty: '42', avgCost: '95', totalValue: '3990' }).onConflictDoNothing();
  const stk = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-17i', source: { userId: 'Usomchai' }, message: { id: 'mid-17i', type: 'text', text: 'stock a4-paper' } }] });
  const stkText = lineReplies.at(-1)?.text ?? '';
  ok('chat-PR2: stock <item> → on-hand total + per-location breakdown (case-insensitive item id)',
    stk.json.chat === 1 && stkText.includes('A4-PAPER') && stkText.includes('42') && stkText.includes('WH-MAIN'),
    JSON.stringify({ reply: stkText.slice(0, 60) }));

  console.log('\n── C5 — LINE OA member CRM (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} LINE-CRM checks failed` : `\n✅ All ${checks.length} LINE-CRM checks passed`);
  globalThis.fetch = realFetch;
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
