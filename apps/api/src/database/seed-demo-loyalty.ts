/**
 * Demo loyalty / CRM for the Invisible tenant: tiers, ~150 members with point
 * balances + ledger, a rewards catalogue and a few campaigns. Lights up the
 * CRM and Loyalty modules. Deterministic (seeded PRNG), idempotent.
 *
 * Requires the demo tenant: `pnpm --filter @ierp/api db:seed:demo`
 * Run: `pnpm --filter @ierp/api db:seed:demo:loyalty`
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray, sql } from 'drizzle-orm';
import * as schema from './schema';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try { (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p); } catch { /* ignore */ }
}

const MEMBERS = 150;
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(424242);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const r2 = (x: number) => Math.round(x * 100) / 100;

const FIRST = ['สมชาย', 'สมหญิง', 'นภา', 'ก้อง', 'มินต์', 'ฝน', 'ต้าร์', 'แอน', 'บีม', 'ปอนด์', 'ใบเฟิร์น', 'กวาง', 'โอ๊ต', 'แพรว', 'ตูน', 'จอย', 'นัท', 'เบนซ์', 'ปาล์ม', 'ไอซ์', 'ฟ้า', 'มาย', 'กัน', 'พลอย'];
const LAST = ['ใจดี', 'รุ่งเรือง', 'ศรีสุข', 'วงศ์ไทย', 'แสงทอง', 'บุญมา', 'สุขใจ', 'พงษ์ไพร', 'มั่งมี', 'เจริญสุข', 'ทองดี', 'อยู่เย็น', 'ศักดิ์ดา', 'ชื่นบาน'];

const TIERS = [
  { tier: 'Standard', min: 0, earn: 1.0, sort: 1 },
  { tier: 'Silver', min: 2000, earn: 1.25, sort: 2 },
  { tier: 'Gold', min: 8000, earn: 1.5, sort: 3 },
  { tier: 'Platinum', min: 20000, earn: 2.0, sort: 4 },
];
const tierFor = (lt: number) => [...TIERS].reverse().find((t) => lt >= t.min)!.tier;

const REWARDS = [
  { code: 'RWD-001', name: 'ส่วนลด 50 บาท', type: 'discount', cost: 500, kind: 'amount', val: 50, tierMin: null },
  { code: 'RWD-002', name: 'ของหวานญี่ปุ่นฟรี 1 ที่', type: 'product', cost: 300, kind: 'free_item', val: 60, tierMin: null },
  { code: 'RWD-003', name: 'ส่วนลด 10% ทั้งบิล', type: 'discount', cost: 800, kind: 'percent', val: 10, tierMin: null },
  { code: 'RWD-004', name: 'บุฟเฟ่ต์ลด 100 บาท', type: 'discount', cost: 1000, kind: 'amount', val: 100, tierMin: 2000 },
  { code: 'RWD-005', name: 'เครื่องดื่มฟรี 1 แก้ว', type: 'product', cost: 200, kind: 'free_item', val: 45, tierMin: null },
  { code: 'RWD-006', name: 'ส่วนลด VIP 20% (Gold+)', type: 'discount', cost: 2000, kind: 'percent', val: 20, tierMin: 8000 },
];

const CAMPAIGNS = [
  { code: 'CMP-001', name: 'อวยพรวันเกิด รับ 2 เท่า', channel: 'line', audience: 'birthdays_today', body: 'สุขสันต์วันเกิด! รับแต้ม 2 เท่าทั้งเดือนเกิดของคุณ 🎂', status: 'sent', targeted: 12 },
  { code: 'CMP-002', name: 'Gold/Platinum x2 points สุดสัปดาห์', channel: 'line', audience: 'tier', tier: 'Gold', body: 'สมาชิก Gold ขึ้นไป รับแต้ม 2 เท่า ศุกร์-อาทิตย์นี้', status: 'sent', targeted: 28 },
  { code: 'CMP-003', name: 'สงกรานต์ลดทั้งร้าน', channel: 'sms', audience: 'all', body: 'ฉลองสงกรานต์ บุฟเฟ่ต์ลดทันที 15% 13-15 เม.ย.', status: 'sent', targeted: 150 },
  { code: 'CMP-004', name: 'ดึงลูกค้าห่างหาย', channel: 'sms', audience: 'segment', segment: 'At Risk', body: 'คิดถึงคุณ! กลับมาทานพร้อมรับส่วนลด 100 บาท', status: 'scheduled', targeted: 0 },
  { code: 'CMP-005', name: 'เปิดเมนูใหม่ฤดูใบไม้ผลิ', channel: 'line', audience: 'all', body: 'เมนูใหม่ซากุระซีซั่นมาแล้ว! มาลองก่อนใคร', status: 'draft', targeted: 0 },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    const tenant = (await tx.select().from(schema.tenants).where(eq(schema.tenants.code, 'INVISIBLE')))[0];
    if (!tenant) throw new Error('INVISIBLE tenant not found — run db:seed:demo first');
    const T = tenant.id;

    // ── wipe (FK-safe) ──
    const memIds = (await tx.select({ id: schema.posMembers.id }).from(schema.posMembers).where(eq(schema.posMembers.tenantId, T))).map((m) => m.id);
    if (memIds.length) {
      for (let i = 0; i < memIds.length; i += 500) {
        const chunk = memIds.slice(i, i + 500);
        await tx.delete(schema.loyaltyRedemptions).where(inArray(schema.loyaltyRedemptions.memberId, chunk));
        await tx.delete(schema.memberCoupons).where(inArray(schema.memberCoupons.memberId, chunk));
        await tx.delete(schema.posMemberLedger).where(inArray(schema.posMemberLedger.memberId, chunk));
      }
    }
    await tx.delete(schema.messageLog).where(eq(schema.messageLog.tenantId, T));
    await tx.delete(schema.posMembers).where(eq(schema.posMembers.tenantId, T));
    await tx.delete(schema.loyaltyRewards).where(eq(schema.loyaltyRewards.tenantId, T));
    await tx.delete(schema.loyaltyCampaigns).where(eq(schema.loyaltyCampaigns.tenantId, T));
    await tx.delete(schema.loyaltyTiers).where(eq(schema.loyaltyTiers.tenantId, T));

    // ── tiers ──
    await tx.insert(schema.loyaltyTiers).values(TIERS.map((t) => ({ tenantId: T, tier: t.tier, minLifetime: String(t.min), earnMult: String(t.earn), redeemMult: '1', sort: t.sort, active: true })));

    // ── members + ledger ──
    const now = Date.now();
    const memberRows = [] as (typeof schema.posMembers.$inferInsert)[];
    for (let i = 1; i <= MEMBERS; i++) {
      const lifetime = Math.round(Math.pow(rnd(), 4.5) * 26000);          // skewed low (realistic pyramid)
      const balance = Math.round(lifetime * (0.2 + rnd() * 0.4));          // some redeemed
      const enrolled = new Date(now - between(10, 720) * 86400000);
      const hasBday = rnd() < 0.55;
      memberRows.push({
        tenantId: T, memberCode: `M-${String(i).padStart(6, '0')}`,
        name: `${pick(FIRST)} ${pick(LAST)}`, phone: `08${between(10000000, 99999999)}`,
        cardNo: rnd() < 0.6 ? `OSH${String(100000 + i)}` : null,
        email: rnd() < 0.35 ? `member${i}@example.com` : null,
        birthday: hasBday ? `19${between(70, 99)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}` : null,
        marketingOptIn: rnd() < 0.85, balance: String(balance), lifetime: String(lifetime),
        tier: tierFor(lifetime), active: rnd() < 0.95, enrolledAt: enrolled, createdBy: 'loyalty-demo',
      });
    }
    const inserted = [];
    for (let i = 0; i < memberRows.length; i += 200) {
      const rows = await tx.insert(schema.posMembers).values(memberRows.slice(i, i + 200)).returning({ id: schema.posMembers.id, lifetime: schema.posMembers.lifetime, balance: schema.posMembers.balance, code: schema.posMembers.memberCode });
      inserted.push(...rows);
    }
    const ledger = [] as (typeof schema.posMemberLedger.$inferInsert)[];
    for (const m of inserted) {
      const lt = Number(m.lifetime), bal = Number(m.balance);
      ledger.push({ tenantId: T, memberId: m.id, txnType: 'Earn', points: String(lt), balanceAfter: String(lt), refDoc: 'enroll+POS', notes: 'lifetime points earned', createdBy: 'loyalty-demo' });
      if (bal < lt) ledger.push({ tenantId: T, memberId: m.id, txnType: 'Redeem', points: String(-(lt - bal)), redeemValue: String(r2((lt - bal) / 10)), balanceAfter: String(bal), refDoc: `RDM-${m.code}`, notes: 'reward redemptions', createdBy: 'loyalty-demo' });
    }
    for (let i = 0; i < ledger.length; i += 500) await tx.insert(schema.posMemberLedger).values(ledger.slice(i, i + 500));

    // ── rewards ──
    await tx.insert(schema.loyaltyRewards).values(REWARDS.map((r) => ({ tenantId: T, rewardCode: r.code, name: r.name, type: r.type, pointCost: String(r.cost), cashValue: String(r.val), couponKind: r.kind, couponValue: String(r.val), perMemberLimit: 2, tierMin: r.tierMin != null ? String(r.tierMin) : null, active: true, createdBy: 'loyalty-demo' })));

    // ── campaigns ──
    await tx.insert(schema.loyaltyCampaigns).values(CAMPAIGNS.map((c) => ({
      tenantId: T, campaignCode: c.code, name: c.name, channel: c.channel, audience: c.audience,
      segment: c.segment ?? null, tier: c.tier ?? null, body: c.body, status: c.status,
      targeted: c.targeted, sentCount: c.status === 'sent' ? c.targeted : 0,
      sentAt: c.status === 'sent' ? new Date(now - between(2, 40) * 86400000) : null, createdBy: 'loyalty-demo',
    })));

    const byTier = inserted.reduce((acc, m) => { const t = tierFor(Number(m.lifetime)); acc[t] = (acc[t] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    console.log(`✅ Loyalty seeded into tenant ${T}:`);
    console.log(`   ${inserted.length} members (${Object.entries(byTier).map(([k, v]) => `${k} ${v}`).join(', ')}) · ${ledger.length} ledger rows`);
    console.log(`   ${REWARDS.length} rewards · ${CAMPAIGNS.length} campaigns · ${TIERS.length} tiers`);
  });
  await client.end();
}

main().catch((e) => { console.error('Loyalty seed failed:', e); process.exit(1); });
