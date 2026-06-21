import { sql, eq, and } from 'drizzle-orm';
import { stockSnapshots } from './schema';

// latest snapshot date (แทน SELECT MAX(Generate_Date) ที่กระจายทั่ว V1)
export async function latestSnapshotDate(db: any): Promise<Date | null> {
  const r = await db.select({ d: sql<string>`max(${stockSnapshots.generateDate})` }).from(stockSnapshots);
  const v = r[0]?.d;
  return v ? new Date(v) : null;
}

// rows ที่ snapshot ล่าสุด (+ optional extra where)
export function atLatestSnapshot(snap: Date) {
  return eq(stockSnapshots.generateDate, snap);
}

// helper วันที่ (server clock — ตรงกับ V1 ที่ใช้ datetime.now())
export function ymd(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function monthStart(d = new Date()): string {
  return ymd(d).slice(0, 7) + '-01';
}
export const n = (v: unknown): number => Number(v ?? 0);
export { sql, eq, and };
