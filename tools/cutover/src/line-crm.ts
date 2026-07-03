/**
 * C5 — LINE OA member CRM: enrol/link a POS member from a verified LINE identity, look up by LINE userId,
 * and push LINE messages to the member's LINE userId (not their phone). Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover line-crm
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'line-secret';
process.env.NODE_ENV = 'test';
process.env.LINE_CHANNEL_TOKEN = 'test-line-push-token'; // makes the LINE push gateway "configured" → real(stubbed) fetch
process.env.LINE_CHAT_RATE_LIMIT = '1000'; // LC-3 governance — keep the per-user budget out of the way until section 21 tests it
process.env.APP_ENC_KEY = 'ierp-dev-enc-key'; // same derived key as the dev fallback — keeps decrypt working when 25g flips NODE_ENV=production (prod fail-closes without it)
// LINE_LOGIN_CHANNEL_ID intentionally unset → verifyLineIdToken uses the dev mock:<userId>[:<name>] path

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import * as s from '../../../apps/api/dist/database/schema/index';
import { reportSubscriptions } from '../../../apps/api/dist/database/schema/bi';
import { setLlmClientForTests } from '../../../apps/api/dist/common/llm-client';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

const linePushes: { to: string; auth: string; text: string; type?: string; altText?: string; contents?: any; ref?: string }[] = [];
const lineBroadcasts: { auth: string; text: string; type?: string; altText?: string }[] = [];
const lineReplies: { replyToken: string; auth: string; text: string; type?: string; contents?: any }[] = [];
const lineContentFetches: { url: string; auth: string }[] = [];
let pushSeq = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  if (url.includes('api.line.me/v2/bot/message/push')) {
    const body = JSON.parse(init?.body ?? '{}');
    const m = body.messages?.[0] ?? {};
    const reqId = `req-${++pushSeq}`; // unique x-line-request-id per push → the provider_ref we store
    linePushes.push({ to: body.to, auth: String(init?.headers?.Authorization ?? ''), text: m.text ?? m.altText ?? '', type: m.type, altText: m.altText, contents: m.contents, ref: reqId });
    return { ok: true, status: 200, headers: { get: () => reqId }, text: async () => '' } as any;
  }
  if (url.includes('api.line.me/v2/bot/message/reply')) {
    const body = JSON.parse(init?.body ?? '{}');
    const m = body.messages?.[0] ?? {};
    // flex replies carry the human copy in altText — surface it as `text` so assertions read one field
    lineReplies.push({ replyToken: body.replyToken, auth: String(init?.headers?.Authorization ?? ''), text: m.text ?? m.altText ?? '', type: m.type, contents: m.contents });
    return { ok: true, status: 200, headers: { get: () => `req-r-${lineReplies.length}` }, text: async () => '' } as any;
  }
  if (url.includes('api-data.line.me/v2/bot/message/')) {
    // LINE content API — return a tiny deterministic "photo" so the chat attach flow can be exercised
    lineContentFetches.push({ url, auth: String(init?.headers?.Authorization ?? '') });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    return { ok: true, status: 200, headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) }, arrayBuffer: async () => bytes.buffer, text: async () => '' } as any;
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
  // rawBody:true mirrors production main.ts — LP-1 requires T1's line creds to carry a Channel Secret,
  // so the webhook verifies the HMAC over the exact raw bytes on every delivery below.
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { rawBody: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const LINE_WH_SECRET = 'whsec-t1-line';
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    let body: any = payload;
    // Sign LINE webhook deliveries centrally (over the exact serialized bytes) so every call site
    // stays a plain object literal while T1's channel secret enforces fail-closed verification.
    if (m === 'POST' && url.startsWith('/api/line/webhook/') && payload && typeof payload === 'object') {
      body = JSON.stringify(payload);
      headers['content-type'] = 'application/json';
      headers['x-line-signature'] = createHmac('sha256', LINE_WH_SECRET).update(body).digest('base64');
    }
    const res = await app.inject({ method: m as any, url, headers, payload: body });
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
  // LP-1 (docs/31): token-only line creds are rejected — the Channel Secret is required, because the
  // webhook fail-closes without it in production (token-only would save fine and silently break go-live).
  const noSecret = await inj('PUT', '/api/messaging/providers/line', token, { creds: { token: 'tenant-line-tok-999' }, enabled: true });
  ok('set line provider without Channel secret → 400 MISSING_FIELD (LP-1 go-live guard)',
    noSecret.status === 400 && noSecret.json.error?.code === 'MISSING_FIELD', JSON.stringify({ s: noSecret.status, code: noSecret.json.error?.code }));
  const setProv = await inj('PUT', '/api/messaging/providers/line', token, { creds: { token: 'tenant-line-tok-999', secret: LINE_WH_SECRET }, enabled: true });
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
  await inj('PUT', '/api/messaging/providers/line', token, { creds: { token: 'tenant-line-tok-999', secret: LINE_WH_SECRET, callbackToken: 'cb-secret-line' }, enabled: true });
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
  ok('chat-PR: link <code> → LINE account bound to staff user; welcome flex card replied via tenant token',
    doLink.json.chat === 1 && linked1.json.linked === true && lineReplies.at(-1)!.type === 'flex'
      && lineReplies.at(-1)!.text.includes('เชื่อมบัญชีสำเร็จ') && lineReplies.at(-1)!.auth.includes('tenant-line-tok-999'),
    JSON.stringify({ linked: linked1.json.linked, type: lineReplies.at(-1)?.type, auth: lineReplies.at(-1)?.auth.includes('tenant-line-tok-999') }));

  // 16d-ii. `help` → the command menu as a flex bubble (altText keeps the plain command list).
  const helpRes = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-1help', source: { userId: 'Usomchai' }, message: { id: 'mid-1help', type: 'text', text: 'help' } }] });
  const helpReply = lineReplies.at(-1);
  const helpHeader = helpReply?.contents?.header?.contents?.[0]?.text ?? '';
  ok('chat-PR: help → flex command menu (grouped card; altText carries the plain list)',
    helpRes.json.chat === 1 && helpReply?.type === 'flex' && helpHeader.includes('เมนูคำสั่ง') && helpReply?.text.includes('รูปแบบคำสั่ง'),
    JSON.stringify({ type: helpReply?.type, header: helpHeader.slice(0, 20) }));

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

  // 16e-ii. multi-word / un-coded item name → qty is the LAST number, name is everything before it.
  const chatPrName = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-2m', source: { userId: 'Usomchai' }, message: { id: 'mid-2m', type: 'text', text: 'pr Iberico ham 2' } }] });
  const prNameNo = /PR-\d{8}-\d{3}/.exec(lineReplies.at(-1)?.text ?? '')?.[0] ?? '';
  const [prNameRow] = prNameNo ? await db.select().from(s.purchaseRequests).where(eq(s.purchaseRequests.prNo, prNameNo)) : [];
  const prNameLines = prNameRow ? await db.select().from(s.prItems).where(eq(s.prItems.prId, Number(prNameRow.id))) : [];
  ok('chat-PR: multi-word item name → id="Iberico ham", qty=2 (last number), no reason required',
    chatPrName.json.chat === 1 && prNameLines.length === 1 && prNameLines[0]!.itemId === 'Iberico ham'
      && Number(prNameLines[0]!.requestQty) === 2 && (prNameLines[0]!.reason == null),
    JSON.stringify({ id: prNameLines[0]?.itemId, qty: prNameLines[0]?.requestQty, reason: prNameLines[0]?.reason }));

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

  // ── 18. Attachments (0228): invoice/receipt photo onto a PO — web API + LINE chat `attach` flow. ──
  const poRes = await inj('POST', '/api/procurement/pos', token, { vendor_name: 'ผู้ขายทดสอบแนบ', items: [{ item_id: 'A4-PAPER', order_qty: 5, unit_price: 100 }] });
  const poNo = poRes.json.po_no as string;
  ok('attach: seed PO created', !!poNo, JSON.stringify({ po: poNo }));

  // 18a. attach at an unknown doc → immediate "not found" reply (no pending state parked).
  const badDoc = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-18a', source: { userId: 'Uprayut' }, message: { id: 'mid-18a', type: 'text', text: 'attach PO-19990101-999' } }] });
  ok('attach: unknown PO → ไม่พบเอกสาร reply', badDoc.json.chat === 1 && lineReplies.at(-1)!.text.includes('ไม่พบเอกสาร'), JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 40) }));

  // 18b. permission: a linked user without procurement/creditors/wh_receive cannot start an attach.
  await db.update(s.users).set({ lineUserId: 'Usomchai' }).where(eq(s.users.username, 'somchai'));
  const noPermAtt = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-18b', source: { userId: 'Usomchai' }, message: { id: 'mid-18b', type: 'text', text: `attach ${poNo}` } }] });
  ok('attach: linked user without paper-handling perms → refused', noPermAtt.json.chat === 1 && lineReplies.at(-1)!.text.includes('ไม่มีสิทธิ์'), JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 50) }));

  // 18c. happy path: attach command parks the state; the next photo is fetched from the LINE content API
  //      and lands as a doc_attachments row (source line, kind receipt, uploader = the linked staff).
  const attStart = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-18c1', source: { userId: 'Uprayut' }, message: { id: 'mid-18c1', type: 'text', text: `attach ${poNo} receipt` } }] });
  const photo = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-18c2', source: { userId: 'Uprayut' }, message: { id: 'mid-18c2', type: 'image' } }] });
  const attRows = await db.select().from(s.docAttachments).where(and(eq(s.docAttachments.docType, 'PO'), eq(s.docAttachments.docNo, poNo)));
  ok('attach: command + photo → attachment stored from the LINE content API (source line, kind receipt)',
    attStart.json.chat === 1 && photo.json.chat === 1 && lineReplies.at(-1)!.text.includes('แนบรูปกับ') && attRows.length === 1
      && attRows[0].source === 'line' && attRows[0].kind === 'receipt' && attRows[0].createdBy === 'prayut'
      && String(attRows[0].dataUrl).startsWith('data:image/png;base64,') && lineContentFetches.length >= 1,
    JSON.stringify({ rows: attRows.length, kind: attRows[0]?.kind, by: attRows[0]?.createdBy }));

  // 18d. replayed photo webhook (same message id) → deduped, no second attachment; a photo with NO pending
  //      state (somchai) is ignored entirely (customers send images all day).
  const replayPhoto = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-18d1', source: { userId: 'Uprayut' }, message: { id: 'mid-18c2', type: 'image' } }] });
  const strayPhoto = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-18d2', source: { userId: 'Usomchai' }, message: { id: 'mid-18d2', type: 'image' } }] });
  const attRows2 = await db.select().from(s.docAttachments).where(and(eq(s.docAttachments.docType, 'PO'), eq(s.docAttachments.docNo, poNo)));
  ok('attach: replayed photo cannot double-attach (state consumed → ignored); stateless photo ignored silently',
    replayPhoto.json.chat === 0 && strayPhoto.json.chat === 0 && attRows2.length === 1, JSON.stringify({ rows: attRows2.length, replay: replayPhoto.json.chat, stray: strayPhoto.json.chat }));

  // 18e. web API round-trip + evidence-integrity delete rules (uploader-or-Admin only).
  const prayutTok = (await inj('POST', '/api/login', undefined, { username: 'prayut', password: 'pw' })).json.token as string;
  await db.insert(s.users).values([{ username: 'apclerk', passwordHash: await pw.hash('pw'), role: 'ApClerk', tenantId: t1 }]).onConflictDoNothing();
  const apTok = (await inj('POST', '/api/login', undefined, { username: 'apclerk', password: 'pw' })).json.token as string;
  const webUp = await inj('POST', '/api/procurement/attachments', apTok, { doc_type: 'PO', doc_no: poNo, kind: 'invoice', filename: 'inv.png', data_url: 'data:image/png;base64,aGk=' });
  const listAtt = await inj('GET', `/api/procurement/attachments?doc_type=PO&doc_no=${poNo}`, token);
  const getOne = await inj('GET', `/api/procurement/attachments/${webUp.json.id}`, prayutTok);
  const delWrongUser = await inj('DELETE', `/api/procurement/attachments/${webUp.json.id}`, prayutTok); // procurement perm but NOT the uploader
  const delUploader = await inj('DELETE', `/api/procurement/attachments/${webUp.json.id}`, apTok);
  ok('attach: web upload + list (metadata only) + fetch; delete refused for non-uploader (NOT_UPLOADER), allowed for uploader',
    (webUp.status === 200 || webUp.status === 201) && listAtt.json.count === 2 && !JSON.stringify(listAtt.json).includes('base64')
      && getOne.json.data_url === 'data:image/png;base64,aGk=' && delWrongUser.status === 403 && delWrongUser.json.error?.code === 'NOT_UPLOADER'
      && delUploader.json.deleted === true,
    JSON.stringify({ up: webUp.status, count: listAtt.json.count, delWrong: delWrongUser.status }));

  // 18f. unknown doc on web upload → 404; bad payload → 400.
  const web404 = await inj('POST', '/api/procurement/attachments', apTok, { doc_type: 'PO', doc_no: 'PO-19990101-999', data_url: 'data:image/png;base64,aGk=' });
  const web400 = await inj('POST', '/api/procurement/attachments', apTok, { doc_type: 'PO', doc_no: poNo, data_url: 'https://not-a-data-url' });
  ok('attach: web negatives — unknown PO 404, non-data-URL 400 BAD_IMAGE',
    web404.status === 404 && web400.status === 400 && web400.json.error?.code === 'BAD_IMAGE', JSON.stringify({ s404: web404.status, s400: web400.status }));

  // ── 19. LC-1 (docs/30): flex queue card + one-tap postback approve with confirm step. ──
  // 19a. a fresh chat PR → the approver queue push is now a FLEX card carrying [อนุมัติ]/[ปฏิเสธ] postbacks.
  const pushesBefore19 = linePushes.length;
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-19a', source: { userId: 'Usomchai' }, message: { id: 'mid-19a', type: 'text', text: 'pr BINDER-A4 6 แฟ้มใหม่' } }] });
  const pr19 = /PR-\d{8}-\d{3}/.exec(lineReplies.at(-1)?.text ?? '')?.[0] ?? '';
  const card = linePushes.slice(pushesBefore19).find((p) => p.to === 'Uprayut');
  const approveBtn = card?.contents?.footer?.contents?.find((b: any) => b.action?.label === 'อนุมัติ');
  const approveData = approveBtn?.action?.data ?? '';
  ok('LC-1: queue push is a flex card with approve/reject postback buttons (altText keeps the typed hint)',
    card?.type === 'flex' && !!card?.altText?.includes(pr19) && !!approveData && JSON.parse(approveData).a === 'decide' && JSON.parse(approveData).d === pr19,
    JSON.stringify({ type: card?.type, data: approveData }));

  // 19b. tapping [อนุมัติ] → confirm card parked with a nonce (no action yet — PR still Pending).
  const tap = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'postback', webhookEventId: 'evt-19b', replyToken: 'rt-19b', source: { userId: 'Uprayut' }, postback: { data: approveData } }] });
  const confirmBtn = lineReplies.at(-1)?.contents?.footer?.contents?.[0];
  const confirmData = confirmBtn?.action?.data ?? '';
  const [pr19RowMid] = await db.select().from(s.purchaseRequests).where(eq(s.purchaseRequests.prNo, pr19));
  ok('LC-1: first tap → flex confirm card with nonce; nothing acted yet (PR still Pending)',
    tap.json.chat === 1 && lineReplies.at(-1)?.type === 'flex' && !!confirmData && JSON.parse(confirmData).a === 'confirm' && pr19RowMid?.status === 'Pending',
    JSON.stringify({ confirm: !!confirmData, status: pr19RowMid?.status }));

  // 19c. tapping [ยืนยัน] → the SAME engine path approves; requester notified.
  const pushesBefore19c = linePushes.length;
  const conf = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'postback', webhookEventId: 'evt-19c', replyToken: 'rt-19c', source: { userId: 'Uprayut' }, postback: { data: confirmData } }] });
  const [pr19Row] = await db.select().from(s.purchaseRequests).where(eq(s.purchaseRequests.prNo, pr19));
  const decidedPush = linePushes.slice(pushesBefore19c).find((p) => p.to === 'Usomchai');
  ok('LC-1: confirm tap → PR Approved via the engine (maker≠checker) + requester ✅ push',
    conf.json.chat === 1 && lineReplies.at(-1)!.text.includes('อนุมัติแล้ว') && pr19Row?.status === 'Approved' && pr19Row?.approvedBy === 'prayut' && !!decidedPush,
    JSON.stringify({ status: pr19Row?.status, by: pr19Row?.approvedBy }));

  // 19d. replaying the confirm postback (state already consumed) → expiry reply, no double-acting.
  const replayConf = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'postback', webhookEventId: 'evt-19d', replyToken: 'rt-19d', source: { userId: 'Uprayut' }, postback: { data: confirmData } }] });
  ok('LC-1: replayed confirm → state consumed, expiry reply (no second action)',
    replayConf.json.chat === 1 && lineReplies.at(-1)!.text.includes('หมดอายุ'), JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 50) }));

  // 19e. SoD binds on buttons exactly as typed: approver taps approve on their OWN PR → SOD_VIOLATION.
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-19e1', source: { userId: 'Uprayut' }, message: { id: 'mid-19e1', type: 'text', text: 'pr LABEL-ROLL 4' } }] });
  const prOwn19 = /PR-\d{8}-\d{3}/.exec(lineReplies.at(-1)?.text ?? '')?.[0] ?? '';
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'postback', webhookEventId: 'evt-19e2', replyToken: 'rt-19e2', source: { userId: 'Uprayut' }, postback: { data: JSON.stringify({ a: 'decide', x: 'approve', d: prOwn19 }) } }] });
  const ownConfirmData = lineReplies.at(-1)?.contents?.footer?.contents?.[0]?.action?.data ?? '';
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'postback', webhookEventId: 'evt-19e3', replyToken: 'rt-19e3', source: { userId: 'Uprayut' }, postback: { data: ownConfirmData } }] });
  const [prOwn19Row] = await db.select().from(s.purchaseRequests).where(eq(s.purchaseRequests.prNo, prOwn19));
  ok('LC-1: one-tap approve of own PR → SOD_VIOLATION at confirm (stays Pending)',
    lineReplies.at(-1)!.text.includes('SOD_VIOLATION') && prOwn19Row?.status === 'Pending', JSON.stringify({ status: prOwn19Row?.status }));

  // 19f. my prs is now a flex carousel (altText keeps the text list).
  const mine19 = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-19f', source: { userId: 'Usomchai' }, message: { id: 'mid-19f', type: 'text', text: 'my prs' } }] });
  const mineReply = lineReplies.at(-1);
  ok('LC-1: my prs → flex carousel of PR cards (altText lists them for non-flex clients)',
    mine19.json.chat === 1 && mineReply?.type === 'flex' && mineReply?.contents?.type === 'carousel' && (mineReply?.contents?.contents?.length ?? 0) >= 2 && mineReply!.text.includes(pr19),
    JSON.stringify({ type: mineReply?.type, cards: mineReply?.contents?.contents?.length }));

  // ── 20. LC-2 (docs/30): petty-cash self-service — expense/advance RAISE via chat + EXP-08 notifications.
  await db.update(s.users).set({ lineUserId: 'Uapclerk' }).where(eq(s.users.username, 'apclerk'));
  await db.insert(s.users).values([{ username: 'apboss', passwordHash: await pw.hash('pw'), role: 'ApClerk', tenantId: t1 }]).onConflictDoNothing();
  await db.update(s.users).set({ lineUserId: 'Uapboss' }).where(eq(s.users.username, 'apboss'));
  const fund = await inj('POST', '/api/finance/petty-cash/funds', token, { fund_code: 'PCF-LINE', name: 'LINE test fund', float_limit: 5000, initial_amount: 2000 });
  ok('LC-2: seed petty-cash fund created', fund.status === 200 || fund.status === 201, JSON.stringify({ s: fund.status }));

  // 20a. permission — a linked user without creditors/exec cannot raise.
  const pexDenied = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-20a', source: { userId: 'Usomchai' }, message: { id: 'mid-20a', type: 'text', text: 'expense PCF-LINE 100 น้ำแข็ง' } }] });
  ok('LC-2: expense without creditors/exec → refused', pexDenied.json.chat === 1 && lineReplies.at(-1)!.text.includes('ไม่มีสิทธิ์'), JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 50) }));

  // 20b. happy path — AP clerk raises an expense in chat: PEX- Pending, NO GL, approvers (creditors/exec,
  //      maker excluded) pushed; the maker gets no self-notification.
  const pushesBefore20 = linePushes.length;
  const pex = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-20b', source: { userId: 'Uapclerk' }, message: { id: 'mid-20b', type: 'text', text: 'expense PCF-LINE 300 ค่าน้ำแข็งหน้าร้าน' } }] });
  const pexNo = /PEX-\d{8}-\d{3}/.exec(lineReplies.at(-1)?.text ?? '')?.[0] ?? '';
  const [pexRow] = pexNo ? await db.select().from(s.expenseRequests).where(eq(s.expenseRequests.reqNo, pexNo)) : [];
  const newPushes = linePushes.slice(pushesBefore20);
  const bossPush = newPushes.find((p) => p.to === 'Uapboss');
  const makerPush = newPushes.find((p) => p.to === 'Uapclerk');
  ok('LC-2: chat expense → PEX PendingApproval (no GL), approver pushed (maker excluded)',
    pex.json.chat === 1 && !!pexRow && pexRow.status === 'PendingApproval' && pexRow.requestedBy === 'apclerk' && pexRow.glRef == null
      && !!bossPush && bossPush.text.includes(pexNo) && !makerPush,
    JSON.stringify({ pex: pexNo, status: pexRow?.status, bossPushed: !!bossPush, makerPushed: !!makerPush }));

  // 20c. service guards bind in chat — over-float refused.
  const overFloat = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-20c', source: { userId: 'Uapclerk' }, message: { id: 'mid-20c', type: 'text', text: 'expense PCF-LINE 99999 ทดสอบเกินวงเงิน' } }] });
  ok('LC-2: over-float expense → INSUFFICIENT_FLOAT reply, no request', overFloat.json.chat === 1 && lineReplies.at(-1)!.text.includes('ไม่สำเร็จ'), JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 60) }));

  // 20d. advance raise + web approve (checker ≠ maker) → requester ✅ push; web reject → ❌ push.
  const adv = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-20d', source: { userId: 'Uapclerk' }, message: { id: 'mid-20d', type: 'text', text: 'advance PCF-LINE 200 ยืมซื้อของหน้างาน' } }] });
  const advNo = /PEX-\d{8}-\d{3}/.exec(lineReplies.at(-1)?.text ?? '')?.[0] ?? '';
  const apbossTok = (await inj('POST', '/api/login', undefined, { username: 'apboss', password: 'pw' })).json.token as string;
  const pushesBefore20d = linePushes.length;
  const appr = await inj('POST', `/api/finance/petty-cash/requests/${pexNo}/approve`, apbossTok);
  const okPush = linePushes.slice(pushesBefore20d).find((p) => p.to === 'Uapclerk' && p.text.includes('อนุมัติแล้ว'));
  const rejAdv = await inj('POST', `/api/finance/petty-cash/requests/${advNo}/reject`, apbossTok, { reason: 'แนบใบเสร็จก่อน' });
  const rejPexPush = linePushes.slice(pushesBefore20d).find((p) => p.to === 'Uapclerk' && p.text.includes('ไม่ได้รับอนุมัติ'));
  ok('LC-2: web approve → requester ✅ push (with amount); reject → ❌ push (with reason)',
    adv.json.chat === 1 && appr.json.status === 'Approved' && !!okPush && okPush.text.includes(pexNo)
      && rejAdv.json.status === 'Rejected' && !!rejPexPush && rejPexPush.text.includes(advNo) && rejPexPush.text.includes('แนบใบเสร็จก่อน'),
    JSON.stringify({ appr: appr.json.status, okPush: !!okPush, rej: rejAdv.json.status, rejPush: !!rejPexPush }));

  // ── 21. LC-3 (docs/30): ESS leave via chat + channel governance (link registry, force-unlink, rate limit).
  const [somchaiRow] = await db.select().from(s.users).where(eq(s.users.username, 'somchai'));
  await db.insert(s.employees).values({ tenantId: t1, empCode: 'E-SOM', name: 'สมชาย ใจดี', userName: 'somchai' }).onConflictDoNothing();
  await db.insert(s.userPermissions).values([{ userId: Number(somchaiRow.id), perm: 'ess' }, { userId: Number(somchaiRow.id), perm: 'pr_raise' }]).onConflictDoNothing();

  // 21a. leave raise via chat → Pending request (to_date derived), approver (exec/users/creditors holder) pushed.
  const pushesBefore21 = linePushes.length;
  const lv = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-21a', source: { userId: 'Usomchai' }, message: { id: 'mid-21a', type: 'text', text: 'leave 2026-07-10 3 พาแม่ไปหาหมอ' } }] });
  const lvId = Number(/#(\d+)/.exec(lineReplies.at(-1)?.text ?? '')?.[1] ?? 0);
  const [lvRow] = lvId ? await db.select().from(s.leaveRequests).where(eq(s.leaveRequests.id, lvId)) : [];
  const lvPush = linePushes.slice(pushesBefore21).find((p) => p.to === 'Uapboss' && p.text.includes('ใบลา'));
  ok('LC-3: chat leave → Pending request (to_date derived) + approver push',
    lv.json.chat === 1 && !!lvRow && lvRow.status === 'Pending' && String(lvRow.toDate) === '2026-07-12' && Number(lvRow.days) === 3 && !!lvPush,
    JSON.stringify({ id: lvId, to: lvRow?.toDate, pushed: !!lvPush }));

  // 21b. permission — a linked user without `ess` cannot raise leave.
  const lvDenied = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-21b', source: { userId: 'Uprayut' }, message: { id: 'mid-21b', type: 'text', text: 'leave 2026-07-10 2' } }] });
  ok('LC-3: leave without ess permission → refused', lvDenied.json.chat === 1 && lineReplies.at(-1)!.text.includes('ไม่มีสิทธิ์'), JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 50) }));

  // 21c. web approve (Admin holds exec) → requester ✅ push.
  const pushesBefore21c = linePushes.length;
  const lvAppr = await inj('POST', `/api/hcm/leave/${lvId}/approve`, token);
  const lvOkPush = linePushes.slice(pushesBefore21c).find((p) => p.to === 'Usomchai' && p.text.includes('อนุมัติแล้ว'));
  ok('LC-3: leave approve → requester ✅ push', lvAppr.json.status === 'Approved' && !!lvOkPush && lvOkPush.text.includes(`#${lvId}`), JSON.stringify({ s: lvAppr.json.status, pushed: !!lvOkPush }));

  // 21d. admin link registry — `users` perm only; masked LINE ids.
  const links = await inj('GET', '/api/line/links', token);
  const somchaiLink = (links.json.links ?? []).find((l: any) => l.username === 'somchai');
  const linksDenied = await inj('GET', '/api/line/links', somchaiTok);
  ok('LC-3: link registry lists linked users (masked id); non-`users` caller refused',
    links.json.count >= 4 && !!somchaiLink && String(somchaiLink.line_user_id_masked).endsWith('…') && !JSON.stringify(links.json).includes('Usomchai"') && linksDenied.status === 403,
    JSON.stringify({ count: links.json.count, masked: somchaiLink?.line_user_id_masked, denied: linksDenied.status }));

  // 21e. force-unlink (offboarding) — the channel dies immediately; audit row written.
  const fu = await inj('DELETE', '/api/line/links/auditor', token);
  const fuChat = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-21e', source: { userId: 'Uauditor' }, message: { id: 'mid-21e', type: 'text', text: 'my prs' } }] });
  const fuAudit = await db.select().from(s.messageLog).where(and(eq(s.messageLog.tenantId, t1), eq(s.messageLog.recipient, 'Uauditor')));
  ok('LC-3: admin force-unlink → subsequent chat is unlinked; audit row recorded',
    fu.json.unlinked === true && fuChat.json.chat === 1 && lineReplies.at(-1)!.text.includes('ยังไม่ได้เชื่อมบัญชี') && fuAudit.some((r: any) => String(r.body).startsWith('[chat:admin-unlink]')),
    JSON.stringify({ unlinked: fu.json.unlinked, audited: fuAudit.some((r: any) => String(r.body).startsWith('[chat:admin-unlink]')) }));

  // 21f. rate limit — budget of 3: first 3 commands answered, 4th gets ONE throttle reply, 5th dropped silently.
  await db.update(s.users).set({ lineUserId: 'Usomsri' }).where(eq(s.users.username, 'somsri'));
  process.env.LINE_CHAT_RATE_LIMIT = '3';
  const rateReplies: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const before = lineReplies.length;
    await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: `rt-21f${i}`, source: { userId: 'Usomsri' }, message: { id: `mid-21f${i}`, type: 'text', text: 'stock A4-PAPER' } }] });
    rateReplies.push(lineReplies.length - before);
  }
  const throttleAudit = await db.select().from(s.messageLog).where(and(eq(s.messageLog.tenantId, t1), eq(s.messageLog.recipient, 'Usomsri')));
  process.env.LINE_CHAT_RATE_LIMIT = '1000';
  ok('LC-3: rate limit — 3 answered, 4th throttle-replied once, 5th silent; throttle audit row',
    rateReplies.join(',') === '1,1,1,1,0' && lineReplies.at(-1)!.text.includes('ถี่เกินไป')
      && throttleAudit.some((r: any) => String(r.body).startsWith('[chat:throttled]')),
    JSON.stringify({ pattern: rateReplies.join(','), audited: throttleAudit.some((r: any) => String(r.body).startsWith('[chat:throttled]')) }));

  // ── 22. LC-4 (docs/30): alert delivery to linked identity + LINE daily digest subscriptions. ──
  // 22a. an alert rule targeting 'user:<username>' resolves to that user's LINKED LINE at send time.
  const rule = await inj('POST', '/api/alerts/rules', token, { name: 'PR ค้างเยอะ', metric: 'open_pr_count', operator: 'gt', threshold: 0, channel: 'line', target_to: 'user:apboss', cooldown_hours: 0 });
  const pushesBefore22 = linePushes.length;
  const alertRun = await inj('POST', '/api/alerts/run', token);
  const alertPush = linePushes.slice(pushesBefore22).find((p) => p.to === 'Uapboss' && p.text.includes('PR ค้างเยอะ'));
  ok('LC-4: alert rule target user:<name> → fired push lands on the LINKED LINE (registry-resolved)',
    (rule.status === 200 || rule.status === 201) && alertRun.json.fired_count >= 1 && !!alertPush,
    JSON.stringify({ fired: alertRun.json.fired_count, pushed: !!alertPush }));

  // 22b. digest opt-in is permission-gated (dashboard/fin_report/exec) — somchai (ess+pr_raise) refused.
  const digDenied = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-22b', source: { userId: 'Usomchai' }, message: { id: 'mid-22b', type: 'text', text: 'subscribe digest' } }] });
  ok('LC-4: subscribe digest without dashboard/fin_report/exec → refused',
    digDenied.json.chat === 1 && lineReplies.at(-1)!.text.includes('ไม่มีสิทธิ์'), JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 50) }));

  // 22c. opt-in creates/joins the tenant's line_daily_digest subscription as a {line_user} recipient.
  const [somsriRow] = await db.select().from(s.users).where(eq(s.users.username, 'somsri'));
  await db.insert(s.userPermissions).values([{ userId: Number(somsriRow.id), perm: 'dashboard' }, { userId: Number(somsriRow.id), perm: 'pr_raise' }]).onConflictDoNothing();
  const digOn = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-22c', source: { userId: 'Usomsri' }, message: { id: 'mid-22c', type: 'text', text: 'subscribe digest' } }] });
  const [digSub] = await db.select().from(reportSubscriptions).where(and(eq(reportSubscriptions.tenantId, t1), eq(reportSubscriptions.reportType, 'line_daily_digest')));
  ok('LC-4: subscribe digest → line_daily_digest subscription with {line_user} recipient',
    digOn.json.chat === 1 && lineReplies.at(-1)!.text.includes('✔') && !!digSub && (digSub.recipients as any[]).some((r: any) => r.line_user === 'somsri'),
    JSON.stringify({ recips: digSub?.recipients }));

  // 22d. the scheduler delivers the digest to the linked LINE (counts summary).
  const pushesBefore22d = linePushes.length;
  const digRun = await inj('POST', '/api/bi/subscriptions/run', token);
  const digPush = linePushes.slice(pushesBefore22d).find((p) => p.to === 'Usomsri' && p.text.includes('รออนุมัติ')); // LP-3: KPI-row format
  ok('LC-4: run-due → digest pushed to the linked LINE (pending approvals / open PRs / alerts 24h)',
    digRun.json.ran_count >= 1 && !!digPush && digPush.text.includes('LINE Daily Digest'),
    JSON.stringify({ ran: digRun.json.ran_count, pushed: !!digPush, head: digPush?.text.slice(0, 60) }));

  // 22e. unsubscribe removes the recipient.
  const digOff = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-22e', source: { userId: 'Usomsri' }, message: { id: 'mid-22e', type: 'text', text: 'unsubscribe digest' } }] });
  const [digSub2] = await db.select().from(reportSubscriptions).where(eq(reportSubscriptions.id, Number(digSub.id)));
  ok('LC-4: unsubscribe digest → recipient removed',
    digOff.json.chat === 1 && !(digSub2.recipients as any[]).some((r: any) => r.line_user === 'somsri'), JSON.stringify({ recips: digSub2?.recipients }));

  // ── 23. LC-5 (docs/30): `ask` governed NL analytics + confirm-first Thai copilot (key-less rules). ──
  // 23a. ask — permission gate (exec/dashboard/masterdata); somchai (ess+pr_raise) refused.
  const askDenied = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-23a', source: { userId: 'Usomchai' }, message: { id: 'mid-23a', type: 'text', text: 'ask ยอดขายตามสาขา' } }] });
  ok('LC-5: ask without dashboard/exec/masterdata → refused', askDenied.json.chat === 1 && lineReplies.at(-1)!.text.includes('ไม่มีสิทธิ์'), JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 50) }));

  // 23b. ask — governed keyword-mapped query (no LLM key in CI); empty data answers honestly.
  const askOk = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-23b', source: { userId: 'Usomsri' }, message: { id: 'mid-23b', type: 'text', text: 'ask ยอดขายตามสาขา' } }] });
  const askText = lineReplies.at(-1)?.text ?? '';
  ok('LC-5: ask → governed NL query answers (dimension resolved; no raw SQL surface)',
    askOk.json.chat === 1 && (askText.includes('branch') || askText.includes('ยอดขาย') || askText.includes('ไม่มีข้อมูล')),
    JSON.stringify({ reply: askText.slice(0, 60) }));

  // 23c. copilot — free Thai text drafts a PR; NOTHING is created before [ยืนยัน].
  const prCountAI = (await db.select().from(s.purchaseRequests)).length;
  const aiDraft = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-23c', source: { userId: 'Usomchai' }, message: { id: 'mid-23c', type: 'text', text: 'บอท ขอซื้อ A4-PAPER 4 ใกล้หมดแล้วนะ' } }] });
  const aiConfirmData = lineReplies.at(-1)?.contents?.footer?.contents?.[0]?.action?.data ?? '';
  const prCountAfterDraft = (await db.select().from(s.purchaseRequests)).length;
  ok('LC-5: copilot draft → confirm card only (no PR before confirm)',
    aiDraft.json.chat === 1 && lineReplies.at(-1)?.type === 'flex' && !!aiConfirmData && JSON.parse(aiConfirmData).d === 'AI-DRAFT' && prCountAfterDraft === prCountAI,
    JSON.stringify({ draft: lineReplies.at(-1)?.text.slice(0, 50), created: prCountAfterDraft - prCountAI }));

  // 23d. confirming the draft replays the ordinary pr path (pr_raise + same numbering + workflow).
  const aiConf = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'postback', webhookEventId: 'evt-23d', replyToken: 'rt-23d', source: { userId: 'Usomchai' }, postback: { data: aiConfirmData } }] });
  const aiPrNo = /PR-\d{8}-\d{3}/.exec(lineReplies.at(-1)?.text ?? '')?.[0] ?? '';
  const [aiPrRow] = aiPrNo ? await db.select().from(s.purchaseRequests).where(eq(s.purchaseRequests.prNo, aiPrNo)) : [];
  ok('LC-5: confirm → PR created through the normal path (requested_by = linked staff)',
    aiConf.json.chat === 1 && !!aiPrRow && aiPrRow.requestedBy === 'somchai' && aiPrRow.status === 'Pending',
    JSON.stringify({ pr: aiPrNo, by: aiPrRow?.requestedBy }));

  // 23e. unknown free text → honest "don't understand" + usage (no guessing, no action).
  const aiUnknown = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-23e', source: { userId: 'Usomchai' }, message: { id: 'mid-23e', type: 'text', text: 'bot วันนี้อากาศดีจัง' } }] });
  ok('LC-5: copilot unknown intent → usage reply, nothing acted', aiUnknown.json.chat === 1 && lineReplies.at(-1)!.text.includes('ยังไม่เข้าใจ'), JSON.stringify({ reply: lineReplies.at(-1)?.text.slice(0, 40) }));

  // ── 24. LP-1 (docs/31): production go-live pack — webhook receipt health + test-self push. ──
  // (The required-secret guard is 24-adjacent but asserted up in section 10 where creds are first saved;
  //  every signed webhook above also exercised the fail-closed HMAC verify.)
  // 24a. readiness: secret flag + exact webhook path + last receipt recorded as 'verified'.
  const glProv = await inj('GET', '/api/messaging/providers', token);
  const glLine = (glProv.json.channels ?? []).find((c: any) => c.channel === 'line');
  ok('LP-1: readiness → webhook_secret_set, webhook_path=/api/line/webhook/T1, last receipt verified (secret never returned)',
    glLine?.webhook_secret_set === true && glLine?.webhook_path === '/api/line/webhook/T1'
      && glLine?.last_webhook_status === 'verified' && !!glLine?.last_webhook_at
      && !JSON.stringify(glProv.json).includes(LINE_WH_SECRET),
    JSON.stringify({ set: glLine?.webhook_secret_set, path: glLine?.webhook_path, st: glLine?.last_webhook_status }));

  // 24b. a tampered delivery → 401 BAD_WEBHOOK_SIGNATURE and the receipt health flips to bad_signature.
  const badSig = await app.inject({ method: 'POST', url: '/api/line/webhook/T1', headers: { 'content-type': 'application/json', 'x-line-signature': 'AAAA/tampered=' }, payload: JSON.stringify({ events: [] }) });
  let badSigJson: any = {}; try { badSigJson = badSig.json(); } catch { /* */ }
  const glAfterBad = ((await inj('GET', '/api/messaging/providers', token)).json.channels ?? []).find((c: any) => c.channel === 'line');
  ok('LP-1: bad webhook signature → 401 fail-closed + receipt health shows bad_signature',
    badSig.statusCode === 401 && badSigJson.error?.code === 'BAD_WEBHOOK_SIGNATURE' && glAfterBad?.last_webhook_status === 'bad_signature',
    JSON.stringify({ s: badSig.statusCode, code: badSigJson.error?.code, st: glAfterBad?.last_webhook_status }));

  // 24c. the next good delivery flips receipt health back to verified.
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [] });
  const glAfterGood = ((await inj('GET', '/api/messaging/providers', token)).json.channels ?? []).find((c: any) => c.channel === 'line');
  ok('LP-1: next verified delivery → receipt health back to verified', glAfterGood?.last_webhook_status === 'verified', JSON.stringify({ st: glAfterGood?.last_webhook_status }));

  // 24d. test-self: an admin with no linked LINE gets an explicit NOT_LINKED (silence explained)…
  const tsUnlinked = await inj('POST', '/api/messaging/providers/line/test-self', token, {});
  ok('LP-1: test-self while unlinked → 400 NOT_LINKED', tsUnlinked.status === 400 && tsUnlinked.json.error?.code === 'NOT_LINKED', JSON.stringify({ s: tsUnlinked.status, code: tsUnlinked.json.error?.code }));

  // 24e. …and after linking, the button pushes to the admin's own LINE (audit campaign line_test).
  const bossCode = (await inj('POST', '/api/line/link-code', token)).json.code as string;
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-24e', source: { userId: 'Uboss' }, message: { id: 'mid-24e', type: 'text', text: `link ${bossCode}` } }] });
  const tsBefore = linePushes.length;
  const tsLinked = await inj('POST', '/api/messaging/providers/line/test-self', token, {});
  const tsLog = await db.select().from(s.messageLog).where(and(eq(s.messageLog.tenantId, t1), eq(s.messageLog.campaign, 'line_test')));
  ok('LP-1: test-self after linking → push lands on the admin\'s own LINE (campaign line_test logged)',
    tsLinked.status === 201 || tsLinked.status === 200
      ? tsLinked.json.status === 'sent' && linePushes.length === tsBefore + 1 && linePushes.at(-1)!.to === 'Uboss' && tsLog.length >= 1
      : false,
    JSON.stringify({ s: tsLinked.status, to: linePushes.at(-1)?.to, logged: tsLog.length }));

  // ── 25. LP-2 (docs/31): copilot uplift — wider intents (expense/leave), scripted-LLM evals, daily cap. ──
  // 25a. deterministic expense draft (key-less) → confirm card only, no request row before confirm.
  const pexCount25 = (await db.select().from(s.expenseRequests)).length;
  const draftExp = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-25a', source: { userId: 'Uapclerk' }, message: { id: 'mid-25a', type: 'text', text: 'บอท ขอเบิก 250 จาก PCF-LINE ค่าน้ำแข็งหน้าร้าน' } }] });
  const expConfirmData = lineReplies.at(-1)?.contents?.footer?.contents?.[0]?.action?.data ?? '';
  const expBtn = lineReplies.at(-1)?.contents?.footer?.contents?.[0]?.action?.label ?? '';
  ok('LP-2: copilot expense draft (Thai free text) → confirm card only, nothing raised',
    draftExp.json.chat === 1 && expBtn === 'ยืนยันเบิกเงิน' && (await db.select().from(s.expenseRequests)).length === pexCount25,
    JSON.stringify({ btn: expBtn, created: (await db.select().from(s.expenseRequests)).length - pexCount25 }));

  // 25b. confirm → PEX raised through the ordinary chat expense path (same perms + service guards).
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'postback', webhookEventId: 'evt-25b', replyToken: 'rt-25b', source: { userId: 'Uapclerk' }, postback: { data: expConfirmData } }] });
  const pex25No = /PEX-\d{8}-\d{3}/.exec(lineReplies.at(-1)?.text ?? '')?.[0] ?? '';
  const [pex25] = pex25No ? await db.select().from(s.expenseRequests).where(eq(s.expenseRequests.reqNo, pex25No)) : [];
  ok('LP-2: confirm expense draft → PEX PendingApproval via the normal path (maker = linked staff)',
    !!pex25 && pex25.status === 'PendingApproval' && pex25.requestedBy === 'apclerk' && Number(pex25.amount) === 250,
    JSON.stringify({ pex: pex25No, by: pex25?.requestedBy, amt: pex25?.amount }));

  // 25c. deterministic leave draft ("ลา <n> วัน ตั้งแต่ <date>") → confirm → leave via the ESS path.
  const draftLv = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-25c1', source: { userId: 'Usomchai' }, message: { id: 'mid-25c1', type: 'text', text: 'บอท ขอลา 2 วัน ตั้งแต่ 2026-08-03 ไปงานบวช' } }] });
  const lvConfirmData = lineReplies.at(-1)?.contents?.footer?.contents?.[0]?.action?.data ?? '';
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'postback', webhookEventId: 'evt-25c2', replyToken: 'rt-25c2', source: { userId: 'Usomchai' }, postback: { data: lvConfirmData } }] });
  const lv25Id = Number(/#(\d+)/.exec(lineReplies.at(-1)?.text ?? '')?.[1] ?? 0);
  const [lv25] = lv25Id ? await db.select().from(s.leaveRequests).where(eq(s.leaveRequests.id, lv25Id)) : [];
  ok('LP-2: copilot leave draft (days-first Thai) → confirm → Pending leave via ESS path (to_date derived)',
    draftLv.json.chat === 1 && !!lv25 && lv25.status === 'Pending' && String(lv25.fromDate) === '2026-08-03' && String(lv25.toDate) === '2026-08-04',
    JSON.stringify({ id: lv25Id, from: lv25?.fromDate, to: lv25?.toDate }));

  // 25d. scripted-LLM eval (docs/31 — the ai-eval seam): rules can't parse it, the (fake) model drafts,
  //      the confirm replays the ordinary pr path. Daily cap 1 → this is the tenant's one allowed call.
  process.env.ANTHROPIC_API_KEY = 'fake-line-copilot-key';
  process.env.LINE_COPILOT_DAILY_CAP = '1';
  let llmCalls = 0;
  setLlmClientForTests({
    create: async (params: any) => {
      llmCalls++;
      const userText = String(params?.messages?.[0]?.content ?? '');
      const reply = userText.includes('เมาส์ไร้สาย')
        ? { intent: 'pr', item_id: 'MOUSE-WL', qty: 1, reason: 'เมาส์ไร้สาย' }
        : null;
      return { content: [{ type: 'text', text: reply ? JSON.stringify(reply) : 'ขออภัย ไม่ใช่ JSON นะ' }] };
    },
    stream: () => { throw new Error('not used'); },
  } as any);
  const prCount25 = (await db.select().from(s.purchaseRequests)).length;
  const draftLlm = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-25d1', source: { userId: 'Usomchai' }, message: { id: 'mid-25d1', type: 'text', text: 'บอท อยากได้เมาส์ไร้สายสักตัวครับ' } }] });
  const llmConfirmData = lineReplies.at(-1)?.contents?.footer?.contents?.[0]?.action?.data ?? '';
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'postback', webhookEventId: 'evt-25d2', replyToken: 'rt-25d2', source: { userId: 'Usomchai' }, postback: { data: llmConfirmData } }] });
  const llmPrNo = /PR-\d{8}-\d{3}/.exec(lineReplies.at(-1)?.text ?? '')?.[0] ?? '';
  const [llmPr] = llmPrNo ? await db.select().from(s.purchaseRequests).where(eq(s.purchaseRequests.prNo, llmPrNo)) : [];
  ok('LP-2: scripted-LLM draft (rules miss) → schema-validated → confirm → PR via the normal path',
    draftLlm.json.chat === 1 && llmCalls === 1 && !!llmPr && llmPr.requestedBy === 'somchai' && (await db.select().from(s.purchaseRequests)).length === prCount25 + 1,
    JSON.stringify({ calls: llmCalls, pr: llmPrNo, by: llmPr?.requestedBy }));

  // 25e. daily LLM cap trips: the next LLM-needed text is answered WITHOUT calling the model (+ audit row).
  const capTry = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-25e', source: { userId: 'Usomchai' }, message: { id: 'mid-25e', type: 'text', text: 'บอท อยากได้อะไรสักอย่างที่กฎไม่เข้าใจ' } }] });
  const capAudit = (await db.select().from(s.messageLog).where(eq(s.messageLog.tenantId, t1))).some((r: any) => String(r.body ?? '').includes('[chat:ai-cap]'));
  ok('LP-2: per-tenant daily LLM cap → model NOT called, honest refusal + [chat:ai-cap] audit',
    capTry.json.chat === 1 && llmCalls === 1 && lineReplies.at(-1)!.text.includes('ยังไม่เข้าใจ') && capAudit,
    JSON.stringify({ calls: llmCalls, audited: capAudit }));
  process.env.LINE_COPILOT_DAILY_CAP = '0'; // 0 = uncapped for the remaining checks

  // 25f. malformed LLM output → schema validation rejects → honest refusal, nothing created or parked.
  const prCount25f = (await db.select().from(s.purchaseRequests)).length;
  const badLlm = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-25f', source: { userId: 'Usomchai' }, message: { id: 'mid-25f', type: 'text', text: 'บอท ช่วยจัดการอะไรก็ได้' } }] });
  const [state25f] = await db.select().from(s.lineChatStates).where(and(eq(s.lineChatStates.tenantId, t1), eq(s.lineChatStates.lineUserId, 'Usomchai')));
  ok('LP-2: malformed LLM JSON → refusal, no draft state, nothing created',
    badLlm.json.chat === 1 && llmCalls === 2 && lineReplies.at(-1)!.text.includes('ยังไม่เข้าใจ')
      && (await db.select().from(s.purchaseRequests)).length === prCount25f && (!state25f || (state25f.payload as any)?.action !== 'copilot-cmd'),
    JSON.stringify({ calls: llmCalls, reply: lineReplies.at(-1)?.text.slice(0, 30) }));

  // 25g. DPA gate (fail closed): key present + NODE_ENV=production + no AI_DPA_ACKNOWLEDGED → the model
  //      is never called; the copilot degrades to the deterministic rules only.
  process.env.NODE_ENV = 'production';
  const dpaTry = await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-25g', source: { userId: 'Usomchai' }, message: { id: 'mid-25g', type: 'text', text: 'บอท อยากได้จอใหม่สวย ๆ' } }] });
  process.env.NODE_ENV = 'test';
  ok('LP-2: AI_DPA gate → LLM not called in prod without DPA ack (deterministic refusal)',
    dpaTry.json.chat === 1 && llmCalls === 2 && lineReplies.at(-1)!.text.includes('ยังไม่เข้าใจ'),
    JSON.stringify({ calls: llmCalls }));
  setLlmClientForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LINE_COPILOT_DAILY_CAP;

  // ── 26. LP-3 (docs/31): digest 2.0 — KPI catalog, per-subscriber selection, per-recipient permission
  //        filter at send time, flex layout. ──
  // Seed KPI data: yesterday's sale, an overdue AR balance, cash in the GL, one low-stock row.
  const bkk26 = new Date(Date.now() + 7 * 3600_000);
  const yest26 = new Date(bkk26.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
  const past26 = new Date(bkk26.getTime() - 10 * 24 * 3600_000).toISOString().slice(0, 10);
  await db.insert(s.arInvoices).values([
    { invoiceNo: 'INV-LP3-Y1', invoiceDate: yest26, dueDate: '2099-01-01', tenantId: t1, amount: '1234.50', paidAmount: '0', status: 'Unpaid' },
    { invoiceNo: 'INV-LP3-OD', invoiceDate: past26, dueDate: past26, tenantId: t1, amount: '800.00', paidAmount: '300.00', status: 'Unpaid' },
  ]);
  const [je26] = await db.insert(s.journalEntries).values({ entryNo: 'JE-LP3-CASH', entryDate: yest26, tenantId: t1, status: 'Posted', source: 'Manual', memo: 'LP-3 cash seed' }).returning();
  await db.insert(s.journalLines).values([
    { entryId: Number(je26.id), accountCode: '1000', debit: '900', credit: '0', tenantId: t1 },
    { entryId: Number(je26.id), accountCode: '3100', debit: '0', credit: '900', tenantId: t1 },
  ]);
  await db.insert(s.branchStock).values({ tenantId: t1, branchId: 1, itemId: 'LOW-1', itemDescription: 'ของใกล้หมด', onHand: '1', reorderPoint: '5' });

  // 26a. `digest kpis` is permission-aware: somchai (no dashboard) refused; boss (Admin) sees fin KPIs.
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-26a1', source: { userId: 'Usomchai' }, message: { id: 'mid-26a1', type: 'text', text: 'digest kpis' } }] });
  const kpiDenied = lineReplies.at(-1)!.text;
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-26a2', source: { userId: 'Uboss' }, message: { id: 'mid-26a2', type: 'text', text: 'digest kpis' } }] });
  const kpiList = lineReplies.at(-1)!.text;
  ok('LP-3: digest kpis → permission-aware menu (no-perm refused; Admin sees the fin KPIs)',
    kpiDenied.includes('ไม่มีสิทธิ์') && kpiList.includes('cash_position') && kpiList.includes('sales_yesterday') && kpiList.includes('ค่าเริ่มต้น'),
    JSON.stringify({ denied: kpiDenied.slice(0, 30), listed: kpiList.includes('cash_position') }));

  // 26b. selection is validated: unknown key refused; a key the caller cannot SEE refused at subscribe.
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-26b1', source: { userId: 'Usomsri' }, message: { id: 'mid-26b1', type: 'text', text: 'subscribe digest nonsense_kpi' } }] });
  const badKey = lineReplies.at(-1)!.text;
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-26b2', source: { userId: 'Usomsri' }, message: { id: 'mid-26b2', type: 'text', text: 'subscribe digest cash_position' } }] });
  const deniedKey = lineReplies.at(-1)!.text;
  ok('LP-3: KPI selection validated — unknown key + un-seeable key both refused at subscribe',
    badKey.includes('ไม่รู้จัก KPI') && deniedKey.includes('ไม่มีสิทธิ์เห็น'),
    JSON.stringify({ bad: badKey.slice(0, 30), denied: deniedKey.slice(0, 40) }));

  // 26c. boss picks fin KPIs; somsri (dashboard) takes the default trio — both stored on the recipients.
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-26c1', source: { userId: 'Uboss' }, message: { id: 'mid-26c1', type: 'text', text: 'subscribe digest sales_yesterday,cash_position,ar_overdue,low_stock' } }] });
  await inj('POST', '/api/line/webhook/T1', undefined, { events: [{ type: 'message', replyToken: 'rt-26c2', source: { userId: 'Usomsri' }, message: { id: 'mid-26c2', type: 'text', text: 'subscribe digest' } }] });
  const [digSub26] = await db.select().from(reportSubscriptions).where(and(eq(reportSubscriptions.tenantId, t1), eq(reportSubscriptions.reportType, 'line_daily_digest')));
  const bossRecip = (digSub26.recipients as any[]).find((r: any) => r.line_user === 'boss');
  ok('LP-3: per-subscriber KPI selection stored on the recipient (no migration — jsonb)',
    !!bossRecip && Array.isArray(bossRecip.kpis) && bossRecip.kpis.includes('cash_position') && (digSub26.recipients as any[]).some((r: any) => r.line_user === 'somsri' && !r.kpis),
    JSON.stringify({ boss: bossRecip?.kpis, n: (digSub26.recipients as any[]).length }));

  // 26d. delivery: same tenant run, two subscribers, two DIFFERENT payloads (permission + selection);
  //      flex bubble with the text as altText; money formatted; boss sees cash, somsri never does.
  await db.update(reportSubscriptions).set({ nextRunAt: new Date() }).where(eq(reportSubscriptions.id, Number(digSub26.id)));
  const pushesBefore26 = linePushes.length;
  const run26 = await inj('POST', '/api/bi/subscriptions/run', token);
  const bossPush26 = linePushes.slice(pushesBefore26).find((p) => p.to === 'Uboss');
  const somsriPush26 = linePushes.slice(pushesBefore26).find((p) => p.to === 'Usomsri');
  ok('LP-3: one run, per-recipient payloads — boss gets fin KPIs (flex), somsri gets the trio without cash',
    run26.json.ran_count >= 1 && !!bossPush26 && bossPush26.type === 'flex'
      && bossPush26.text.includes('เงินสดคงเหลือ') && bossPush26.text.includes('600') /* 900 seed − 300 LC-2 petty-cash expense (1015 is a cash account) */ && bossPush26.text.includes('ยอดขายเมื่อวาน') && bossPush26.text.includes('1,234.5')
      && bossPush26.text.includes('ลูกหนี้เกินกำหนด') && bossPush26.text.includes('500') && bossPush26.text.includes('สินค้าใกล้หมด')
      && !!somsriPush26 && somsriPush26.text.includes('รออนุมัติ') && !somsriPush26.text.includes('เงินสดคงเหลือ'),
    JSON.stringify({ boss: bossPush26?.text.slice(0, 120), somsri: somsriPush26?.text.slice(0, 60) }));

  console.log('\n── C5 — LINE OA member CRM (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} LINE-CRM checks failed` : `\n✅ All ${checks.length} LINE-CRM checks passed`);
  globalThis.fetch = realFetch;
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
