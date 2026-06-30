/**
 * Real-Postgres smoke (panel Round-2, condition #1 / debug-mantra "green CI ≠ working prod").
 * The 90+ cutover harnesses boot on PGlite, which does NOT reproduce: postgres-js's raw-Date crash,
 * true FORCE ROW LEVEL SECURITY under a non-owner role, or the org-scoped RLS subquery (0193). This
 * harness runs the ACTUAL migrations against a real Postgres and asserts those divergence-class behaviours.
 *
 * Skips cleanly when DATABASE_URL is unset (local PGlite runs are unaffected). In CI a postgres:16
 * service container provides DATABASE_URL.
 *   DATABASE_URL=postgres://... pnpm --filter @ierp/cutover pg-smoke
 */
import postgres from 'postgres';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log('pg-smoke: SKIPPED (no DATABASE_URL — PGlite-only environment)'); return; }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // Apply every migration in order, as the owner (creates the app_user role + RLS policies).
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      const body = readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, '');
      await sql.unsafe(body);
    }
    ok('migrations apply on real Postgres', true);

    // Two orgs, one tenant each (org 10 → t1, org 20 → t2). Unique codes per run so a reused local DB
    // doesn't collide on tenants.code — we can't clean up (audit_log rows are immutable, see below).
    const sfx = Math.floor(Math.random() * 1e9);
    const [t1] = await sql`INSERT INTO tenants (code,name,org_id) VALUES (${'PGS-A-' + sfx},'Org A Shop',10) RETURNING id`;
    const [t2] = await sql`INSERT INTO tenants (code,name,org_id) VALUES (${'PGS-B-' + sfx},'Org B Shop',20) RETURNING id`;
    const a = Number(t1.id), b = Number(t2.id);
    // A tenant-scoped row in each (audit_log carries tenant_id and is FORCE-RLS).
    await sql`INSERT INTO audit_log (tenant_id,actor,action,status,seq,hash) VALUES (${a},'sys','seed','success',1,'h1'),(${b},'sys','seed','success',1,'h2')`;

    // ── Multi-company org-scoped Admin: SET ROLE app_user + app.org_id=10 → sees org-A tenant, NOT org-B.
    const orgScoped = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      await tx`SELECT set_config('app.bypass_rls','off',true), set_config('app.tenant_id','',true), set_config('app.org_id','10',true)`;
      return tx`SELECT id FROM tenants WHERE id IN (${a},${b}) ORDER BY id`;
    });
    const seen = orgScoped.map((r: any) => Number(r.id));
    ok('org-scoped Admin sees own org only', seen.length === 1 && seen[0] === a, `saw ${JSON.stringify(seen)} expected [${a}]`);

    // ── Tenant-scoped staff: app.tenant_id=A → sees only A's audit row, never B's (FORCE RLS under app_user).
    const scopedRows = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      await tx`SELECT set_config('app.bypass_rls','off',true), set_config('app.tenant_id',${String(a)},true), set_config('app.org_id','',true)`;
      return tx`SELECT tenant_id FROM audit_log WHERE tenant_id IN (${a},${b})`;
    });
    ok('FORCE-RLS isolates tenant rows', scopedRows.length === 1 && Number(scopedRows[0].tenant_id) === a, `rows=${scopedRows.length}`);

    // ── Single-company global bypass still sees both (legacy HQ behavior preserved).
    const bypassRows = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      await tx`SELECT set_config('app.bypass_rls','on',true), set_config('app.tenant_id','',true), set_config('app.org_id','',true)`;
      return tx`SELECT tenant_id FROM audit_log WHERE tenant_id IN (${a},${b})`;
    });
    ok('global bypass sees all tenants', bypassRows.length === 2, `rows=${bypassRows.length}`);

    // ── postgres-js Date round-trip (the class that crashes prod but passes PGlite).
    const d = new Date('2026-06-30T00:00:00Z');
    const [dr] = await sql`SELECT ${d}::timestamptz AS ts`;
    ok('postgres-js Date param round-trips', !!dr?.ts);

    // ── Bonus: audit_log immutability (ITGC-AC-10) is enforced by a DB trigger on REAL Postgres — a
    // PGlite harness does not reproduce this, so it belongs here. A DELETE must be rejected (P0001).
    let immutable = false;
    try { await sql`DELETE FROM audit_log WHERE tenant_id = ${a}`; }
    catch (e: any) { immutable = e?.code === 'P0001' || /append-only/i.test(String(e?.message)); }
    ok('audit_log is append-only (DELETE rejected on real Postgres)', immutable);

    // No teardown: audit_log rows are immutable by design (above), so we leave the seed rows. The CI
    // Postgres is an ephemeral service container; local reuse is collision-safe via the per-run code suffix.
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(() => {
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  console.log(`\npg-smoke: ${checks.length - failed.length}/${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error('pg-smoke crashed:', e); process.exit(1); });
