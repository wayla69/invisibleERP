import { ConflictException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';

// Shared FK-safe fixpoint delete engine behind both BillingService.factoryResetTenant and
// TenantLifecycleService.purgeTenant. Extracted so the loop isn't duplicated across two providers
// (docs/46 Phase 0 — this also SHRINKS billing.service.ts's LOC).

// Same runtime enumeration the RLS-loop migrations use — every BASE TABLE column literally named
// `tenant_id` (convention, not necessarily a declared FK). Deliberately does NOT touch `audit_log`:
// preserve-sets always include it (the ITGC-AC-16 hash chain is DB-enforced append-only — a DELETE
// against it fails regardless of what a caller's preserve-set says, so never even attempt it here).
export async function tenantIdColumns(db: DrizzleDb): Promise<string[]> {
  const res: any = await db.execute(sql`
    SELECT c.table_name AS tbl FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND tb.table_type = 'BASE TABLE'
    ORDER BY c.table_name`);
  return (res.rows ?? res).map((r: any) => String(r.tbl));
}

// A tenantless child table reachable from a tenant-rooted parent via FK edges, plus the nested
// IN-subquery path that selects exactly the tenant's rows in it (see tenantlessChildTargets).
interface ChildTarget { table: string; fkCol: string; parentSubquery: string }

const q = (name: string) => `"${name.replace(/"/g, '""')}"`; // identifiers come from pg_catalog, not user input

// The 2026-07-13 INVISIBLE factory-reset outage: pure line-item tables WITHOUT a tenant_id column
// (cust_pos_items → cust_pos_sales, survey_answers → survey_responses) are invisible to the
// tenant_id-column enumeration above, so their rows were never deleted and permanently blocked their
// parents' DELETE → FACTORY_RESET_BLOCKED with zero progress. This walks the FK graph at runtime
// (single-column FKs) and returns, for every tenantless table reachable from a wiped tenant table
// through child→parent edges (transitively, so a tenantless grandchild of a tenantless child is still
// found), a DELETE predicate that selects exactly the rows belonging to the tenant — a nested
// IN-subquery chain terminating in `WHERE tenant_id = $1` on the tenant-rooted ancestor. Rows whose
// ancestor is another tenant's (or NULL/shared) are untouched: ownership is derived, never guessed.
export async function tenantlessChildTargets(
  db: DrizzleDb, wipedTables: Set<string>,
): Promise<ChildTarget[]> {
  const res: any = await db.execute(sql`
    SELECT child.relname AS child_table, ca.attname AS child_col,
           parent.relname AS parent_table, pa.attname AS parent_col
    FROM pg_constraint con
    JOIN pg_class child  ON child.oid  = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_attribute ca ON ca.attrelid = child.oid  AND ca.attnum = con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = parent.oid AND pa.attnum = con.confkey[1]
    WHERE con.contype = 'f' AND child.relnamespace = 'public'::regnamespace
      AND array_length(con.conkey, 1) = 1`);
  const fks: { child: string; childCol: string; parent: string; parentCol: string }[] =
    (res.rows ?? res).map((r: any) => ({
      child: String(r.child_table), childCol: String(r.child_col),
      parent: String(r.parent_table), parentCol: String(r.parent_col),
    }));
  const tenantScoped = new Set(await tenantIdColumns(db));

  // covered: table → SQL fragment selecting the tenant's <parentCol> values in it ($1 = tenant id).
  // Seed with the directly-wiped tenant tables, then expand through tenantless children to a fixpoint.
  const targets: ChildTarget[] = [];
  const coveredSubquery = new Map<string, (col: string) => string>();
  for (const t of wipedTables) coveredSubquery.set(t, (col) => `SELECT ${q(col)} FROM ${q(t)} WHERE tenant_id = $1`);
  let grew = true;
  while (grew) {
    grew = false;
    for (const fk of fks) {
      if (tenantScoped.has(fk.child)) continue;           // the normal tenant_id loop owns it
      if (fk.child === 'audit_log') continue;             // never touched (append-only hash chain)
      if (!coveredSubquery.has(fk.parent)) continue;      // parent not (yet) reachable from a tenant root
      const parentSubquery = coveredSubquery.get(fk.parent)!(fk.parentCol);
      if (targets.some((t) => t.table === fk.child && t.fkCol === fk.childCol)) continue;
      targets.push({ table: fk.child, fkCol: fk.childCol, parentSubquery });
      if (!coveredSubquery.has(fk.child)) {
        coveredSubquery.set(fk.child, (col) => `SELECT ${q(col)} FROM ${q(fk.child)} WHERE ${q(fk.childCol)} IN (${parentSubquery})`);
        grew = true;
      }
    }
  }
  return targets;
}

// Topologically order the wiped tables so each is deleted BEFORE any table it references via FK
// (children before parents) — a leaf-first order in which no single DELETE can violate a still-
// referencing FK. This replaces the old savepoint-catch-retry loop, which relied on catching a failed
// DELETE and ROLLBACK-TO-SAVEPOINT to recover: PGlite honours that, but **postgres-js does NOT** — once
// any statement errors inside a drizzle/postgres-js transaction the whole tx is poisoned and the error
// propagates out, so the retry never happened in prod (green on PGlite CI, raw FK 500 in prod — the
// INVISIBLE/Amber reset outage, same CI-vs-prod driver-divergence class as the 0387 RLS bug). With a
// correct delete order there are no expected failures at all, so the outcome is driver-independent.
function topoOrderChildrenFirst(tables: string[], fks: { child: string; parent: string }[]): string[] {
  const inSet = new Set(tables);
  // childrenOf[t] = tables that REFERENCE t (t is their FK parent). t may only be deleted once every
  // table referencing it is already deleted — so emit t after all of childrenOf[t] are placed.
  const childrenOf = new Map<string, Set<string>>();
  for (const t of tables) childrenOf.set(t, new Set());
  for (const fk of fks) {
    if (fk.child === fk.parent) continue; // self-FK imposes no ordering
    if (inSet.has(fk.child) && inSet.has(fk.parent)) childrenOf.get(fk.parent)!.add(fk.child);
  }
  const ordered: string[] = [];
  const placed = new Set<string>();
  let progress = true;
  while (ordered.length < tables.length && progress) {
    progress = false;
    for (const t of tables) {
      if (placed.has(t)) continue;
      if ([...childrenOf.get(t)!].every((c) => placed.has(c) || c === t)) { ordered.push(t); placed.add(t); progress = true; }
    }
  }
  for (const t of tables) if (!placed.has(t)) ordered.push(t); // FK cycle leftovers → best-effort tail
  return ordered;
}

// FK-safe delete: clears tenantless FK-child tables (see tenantlessChildTargets), then deletes the
// tenant_id tables in child-first topological order — no DELETE is expected to fail on an FK, so no
// savepoint recovery is relied upon. A defensive savepoint still wraps each statement so an unforeseen
// cyclic / preserved-table reference degrades to a clean FACTORY_RESET_BLOCKED instead of a raw 500.
export async function wipeTenantRefs(
  db: DrizzleDb, tenantId: number, tables: string[], preserveTables: Set<string>,
  blockedCode: string, blockedMessage: (names: string) => string, blockedMessageTh: (names: string) => string,
): Promise<{ targeted: number; rowsDeleted: number }> {
  // The child-target DELETEs are assembled as raw SQL with the tenant id inlined — hard-require an
  // integer so a malformed value can never reach the string (callers already Number() route params).
  if (!Number.isInteger(tenantId)) throw new Error(`wipeTenantRefs: tenantId must be an integer, got ${String(tenantId)}`);
  // Authorise the wipe to delete append-only rows (Posted GL, approval actions) whose immutability
  // triggers otherwise RAISE on DELETE — transaction-local, so it reverts at request end and only ever
  // covers this god-only, two-step-gated reset/purge (migration 0402). app_user can't disable the
  // triggers directly (not owner) nor session_replication_role (not superuser), so this GUC gate is it.
  await db.execute(sql`SET LOCAL app.tenant_wipe = 'on'`);
  const wiped = tables.filter((n) => !preserveTables.has(n));
  const targeted = wiped.length;
  const childTargets = await tenantlessChildTargets(db, new Set(wiped));

  const fkRes: any = await db.execute(sql`
    SELECT ch.relname AS child_t, pa.relname AS parent_t
    FROM pg_constraint con
    JOIN pg_class ch ON ch.oid = con.conrelid
    JOIN pg_class pa ON pa.oid = con.confrelid
    WHERE con.contype = 'f' AND ch.relnamespace = 'public'::regnamespace
      AND array_length(con.conkey, 1) = 1`);
  const fks = (fkRes.rows ?? fkRes).map((r: any) => ({ child: String(r.child_t), parent: String(r.parent_t) }));
  const ordered = topoOrderChildrenFirst(wiped, fks);

  let rowsDeleted = 0;
  const savepoint = async (run: () => Promise<number>): Promise<{ ok: boolean; n: number }> => {
    await db.execute(sql`SAVEPOINT tenant_wipe_tbl`);
    try {
      const n = await run();
      await db.execute(sql`RELEASE SAVEPOINT tenant_wipe_tbl`);
      return { ok: true, n };
    } catch {
      await db.execute(sql`ROLLBACK TO SAVEPOINT tenant_wipe_tbl`);
      return { ok: false, n: 0 };
    }
  };

  // 1. Tenantless FK children first, so a tenantless child never blocks its tenant-scoped parent.
  for (const ct of childTargets) {
    const { n } = await savepoint(async () => {
      const r: any = await db.execute(sql.raw(
        `DELETE FROM ${q(ct.table)} WHERE ${q(ct.fkCol)} IN (${ct.parentSubquery})`.replace(/\$1/g, String(tenantId)),
      ));
      return Number(r?.rowCount ?? r?.affectedRows ?? 0);
    });
    rowsDeleted += n;
  }

  // 2. Tenant_id tables in child-first order — single pass; nothing is expected to fail on an FK.
  const blocked: string[] = [];
  for (const name of ordered) {
    const ident = sql.raw(q(name)); // identifier from pg_catalog, not user input
    const { ok, n } = await savepoint(async () => {
      const r: any = await db.execute(sql`DELETE FROM ${ident} WHERE tenant_id = ${tenantId}`);
      return Number(r?.rowCount ?? r?.affectedRows ?? 0);
    });
    if (ok) rowsDeleted += n; else blocked.push(name);
  }

  if (blocked.length) {
    const names = blocked.slice(0, 8).join(', ') + (blocked.length > 8 ? '…' : '');
    throw new ConflictException({ code: blockedCode, message: blockedMessage(names), messageTh: blockedMessageTh(names) });
  }
  return { targeted, rowsDeleted };
}
