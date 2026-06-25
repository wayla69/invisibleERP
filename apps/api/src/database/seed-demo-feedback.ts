/**
 * Demo customer feedback for the Oshinei tenant: an NPS + a CSAT survey with
 * ~70 responses (skewed to promoters, realistic detractor tail) and structured
 * answers. Idempotent (responses/answers wiped by tenant; survey templates upserted).
 *
 * Requires the demo tenant: `pnpm --filter @ierp/api db:seed:demo`
 * Run: `pnpm --filter @ierp/api db:seed:demo:feedback`
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray, sql } from 'drizzle-orm';
import * as schema from './schema';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try { (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p); } catch { /* ignore */ }
}

const RESPONSES = 70;
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(246802);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const SURVEYS = [
  { surveyId: 'SVY-OSHINEI-NPS', surveyName: 'แบบสอบถามความพึงพอใจหลังรับประทาน (NPS)', surveyType: 'NPS', trigger: 'Post-Dining' },
  { surveyId: 'SVY-OSHINEI-CSAT', surveyName: 'ประเมินคุณภาพอาหารและบริการ (CSAT)', surveyType: 'CSAT', trigger: 'Post-Dining' },
];
const PROMOTER = ['อาหารสดมาก ปลาแซลมอนละลายในปาก! 🍣', 'บุฟเฟ่ต์คุ้มค่ามาก จะกลับมาอีกแน่นอน', 'บริการดีเยี่ยม พนักงานยิ้มแย้ม', 'Best Japanese buffet in town!', 'ซูชิสดใหม่ ราคาเป็นกันเอง'];
const PASSIVE = ['โดยรวมโอเค แต่รอคิวนานหน่อย', 'อาหารอร่อยดี แต่ร้านค่อนข้างแน่น', 'Good value, a bit noisy though'];
const DETRACTOR = ['รออาหารนานมาก เสิร์ฟช้า', 'บางจานเค็มไป', 'ที่จอดรถหายาก'];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    const tenant = (await tx.select().from(schema.tenants).where(eq(schema.tenants.code, 'OSHINEI')))[0];
    if (!tenant) throw new Error('OSHINEI tenant not found — run db:seed:demo first');
    const T = tenant.id;

    // ── survey templates (global; upsert) ──
    await tx.insert(schema.surveys).values(SURVEYS.map((s) => ({ ...s, active: true, createdAt: new Date() }))).onConflictDoNothing();

    // ── wipe prior responses for this tenant (answers first) ──
    const old = (await tx.select({ id: schema.surveyResponses.id }).from(schema.surveyResponses).where(eq(schema.surveyResponses.tenantId, T))).map((r) => r.id);
    if (old.length) for (let i = 0; i < old.length; i += 500) await tx.delete(schema.surveyAnswers).where(inArray(schema.surveyAnswers.responseId, old.slice(i, i + 500)));
    await tx.delete(schema.surveyResponses).where(eq(schema.surveyResponses.tenantId, T));

    // recent sale_nos to attach some responses to
    const saleNos = (await tx.select({ n: schema.custPosSales.saleNo }).from(schema.custPosSales).where(eq(schema.custPosSales.tenantId, T)).limit(400)).map((r) => r.n);
    const now = Date.now();

    // ── responses (skewed to promoters) ──
    let answers = 0;
    for (let i = 0; i < RESPONSES; i++) {
      const roll = rnd();
      const nps = roll < 0.6 ? between(9, 10) : roll < 0.85 ? between(7, 8) : between(2, 6);
      const comment = nps >= 9 ? pick(PROMOTER) : nps >= 7 ? pick(PASSIVE) : pick(DETRACTOR);
      const [resp] = await tx.insert(schema.surveyResponses).values({
        surveyId: 'SVY-OSHINEI-NPS', tenantId: T, orderNo: saleNos.length ? pick(saleNos) : null,
        responseDate: new Date(now - between(0, 45) * 86400000).toISOString().slice(0, 10), npsScore: nps, comments: comment,
      }).returning({ id: schema.surveyResponses.id });
      if (rnd() < 0.6) {
        await tx.insert(schema.surveyAnswers).values([
          { responseId: resp.id, questionNo: 1, answer: `คุณภาพอาหาร: ${nps >= 8 ? 'ดีมาก' : nps >= 6 ? 'พอใช้' : 'ควรปรับปรุง'}` },
          { responseId: resp.id, questionNo: 2, answer: `ความเร็วบริการ: ${nps >= 8 ? 'รวดเร็ว' : 'ปานกลาง'}` },
        ]);
        answers += 2;
      }
    }

    const promoters = await tx.select({ c: sql<number>`count(*)::int` }).from(schema.surveyResponses).where(sql`${schema.surveyResponses.tenantId} = ${T} and ${schema.surveyResponses.npsScore} >= 9`);
    const detractors = await tx.select({ c: sql<number>`count(*)::int` }).from(schema.surveyResponses).where(sql`${schema.surveyResponses.tenantId} = ${T} and ${schema.surveyResponses.npsScore} <= 6`);
    const nps = Math.round(((Number(promoters[0].c) - Number(detractors[0].c)) / RESPONSES) * 100);
    console.log(`✅ Feedback seeded into tenant ${T}:`);
    console.log(`   ${SURVEYS.length} surveys · ${RESPONSES} responses · ${answers} structured answers`);
    console.log(`   NPS ≈ ${nps} (promoters ${promoters[0].c} − detractors ${detractors[0].c})`);
  });
  await client.end();
}

main().catch((e) => { console.error('Feedback seed failed:', e); process.exit(1); });
