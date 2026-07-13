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
import { createHash } from 'node:crypto';
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
  // A receipt-upload submission (LYL-17) — personal data (photo + freeform fields) the member submitted themselves.
  await db.insert(s.loyaltyReceiptSubmissions).values({ tenantId: t1, memberId, receiptImage: 'data:image/png;base64,AAAA', purchaseAmount: '200', storeName: 'ร้านทดสอบ', note: 'ซื้อของ', status: 'Approved' });
  // A consented guest dining profile + companion (fine-casual guest CRM) — preference/profiling data that an
  // access request must export and an erasure must HARD-DELETE.
  await db.insert(s.memberConsents).values({ tenantId: t1, memberId, purpose: 'dining_profile', granted: true, grantedAt: new Date(), source: 'pos' });
  await db.insert(s.memberDiningProfiles).values({ tenantId: t1, memberId, favoriteMenus: ['หอยเชลล์ย่าง'], allergies: ['กุ้ง'], serviceNotes: 'น้ำเปล่าไม่ใส่น้ำแข็ง' });
  await db.insert(s.memberCompanions).values({ tenantId: t1, memberId, name: 'คุณเมย์', relationship: 'ภรรยา' });
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
  const rcpt = exp.json.export?.receipt_submissions?.[0];
  ok('export also bundles the member\'s receipt-upload submissions (LYL-17)', (exp.json.export?.receipt_submissions?.length ?? 0) === 1 && rcpt?.receipt_image === 'data:image/png;base64,AAAA' && rcpt?.store_name === 'ร้านทดสอบ', JSON.stringify(rcpt));
  ok('export also bundles the guest dining profile + companions', exp.json.export?.dining_profile?.allergies?.[0] === 'กุ้ง' && exp.json.export?.companions?.[0]?.name === 'คุณเมย์', JSON.stringify({ dp: exp.json.export?.dining_profile?.allergies, comp: exp.json.export?.companions?.length }));

  // 3. File + execute an erasure DSAR.
  const er = await inj('POST', '/api/pdpa/dsar', dpo1, { subject_type: 'member', subject_ref: 'M-0001', request_type: 'erasure' });
  const erase = await inj('POST', `/api/pdpa/dsar/${er.json.id}/erase`, dpo1);
  ok('erasure → completed + pseudonym issued', erase.json.erased === true && /^PDPA-ERASED-/.test(erase.json.pseudonym ?? ''), JSON.stringify(erase.json));

  // 4. The member's PII is redacted in the operational store (verify via a fresh access export).
  const acc2 = await inj('POST', '/api/pdpa/dsar', dpo1, { subject_type: 'member', subject_ref: 'M-0001', request_type: 'access' });
  const exp2 = await inj('POST', `/api/pdpa/dsar/${acc2.json.id}/export`, dpo1);
  const p2 = exp2.json.export?.profile;
  ok('member PII redacted after erasure (name=[erased], phone null)', p2?.name === '[erased]' && !p2?.phone && !p2?.email, JSON.stringify({ name: p2?.name, phone: p2?.phone }));
  const rcpt2 = exp2.json.export?.receipt_submissions?.[0];
  ok('receipt submission redacted after erasure (image/store/note gone) but transactional facts kept', rcpt2?.receipt_image === '[erased]' && !rcpt2?.store_name && !rcpt2?.note && Number(rcpt2?.purchase_amount) === 200 && rcpt2?.status === 'Approved', JSON.stringify(rcpt2));
  const dpCnt = Number(((await pg.query(`SELECT count(*)::int n FROM member_dining_profiles WHERE member_id=${memberId}`)).rows as any[])[0].n);
  const compCnt = Number(((await pg.query(`SELECT count(*)::int n FROM member_companions WHERE member_id=${memberId}`)).rows as any[])[0].n);
  ok('guest dining profile + companions HARD-DELETED by erasure (pure preference data)', dpCnt === 0 && compCnt === 0 && exp2.json.export?.dining_profile === null && (exp2.json.export?.companions?.length ?? 0) === 0, `profiles=${dpCnt} companions=${compCnt}`);

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
  // ── Employee data subject (docs/27 AUD-LGL-03) — access returns the DECRYPTED identifiers the employer
  // holds (ITGC-AC-19 columns); erasure redacts the master record but KEEPS payslips (statutory retention).
  const [emp] = await db.insert(s.employees).values({ tenantId: t1, empCode: 'EMP-PD1', name: 'Prasert K.', nationalId: '1102003330011', ssoNo: 'SSO-777', bankAccount: '111-2-33333-1', monthlySalary: '25000' }).returning();
  await db.insert(s.payruns).values({ tenantId: t1, period: '2026-05', status: 'Posted', headcount: 1 }).onConflictDoNothing();
  const [prun] = await db.select().from(s.payruns).where(eq(s.payruns.period, '2026-05'));
  await db.insert(s.payslips).values({ payrunId: Number(prun.id), tenantId: t1, employeeId: Number(emp.id), empCode: 'EMP-PD1', empName: 'Prasert K.', nationalId: '1102003330011', gross: '25000', net: '24000' });

  const eacc = await inj('POST', '/api/pdpa/dsar', dpo1, { subject_type: 'employee', subject_ref: 'EMP-PD1', request_type: 'access' });
  const eexp = await inj('POST', `/api/pdpa/dsar/${eacc.json.id}/export`, dpo1);
  ok('employee DSAR access → bundle carries the decrypted citizen ID + bank account + payslips',
    eexp.json.export?.found === true && eexp.json.export?.profile?.national_id === '1102003330011' && eexp.json.export?.profile?.bank_account === '111-2-33333-1' && (eexp.json.export?.payslips?.length ?? 0) === 1,
    JSON.stringify({ nid: eexp.json.export?.profile?.national_id, slips: eexp.json.export?.payslips?.length }));

  const eer = await inj('POST', '/api/pdpa/dsar', dpo1, { subject_type: 'employee', subject_ref: 'EMP-PD1', request_type: 'erasure' });
  const eerRes = await inj('POST', `/api/pdpa/dsar/${eer.json.id}/erase`, dpo1);
  const empRow: any = (await pg.query(`select name, national_id, sso_no, bank_account, active from employees where emp_code = 'EMP-PD1'`)).rows[0];
  const slipRow: any = (await pg.query(`select national_id, gross from payslips where emp_code = 'EMP-PD1'`)).rows[0];
  ok('employee erasure → master identifiers redacted, account deactivated, pseudonym issued',
    eerRes.json.erased === true && /^PDPA-ERASED-EMP-/.test(eerRes.json.pseudonym ?? '') && empRow.name === '[erased]' && empRow.national_id == null && empRow.bank_account == null && empRow.active === false,
    JSON.stringify({ name: empRow.name, nid: empRow.national_id, act: empRow.active }));
  ok('employee erasure keeps statutory payroll records (payslip intact — PDPA legal-obligation carve-out)',
    !!slipRow && Number(slipRow.gross) === 25000 && !!slipRow.national_id,
    JSON.stringify({ gross: slipRow?.gross, has_nid: !!slipRow?.national_id }));

  const rej0 = await inj('POST', '/api/pdpa/dsar', dpo1, { subject_type: 'customer', subject_ref: 'CUST-9', request_type: 'objection' });
  const rej = await inj('POST', `/api/pdpa/dsar/${rej0.json.id}/reject`, dpo1, { reason: 'not a data subject of this controller' });
  ok('reject DSAR → status rejected', rej.json.status === 'rejected', JSON.stringify(rej.json));

  // ── PDPA-03: RoPA — Records of Processing Activities (มาตรา 39 / GDPR Art.30) ──
  const ropaCreate = await inj('POST', '/api/pdpa/ropa', dpo1, {
    name: 'Loyalty membership', purpose: 'Operate the loyalty programme + marketing', legal_basis: 'consent',
    data_categories: ['name', 'phone', 'email'], data_subjects: ['members'], recipients: ['Marketing team'],
    sub_processors: ['Anthropic', 'Stripe'], retention_period: '3 years after last activity', cross_border: 'SCCs — Anthropic (US)', security_measures: 'field encryption + RBAC',
  });
  ok('PDPA-03: create RoPA activity → id + legal basis captured', ropaCreate.status === 201 && ropaCreate.json.id > 0 && ropaCreate.json.legal_basis === 'consent' && (ropaCreate.json.sub_processors ?? []).includes('Anthropic'), JSON.stringify(ropaCreate.json).slice(0, 150));
  const ropaBad = await inj('POST', '/api/pdpa/ropa', dpo1, { name: 'x', purpose: 'y', legal_basis: 'vibes' });
  ok('PDPA-03: an invalid legal basis is rejected (400)', ropaBad.status === 400, `${ropaBad.status} ${ropaBad.json.error?.code}`);
  const ropaList = await inj('GET', '/api/pdpa/ropa', dpo1);
  ok('PDPA-03: RoPA register lists the activity', (ropaList.json.activities ?? []).some((a: any) => a.id === ropaCreate.json.id && a.name === 'Loyalty membership'), `n=${ropaList.json.count}`);
  const ropaUpd = await inj('POST', `/api/pdpa/ropa/${ropaCreate.json.id}`, dpo1, { retention_period: '5 years', active: false });
  ok('PDPA-03: update RoPA (retention + deactivate) persists', ropaUpd.status === 201 && ropaUpd.json.retention_period === '5 years' && ropaUpd.json.active === false, JSON.stringify(ropaUpd.json).slice(0, 120));
  const ropaActive = await inj('GET', '/api/pdpa/ropa?active=1', dpo1);
  ok('PDPA-03: active-only filter excludes the deactivated activity', !(ropaActive.json.activities ?? []).some((a: any) => a.id === ropaCreate.json.id), `n=${ropaActive.json.count}`);
  const ropaCross = await inj('GET', `/api/pdpa/ropa/${ropaCreate.json.id}`, dpo2);
  ok('PDPA-03: RLS — other-tenant DPO cannot read the RoPA activity (404)', ropaCross.status === 404 || ropaCross.json?.error?.code === 'NOT_FOUND', `status=${ropaCross.status}`);

  // ── PDPA-04: PII retention sweep — opt-in, default-OFF, idempotent, reuses the erasure redaction path ──
  // Seed: an OLD member (last ledger activity ~4 years ago) and a RECENT member, both in T1.
  const yearsAgo4 = new Date(Date.now() - 4 * 365 * 86400_000);
  const [oldM] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-OLD1', name: 'Wichai Kao', phone: '0810009999', email: 'wichai@example.com', enrolledAt: yearsAgo4, lastUpdated: yearsAgo4 }).returning();
  await db.insert(s.posMemberLedger).values({ tenantId: t1, memberId: Number(oldM.id), txnDate: yearsAgo4, txnType: 'Earn', points: '100', balanceAfter: '100', refDoc: 'SALE-OLD' });
  await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-NEW1', name: 'Malee Mai', phone: '0810008888' });
  // 1. Default-OFF: no policy exists → the sweep touches nothing.
  const sweep0 = await inj('POST', '/api/pdpa/retention/sweep', dpo1, {});
  ok('PDPA-04: no policy → sweep is a no-op (default-off)', sweep0.status === 201 && sweep0.json.policies === 0 && sweep0.json.swept_total === 0, JSON.stringify(sweep0.json));
  // 2. A too-short retention window is rejected (guard against accidental mass-anonymization).
  const polBad = await inj('PUT', '/api/pdpa/retention', dpo1, { subject_type: 'member', retain_months: 6, enabled: true });
  ok('PDPA-04: retain_months < 12 → 400 RETENTION_TOO_SHORT', polBad.status === 400 && polBad.json.error?.code === 'RETENTION_TOO_SHORT', `${polBad.status} ${polBad.json.error?.code}`);
  // 3. Enable a 36-month policy; dry-run reports the aged member as a candidate without touching it.
  const polOk = await inj('PUT', '/api/pdpa/retention', dpo1, { subject_type: 'member', retain_months: 36, enabled: true });
  ok('PDPA-04: policy saved (member, 36 months, enabled)', polOk.json.retain_months === 36 && polOk.json.enabled === true, JSON.stringify(polOk.json));
  const dry = await inj('POST', '/api/pdpa/retention/sweep', dpo1, { dry_run: true });
  const dryT1 = (dry.json.results ?? [])[0];
  const oldStillThere: any = (await pg.query(`select name from pos_members where member_code = 'M-OLD1'`)).rows[0];
  ok('PDPA-04: dry-run lists the aged member as a candidate and redacts NOTHING', dry.json.dry_run === true && dryT1?.candidates === 1 && (dryT1?.sample ?? []).includes('M-OLD1') && oldStillThere.name === 'Wichai Kao', JSON.stringify({ dry: dryT1, name: oldStillThere.name }));
  // 4. Real run: the aged member is anonymized via the erasure path; the recent member is untouched.
  const sweep1 = await inj('POST', '/api/pdpa/retention/sweep', dpo1, {});
  const oldAfter: any = (await pg.query(`select name, phone, email, active from pos_members where member_code = 'M-OLD1'`)).rows[0];
  const newAfter: any = (await pg.query(`select name, phone from pos_members where member_code = 'M-NEW1'`)).rows[0];
  const ledgerRow: any = (await pg.query(`select pseudonym, dsar_id, erased_by from pdpa_erasures where subject_id = ${Number(oldM.id)}`)).rows[0];
  ok('PDPA-04: sweep anonymizes the aged member (name=[erased], identifiers null, deactivated)', sweep1.json.swept_total === 1 && oldAfter.name === '[erased]' && oldAfter.phone == null && oldAfter.email == null && oldAfter.active === false, JSON.stringify({ swept: sweep1.json.swept_total, old: oldAfter }));
  ok('PDPA-04: an erasure-ledger row is recorded (pseudonym, no DSAR, swept by the job)', !!ledgerRow && /^PDPA-ERASED-/.test(ledgerRow.pseudonym) && ledgerRow.dsar_id == null, JSON.stringify(ledgerRow));
  ok('PDPA-04: the recently-active member is untouched', newAfter.name === 'Malee Mai' && newAfter.phone === '0810008888', JSON.stringify(newAfter));
  // 5. Idempotent: a re-run sweeps nothing (the redacted member is no longer a candidate).
  const sweep2 = await inj('POST', '/api/pdpa/retention/sweep', dpo1, {});
  ok('PDPA-04: re-run sweeps 0 (idempotent — [erased] members are never candidates)', sweep2.json.swept_total === 0, JSON.stringify(sweep2.json));

  // ── G3 (docs/45) — PDPA-05: consent-gated HASHED audience export ──
  // Fresh trio (M-0001 is erased above): G3A consented (phone+email), G3B NO consent row but the legacy
  // marketingOptIn flag true (must be EXCLUDED — the ledger is the basis, not the flag), G3C withdrawn.
  const [g3a] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-G3A', name: 'Anong', phone: '081-000-9999', email: 'Anong@Example.com ', marketingOptIn: false }).returning();
  const [g3b] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-G3B', name: 'Boonmee', phone: '0820009999', email: 'boonmee@example.com', marketingOptIn: true }).returning();
  const [g3c] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-G3C', name: 'Chai', phone: '0830009999', email: 'chai@example.com', marketingOptIn: true }).returning();
  await db.insert(s.memberConsents).values([
    { tenantId: t1, memberId: Number(g3a.id), purpose: 'marketing', granted: true, grantedAt: new Date() },
    { tenantId: t1, memberId: Number(g3c.id), purpose: 'marketing', granted: false, grantedAt: new Date(), withdrawnAt: new Date() },
  ]);
  await db.insert(s.users).values([{ username: 'mkt1', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t1 }]).onConflictDoNothing();
  const mktUid = Number((await db.select().from(s.users).where(eq(s.users.username, 'mkt1')))[0].id);
  await db.insert(s.userPermissions).values(['marketing', 'exec'].map((perm) => ({ userId: mktUid, perm }))).onConflictDoNothing();
  const mkt1 = await login('mkt1');

  const sha = (v: string) => createHash('sha256').update(v).digest('hex');
  const prev = await inj('GET', '/api/crm/audience-export/preview', mkt1);
  const pj = JSON.stringify(prev.json);
  ok('PDPA-05: preview is hash-only + consent-filtered — 1 of 3 members (no-row + withdrawn excluded; flag is NOT a basis), normalized sha256 email/phone',
    prev.json.consented === 1 && prev.json.count === 1 &&
    prev.json.members?.[0]?.hashed_email === sha('anong@example.com') && prev.json.members?.[0]?.hashed_phone === sha('66810009999') &&
    !pj.includes('@example.com') && !pj.includes('0810009999') && !pj.includes('Anong'),
    JSON.stringify({ consented: prev.json.consented, count: prev.json.count, em_ok: prev.json.members?.[0]?.hashed_email === sha('anong@example.com') }));

  // The BI job is FAIL-CLOSED without the ROPA activity: run → failed + a 'blocked' register row.
  const mkSub = async () => (await inj('POST', '/api/bi/subscriptions', mkt1, { name: 'aud', report_type: 'audience_export_sync', frequency: 'weekly' })).json;
  const sub1 = await mkSub();
  const runBlocked = await inj('POST', `/api/bi/subscriptions/${sub1.id}/run`, mkt1, {});
  const reg1 = await inj('GET', '/api/crm/audience-export/register', mkt1);
  ok('PDPA-05: without an ACTIVE audience_export ROPA activity the run FAILS CLOSED and a blocked register row is recorded',
    runBlocked.json.status !== 'success' && (reg1.json.exports ?? []).some((r: any) => r.status === 'blocked' && r.error === 'ROPA_MISSING'),
    JSON.stringify({ run: runBlocked.json.status, reg: reg1.json.exports?.[0]?.status }));

  // Record the processing activity (legal_basis=consent) → the same run now succeeds, register carries evidence.
  const ropaAud = await inj('POST', '/api/pdpa/ropa', dpo1, { name: 'audience_export', purpose: 'Ads-platform custom audiences (hashed)', legal_basis: 'consent', recipients: ['ads platform'], cross_border: 'SCCs', data_categories: ['hashed_email', 'hashed_phone'] });
  const runOk = await inj('POST', `/api/bi/subscriptions/${sub1.id}/run`, mkt1, {});
  const reg2 = await inj('GET', '/api/crm/audience-export/register', mkt1);
  const okRow = (reg2.json.exports ?? []).find((r: any) => r.status === 'success');
  ok('PDPA-05: with the ROPA entry the export runs — 1 consented row pushed (mock target), register ties the run to the ROPA id',
    runOk.json.status === 'success' && /Audience export: 1 hashed row/.test(runOk.json.summary ?? '') &&
    okRow?.members_consented === 1 && okRow?.rows_pushed === 1 && okRow?.target === 'mock' && Number(okRow?.ropa_activity_id) === Number(ropaAud.json.id) && okRow?.consent_basis === 'member_consents:marketing',
    JSON.stringify({ run: runOk.json.status, row: okRow }));

  // ── G3b — DIRECT ads adapters (env-gated): stub global.fetch, assert the EXACT wire shapes ──
  process.env.META_ADS_ACCESS_TOKEN = 'meta-tok';
  process.env.META_AUDIENCE_ID = 'AUD-1';
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'dev-tok';
  process.env.GOOGLE_ADS_CLIENT_ID = 'cid';
  process.env.GOOGLE_ADS_CLIENT_SECRET = 'sec';
  process.env.GOOGLE_ADS_REFRESH_TOKEN = 'ref-tok';
  process.env.GOOGLE_ADS_CUSTOMER_ID = '123-456-7890';
  process.env.GOOGLE_ADS_USER_LIST_ID = 'LIST-9';
  const realFetch = global.fetch;
  const wire: { url: string; host?: string; headers: any; body: any }[] = [];
  global.fetch = (async (url: any, init: any) => {
    const u = String(url);
    // exact-hostname routing (js/incomplete-url-substring-sanitization — never substring-match a host)
    const host = (() => { try { return new URL(u).hostname; } catch { return ''; } })();
    let body: any = init?.body;
    try { body = JSON.parse(init?.body); } catch { /* form-encoded token request */ }
    wire.push({ url: u, host, headers: init?.headers ?? {}, body });
    const json =
      host === 'oauth2.googleapis.com' ? { access_token: 'gat', expires_in: 3600 } :
      u.includes('offlineUserDataJobs:create') ? { resourceName: 'customers/1234567890/offlineUserDataJobs/77' } :
      host === 'graph.facebook.com' ? { audience_id: 'AUD-1', num_received: 1 } : {};
    return { ok: true, status: 200, json: async () => json } as any;
  }) as any;
  const sub2 = await mkSub();
  const runAds = await inj('POST', `/api/bi/subscriptions/${sub2.id}/run`, mkt1, {});
  global.fetch = realFetch;
  for (const k of ['META_ADS_ACCESS_TOKEN', 'META_AUDIENCE_ID', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_USER_LIST_ID']) delete process.env[k];

  const metaCall = wire.find((w) => w.host === 'graph.facebook.com');
  const gCreate = wire.find((w) => w.url.includes('offlineUserDataJobs:create'));
  const gAdd = wire.find((w) => w.url.includes(':addOperations'));
  const gRun = wire.find((w) => w.url.includes(':run'));
  ok('G3b: Meta adapter — pre-hashed EMAIL_SHA256/PHONE_SHA256 schema on the pinned audience, session-flagged, digits-no-plus phone hash',
    runAds.json.status === 'success' && /meta\+google/.test(runAds.json.summary ?? '') &&
    metaCall?.url.includes('/v21.0/AUD-1/users') &&
    JSON.stringify(metaCall?.body?.payload?.schema) === JSON.stringify(['EMAIL_SHA256', 'PHONE_SHA256']) &&
    metaCall?.body?.payload?.data?.[0]?.[0] === sha('anong@example.com') && metaCall?.body?.payload?.data?.[0]?.[1] === sha('66810009999') &&
    metaCall?.body?.session?.batch_seq === 1 && metaCall?.body?.session?.last_batch_flag === true,
    JSON.stringify({ run: runAds.json.status, url: metaCall?.url, s: metaCall?.body?.session }));
  ok('G3b: Google adapter — OfflineUserDataJob create→addOperations→run against the pinned user list, PLUS-prefixed phone hash, partial-failure on',
    gCreate?.body?.job?.customerMatchUserListMetadata?.userList === 'customers/1234567890/userLists/LIST-9' &&
    gAdd?.url.includes('customers/1234567890/offlineUserDataJobs/77') && gAdd?.body?.enablePartialFailure === true &&
    gAdd?.body?.operations?.[0]?.create?.userIdentifiers?.some((x: any) => x.hashedEmail === sha('anong@example.com')) &&
    gAdd?.body?.operations?.[0]?.create?.userIdentifiers?.some((x: any) => x.hashedPhoneNumber === sha('+66810009999')) &&
    gRun != null && (gAdd?.headers?.['developer-token'] === 'dev-tok'),
    JSON.stringify({ create: gCreate?.body?.job, ids: gAdd?.body?.operations?.[0]?.create?.userIdentifiers?.length, run: !!gRun }));
  const reg3 = await inj('GET', '/api/crm/audience-export/register', mkt1);
  const byTarget = Object.fromEntries((reg3.json.exports ?? []).filter((r: any) => r.status === 'success').map((r: any) => [r.target, r]));
  ok('G3b: per-recipient register evidence — separate success rows for meta and google, counts intact',
    byTarget.meta?.rows_pushed === 1 && byTarget.google?.rows_pushed === 1 && byTarget.meta?.consent_basis === 'member_consents:marketing',
    JSON.stringify({ targets: Object.keys(byTarget) }));

  await app.close();
  console.log('\n── Step 8 — PDPA (DSAR + erasure + audit pseudonymisation) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} pdpa checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} pdpa checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
