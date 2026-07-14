/**
 * Read-only wipe / factory-reset diagnostic — inspect a tenant's post-wipe state WITHOUT mutating anything.
 *
 * WHY THIS EXISTS: after a Platform-Console factory-reset (suspend → ล้างข้อมูล → reactivate) reports an
 * error or "0 rows deleted", you need to see the ground truth from the DB: is the company's business data
 * actually gone, or did a table block the delete? This script answers that read-only.
 *
 * THE "0 ROWS" TRAP (see database/migrate.ts header): prod connects as the hardened non-superuser role
 * (NOBYPASSRLS) and every tenant-scoped table has FORCE ROW LEVEL SECURITY behind a GUC policy. A plain
 * SELECT therefore sees ZERO rows unless `app.bypass_rls='on'` is set on the session — so a naive audit
 * script would report phantom emptiness indistinguishable from a real wipe. This script sets that GUC
 * defensively (harmless when the connection is already a superuser, e.g. Railway's DATABASE_PUBLIC_URL),
 * and additionally pins the whole session to `default_transaction_read_only=on` so it can NEVER write.
 *
 * รัน (บน Railway, ผ่าน Postgres service เพื่อ inject DATABASE_PUBLIC_URL):
 *   railway run --service Postgres-QDRG -- pnpm --filter @ierp/api db:wipe-audit -- <tenantId> [--audit 40]
 * หรือ local:  DATABASE_PUBLIC_URL=... pnpm --filter @ierp/api db:wipe-audit -- 498
 */
import { resolve } from 'node:path';
import postgres from 'postgres';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try {
    (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p);
  } catch {
    /* ignore — env is injected by `railway run` in prod */
  }
}

// Tables the factory-reset intentionally KEEPS (identity/billing/audit), mirroring FACTORY_RESET_PRESERVE
// in modules/billing/tenant-provisioning.service.ts. Fiscal-year + chart-of-accounts rows are also expected
// back because the reset RE-SEEDS them. Non-zero counts in any of these after a wipe are NORMAL.
const PRESERVED = new Set([
  'users', 'user_permissions', 'user_prefs',
  'subscriptions',
  'audit_log',
  'ai_token_usage', 'ai_overage_billing_runs',
  'usage_events', 'usage_overage_billing_runs',
]);
// Re-seeded by factoryResetTenant (provisionFiscalYear + provisionTenantCoA) — non-zero here is also NORMAL.
const RESEEDED_HINT = /(fiscal|period|account|coa|chart)/i;

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`; // identifiers come from pg_catalog, never user input
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tenantId = Number(args.find((a) => /^\d+$/.test(a)));
  const auditIdx = args.indexOf('--audit');
  const auditLimit = auditIdx >= 0 ? Number(args[auditIdx + 1]) || 40 : 40;
  if (!Number.isInteger(tenantId)) {
    console.error('Usage: db:wipe-audit -- <tenantId> [--audit N]   (tenantId must be an integer)');
    process.exit(2);
  }

  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Neither DATABASE_PUBLIC_URL nor DATABASE_URL is set (run via `railway run --service Postgres-QDRG`).');

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // Hard read-only session + RLS bypass so counts reflect reality, not phantom-empty tables.
    await sql`SELECT set_config('app.bypass_rls', 'on', false)`;
    await sql`SELECT set_config('default_transaction_read_only', 'on', false)`;

    // ── 1. Tenant lifecycle row ────────────────────────────────────────────────────────────────────
    const [t] = await sql`
      SELECT id, code, name, suspended_at, deleted_at, purged_at
      FROM tenants WHERE id = ${tenantId} LIMIT 1`;
    console.log('\n═══ TENANT ═══');
    if (!t) {
      console.log(`  ⚠️  No tenant with id=${tenantId}`);
    } else {
      console.log(`  id=${t.id}  code=${t.code}  name=${t.name}`);
      console.log(`  suspended_at=${t.suspended_at ?? '—'}  deleted_at=${t.deleted_at ?? '—'}  purged_at=${t.purged_at ?? '—'}`);
      const state = t.suspended_at ? 'SUSPENDED (ready for factory-reset)' : 'ACTIVE (reset is blocked until suspended)';
      console.log(`  → lifecycle: ${state}`);
    }

    // ── 2. Remaining rows per tenant-scoped table ──────────────────────────────────────────────────
    // Every BASE TABLE with a literal `tenant_id` column — the same enumeration the wipe engine uses.
    const cols: { tbl: string }[] = await sql`
      SELECT c.table_name AS tbl
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND tb.table_type = 'BASE TABLE'
      ORDER BY c.table_name`;
    const tables = cols.map((r) => r.tbl);

    // One round-trip: UNION ALL of per-table counts (identifiers quoted from pg_catalog; $1 = tenant id).
    const unionSql = tables
      .map((tbl) => `SELECT '${tbl}' AS t, count(*)::bigint AS n FROM ${q(tbl)} WHERE tenant_id = $1`)
      .join(' UNION ALL ');
    const counts: { t: string; n: string }[] = await sql.unsafe(unionSql, [tenantId]);
    const nonZero = counts
      .map((r) => ({ t: r.t, n: Number(r.n) }))
      .filter((r) => r.n > 0)
      .sort((a, b) => b.n - a.n);

    const total = nonZero.reduce((s, r) => s + r.n, 0);
    console.log(`\n═══ REMAINING ROWS (tenant_id=${tenantId}) across ${tables.length} tenant tables ═══`);
    if (!nonZero.length) {
      console.log('  (all tenant tables are empty for this tenant)');
    } else {
      for (const r of nonZero) {
        const tag = PRESERVED.has(r.t) ? ' [preserved — expected]'
          : RESEEDED_HINT.test(r.t) ? ' [re-seeded? — likely expected]'
          : ' ← BUSINESS DATA (should be 0 after a successful wipe)';
        console.log(`  ${String(r.n).padStart(8)}  ${r.t}${tag}`);
      }
    }
    const leftover = nonZero.filter((r) => !PRESERVED.has(r.t) && !RESEEDED_HINT.test(r.t));
    console.log(`  ── total ${total} rows in ${nonZero.length} tables; ${leftover.length} table(s) hold un-preserved business data`);
    if (leftover.length) {
      console.log('  ⚠️  Business data remains — the wipe did NOT fully delete (check for FACTORY_RESET_BLOCKED / a blocking FK / an un-suspended tenant).');
    } else if (t?.suspended_at == null && total > 0) {
      console.log('  ℹ️  Only preserved/re-seeded tables hold rows — consistent with a completed wipe + reactivate.');
    }

    // NB tenantless line-item tables (e.g. cust_pos_items, survey_answers) have NO tenant_id column and so
    // are invisible to the enumeration above — the wipe engine reaches them via FK subqueries. If business
    // parents (cust_pos_sales, survey_responses) show 0 here, their children were cleared with them.

    // ── 3. Recent lifecycle audit trail ────────────────────────────────────────────────────────────
    const audits: { ts: string; actor: string; action: string; entity: string; entity_id: string; status: string }[] = await sql`
      SELECT ts, actor, action, entity, entity_id, status
      FROM audit_log
      WHERE (tenant_id = ${tenantId} OR entity_id = ${String(tenantId)})
        AND (
          action ILIKE '%factory-reset%' OR action ILIKE '%suspend%'
          OR action ILIKE '%reactivate%' OR action ILIKE '%purge%'
          OR action ILIKE '%tenants/${tenantId}%'
        )
      ORDER BY ts DESC
      LIMIT ${auditLimit}`;
    console.log(`\n═══ AUDIT LOG — lifecycle actions on tenant ${tenantId} (latest ${auditLimit}) ═══`);
    if (!audits.length) {
      console.log('  (no matching audit rows — try a broader query, or the action ran under a different tenant_id)');
    } else {
      for (const a of audits) {
        console.log(`  ${a.ts}  ${a.status?.padEnd(7) ?? ''}  ${a.actor ?? '?'}  ${a.action ?? ''}  ${a.entity ?? ''}#${a.entity_id ?? ''}`);
      }
    }
    console.log('');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error('wipe-audit-check failed:', e);
  process.exit(1);
});
