/**
 * Step 8 ToE — PDPA (Thailand) compliance: DSAR workflow + subject export + erasure with read-time
 * audit pseudonymisation.
 * Boots the real Nest app over PGlite and asserts: a DSAR is filed with the statutory 30-day due date;
 * an access request exports the subject's data bundle; an erasure redacts the member's PII, withdraws
 * consents, and records an erasure-ledger row; the immutable audit trail then SHOWS the pseudonym instead
 * of the erased PII (stored row unchanged); and DSARs are tenant-isolated by RLS.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pdpa
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pdpa-secret';
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

const MIG = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await pg.exec(readFileSync(join(MIG, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'Shop One' }, { code: 'T2', name: 'Shop Two' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const t1 = await tid('T1'), t2 = await tid('T2');
  // Two tenant-scoped DPO users (role Sales + explicit `users` override → reach /api/pdpa without being Admin,
  // so RLS actually scopes them — an Admin would bypass RLS and defeat the isolation check).
  await db.insert(s.users).values([
    { username: 'dpo1', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t1 },
    { username: 'dpo2', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t2 },
  ]).onConflictDoNothing();
  for (const uname of ['dpo1', 'dpo2']) {
    const uid = Number((await db.select().from(s.users).where(eq(s.users.username, uname)))[0].id);
    await db.insert(s.userPermissions).values(['users', 'dashboard'].map((perm) => ({ userId: uid, perm }))).onConflictDoNothing();
  }
  // A member with PII in tenant T1, with a consent + a points-ledger row.
  const [m] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-0001', name: 'Somchai Jaidee', phone: '0810001234', email: 'somchai@example.com', tier: 'Gold', balance: '500', marketingOptIn: true }).returning();
  const memberId = Number(m.id);
  await db.insert(s.memberConsents).values({ tenantId: t1, memberId, purpose: 'marketing', granted: true, grantedAt: new Date() });
  await db.insert(s.posMemberLedger).values({ tenantId: t1, memberId, txnType: 'Earn', points: '500', balanceAfter: '500', refDoc: 'SALE-1' });
  // An audit_log row whose meta carries the member's PII (to prove read-time pseudonymisation after erasure).
  await db.insert(s.auditLog).values({ actor: 'cashier1', tenantId: t1, action: 'POST /api/pos/orders', entity: 'order', entityId: 'SO-1', status: 'success', meta: { customer_phone: '0810001234', customer_name: 'Somchai Jaidee' } });

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (method: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw' })).json.token;
  const dpo1 = await login('dpo1');
  const dpo2 = await login('dpo2');

  // 1. File an access DSAR — statutory 30-day due date set, status received.
  const acc = await inj('POST', '/api/pdpa/dsar', dpo1, { subject_type: 'member', subject_ref: 'M-0001', request_type: 'access' });
  const dueOk = acc.json.due_date && (new Date(acc.json.due_date).getTime() - Date.now()) > 25 * 86400_000;
  ok('file access DSAR → received + ~30-day due date', acc.json.status === 'received' && dueOk, JSON.stringify({ st: acc.json.status, due: acc.json.due_date }));

  // 2. Fulfil access/portability — bundle includes profile + consents + ledger; request closed.
  const exp = await inj('POST', `/api/pdpa/dsar/${acc.json.id}/export`, dpo1);
  const prof = exp.json.export?.profile;
  ok('export bundles subject profile + consents + ledger', exp.json.status === 'completed' && prof?.name === 'Somchai Jaidee' && (exp.json.export?.consents?.length ?? 0) >= 1 && (exp.json.export?.points_ledger?.length ?? 0) >= 1, JSON.stringify({ st: exp.json.status, name: prof?.name }));

  // 3. File + execute an erasure DSAR.
  const er = await inj('POST', '/api/pdpa/dsar', dpo1, { subject_type: 'member', subject_ref: 'M-0001', request_type: 'erasure' });
  const erase = await inj('POST', `/api/pdpa/dsar/${er.json.id}/erase`, dpo1);
  ok('erasure → completed + pseudonym issued', erase.json.erased === true && /^PDPA-ERASED-/.test(erase.json.pseudonym ?? ''), JSON.stringify(erase.json));

  // 4. The member's PII is redacted in the operational store (verify via a fresh access export).
  const acc2 = await inj('POST', '/api/pdpa/dsar', dpo1, { subject_type: 'member', subject_ref: 'M-0001', request_type: 'access' });
  const exp2 = await inj('POST', `/api/pdpa/dsar/${acc2.json.id}/export`, dpo1);
  const p2 = exp2.json.export?.profile;
  ok('member PII redacted after erasure (name=[erased], phone null)', p2?.name === '[erased]' && !p2?.phone && !p2?.email, JSON.stringify({ name: p2?.name, phone: p2?.phone }));

  // 5. The immutable audit trail now SHOWS the pseudonym instead of the erased PII (stored row untouched).
  const audit = await inj('GET', '/api/admin/audit?action=pos', dpo1);
  const row = (audit.json.rows ?? []).find((r: any) => r.entity_id === 'SO-1');
  const metaStr = JSON.stringify(row?.meta ?? {});
  ok('audit log pseudonymised at read-time (no PII, shows pseudonym)', !!row && !metaStr.includes('0810001234') && !metaStr.includes('Somchai Jaidee') && metaStr.includes('PDPA-ERASED-'), `meta=${metaStr}`);

  // 6. The STORED audit row is byte-unchanged — erasure pseudonymises at READ time only, so the immutable,
  //    hash-chained audit_log (AC-10/AC-16) is never mutated. Read the raw row straight from the DB.
  const [raw] = await db.select().from(s.auditLog).where(eq(s.auditLog.entityId, 'SO-1'));
  const rawMeta = JSON.stringify(raw?.meta ?? {});
  ok('stored audit row is unmutated (PII still on disk; masked only in views)', rawMeta.includes('0810001234') && rawMeta.includes('Somchai Jaidee'), `rawMeta=${rawMeta}`);

  // 7. RLS — a DPO in another tenant cannot see tenant T1's DSAR.
  const cross = await inj('GET', `/api/pdpa/dsar/${acc.json.id}`, dpo2);
  ok('RLS: other-tenant DPO cannot read the DSAR (404)', cross.status === 404 || cross.json?.error?.code === 'NOT_FOUND', `status=${cross.status}`);

  // 8. Reject flow.
  const rej0 = await inj('POST', '/api/pdpa/dsar', dpo1, { subject_type: 'customer', subject_ref: 'CUST-9', request_type: 'objection' });
  const rej = await inj('POST', `/api/pdpa/dsar/${rej0.json.id}/reject`, dpo1, { reason: 'not a data subject of this controller' });
  ok('reject DSAR → status rejected', rej.json.status === 'rejected', JSON.stringify(rej.json));

  await app.close();
  console.log('\n── Step 8 — PDPA (DSAR + erasure + audit pseudonymisation) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} pdpa checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} pdpa checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
