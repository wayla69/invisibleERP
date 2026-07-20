/**
 * Demo HR / payroll for the Invisible tenant: a staff roster (kitchen, service,
 * cashier, management), timesheets with overtime, leave requests, and posted
 * monthly payroll runs with per-employee payslips. Deterministic, idempotent.
 *
 * Requires the demo tenant: `pnpm --filter @ierp/api db:seed:demo`
 * Run: `pnpm --filter @ierp/api db:seed:demo:hr`
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray, sql } from 'drizzle-orm';
import * as schema from './schema';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try { (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p); } catch { /* ignore */ }
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(771177);
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const r2 = (x: number) => Math.round(x * 100) / 100;

// roster (name, position, department, monthly salary, pf rate)
const STAFF: [string, string, string, number, number][] = [
  ['ก้องเกียรติ วงศ์ไทย', 'ผู้จัดการร้าน (Store Manager)', 'บริหาร', 45000, 0.05],
  ['ทาคาชิ ยามาดะ', 'หัวหน้าเชฟ (Head Chef)', 'ครัว', 38000, 0.05],
  ['สมชาย ใจดี', 'เชฟซูชิ (Sushi Chef)', 'ครัว', 28000, 0.03],
  ['เคนจิ ซาโต้', 'เชฟซูชิ (Sushi Chef)', 'ครัว', 27000, 0.03],
  ['ก้อง แสงทอง', 'เชฟครัวร้อน (Hot-line Chef)', 'ครัว', 25000, 0.03],
  ['นภา ศรีสุข', 'เชฟครัวเย็น (Cold-line Chef)', 'ครัว', 24000, 0.03],
  ['มินต์ บุญมา', 'พนักงานเสิร์ฟ (Server)', 'บริการ', 15000, 0],
  ['ต้าร์ รุ่งเรือง', 'พนักงานเสิร์ฟ (Server)', 'บริการ', 15000, 0],
  ['ฝน อยู่เย็น', 'พนักงานเสิร์ฟ (Server)', 'บริการ', 14500, 0],
  ['แพรว ทองดี', 'พนักงานเสิร์ฟ (Server)', 'บริการ', 14500, 0],
  ['ไอซ์ เจริญสุข', 'แคชเชียร์ (Cashier)', 'แคชเชียร์', 16000, 0.03],
  ['พลอย มั่งมี', 'แคชเชียร์ (Cashier)', 'แคชเชียร์', 16000, 0.03],
  ['โอ๊ต ชื่นบาน', 'พนักงานล้างจาน (Steward)', 'ครัว', 13000, 0],
  ['แอน สุขใจ', 'พนักงานต้อนรับ (Host)', 'บริการ', 14000, 0],
];

// simplified-but-realistic payslip math (TH SSO 5% capped ฿750, PF by rate, light WHT)
function payslip(salary: number, pfRate: number, otHours: number, hourlyRate: number, unpaidDays: number) {
  const otPay = r2(otHours * hourlyRate * 1.5);
  const unpaid = r2(unpaidDays * (salary / 30));
  const gross = r2(salary + otPay - unpaid);
  const ssoBase = Math.min(Math.max(gross, 1650), 15000);
  const ssoEe = r2(ssoBase * 0.05), ssoEr = ssoEe;
  const pfEe = r2(salary * pfRate), pfEr = pfEe;
  const taxable = gross - ssoEe - pfEe;
  const wht = r2(taxable > 30000 ? taxable * 0.05 : taxable > 20000 ? taxable * 0.02 : 0);
  const net = r2(gross - ssoEe - pfEe - wht);
  return { otPay, unpaid, gross, ssoEe, ssoEr, pfEe, pfEr, wht, net };
}

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
    await tx.delete(schema.payslips).where(eq(schema.payslips.tenantId, T));
    await tx.delete(schema.payruns).where(eq(schema.payruns.tenantId, T));
    await tx.delete(schema.timesheets).where(eq(schema.timesheets.tenantId, T));
    await tx.delete(schema.leaveRequests).where(eq(schema.leaveRequests.tenantId, T));
    await tx.delete(schema.leaveBalances).where(eq(schema.leaveBalances.tenantId, T));
    await tx.delete(schema.timeClock).where(eq(schema.timeClock.tenantId, T));
    await tx.delete(schema.employees).where(eq(schema.employees.tenantId, T));

    // ── employees ──
    const now = Date.now();
    await tx.insert(schema.employees).values(STAFF.map((s, i) => ({
      tenantId: T, empCode: `EMP-${String(i + 1).padStart(3, '0')}`, name: s[0], position: s[1], department: s[2],
      monthlySalary: String(s[3]), hourlyRate: String(r2(s[3] / 30 / 8)), pfRate: String(s[4]), allowances: '0',
      ssoEligible: true, nationalId: `1${between(1000000000000, 1999999999999)}`.slice(0, 13),
      bankAccount: `${between(1000000000, 9999999999)}`, startDate: new Date(now - between(120, 1400) * 86400000).toISOString().slice(0, 10), active: true,
    })));
    const emps = await tx.select().from(schema.employees).where(eq(schema.employees.tenantId, T));

    // ── leave requests (a handful) ──
    const leaveRows: (typeof schema.leaveRequests.$inferInsert)[] = [];
    for (const e of emps) {
      if (rnd() < 0.4) {
        const type = (['annual', 'sick', 'personal', 'unpaid'] as const)[between(0, 3)];
        const from = new Date(now - between(3, 50) * 86400000);
        const days = between(1, 3);
        leaveRows.push({ tenantId: T, employeeId: e.id, leaveType: type, fromDate: from.toISOString().slice(0, 10),
          toDate: new Date(from.getTime() + (days - 1) * 86400000).toISOString().slice(0, 10), days: String(days),
          paid: type !== 'unpaid', status: rnd() < 0.8 ? 'Approved' : 'Pending', reason: 'ลาตามสิทธิ', createdBy: 'hr-demo' });
      }
    }
    if (leaveRows.length) await tx.insert(schema.leaveRequests).values(leaveRows);

    // ── timesheets (current month, with OT) ──
    const tsRows: (typeof schema.timesheets.$inferInsert)[] = [];
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
    const todayStr = fmt.format(new Date());
    const thisMonth = todayStr.slice(0, 7);
    const dom = Number(todayStr.slice(8, 10));
    const otByEmp = new Map<number, number>();
    for (const e of emps) {
      let ot = 0;
      for (let d = 1; d <= dom; d++) {
        if (rnd() < 0.18) continue; // day off
        const otH = rnd() < 0.3 ? between(1, 3) : 0; ot += otH;
        tsRows.push({ tenantId: T, employeeId: e.id, workDate: `${thisMonth}-${String(d).padStart(2, '0')}`, regularHours: '8', otHours: String(otH), createdBy: 'hr-demo' });
      }
      otByEmp.set(e.id, ot);
    }
    for (let i = 0; i < tsRows.length; i += 500) await tx.insert(schema.timesheets).values(tsRows.slice(i, i + 500));

    // ── payroll runs + payslips (last 2 months) ──
    const periods = [-1, 0].map((off) => { const dt = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)) - 1 + off, 1)); return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`; });
    let runs = 0, slips = 0;
    for (const period of periods) {
      const current = period === thisMonth;
      let gT = 0, eeT = 0, erT = 0, whtT = 0, netT = 0;
      const slipRows: (typeof schema.payslips.$inferInsert)[] = [];
      const [run] = await tx.insert(schema.payruns).values({ tenantId: T, period, status: 'Posted', headcount: emps.length, runBy: 'hr-demo', runAt: new Date() }).returning({ id: schema.payruns.id });
      for (const e of emps) {
        const salary = Number(e.monthlySalary), pfRate = Number(e.pfRate), hr = Number(e.hourlyRate);
        const ot = current ? (otByEmp.get(e.id) ?? 0) : between(0, 14);
        const unpaidDays = rnd() < 0.12 ? between(1, 2) : 0;
        const p = payslip(salary, pfRate, ot, hr, unpaidDays);
        gT += p.gross; eeT += p.ssoEe; erT += p.ssoEr; whtT += p.wht; netT += p.net;
        slipRows.push({ payrunId: run!.id, tenantId: T, employeeId: e.id, empCode: e.empCode, empName: e.name, nationalId: e.nationalId,
          gross: String(p.gross), otPay: String(p.otPay), unpaid: String(p.unpaid), ssoEmployee: String(p.ssoEe), ssoEmployer: String(p.ssoEr),
          pfEmployee: String(p.pfEe), pfEmployer: String(p.pfEr), wht: String(p.wht), net: String(p.net) });
      }
      await tx.insert(schema.payslips).values(slipRows);
      await tx.update(schema.payruns).set({ grossTotal: String(r2(gT)), ssoEeTotal: String(r2(eeT)), ssoErTotal: String(r2(erT)), whtTotal: String(r2(whtT)), netTotal: String(r2(netT)) }).where(eq(schema.payruns.id, run!.id));
      runs++; slips += slipRows.length;
    }

    console.log(`✅ HR/payroll seeded into tenant ${T}:`);
    console.log(`   ${emps.length} employees · ${tsRows.length} timesheet rows · ${leaveRows.length} leave requests`);
    console.log(`   ${runs} payroll runs (${periods.join(', ')}) · ${slips} payslips`);
  });
  await client.end();
}

main().catch((e) => { console.error('HR seed failed:', e); process.exit(1); });
