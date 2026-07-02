/**
 * C12 — LINE marketing automation (closed loop): behaviour trigger → per-member coupon push over LINE
 * (consent-respecting) → redemption tracked back to the sale → attribution report. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover line-automation
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'la-secret';
process.env.NODE_ENV = 'test';
process.env.LINE_CHANNEL_TOKEN = 'test-line-token'; // LINE gateway "configured" → real(stubbed) push

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
import { bucketPct } from '../../../apps/api/dist/modules/marketing/marketing-automation.service';
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

  // members: lapsed (LINE, opted-in) / active (not lapsed) / opted-out / no-LINE / at-risk (winback)
  const mk = async (code: string, line: string | null, optIn: boolean, recency: number, segment: string) => {
    const [m] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: code, name: code, lineUserId: line, marketingOptIn: optIn, active: true, balance: '0' }).returning({ id: s.posMembers.id });
    await db.insert(s.customerProfiles).values({ memberId: Number(m.id), rfmRecency: recency, rfmSegment: segment });
    return Number(m.id);
  };
  const lapsedId = await mk('M-LAPSED', 'Ulapsed', true, 45, 'At Risk');
  await mk('M-ACTIVE', 'Uactive', true, 5, 'Champions');
  await mk('M-OPTOUT', 'Uoptout', false, 60, 'Lost');
  await mk('M-NOLINE', null, true, 90, 'Lost');

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const token = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'boss', password: 'pw' } })).json().token;
  const inj = async (m: string, url: string, payload?: any) => { const r = await app.inject({ method: m as any, url, headers: { authorization: `Bearer ${token}` }, payload }); let j: any = {}; try { j = r.json(); } catch { /* */ } return { status: r.statusCode, json: j }; };

  // ── 1. run a lapsed campaign: opted-in LINE member sent, opted-out skipped, no-LINE failed ──
  linePushes.length = 0;
  const run = await inj('POST', '/api/marketing/automation/campaigns', { name: 'Win them back', trigger: 'lapsed', channel: 'line', discount_type: 'amount', discount_value: 100, lapsed_days: 30 });
  ok('lapsed campaign: 3 targeted → 1 sent (opted-in LINE), 1 skipped (opt-out), 1 failed (no LINE)',
    run.json.targeted === 3 && run.json.sent === 1 && run.json.skipped === 1 && run.json.failed === 1,
    JSON.stringify({ t: run.json.targeted, s: run.json.sent, sk: run.json.skipped, f: run.json.failed }));
  const campaignId = run.json.campaign_id;

  // ── 2. the coupon was pushed over LINE to the member's LINE userId ──
  const push = linePushes.find((p) => p.to === 'Ulapsed');
  const coupon = (push?.text.match(/LAPSED-\d+-[A-Z0-9]+/) ?? [])[0];
  ok('LINE push: coupon delivered to the member LINE userId (Bearer token)', !!push && push.auth === 'Bearer test-line-token' && !!coupon, JSON.stringify({ to: push?.to, coupon }));

  // ── 3. close the loop: redeem the coupon against a sale ──
  const red = await inj('POST', '/api/marketing/automation/redeem', { coupon_code: coupon, sale_no: 'SALE-1', value: 100 });
  ok('redeem: coupon → redeemed, value 100, linked to the campaign + member',
    red.json.redeemed === true && red.json.redeemed_value === 100 && red.json.campaign_id === campaignId && red.json.member_id === lapsedId,
    JSON.stringify({ red: red.json.redeemed, val: red.json.redeemed_value }));

  // ── 4. redemption is idempotent (re-presenting the coupon doesn't double-count) ──
  const red2 = await inj('POST', '/api/marketing/automation/redeem', { coupon_code: coupon, sale_no: 'SALE-2', value: 100 });
  ok('redeem idempotent: re-presented coupon → already_redeemed (no double count)', red2.json.already_redeemed === true, JSON.stringify({ again: red2.json.already_redeemed }));

  // ── 5. closed-loop report: redemption rate + attributed revenue ──
  const rep = await inj('GET', `/api/marketing/automation/campaigns/${campaignId}`);
  ok('report: 1 sent, 1 redeemed → 100% redemption, ฿100 attributed revenue',
    rep.json.sent === 1 && rep.json.redeemed === 1 && rep.json.redemption_rate_pct === 100 && rep.json.attributed_revenue === 100,
    JSON.stringify({ sent: rep.json.sent, redeemed: rep.json.redeemed, rate: rep.json.redemption_rate_pct, rev: rep.json.attributed_revenue }));

  // ── 6. winback audience targets the RFM At-Risk/Lost segments (preview, no send) ──
  const prev = await inj('POST', '/api/marketing/automation/preview', { trigger: 'winback', channel: 'line' });
  ok('winback preview: At-Risk/Lost members targeted (reachable = opted-in + LINE-linked)', prev.json.audience >= 2 && prev.json.reachable >= 1, JSON.stringify(prev.json));

  // ── 7. unknown coupon → 404 ──
  const bad = await inj('POST', '/api/marketing/automation/redeem', { coupon_code: 'NOPE-1-XXXXX' });
  ok('redeem unknown coupon → 404 COUPON_NOT_FOUND', bad.status === 404 && bad.json.error?.code === 'COUPON_NOT_FOUND', JSON.stringify({ s: bad.status }));

  // ── 8. A/B + holdout (G2): holdout gets NO message and NO coupon — the control-group baseline ──
  for (let i = 0; i < 36; i++) await mk(`M-AB${i}`, `Uab${i}`, true, 5, 'Loyal');
  linePushes.length = 0;
  const ab = await inj('POST', '/api/marketing/automation/campaigns', { name: 'AB test', trigger: 'all', channel: 'line', discount_type: 'amount', discount_value: 50, variant_b_body: '🔥 ดีลพิเศษเฉพาะคุณ', split_b_pct: 30, holdout_pct: 30 });
  const abId = ab.json.campaign_id;
  const abSends = await db.select().from(s.campaignSends).where(eq(s.campaignSends.campaignId, abId));
  const holdRows = abSends.filter((r: any) => r.variant === 'holdout');
  ok('A/B+holdout: holdout members recorded with no coupon/recipient and NO gateway call (pushes == sent)',
    ab.json.holdout > 0 && holdRows.length === ab.json.holdout && holdRows.every((r: any) => r.status === 'holdout' && r.couponCode == null && r.recipient == null) && linePushes.length === ab.json.sent,
    JSON.stringify({ holdout: ab.json.holdout, sent: ab.json.sent, pushes: linePushes.length }));

  // ── 9. assignment is DETERMINISTIC — every recorded variant re-derives from bucketPct(campaign, member) ──
  const expectVariant = (memberId: number) => { const p = bucketPct(abId, memberId); return p < 30 ? 'holdout' : p < 60 ? 'B' : 'A'; };
  const mismatches = abSends.filter((r: any) => r.variant !== expectVariant(Number(r.memberId)));
  const bSeen = linePushes.some((p) => p.text.includes('ดีลพิเศษเฉพาะคุณ'));
  const aSeen = linePushes.some((p) => p.text.includes('ส่วนลดพิเศษ'));
  ok('A/B assignment deterministic (hash-derived, no RNG); variant B body actually delivered alongside A',
    mismatches.length === 0 && aSeen && bSeen,
    JSON.stringify({ mismatches: mismatches.length, aSeen, bSeen }));

  // ── 10. per-group report: A/B tallies, holdout count, honest lift framing; a B redemption lands in B ──
  const bSend = abSends.find((r: any) => r.variant === 'B' && r.status === 'sent');
  await inj('POST', '/api/marketing/automation/redeem', { coupon_code: bSend!.couponCode, sale_no: 'SALE-AB', value: 50 });
  const abRep = await inj('GET', `/api/marketing/automation/campaigns/${abId}`);
  ok('report: per-group A/B tallies + holdout count + lift note; the B redemption is attributed to group B',
    abRep.json.ab != null && abRep.json.ab.b.redeemed === 1 && abRep.json.ab.a.redeemed === 0 && abRep.json.ab.holdout.count === ab.json.holdout && typeof abRep.json.ab.lift_note === 'string' && abRep.json.ab.b.attributed_revenue === 50,
    JSON.stringify({ b: { sent: abRep.json.ab?.b?.sent, red: abRep.json.ab?.b?.redeemed, rev: abRep.json.ab?.b?.attributed_revenue }, hold: abRep.json.ab?.holdout?.count }));

  // ── 11. Organic-purchase baseline (H2): actual paid orders per group inside the attribution window ──
  // One HOLDOUT member buys in-window (the organic baseline), one messaged member buys in-window, and one
  // messaged member bought BEFORE the send (out-of-window ⇒ must not count).
  const holdMember = Number(holdRows[0].memberId);
  const sentRows = abSends.filter((r: any) => r.status === 'sent');
  const msgIn = Number(sentRows[0].memberId), msgOut = Number(sentRows[1].memberId);
  await db.insert(s.dineInOrders).values([
    { orderNo: 'DIN-H2-HOLD', tenantId: t1, memberId: holdMember, saleNo: 'SALE-H2-1', total: '300', openedAt: new Date(), channel: 'web' },
    { orderNo: 'DIN-H2-MSG', tenantId: t1, memberId: msgIn, saleNo: 'SALE-H2-2', total: '500', openedAt: new Date(), channel: 'web' },
    { orderNo: 'DIN-H2-OLD', tenantId: t1, memberId: msgOut, saleNo: 'SALE-H2-3', total: '999', openedAt: new Date(Date.now() - 5 * 86_400_000), channel: 'web' },
  ]);
  const orgRep = await inj('GET', `/api/marketing/automation/campaigns/${abId}`);
  const org = orgRep.json.organic;
  ok('organic baseline: holdout member\'s real purchase counted as the do-nothing baseline (window 30d)',
    org != null && org.window_days === 30 && org.holdout.purchasers === 1 && org.holdout.order_revenue === 300 && org.holdout.members === ab.json.holdout,
    JSON.stringify({ w: org?.window_days, hp: org?.holdout?.purchasers, hrev: org?.holdout?.order_revenue }));
  ok('organic baseline: pre-send order excluded — messaged group counts only the in-window purchaser',
    org?.messaged?.purchasers === 1 && org?.messaged?.order_revenue === 500,
    JSON.stringify({ mp: org?.messaged?.purchasers, mrev: org?.messaged?.order_revenue }));
  ok('organic lift: purchase-rate delta (messaged − holdout, pp) + scaled incremental revenue reported with group sizes',
    org?.organic_lift != null && typeof org.organic_lift.purchase_rate_pp === 'number' && typeof org.organic_lift.incremental_revenue === 'number' && org.messaged.members > 0 && org.holdout.members > 0 && typeof org.note === 'string',
    JSON.stringify(org?.organic_lift));

  // ── V3 (docs/29): significance — tiny groups can never claim "real"; a strong big-sample effect can ──
  const orgSig = org?.organic_lift?.significance;
  ok('V3 significance: the small-group organic lift is honestly UNDERPOWERED (never significant)',
    orgSig != null && orgSig.significant === false && String(orgSig.verdict).includes('underpowered') && orgSig.stats_version === 'v1' && Array.isArray(orgSig.ci95_pp),
    JSON.stringify(orgSig));
  // Seed a synthetic large A/B: A 40 sent / 30 redeemed vs B 40 sent / 5 redeemed → p ≪ .05, CI excludes 0.
  const [bigCamp] = await db.insert(s.automationCampaigns).values({ tenantId: t1, name: 'V3 big', trigger: 'all', channel: 'line', discountType: 'amount', discountValue: '10', status: 'sent', splitBPct: 50, holdoutPct: 0, windowDays: 30 }).returning({ id: s.automationCampaigns.id });
  const bigRows: any[] = [];
  for (let i = 0; i < 40; i++) {
    bigRows.push({ tenantId: t1, campaignId: Number(bigCamp.id), memberId: null, variant: 'A', status: 'sent', couponCode: `V3A-${i}`, sentAt: new Date(), redeemedAt: i < 30 ? new Date() : null, redeemedValue: i < 30 ? '10' : null });
    bigRows.push({ tenantId: t1, campaignId: Number(bigCamp.id), memberId: null, variant: 'B', status: 'sent', couponCode: `V3B-${i}`, sentAt: new Date(), redeemedAt: i < 5 ? new Date() : null, redeemedValue: i < 5 ? '10' : null });
  }
  await db.insert(s.campaignSends).values(bigRows);
  const bigRep = await inj('GET', `/api/marketing/automation/campaigns/${Number(bigCamp.id)}`);
  const abSig = bigRep.json.ab?.ab_significance;
  ok('V3 significance: a strong 40v40 A/B effect (75% vs 12.5%) is REAL — p < .05, 95% CI excludes zero, verdict "real"',
    abSig != null && abSig.significant === true && abSig.verdict === 'real' && abSig.p_value < 0.05 && (abSig.ci95_pp[0] > 0 || abSig.ci95_pp[1] < 0) && abSig.delta_pp === 62.5,
    JSON.stringify(abSig));

  console.log('\n── C12 — LINE marketing automation (closed loop) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} line-automation checks failed` : `\n✅ All ${checks.length} line-automation checks passed`);
  globalThis.fetch = realFetch;
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
