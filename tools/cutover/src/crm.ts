/**
 * POS CRM Update — online-order loyalty sync, CRM/360 profile, RFM segmentation,
 * personalized promo targeting, branch KPI dashboard over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover crm
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-secret';
process.env.NODE_ENV = 'test';

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
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([
    { code: 'HQ', name: 'HQ' },
    { code: 'T1', name: 'ร้านชาหนึ่ง', vatRegistered: true },
    { code: 'T2', name: 'ร้านชาสอง', vatRegistered: true },
  ]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'mgr1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'mgr2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
  ]).onConflictDoNothing();

  // Loyalty config — enabled for T1
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: true, pointsPerBaht: '1', bahtPerPoint: '0.1', minRedeem: '100' }).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ maxParamLength: 500 }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [admin, mgr1, mgr2] = [await login('admin', 'admin123'), await login('mgr1', 'pw1'), await login('mgr2', 'pw2')];

  // ── 1. Enroll member for T1 ──
  const enroll = await inj('POST', '/api/loyalty/members', mgr1, { name: 'สมชาย ชาดี', phone: '0801234567' });
  const memberId = enroll.json.id as number;
  ok('Enroll member → member_code M-000XXX, id assigned', enroll.status === 201 && /^M-/.test(enroll.json.member_code ?? '') && memberId > 0, JSON.stringify(enroll.json));

  // ── 2. Channel order with member_id → pay → confirm → points earned ──
  const ord = await inj('POST', '/api/order/T1', undefined, {
    fulfillment_type: 'takeaway', member_id: memberId,
    items: [{ name: 'ชาไทย', qty: 2, unit_price: 50, station_code: 'drinks' }],
  });
  ok('Channel order create with member_id → DIN- + token', /^DIN-/.test(ord.json.order_no ?? '') && !!ord.json.token, JSON.stringify({ no: ord.json.order_no }));

  const pay = await inj('POST', `/api/order/t/${ord.json.token}/pay`, undefined, {});
  ok('Channel pay → PromptPay Pending', pay.json.status === 'Pending' && /^PAY-/.test(pay.json.payment_no ?? ''), `status=${pay.json.status}`);

  const confirm = await inj('POST', `/api/order/t/${ord.json.token}/confirm`, undefined, { payment_no: pay.json.payment_no });
  ok('Channel confirm → paid=true, points_earned > 0 (loyalty sync)', confirm.json.paid === true && Number(confirm.json.points_earned) > 0, JSON.stringify({ paid: confirm.json.paid, pts: confirm.json.points_earned }));

  // ── 3. posMemberLedger has Earn row for this sale ──
  const ledgerRows = (await pg.query(`SELECT txn_type, points, ref_doc FROM pos_member_ledger WHERE member_id=${memberId} AND txn_type='Earn'`)).rows as any[];
  const earnRow = ledgerRows.find((r: any) => r.ref_doc === confirm.json.sale_no);
  ok('posMemberLedger: Earn row linked to sale_no, points > 0', !!earnRow && Number(earnRow.points) > 0, JSON.stringify(earnRow));

  // ── 4. member_id stored on dine_in_orders ──
  const dinRow = (await pg.query(`SELECT member_id FROM dine_in_orders WHERE order_no='${ord.json.order_no}'`)).rows as any[];
  ok('dine_in_orders.member_id = enrolled member id', Number(dinRow[0]?.member_id) === memberId, `member_id=${dinRow[0]?.member_id} expected=${memberId}`);

  // ── 5. Loyalty earn idempotent — re-confirm cannot double-earn points ──
  await inj('POST', `/api/order/t/${ord.json.token}/confirm`, undefined, { payment_no: pay.json.payment_no });
  const earnRows2 = (await pg.query(`SELECT count(*)::int n FROM pos_member_ledger WHERE member_id=${memberId} AND txn_type='Earn' AND ref_doc='${confirm.json.sale_no}'`)).rows as any[];
  ok('Loyalty earn idempotent (re-confirm → still 1 ledger row, no double-earn)', earnRows2[0].n === 1, `n=${earnRows2[0].n}`);

  // ── 6. Refresh CRM profile → RFM computed ──
  const refresh = await inj('POST', `/api/crm/profile/${memberId}/refresh`, mgr1);
  ok('Refresh profile → total_orders=1, rfm_segment=New', refresh.status === 200 && refresh.json.total_orders === 1 && refresh.json.rfm_segment === 'New', JSON.stringify(refresh.json));

  // ── 7. 360-degree customer view ──
  const view = await inj('GET', `/api/crm/profile/${memberId}`, mgr1);
  ok('360 view: member + crm profile + recent_orders', view.json.member?.id === memberId && view.json.crm?.rfm_segment === 'New' && Array.isArray(view.json.recent_orders) && view.json.recent_orders.length === 1, JSON.stringify({ seg: view.json.crm?.rfm_segment, orders: view.json.recent_orders?.length }));

  // ── 7a2. Real-time loyalty tick: the earn (channel confirm) published a loyalty_points event to BiLive ──
  const live1 = await inj('GET', '/api/bi/live/recent?limit=50', mgr1);
  const earnEv = (live1.json.events ?? []).find((e: any) => e.type === 'loyalty_points' && e.kind === 'earn' && e.member_id === memberId);
  ok('Real-time: earn published a loyalty_points tick (kind=earn, member_id, points>0) to the live feed',
    live1.status === 200 && !!earnEv && earnEv.points > 0, JSON.stringify({ found: !!earnEv, points: earnEv?.points }));
  // RLS: T2 (exec on its own tenant) never sees T1's loyalty tick on the tenant-filtered feed.
  const liveT2 = await inj('GET', '/api/bi/live/recent?limit=50', mgr2);
  ok('Real-time: T2 live feed excludes T1 loyalty_points ticks (tenant-filtered)',
    liveT2.status === 200 && !(liveT2.json.events ?? []).some((e: any) => e.type === 'loyalty_points' && e.member_id === memberId),
    JSON.stringify({ t2: (liveT2.json.events ?? []).filter((e: any) => e.type === 'loyalty_points').length }));

  // ── 7a3. Loyalty-scoped live feed (analytics tile source) shows the earn tick, tenant-filtered ──
  const loyLive = await inj('GET', '/api/loyalty/analytics/live?limit=12', mgr1);
  ok('Loyalty live feed: returns the earn tick (loyalty_points) for the caller tenant',
    loyLive.status === 200 && (loyLive.json.events ?? []).some((e: any) => e.kind === 'earn' && e.member_id === memberId), JSON.stringify({ n: (loyLive.json.events ?? []).length }));
  const loyLiveT2 = await inj('GET', '/api/loyalty/analytics/live?limit=12', mgr2);
  ok('Loyalty live feed: T2 sees none of T1 ticks', loyLiveT2.status === 200 && !(loyLiveT2.json.events ?? []).some((e: any) => e.member_id === memberId), JSON.stringify({ n: (loyLiveT2.json.events ?? []).length }));

  // ── 7b. RFM segment distribution (Customer Segmentation / Insights) ──
  const segs = await inj('GET', '/api/loyalty/analytics/segments', mgr1);
  const segList = (segs.json.segments ?? []) as { segment: string; members: number }[];
  const canon = ['Champions', 'Loyal', 'At Risk', 'Lost', 'New'];
  const hasCanon = canon.every((c) => segList.some((s) => s.segment === c));
  const newSeg = segList.find((s) => s.segment === 'New');
  ok('Segment mix: 5 canonical segments present, New has ≥1 member, profiled ≥1',
    segs.status === 200 && hasCanon && (newSeg?.members ?? 0) >= 1 && segs.json.profiled_members >= 1,
    JSON.stringify({ profiled: segs.json.profiled_members, new: newSeg?.members }));

  // ── 7c. RLS: T2 cannot see T1's segment aggregate ──
  const segs2 = await inj('GET', '/api/loyalty/analytics/segments', mgr2);
  ok('RLS: T2 segment mix excludes T1 members (profiled=0)', segs2.status === 200 && segs2.json.profiled_members === 0, JSON.stringify({ profiled: segs2.json.profiled_members }));

  // ── 7d. CDP / data export — bulk member snapshot with RFM + consent, tenant-scoped ──
  const exp = await inj('GET', '/api/crm/export?limit=100', mgr1);
  const expRow = (exp.json.members ?? []).find((m: any) => m.rfm_segment === 'New');
  ok('CDP export: member row carries identity + RFM segment + consent flags; total ≥ 1',
    exp.status === 200 && exp.json.total >= 1 && !!expRow && expRow.rfm_segment === 'New' && typeof expRow.consent?.marketing === 'boolean' && typeof expRow.consent?.line === 'boolean',
    JSON.stringify({ total: exp.json.total, seg: expRow?.rfm_segment, consent: expRow?.consent?.marketing }));
  // RLS: T2 export never includes T1 members (explicit tenant scope).
  const expT2 = await inj('GET', '/api/crm/export?limit=100', mgr2);
  ok('CDP export: T2 sees none of T1 members (tenant-scoped, total=0)', expT2.status === 200 && expT2.json.total === 0, JSON.stringify({ total: expT2.json.total }));
  // ICFR egress: the export wrote an append-only audit row (actor + row count).
  const auditRows = await db.select().from(s.auditLog).where(eq(s.auditLog.action, 'CRM.CDP_EXPORT'));
  ok('CDP export: an audit row was recorded (CRM.CDP_EXPORT with actor + row count)',
    auditRows.length >= 1 && auditRows.some((r: any) => r.actor === 'mgr1' && (r.meta?.rows ?? -1) >= 1),
    JSON.stringify({ n: auditRows.length, actor: auditRows.at(-1)?.actor }));

  // ── 7e. Scheduled CDP sync job — pushes the member snapshot to the CDP (mock when unconfigured) ──
  const cdpSub = await inj('POST', '/api/bi/subscriptions', mgr1, { name: 'CDP nightly', report_type: 'cdp_export_sync', frequency: 'daily' });
  const cdpRun = await inj('POST', `/api/bi/subscriptions/${cdpSub.json.id}/run`, mgr1);
  ok('CDP sync job: runs successfully, pushes the tenant member snapshot (1/1 to mock)',
    cdpRun.status === 200 && cdpRun.json.status === 'success' && /CDP sync/.test(cdpRun.json.summary ?? '') && /1\/1/.test(cdpRun.json.summary ?? ''),
    JSON.stringify({ status: cdpRun.json.status, summary: cdpRun.json.summary }));

  // ── 7f. Saved custom segments (Phase D1) — rule-builder over member/profile fields, resolve to members ──
  const segCat = await inj('GET', '/api/loyalty/saved-segments/catalog', mgr1);
  ok('Saved segments: catalog exposes whitelisted fields + operators',
    segCat.status === 200 && (segCat.json.fields ?? []).some((f: any) => f.key === 'segment') && (segCat.json.operators ?? []).includes('gte'),
    JSON.stringify({ fields: (segCat.json.fields ?? []).length }));
  const segCreate = await inj('POST', '/api/loyalty/saved-segments', mgr1, { name: 'New members', match_mode: 'all', rules: [{ field: 'segment', op: 'eq', value: 'New' }] });
  ok('Saved segments: create returns the segment + its rules', segCreate.status === 201 && segCreate.json.id > 0 && segCreate.json.rules?.[0]?.field === 'segment', JSON.stringify({ s: segCreate.status, id: segCreate.json.id }));
  const segMembers = await inj('GET', `/api/loyalty/saved-segments/${segCreate.json.id}/members`, mgr1);
  ok('Saved segments: resolve returns the matching members (New → the enrolled member)',
    segMembers.status === 200 && segMembers.json.total >= 1 && (segMembers.json.members ?? []).some((m: any) => m.id === memberId), JSON.stringify({ total: segMembers.json.total }));
  const segBad = await inj('POST', '/api/loyalty/saved-segments', mgr1, { name: 'bad', rules: [{ field: 'DROP TABLE', op: 'eq', value: 'x' }] });
  ok('Saved segments: an unknown field is rejected (whitelist → no SQLi)', segBad.status === 400 && (segBad.json?.error?.code === 'BAD_FIELD'), JSON.stringify({ s: segBad.status, code: segBad.json?.error?.code }));
  const segT2 = await inj('GET', `/api/loyalty/saved-segments/${segCreate.json.id}/members`, mgr2);
  ok('Saved segments: T2 cannot resolve a T1 segment (tenant-scoped, 404)', segT2.status === 404, JSON.stringify({ s: segT2.status }));

  // ── 7g. Saved segments as SEND audiences (Phase F1) — blast + campaign resolve through the rule engine ──
  // A second member who matches the segment but has opted out (consent must hold at send time).
  const optout = await inj('POST', '/api/loyalty/members', mgr1, { name: 'งดข่าวสาร', phone: '0809999911' });
  await db.insert(s.customerProfiles).values({ tenantId: t1, memberId: Number(optout.json.id), rfmSegment: 'New' }).onConflictDoNothing();
  await inj('PATCH', `/api/loyalty/members/${optout.json.id}`, mgr1, { marketing_opt_in: false });
  const segBlast = await inj('POST', '/api/messaging/blast', mgr1, { audience: 'saved_segment', segment_id: segCreate.json.id, channel: 'sms', body: 'โปรสำหรับกลุ่ม New' });
  ok('Saved-segment blast: targets only matching members and respects opt-out (2 targeted → 1 sent, 1 skipped)',
    (segBlast.status === 200 || segBlast.status === 201) && segBlast.json.targeted === 2 && segBlast.json.sent === 1 && segBlast.json.skipped === 1,
    JSON.stringify({ s: segBlast.status, t: segBlast.json.targeted, sent: segBlast.json.sent, sk: segBlast.json.skipped }));
  const segCamp = await inj('POST', '/api/loyalty/campaigns', mgr1, { name: 'Seg campaign', channel: 'sms', audience: 'saved_segment', saved_segment_id: segCreate.json.id, body: 'สวัสดีกลุ่ม New' });
  const segCampSend = await inj('POST', `/api/loyalty/campaigns/${segCamp.json.id}/send`, mgr1);
  ok('Saved-segment campaign: audience resolved at send time, PDPA opt-out skipped (2 targeted, 1 sent, 1 skipped)',
    segCamp.json.saved_segment_id === segCreate.json.id && segCampSend.json.targeted === 2 && segCampSend.json.sent === 1 && segCampSend.json.skipped === 1,
    JSON.stringify({ segId: segCamp.json.saved_segment_id, t: segCampSend.json.targeted, sent: segCampSend.json.sent, sk: segCampSend.json.skipped }));
  const segCampT2 = await inj('POST', '/api/loyalty/campaigns', mgr2, { name: 'steal', channel: 'sms', audience: 'saved_segment', saved_segment_id: segCreate.json.id, body: 'x' });
  ok('Saved-segment campaign: a T2 user cannot target a T1 segment (404 at create)', segCampT2.status === 404, JSON.stringify({ s: segCampT2.status, code: segCampT2.json?.error?.code }));

  // ── 7h. Scheduled RFM re-profiling (Phase F2) — a stale profile is re-bucketed; re-run is stable ──
  // Stale-ify the paying member's profile (simulates drift between orders), then bulk-refresh.
  await db.update(s.customerProfiles).set({ rfmSegment: 'Lost' }).where(and(eq(s.customerProfiles.tenantId, t1), eq(s.customerProfiles.memberId, memberId)));
  const bulkRefresh = await inj('POST', '/api/crm/profiles/refresh', mgr1, {});
  const profAfter = await inj('GET', `/api/crm/profile/${memberId}`, mgr1);
  ok('RFM bulk refresh: sweeps the active base and re-buckets a stale profile (Lost → New, changes counted)',
    bulkRefresh.status === 200 && bulkRefresh.json.profiled >= 2 && bulkRefresh.json.segment_changes >= 1 && profAfter.json.crm?.rfm_segment === 'New',
    JSON.stringify({ profiled: bulkRefresh.json.profiled, changes: bulkRefresh.json.segment_changes, seg: profAfter.json.crm?.rfm_segment }));
  // Scheduled surface: the crm_profile_refresh BI job runs the same sweep; a repeat run reports 0 changes.
  const rfmSub = await inj('POST', '/api/bi/subscriptions', mgr1, { name: 'RFM nightly', report_type: 'crm_profile_refresh', frequency: 'daily' });
  const rfmRun = await inj('POST', `/api/bi/subscriptions/${rfmSub.json.id}/run`, mgr1);
  ok('RFM refresh job (BI scheduler): repeat run succeeds and is stable — 0 segment changes (idempotent)',
    rfmRun.status === 200 && rfmRun.json.status === 'success' && /RFM refresh/.test(rfmRun.json.summary ?? '') && /0 segment change/.test(rfmRun.json.summary ?? ''),
    JSON.stringify({ status: rfmRun.json.status, summary: rfmRun.json.summary }));

  // ── 7i. Lifecycle journeys (Phase G1, MKT-12) — claim-first at-most-once steps, consent, frequency cap ──
  // Journey: step1 send now (wait 0), step2 send after 7 days. Cap: 1 msg / 7 days (step2 would be capped
  // anyway if it were due — the cap check is exercised separately below).
  const jny = await inj('POST', '/api/loyalty/journeys', mgr1, {
    name: 'Welcome series', trigger: 'manual', cap_messages: 2, cap_window_days: 7,
    steps: [
      { wait_days: 0, channel: 'sms', body: 'ยินดีต้อนรับ! รับส่วนลด 10%' },
      { wait_days: 7, channel: 'sms', body: 'ครบสัปดาห์แล้ว มาอีกนะ' },
    ],
  });
  await inj('POST', `/api/loyalty/journeys/${jny.json.id}/activate`, mgr1);
  const jEnroll = await inj('POST', `/api/loyalty/journeys/${jny.json.id}/enroll`, mgr1, { member_id: memberId });
  const jEnrollDup = await inj('POST', `/api/loyalty/journeys/${jny.json.id}/enroll`, mgr1, { member_id: memberId });
  ok('Journey: created + activated; enrol once (re-enrol is a no-op — once-per-member policy)',
    jny.json.code?.startsWith('JNY-') && jEnroll.json.enrolled === true && jEnrollDup.json.enrolled === false,
    JSON.stringify({ code: jny.json.code, first: jEnroll.json.enrolled, dup: jEnrollDup.json.enrolled }));

  const jRun1 = await inj('POST', '/api/loyalty/journeys/run-due', mgr1);
  const jRun2 = await inj('POST', '/api/loyalty/journeys/run-due', mgr1);
  const jLog1 = await db.select().from(s.messageLog).where(and(eq(s.messageLog.tenantId, t1), eq(s.messageLog.campaign, `journey:${jny.json.code}:1`)));
  ok('Journey run: step 1 sends exactly once (claim-first) — a re-run sends nothing and step 2 waits 7 days',
    jRun1.json.sent === 1 && jRun2.json.sent === 0 && jLog1.length === 1 && jLog1[0].status === 'sent',
    JSON.stringify({ run1: jRun1.json.sent, run2: jRun2.json.sent, logged: jLog1.length }));

  // Consent: the opted-out (but matching) member from 7g enrols, but the send is skipped + audited.
  await inj('POST', `/api/loyalty/journeys/${jny.json.id}/enroll`, mgr1, { member_id: Number(optout.json.id) });
  const jRun3 = await inj('POST', '/api/loyalty/journeys/run-due', mgr1);
  const jLogOptout = await db.select().from(s.messageLog).where(and(eq(s.messageLog.tenantId, t1), eq(s.messageLog.memberId, Number(optout.json.id)), eq(s.messageLog.campaign, `journey:${jny.json.code}:1`)));
  ok('Journey consent (MKT-12): opted-out member is skipped at the step, audited in message_log',
    jRun3.json.sent === 0 && jLogOptout.length === 1 && jLogOptout[0].status === 'skipped',
    JSON.stringify({ sent: jRun3.json.sent, status: jLogOptout[0]?.status }));

  // Frequency cap: a second journey (cap 1/7d, two zero-wait steps) — step 2 must be capped, audited.
  const jny2 = await inj('POST', '/api/loyalty/journeys', mgr1, {
    name: 'Burst test', trigger: 'manual', cap_messages: 1, cap_window_days: 7,
    steps: [
      { wait_days: 0, channel: 'sms', body: 'ข้อความที่หนึ่ง' },
      { wait_days: 0, channel: 'sms', body: 'ข้อความที่สอง (ต้องโดน cap)' },
    ],
  });
  await inj('POST', `/api/loyalty/journeys/${jny2.json.id}/activate`, mgr1);
  await inj('POST', `/api/loyalty/journeys/${jny2.json.id}/enroll`, mgr1, { member_id: memberId });
  await inj('POST', '/api/loyalty/journeys/run-due', mgr1); // step 1 sends (member's only journey msg in-window... plus jny step1: cap counts ALL journey msgs)
  const jRunCap = await inj('POST', '/api/loyalty/journeys/run-due', mgr1); // step 2 due (wait 0) → capped
  const jLogCap = await db.select().from(s.messageLog).where(and(eq(s.messageLog.tenantId, t1), eq(s.messageLog.memberId, memberId), eq(s.messageLog.campaign, `journey:${jny2.json.code}:2`)));
  ok('Journey frequency cap (MKT-12): over-cap step is skipped and audited (error: frequency cap)',
    jRunCap.json.sent === 0 && jLogCap.length === 1 && jLogCap[0].status === 'skipped' && jLogCap[0].error === 'frequency cap',
    JSON.stringify({ sent: jRunCap.json.sent, status: jLogCap[0]?.status, err: jLogCap[0]?.error }));

  // Tenant isolation: T2 cannot see or enrol into T1 journeys.
  const jT2List = await inj('GET', '/api/loyalty/journeys', mgr2);
  const jT2Enroll = await inj('POST', `/api/loyalty/journeys/${jny.json.id}/enroll`, mgr2, { member_id: memberId });
  ok('Journey tenant isolation: T2 sees no T1 journeys and cannot enrol into one (404)',
    (jT2List.json.journeys ?? []).length === 0 && jT2Enroll.status === 404,
    JSON.stringify({ t2n: (jT2List.json.journeys ?? []).length, s: jT2Enroll.status }));

  // ── 8. Personalized promos ──
  // Seed a promo + audience rule directly (no promo creation API in test scope)
  const [promo] = await db.insert(s.promotions).values({ tenantId: t1, promoId: 'NEWMEMBER10', promoName: 'ส่วนลดสมาชิกใหม่ 10%', promoType: 'percent', discountPct: '10', active: true }).returning({ id: s.promotions.id });
  const ruleRes = await inj('POST', '/api/crm/audience-rules', mgr1, { promo_id: Number(promo.id), rfm_segment: 'New' });
  ok('Audience rule created for New segment', ruleRes.status === 201 && ruleRes.json.rfm_segment === 'New', JSON.stringify(ruleRes.json));

  const promos = await inj('GET', `/api/crm/promos/${memberId}`, mgr1);
  ok('Personalized promos: segment=New, 1 promo returned (NEWMEMBER10)', promos.json.segment === 'New' && (promos.json.promos ?? []).length >= 1, JSON.stringify({ seg: promos.json.segment, n: promos.json.promos?.length }));

  // ── 9. Branch KPI dashboard ──
  const kpi = await inj('GET', '/api/crm/branch-kpi', mgr1);
  ok('Branch KPI: today.orders >= 1, revenue > 0', kpi.json.today?.orders >= 1 && kpi.json.today?.revenue > 0 && kpi.json.by_channel && Array.isArray(kpi.json.hourly_revenue), JSON.stringify({ orders: kpi.json.today?.orders, rev: kpi.json.today?.revenue }));

  // ── 10. RLS: T2 cannot see T1 member profile ──
  const t2View = await inj('GET', `/api/crm/profile/${memberId}`, mgr2);
  // T2 manager cannot see T1's member (member belongs to T1) — expect 404 or empty
  const t2Sees = t2View.json.member?.id === memberId;
  ok('RLS: T2 manager cannot see T1 member 360 profile', !t2Sees, `T2 saw T1 member: ${t2Sees}`);

  // ── 11. GL balanced (trial balance Dr=Cr) ──
  const tb = await inj('GET', '/api/ledger/trial-balance', admin);
  ok('Trial balance balanced after CRM order (Dr==Cr)', tb.json.totals?.balanced === true, JSON.stringify(tb.json.totals ?? {}));

  // ── Results ──
  await app.close();
  let pass = 0;
  for (const c of checks) {
    const sym = c.ok ? 'PASS' : 'FAIL';
    console.log(`  [${sym}] ${c.name}${c.detail ? `  →  ${c.detail}` : ''}`);
    if (c.ok) pass++;
  }
  console.log(`\n${pass}/${checks.length} checks passed`);
  if (pass < checks.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
