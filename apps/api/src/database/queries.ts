import { sql, eq, and } from 'drizzle-orm';
import { stockSnapshots } from './schema';
import { bizYmdDash } from '../common/bizdate';

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

// helper วันที่ — business timezone (Asia/Bangkok) so doc-day == accounting-day == period
// regardless of the server clock TZ. See common/bizdate.ts.
export function ymd(d = new Date()): string {
  return bizYmdDash(d);
}
export function monthStart(d = new Date()): string {
  return ymd(d).slice(0, 7) + '-01';
}
export const n = (v: unknown): number => Number(v ?? 0);
// Fixed-point serializer for numeric(_, scale) columns — avoids String(1e-7)='1e-7'
// (which numeric rejects) and clamps to the column's minor-unit scale.
export const fx = (v: unknown, scale = 2): string => (Number(v ?? 0)).toFixed(scale);
export { sql, eq, and };
