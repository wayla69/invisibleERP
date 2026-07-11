/**
 * CLS-02 (control GL-26) — Disclosure / close-package checklist (governed close binder) over PGlite.
 * A preparer opens a per-period disclosure checklist (auto-seeded with the standard TFRS/SEC items); review
 * is blocked while any item is still Open (ITEMS_INCOMPLETE); a preparer cannot self-review (SOD_SELF_APPROVAL);
 * once every item is Complete/NA a DISTINCT reviewer reviews and the financials are issued. Support evidence
 * pins to doc_attachments docType DISC (assertDocExists). RLS: another tenant sees none of T1's checklists.
 * Posts NOTHING to the GL.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover disclosure-checklist
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'disclosure-secret';
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
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'prep1', passwordHash: await pw.hash('pw'), role: 'FinancialController', tenantId: t1 }, // preparer (gl_close)
    { username: 'rev1', passwordHash: await pw.hash('pw'), role: 'FinancialController', tenantId: t1 },  // distinct reviewer (gl_close)
    { username: 'rev2', passwordHash: await pw.hash('pw'), role: 'FinancialController', tenantId: t2 },  // RLS — other tenant
  ]).onConflictDoNothing();
  const grant = async (username: string, perms: string[]) => {
    const uid = Number((await db.select().from(s.users).where(eq(s.users.username, username)))[0].id);
    await db.insert(s.userPermissions).values(perms.map((perm) => ({ userId: uid, perm }))).onConflictDoNothing();
  };
  await grant('prep1', ['gl_close', 'procurement']); // procurement so admin-free DISC attach test can run under prep1
  await grant('rev1', ['gl_close']);
  await grant('rev2', ['gl_close']);

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
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const admin = await login('admin', 'admin123');
  const prep1 = await login('prep1', 'pw');
  const rev1 = await login('rev1', 'pw');
  const rev2 = await login('rev2', 'pw');

  // ── A. Open a checklist → seeds the standard items (Draft) ──
  const open = await inj('POST', '/api/close/disclosure', prep1, { period: '2026-06' });
  const id = Number(open.json?.id);
  ok('Open seeds the standard disclosure items (Draft, ≥10 items, DISC checklist_no)',
    open.status === 201 && open.json?.status === 'Draft' && Array.isArray(open.json?.items) && open.json.items.length >= 10 && /^DISC-/.test(open.json?.checklist_no ?? '') && open.json.items.every((i: any) => i.status === 'Open'),
    `st=${open.status} status=${open.json?.status} n=${open.json?.items?.length} no=${open.json?.checklist_no}`);

  // ── B. Re-open the same period is idempotent (returns the existing Draft) ──
  const reopen = await inj('POST', '/api/close/disclosure', prep1, { period: '2026-06' });
  ok('Re-open the same period is idempotent (same checklist id)', reopen.status === 201 && Number(reopen.json?.id) === id, `id=${reopen.json?.id} vs ${id}`);

  // ── C. Review while an item is Open → 400 ITEMS_INCOMPLETE ──
  const earlyReview = await inj('POST', `/api/close/disclosure/${id}/review`, rev1);
  ok('Review while an item is Open → 400 ITEMS_INCOMPLETE', earlyReview.status === 400 && earlyReview.json?.error?.code === 'ITEMS_INCOMPLETE', `st=${earlyReview.status} code=${earlyReview.json?.error?.code}`);

  // ── D. Complete/NA every item (with a support-doc reference on the first) ──
  const items = open.json.items as any[];
  const first = items[0];
  const upd = await inj('PUT', `/api/close/disclosure/${id}/items/${first.id}`, prep1, { status: 'Complete', support_doc_ref: open.json.checklist_no });
  ok('Complete an item + attach support_doc_ref (records completed_by)',
    upd.status === 200 && upd.json.items.find((i: any) => i.id === first.id)?.status === 'Complete' && upd.json.items.find((i: any) => i.id === first.id)?.completed_by === 'prep1' && upd.json.items.find((i: any) => i.id === first.id)?.support_doc_ref === open.json.checklist_no,
    `st=${upd.status}`);
  for (const it of items.slice(1)) await inj('PUT', `/api/close/disclosure/${id}/items/${it.id}`, prep1, { status: it.seq % 5 === 0 ? 'NA' : 'Complete' });
  const afterAll = await inj('GET', `/api/close/disclosure/${id}`, prep1);
  ok('All items Complete/NA (none Open)', afterAll.json.items.every((i: any) => i.status !== 'Open'), `open=${afterAll.json.items.filter((i: any) => i.status === 'Open').length}`);

  // ── E. Self-review by the preparer → 403 SOD_SELF_APPROVAL ──
  const selfReview = await inj('POST', `/api/close/disclosure/${id}/review`, prep1);
  ok('Self-review by the preparer → 403 SOD_SELF_APPROVAL', selfReview.status === 403 && selfReview.json?.error?.code === 'SOD_SELF_APPROVAL', `st=${selfReview.status} code=${selfReview.json?.error?.code}`);

  // ── F. Distinct reviewer reviews → Reviewed; issue → Issued ──
  const review = await inj('POST', `/api/close/disclosure/${id}/review`, rev1);
  ok('Distinct reviewer reviews → Reviewed (reviewed_by recorded)', review.status === 200 && review.json?.status === 'Reviewed' && review.json?.reviewed_by === 'rev1', `st=${review.status} status=${review.json?.status}`);
  const issueBeforeReview = await inj('POST', `/api/close/disclosure/${id}/issue`, rev1);
  ok('Issue a Reviewed checklist → Issued (issued_by recorded)', issueBeforeReview.status === 200 && issueBeforeReview.json?.status === 'Issued' && issueBeforeReview.json?.issued_by === 'rev1', `st=${issueBeforeReview.status} status=${issueBeforeReview.json?.status}`);
  const reReview = await inj('POST', `/api/close/disclosure/${id}/review`, rev1);
  ok('Re-review an Issued checklist → 400 NOT_DRAFT', reReview.status === 400 && reReview.json?.error?.code === 'NOT_DRAFT', `st=${reReview.status} code=${reReview.json?.error?.code}`);

  // ── G. Support evidence pins to doc_attachments docType DISC (assertDocExists) ──
  const attach = await inj('POST', '/api/procurement/attachments', prep1, { doc_type: 'DISC', doc_no: open.json.checklist_no, data_url: PNG, kind: 'other', filename: 'note-24.png' });
  ok('Attach DISC support evidence to the checklist_no (assertDocExists DISC)', attach.status === 201 && attach.json?.doc_type === 'DISC', `st=${attach.status} code=${attach.json?.error?.code}`);
  const attachBad = await inj('POST', '/api/procurement/attachments', prep1, { doc_type: 'DISC', doc_no: 'DISC-NOPE-999', data_url: PNG, kind: 'other' });
  ok('Attach DISC to a non-existent checklist → 404 NOT_FOUND', attachBad.status === 404 && attachBad.json?.error?.code === 'NOT_FOUND', `st=${attachBad.status} code=${attachBad.json?.error?.code}`);

  // ── H. RLS — another tenant sees none of T1's checklists ──
  const t2list = await inj('GET', '/api/close/disclosure', rev2);
  ok('RLS: T2 reviewer sees 0 of T1 checklists', (t2list.json?.checklists ?? []).length === 0, `n=${(t2list.json?.checklists ?? []).length}`);
  const t1list = await inj('GET', '/api/close/disclosure', rev1);
  ok('Register: T1 lists the checklist (Issued)', (t1list.json?.checklists ?? []).length === 1 && t1list.json.checklists[0].status === 'Issued', `n=${(t1list.json?.checklists ?? []).length}`);

  console.log('\n── CLS-02 (GL-26) — Disclosure / close-package checklist ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} disclosure-checklist checks failed` : `\n✅ All ${checks.length} disclosure-checklist checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
