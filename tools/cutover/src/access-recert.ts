/**
 * GRC-2 — ITGC-AC-21 Access Recertification Campaign (line-item UAR + closed-loop revocation) over PGlite.
 * Open a campaign (snapshots every user's effective access as a keep/revoke worklist); certify is BLOCKED
 * while any line is pending (ITEMS_PENDING); disposition keep/revoke per user; on certify a 'revoke' decision
 * ACTUALLY removes the user's user_permissions grants (the closed loop — asserted against the DB); a certified
 * campaign is frozen; RLS isolates a campaign to its tenant. Builds on admin-users — never touches the SoD
 * exception (ITGC-AC-09) flow.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover access-recert
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'access-recert-secret';
process.env.NODE_ENV = 'test';
// multi-company so per-tenant Admins are RLS-scoped to their own tenant (single-company grants a global
// Admin bypass) — lets the RLS-isolation checks below prove a T1 Admin can't see an HQ campaign.
process.env.TENANCY_MODE = 'multi-company';

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

  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'T1' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'iam', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },      // reviewer (HQ)
    { username: 'keeper', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: hq },    // access retained
    { username: 'leaver', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: hq },    // access revoked (closed loop)
    { username: 't1admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 },   // other tenant (RLS)
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  const leaverId = await uid('leaver');
  // Give 'leaver' a permission OVERRIDE — the grant the campaign's revoke decision must actually remove.
  await db.insert(s.userPermissions).values([{ userId: leaverId, perm: 'gl_post' }, { userId: leaverId, perm: 'ar' }]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /**/ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [iam, t1admin] = [await login('iam', 'admin123'), await login('t1admin', 'admin123')];

  // ── 1. Open a campaign — snapshots the HQ population as pending line items ──
  const open = await inj('POST', '/api/admin/users/access-review/campaign', iam, { period: '2026-Q3', notes: 'quarterly recert' });
  const cid = open.json.id;
  ok('Open campaign → status open, snapshots 3 HQ users as pending', open.status === 201 && open.json.status === 'open' && open.json.items_total === 3, JSON.stringify(open.json));

  // ── 2. Get campaign — line items carry the effective-permission snapshot, all pending ──
  const got = await inj('GET', `/api/admin/users/access-review/campaign/${cid}`, iam);
  const byUser = (u: string) => (got.json.items ?? []).find((i: any) => i.username === u);
  ok('Get campaign lists line items with current_perms snapshot', got.status === 200 && got.json.pending === 3 && Array.isArray(byUser('leaver')?.current_perms) && byUser('leaver').current_perms.includes('gl_post'), JSON.stringify({ pending: got.json.pending, leaver: byUser('leaver')?.current_perms }));

  // ── 3. Certify is BLOCKED while any line is undecided ──
  const earlyCert = await inj('POST', `/api/admin/users/access-review/campaign/${cid}/certify`, iam);
  ok('Certify with pending lines → 422 ITEMS_PENDING', earlyCert.status === 422 && earlyCert.json.error?.code === 'ITEMS_PENDING', JSON.stringify(earlyCert.json));

  // ── 4. An invalid decision is rejected ──
  const badDec = await inj('POST', `/api/admin/users/access-review/campaign/${cid}/items/leaver`, iam, { decision: 'maybe' });
  ok('Invalid decision → 400', badDec.status === 400, JSON.stringify(badDec.json));

  // ── 5. Disposition each user: keep iam + keeper, revoke leaver ──
  const dKeep1 = await inj('POST', `/api/admin/users/access-review/campaign/${cid}/items/iam`, iam, { decision: 'keep' });
  const dKeep2 = await inj('POST', `/api/admin/users/access-review/campaign/${cid}/items/keeper`, iam, { decision: 'keep' });
  const dRevoke = await inj('POST', `/api/admin/users/access-review/campaign/${cid}/items/leaver`, iam, { decision: 'revoke', notes: 'transferred out' });
  ok('Keep/revoke dispositions record → decision + reviewer', dKeep1.status === 201 && dKeep2.status === 201 && dRevoke.status === 201 && dRevoke.json.decision === 'revoke' && dRevoke.json.reviewer === 'iam', JSON.stringify(dRevoke.json));

  // Deciding an unknown user → ITEM_NOT_FOUND
  const noItem = await inj('POST', `/api/admin/users/access-review/campaign/${cid}/items/ghost`, iam, { decision: 'keep' });
  ok('Disposition an unknown user → 404 ITEM_NOT_FOUND', noItem.status === 404 && noItem.json.error?.code === 'ITEM_NOT_FOUND', JSON.stringify(noItem.json));

  // Campaign drifted open → in_review
  const midway = await inj('GET', `/api/admin/users/access-review/campaign/${cid}`, iam);
  ok('Campaign status drifts to in_review after first disposition', midway.json.status === 'in_review' && midway.json.pending === 0, JSON.stringify({ status: midway.json.status, pending: midway.json.pending }));

  // Pre-certify: leaver still holds its 2 permission overrides
  const before = await db.select().from(s.userPermissions).where(eq(s.userPermissions.userId, leaverId));
  ok('Pre-certify: leaver still holds its granted overrides', before.length === 2, `count=${before.length}`);

  // ── 6. Certify — every line decided; the 'revoke' grants are ACTUALLY removed (closed loop) ──
  const cert = await inj('POST', `/api/admin/users/access-review/campaign/${cid}/certify`, iam);
  ok('Certify → certified, 1 revoked / 2 kept', cert.status === 201 && cert.json.status === 'certified' && cert.json.items_revoked === 1 && cert.json.items_kept === 2 && (cert.json.revoked_users ?? []).includes('leaver'), JSON.stringify(cert.json));

  const after = await db.select().from(s.userPermissions).where(eq(s.userPermissions.userId, leaverId));
  ok('CLOSED LOOP: leaver lost its permission grants on certify', after.length === 0, `count=${after.length}`);
  const kept = await db.select().from(s.userPermissions).where(eq(s.userPermissions.userId, await uid('leaver')));
  ok('Certified campaign records the revoke as actioned', (await inj('GET', `/api/admin/users/access-review/campaign/${cid}`, iam)).json.items.find((i: any) => i.username === 'leaver')?.actioned === true, `keptRows=${kept.length}`);

  // ── 7. A certified campaign is frozen ──
  const reDecide = await inj('POST', `/api/admin/users/access-review/campaign/${cid}/items/keeper`, iam, { decision: 'revoke' });
  ok('Re-decide a certified campaign → 422 CAMPAIGN_CERTIFIED', reDecide.status === 422 && reDecide.json.error?.code === 'CAMPAIGN_CERTIFIED', JSON.stringify(reDecide.json));
  const reCert = await inj('POST', `/api/admin/users/access-review/campaign/${cid}/certify`, iam);
  ok('Re-certify → 422 CAMPAIGN_CERTIFIED', reCert.status === 422 && reCert.json.error?.code === 'CAMPAIGN_CERTIFIED', JSON.stringify(reCert.json));

  // ── 8. RLS isolation — a T1 Admin sees only T1 in its own campaign, and cannot see the HQ campaign ──
  const t1open = await inj('POST', '/api/admin/users/access-review/campaign', t1admin, { period: '2026-Q3' });
  ok('RLS: T1 campaign snapshots only T1 users (isolation on open)', t1open.status === 201 && t1open.json.items_total === 1, JSON.stringify(t1open.json));
  const t1GetHq = await inj('GET', `/api/admin/users/access-review/campaign/${cid}`, t1admin);
  ok('RLS: T1 cannot read the HQ campaign → 404 CAMPAIGN_NOT_FOUND', t1GetHq.status === 404 && t1GetHq.json.error?.code === 'CAMPAIGN_NOT_FOUND', JSON.stringify(t1GetHq.json));
  const t1CertHq = await inj('POST', `/api/admin/users/access-review/campaign/${cid}/certify`, t1admin);
  ok('RLS: T1 cannot certify the HQ campaign → 404 CAMPAIGN_NOT_FOUND', t1CertHq.status === 404 && t1CertHq.json.error?.code === 'CAMPAIGN_NOT_FOUND', JSON.stringify(t1CertHq.json));

  // ── 9. Back-compat — the legacy blanket certifyReview still records a certified sign-off ──
  const blanket = await inj('POST', '/api/admin/users/access-review/certify', iam, { period: '2026-Q3-blanket', notes: 'legacy' });
  const certs = await inj('GET', '/api/admin/users/access-review/certifications', iam);
  ok('Back-compat: blanket certifyReview still records a certified review', (blanket.status === 200 || blanket.status === 201) && (certs.json.reviews ?? []).some((r: any) => r.period === '2026-Q3-blanket' && r.status === 'certified'), JSON.stringify(blanket.json));

  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => {
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.filter((c) => !c.ok).length;
  console.log(`\n${'─'.repeat(60)}`);
  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(`${'─'.repeat(60)}\n${pass}/${checks.length} passed${fail ? ` (${fail} failed)` : ' 🎉'}`);
  if (fail) process.exit(1);
});
