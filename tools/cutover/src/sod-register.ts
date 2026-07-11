/**
 * GRC-5 (ITGC-AC-22) — SoD-Conflict Register + Compensating-Control governance. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover sod-register
 *
 * Proves the DETECTIVE + accepted-risk-governance layer over the existing preventive SoD enforcement
 * (SOD_RULES / detectSodConflicts stay unchanged): the standing conflict dashboard surfaces the CURRENT
 * conflicts across the user population grouped by rule (who holds both sides); an accepted conflict REQUIRES
 * a compensating control + owner + expiry (else 422) and cannot be raised for a user who does not hold it
 * (NO_SUCH_CONFLICT); the detective "expired" worklist flags acceptances past expiry OR overdue for
 * re-review; a re-review stamps last_reviewed_at and clears the overdue flag; a non-privileged user is
 * denied; and dispositions are RLS-isolated per tenant.
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sod-register-secret';
process.env.NODE_ENV = 'test';

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
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T2', name: 'Tenant 2' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  const t2 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'T2')))[0].id);

  // Seed users directly (no forced password-change, unlike /api/admin/users). hqrev/t2rev are SoD-CLEAN
  // access-governance reviewers (AccessAdmin → holds only `users`, tenant-scoped, no RLS bypass). The
  // conflicted users hold BOTH sides of a rule via a per-user override: procurement+approvals ⇒ R07
  // (initiate + approve), md_vendor+creditors ⇒ R02 (maintain vendor + pay).
  await db.insert(s.users).values([
    { username: 'hqrev', passwordHash: await pw.hash('pw1234'), role: 'AccessAdmin', tenantId: hq },
    { username: 't2rev', passwordHash: await pw.hash('pw1234'), role: 'AccessAdmin', tenantId: t2 },
    { username: 'conflictu', passwordHash: await pw.hash('pw1234'), role: 'Warehouse', tenantId: hq },
    { username: 'conflictu2', passwordHash: await pw.hash('pw1234'), role: 'Warehouse', tenantId: hq },
    { username: 't2conf', passwordHash: await pw.hash('pw1234'), role: 'Warehouse', tenantId: t2 },
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  await db.insert(s.userPermissions).values([
    { userId: await uid('conflictu'), perm: 'procurement' }, { userId: await uid('conflictu'), perm: 'approvals' },
    { userId: await uid('conflictu2'), perm: 'md_vendor' }, { userId: await uid('conflictu2'), perm: 'creditors' },
    { userId: await uid('t2conf'), perm: 'procurement' }, { userId: await uid('t2conf'), perm: 'approvals' },
  ]).onConflictDoNothing();

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
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token;

  const hqrev = await login('hqrev', 'pw1234');
  const t2rev = await login('t2rev', 'pw1234');
  const conflictTok = await login('conflictu', 'pw1234');
  ok('Fixture users log in (hqrev/t2rev reviewers + conflicted user)', !!hqrev && !!t2rev && !!conflictTok);

  // ── 1. Standing dashboard surfaces the current conflicts grouped by rule ──
  const dash = await inj('GET', '/api/admin/sod/conflicts', hqrev);
  const groups: any[] = dash.json.conflicts_by_rule ?? [];
  const r07 = groups.find((g) => g.rule_id === 'R07');
  const r02 = groups.find((g) => g.rule_id === 'R02');
  ok('GET /conflicts groups by rule; R07 lists conflictu holding both sides; R02 lists conflictu2',
    dash.status === 200 && !!r07 && r07.users.some((u: any) => u.username === 'conflictu' && u.disposition_status === 'none') && !!r02 && r02.users.some((u: any) => u.username === 'conflictu2') && dash.json.summary.ungoverned_conflicts >= 2,
    JSON.stringify({ s: dash.status, rules: groups.map((g) => g.rule_id), ungoverned: dash.json.summary?.ungoverned_conflicts }));

  // ── 2. Accept WITHOUT a compensating control → 422 ──
  const noCC = await inj('POST', '/api/admin/sod/dispositions', hqrev, { rule_id: 'R07', username: 'conflictu' });
  ok('Accept without compensating_control/owner/expiry → 422 COMPENSATING_CONTROL_REQUIRED', noCC.status === 422 && noCC.json.error?.code === 'COMPENSATING_CONTROL_REQUIRED', JSON.stringify({ s: noCC.status, c: noCC.json.error?.code }));

  // ── 3. Accept a conflict a user does NOT hold → 422 NO_SUCH_CONFLICT ──
  const phantom = await inj('POST', '/api/admin/sod/dispositions', hqrev, { rule_id: 'R07', username: 'hqrev', compensating_control: 'x', owner: 'CFO', expiry_date: '2030-01-01' });
  ok('Accept a phantom conflict (user does not hold it) → 422 NO_SUCH_CONFLICT', phantom.status === 422 && phantom.json.error?.code === 'NO_SUCH_CONFLICT', JSON.stringify({ s: phantom.status, c: phantom.json.error?.code }));

  // ── 4. Accept conflictu R07 with a documented compensating control + owner + future expiry ──
  const acc = await inj('POST', '/api/admin/sod/dispositions', hqrev, { rule_id: 'R07', username: 'conflictu', compensating_control: 'Independent monthly review of all POs approved by this user by the Controller', owner: 'Controller', expiry_date: '2030-01-01', notes: 'Small team; interim acceptance.' });
  const accId = Number(acc.json.id);
  ok('Accept R07 for conflictu → accepted, acceptor recorded (accepted_by=hqrev), compensating control stored',
    acc.status === 201 || acc.status === 200 ? acc.json.accepted === true && acc.json.status === 'accepted' && acc.json.accepted_by === 'hqrev' && !!acc.json.compensating_control && !!accId : false,
    JSON.stringify({ s: acc.status, st: acc.json.status, by: acc.json.accepted_by, id: accId }));

  // ── 5. Dashboard now reflects the governance decision on that conflict ──
  const dash2 = await inj('GET', '/api/admin/sod/conflicts', hqrev);
  const r07b = (dash2.json.conflicts_by_rule ?? []).find((g: any) => g.rule_id === 'R07');
  ok('GET /conflicts now shows conflictu R07 disposition_status=accepted; accepted_conflicts ≥ 1',
    r07b?.users.some((u: any) => u.username === 'conflictu' && u.disposition_status === 'accepted') && dash2.json.summary.accepted_conflicts >= 1,
    JSON.stringify({ accepted: dash2.json.summary?.accepted_conflicts }));

  // ── 6. Accept conflictu2 R02 with a PAST expiry → the expired worklist flags past_expiry ──
  await inj('POST', '/api/admin/sod/dispositions', hqrev, { rule_id: 'R02', username: 'conflictu2', compensating_control: 'Vendor-master change report reviewed weekly', owner: 'AP Manager', expiry_date: '2020-01-01' });
  const exp1 = await inj('GET', '/api/admin/sod/dispositions/expired', hqrev);
  ok('GET /dispositions/expired flags the past-expiry R02 acceptance (reason past_expiry)',
    exp1.status === 200 && (exp1.json.dispositions ?? []).some((d: any) => d.rule_id === 'R02' && d.username === 'conflictu2' && d.expired_reason === 'past_expiry'),
    JSON.stringify({ s: exp1.status, count: exp1.json.count, reasons: (exp1.json.dispositions ?? []).map((d: any) => d.expired_reason) }));

  // ── 7. Backdate conflictu's last_reviewed_at → it becomes review_overdue on the worklist ──
  await db.update(s.sodConflictDispositions).set({ lastReviewedAt: new Date(Date.now() - 200 * 86400_000) }).where(eq(s.sodConflictDispositions.id, accId));
  const exp2 = await inj('GET', '/api/admin/sod/dispositions/expired', hqrev);
  ok('Overdue re-review (last_reviewed_at > 90d ago) flagged review_overdue',
    (exp2.json.dispositions ?? []).some((d: any) => d.id === accId && d.expired_reason === 'review_overdue'),
    JSON.stringify({ ids: (exp2.json.dispositions ?? []).map((d: any) => [d.id, d.expired_reason]) }));

  // ── 8. Re-review stamps last_reviewed_at and clears the overdue flag ──
  const rev = await inj('POST', `/api/admin/sod/dispositions/${accId}/review`, hqrev, { notes: 'Q re-review — control still operating', expiry_date: '2031-01-01' });
  const exp3 = await inj('GET', '/api/admin/sod/dispositions/expired', hqrev);
  const stillOverdue = (exp3.json.dispositions ?? []).some((d: any) => d.id === accId);
  ok('Re-review updates last_reviewed_at (recent) and clears the overdue flag',
    rev.status === 201 || rev.status === 200 ? rev.json.reviewed === true && new Date(rev.json.last_reviewed_at).getTime() > Date.now() - 60_000 && !stillOverdue : false,
    JSON.stringify({ s: rev.status, lr: rev.json.last_reviewed_at, stillOverdue }));

  // ── 9. A non-privileged user (no users/exec) is denied the register ──
  const denied = await inj('GET', '/api/admin/sod/conflicts', conflictTok);
  ok('Non-privileged user (procurement/approvals only) is denied /conflicts (403)', denied.status === 403, JSON.stringify({ s: denied.status }));

  // ── 10. RLS: a T2 disposition is invisible to an HQ reviewer ──
  await inj('POST', '/api/admin/sod/dispositions', t2rev, { rule_id: 'R07', username: 't2conf', compensating_control: 'T2 comp control', owner: 'T2 owner', expiry_date: '2030-06-01' });
  const hqList = await inj('GET', '/api/admin/sod/dispositions', hqrev);
  ok('RLS: T2 disposition (t2conf) not visible in the HQ register',
    hqList.status === 200 && !(hqList.json.dispositions ?? []).some((d: any) => d.username === 't2conf'),
    JSON.stringify({ hqUsers: (hqList.json.dispositions ?? []).map((d: any) => d.username) }));

  console.log('\n── GRC-5 (ITGC-AC-22) — SoD-Conflict Register + Compensating-Control governance (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} sod-register checks failed` : `\n✅ All ${checks.length} sod-register checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
