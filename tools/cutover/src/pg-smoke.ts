/**
 * Real-Postgres smoke (panel Round-2, condition #1 / debug-mantra "green CI ≠ working prod").
 * The 90+ cutover harnesses boot on PGlite, which does NOT reproduce: postgres-js's raw-Date crash,
 * true FORCE ROW LEVEL SECURITY under a non-owner role, or the org-scoped RLS subquery (0193). This
 * harness runs the ACTUAL migrations against a real Postgres and asserts those divergence-class behaviours.
 *
 * Migrations are applied THE WAY PROD APPLIES THEM (tenancy-model.md rev 1.26 — the 0387 incident):
 * via `pnpm --filter @ierp/api db:migrate` connecting as a freshly-provisioned NOSUPERUSER,
 * NOBYPASSRLS owner role mirroring the §1bis `ierp_app` provisioning. Applying them as the service
 * container's superuser (as this harness originally did) bypasses RLS unconditionally and masked a
 * migration that read the FORCE-RLS `users` table and saw zero rows in prod — failing the deploy
 * twice while every CI gate stayed green.
 *
 * Skips cleanly when DATABASE_URL is unset (local PGlite runs are unaffected). In CI a postgres:16
 * service container provides DATABASE_URL (as a superuser — used only to provision the role and to
 * seed/inspect; the migrations themselves run as the hardened role).
 *   DATABASE_URL=postgres://... pnpm --filter @ierp/cutover pg-smoke
 * NB local reuse: a DB previously migrated by the old inline runner has no drizzle journal table —
 * use a fresh database the first time you run the db:migrate-based version.
 */
import postgres from 'postgres';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const REPO_ROOT = resolve(process.cwd(), '../..');
const MIGRATION_ROLE = 'ierp_smoke'; // throwaway per-DB stand-in for prod's ierp_app
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log('pg-smoke: SKIPPED (no DATABASE_URL — PGlite-only environment)'); return; }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // ── Provision the prod-shaped migration role (mirror docs/ops/tenancy-model.md §1bis /
    // ops-provision-app-role.yml). `app_user` is bootstrapped here because it pre-exists in prod
    // (0002 only CREATEs it IF NOT EXISTS — which a NOCREATEROLE role cannot do on a fresh DB).
    await sql.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
          CREATE ROLE app_user NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${MIGRATION_ROLE}') THEN
          CREATE ROLE ${MIGRATION_ROLE} LOGIN PASSWORD '${MIGRATION_ROLE}'
            NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        END IF;
        EXECUTE format('GRANT CREATE ON DATABASE %I TO ${MIGRATION_ROLE}', current_database());
        EXECUTE 'GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATION_ROLE}';
        EXECUTE 'GRANT app_user TO ${MIGRATION_ROLE}'; -- SET ROLE app_user needs session-role membership
      END $$;
    `);
    // §1bis ownership transfer (tables/sequences/views + enum TYPEs). No-op on a fresh CI container
    // (the role creates and therefore owns everything); real work on a reused local DB where a prior
    // superuser run owns the objects — ALTER TABLE / ALTER TYPE ... ADD VALUE require ownership.
    await sql.unsafe(`
      DO $$ DECLARE r record; BEGIN
        FOR r IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') LOOP
          EXECUTE format('ALTER TABLE %I.%I OWNER TO ${MIGRATION_ROLE}', r.schemaname, r.tablename);
        END LOOP;
        FOR r IN SELECT schemaname, sequencename FROM pg_sequences WHERE schemaname IN ('public','drizzle') LOOP
          EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO ${MIGRATION_ROLE}', r.schemaname, r.sequencename);
        END LOOP;
        FOR r IN SELECT schemaname, viewname FROM pg_views WHERE schemaname IN ('public','drizzle') LOOP
          EXECUTE format('ALTER VIEW %I.%I OWNER TO ${MIGRATION_ROLE}', r.schemaname, r.viewname);
        END LOOP;
        FOR r IN SELECT n.nspname, t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'public' AND t.typtype = 'e' LOOP
          EXECUTE format('ALTER TYPE %I.%I OWNER TO ${MIGRATION_ROLE}', r.nspname, r.typname);
        END LOOP;
      END $$;
    `);
    const [posture] = await sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${MIGRATION_ROLE}`;
    ok('migration role is NOSUPERUSER + NOBYPASSRLS (prod ierp_app posture)',
      posture !== undefined && !posture.rolsuper && !posture.rolbypassrls);

    // ── Apply every migration exactly as prod does: the real db:migrate runner (sets the
    // app.bypass_rls session GUC) connecting as the hardened role. A migration that reads a
    // FORCE-RLS table now sees what prod sees — the class the superuser apply loop masked (0387).
    const appUrl = new URL(url);
    appUrl.username = MIGRATION_ROLE;
    appUrl.password = MIGRATION_ROLE;
    let migrated = true;
    try {
      // PG_SMOKE_MIGRATE_CMD is a local-dev escape hatch (e.g. invoking tsx directly where running
      // pnpm is not possible); CI always uses the real prod command.
      execSync(process.env.PG_SMOKE_MIGRATE_CMD || 'pnpm --filter @ierp/api db:migrate', {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: appUrl.toString() },
      });
    } catch {
      migrated = false;
    }
    ok('full migration run completes via db:migrate as the prod-shaped role', migrated);
    if (!migrated) throw new Error('db:migrate failed under the non-superuser role — a prod deploy would fail identically');

    // Every journaled migration must be recorded applied in drizzle's journal table.
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'));
    const [applied] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    ok('every journaled migration is recorded as applied', Number(applied.n) >= journal.entries.length,
      `applied=${applied.n} journal=${journal.entries.length}`);

    // Two orgs, one tenant each (org 10 → t1, org 20 → t2). Unique codes per run so a reused local DB
    // doesn't collide on tenants.code — we can't clean up (audit_log rows are immutable, see below).
    const sfx = Math.floor(Math.random() * 1e9);
    const [t1] = await sql`INSERT INTO tenants (code,name,org_id) VALUES (${'PGS-A-' + sfx},'Org A Shop',10) RETURNING id`;
    const [t2] = await sql`INSERT INTO tenants (code,name,org_id) VALUES (${'PGS-B-' + sfx},'Org B Shop',20) RETURNING id`;
    const a = Number(t1.id), b = Number(t2.id);
    // A tenant-scoped row in each (audit_log carries tenant_id and is FORCE-RLS).
    await sql`INSERT INTO audit_log (tenant_id,actor,action,status,seq,hash) VALUES (${a},'sys','seed','success',1,'h1'),(${b},'sys','seed','success',1,'h2')`;

    // ── The 0387 failure mode, asserted directly: `users` is FORCE-RLS with a GUC-based policy, so the
    // migration role (a table OWNER — FORCE binds owners too) sees ZERO rows without app.bypass_rls and
    // the real rows with it. This is the exact read 0387's backfill performed; an empty fresh-CI DB
    // makes such a migration pass trivially, so the mechanism itself is pinned here with a seeded row.
    const uname = 'pgs-user-' + sfx;
    await sql`INSERT INTO users (username, password_hash, tenant_id) VALUES (${uname}, 'x', ${a})`;
    const roleUrl = new URL(url);
    roleUrl.username = MIGRATION_ROLE;
    roleUrl.password = MIGRATION_ROLE;
    const roleSql = postgres(roleUrl.toString(), { max: 1, onnotice: () => {} });
    try {
      const [bare] = await roleSql`SELECT count(*)::int AS n FROM users WHERE username = ${uname}`;
      ok('FORCE-RLS hides users rows from a bare migration session (the 0387 failure mode)', Number(bare.n) === 0, `rows=${bare.n}`);
      const gucRows = await roleSql.begin(async (tx) => {
        await tx`SELECT set_config('app.bypass_rls','on',true)`;
        return tx`SELECT count(*)::int AS n FROM users WHERE username = ${uname}`;
      });
      ok('app.bypass_rls GUC (what db:migrate sets) restores row visibility for the migration role', Number(gucRows[0].n) === 1, `rows=${gucRows[0].n}`);
    } finally {
      await roleSql.end({ timeout: 5 });
    }

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
