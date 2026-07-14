import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';

// Garbage-collection engine for the SHARED item master (`items`). `items` has NO tenant_id (a global master,
// natural key = the TEXT `item_id`), so the tenant factory-reset / purge — which only clear tenant_id-scoped
// tables — never touch it: a company's leftover catalogue rows survive its reset and keep showing in EVERY
// tenant's shop (the /shop catalog reads `items` unfiltered). This engine finds the items that NO tenant
// references any more and lets the platform owner delete exactly those, leaving items another company still
// uses (on a PO, in stock, on a BoM, …) intact.
//
// CRITICAL: "unreferenced" is only correct when computed with a CROSS-TENANT (god / RLS-bypass) view — under
// a per-company scope another company's in-use items look orphaned. The caller guarantees the bypass via the
// @PlatformAdmin route (which keeps the full bypass even when a god is act-as-scoped to one company).

// TEXT columns that hold an item CODE (→ items.item_id), by naming convention across the schema. Discovery is
// catalogue-driven (like md_merge_repoint_text / the RLS loop), so a newly-added child table that follows the
// convention is covered automatically — no edit here.
const CODE_COLUMNS = ['item_id', 'product_item_id', 'item_no', 'free_item_id', 'ingredient_item_id', 'item_code'];

const q = (name: string) => `"${name.replace(/"/g, '""')}"`; // identifiers come from pg_catalog, not user input
const rowsOf = (res: any): any[] => res?.rows ?? res ?? [];

export interface ItemRefColumn { table: string; col: string; kind: 'code' | 'id' }

// Every base-table column (outside items/item_images) that points at the item master:
//   kind 'code' — a TEXT item-code column (→ items.item_id)
//   kind 'id'   — a BIGINT/INT column referencing items.id: the two item_relationships FKs and a bigint
//                 `item_id` (installed_base). The items-self successor pointers (superseded_by/merged_into)
//                 are added directly in the query below since they live on `items` itself.
export async function itemRefColumns(db: DrizzleDb): Promise<ItemRefColumn[]> {
  const res: any = await db.execute(sql`
    SELECT c.table_name AS tbl, c.column_name AS col, c.data_type AS dt
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.table_name NOT IN ('items', 'item_images')
    ORDER BY c.table_name, c.column_name`);
  const isText = (dt: string) => dt === 'text' || dt === 'character varying';
  const isInt = (dt: string) => dt === 'bigint' || dt === 'integer';
  const out: ItemRefColumn[] = [];
  for (const r of rowsOf(res)) {
    const table = String(r.tbl); const col = String(r.col); const dt = String(r.dt);
    if (CODE_COLUMNS.includes(col) && isText(dt)) out.push({ table, col, kind: 'code' });
    else if (col === 'item_id' && isInt(dt)) out.push({ table, col, kind: 'id' });              // installed_base bigint → items.id
    else if ((col === 'from_item_id' || col === 'to_item_id') && isInt(dt)) out.push({ table, col, kind: 'id' }); // item_relationships FKs
  }
  return out;
}

interface UnusedRow { id: number; itemId: string }

// The set of item rows that no surviving reference points at — the delete candidates. A 'merged' (soft-
// retired duplicate) row is preserved so the match-merge audit trail (DQM Phase 11) is never destroyed.
async function unusedItemRows(db: DrizzleDb): Promise<UnusedRow[]> {
  const refs = await itemRefColumns(db);
  const codeParts = refs.filter((r) => r.kind === 'code')
    .map((r) => `SELECT ${q(r.col)}::text AS v FROM ${q(r.table)} WHERE ${q(r.col)} IS NOT NULL`);
  const idParts = refs.filter((r) => r.kind === 'id')
    .map((r) => `SELECT ${q(r.col)}::bigint AS v FROM ${q(r.table)} WHERE ${q(r.col)} IS NOT NULL`);
  // items-self successor pointers: a survivor/successor must never be collected.
  idParts.push('SELECT superseded_by::bigint AS v FROM items WHERE superseded_by IS NOT NULL');
  idParts.push('SELECT merged_into::bigint AS v FROM items WHERE merged_into IS NOT NULL');
  // `WHERE false` guards the degenerate (no columns) case so the CTE is always valid SQL.
  const codeUnion = codeParts.length ? codeParts.join(' UNION ') : 'SELECT NULL::text AS v WHERE false';
  const idUnion = idParts.join(' UNION ');

  const res: any = await db.execute(sql.raw(`
    WITH used_codes AS (${codeUnion}), used_ids AS (${idUnion})
    SELECT i.id, i.item_id
    FROM items i
    WHERE COALESCE(i.status, 'active') <> 'merged'
      AND NOT EXISTS (SELECT 1 FROM used_codes uc WHERE uc.v = i.item_id)
      AND NOT EXISTS (SELECT 1 FROM used_ids ui WHERE ui.v = i.id)
    ORDER BY i.item_id`));
  return rowsOf(res).map((r: any) => ({ id: Number(r.id), itemId: String(r.item_id) }));
}

const SAMPLE = 500; // cap the preview list so a huge purge doesn't return an unbounded payload

// The base tables that carry a real `tenant_id` column — used to attribute a reference to the company that
// owns it (a referencing table without one is platform/shared, reported as tenant_id=null).
async function tablesWithTenantId(db: DrizzleDb): Promise<Set<string>> {
  const res: any = await db.execute(sql`
    SELECT c.table_name AS tbl FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'`);
  return new Set(rowsOf(res).map((r: any) => String(r.tbl)));
}

export interface KeptByTenant { tenant_id: number | null; code: string | null; name: string | null; items: number }

// DIAGNOSTIC — for the items that are KEPT (still referenced, so NOT collected by a purge), attribute them to
// the company whose data references them. Answers "why do N products survive the purge?": if they map to the
// company you just reset, its data wasn't fully wiped; if they map to OTHER companies, the shared catalogue is
// simply in use elsewhere and a purge can't remove them. Grouped by referencing tenant, distinct items each
// (an item used by two companies counts for both). Computed cross-tenant — the caller holds the god bypass.
export async function keptByTenant(db: DrizzleDb): Promise<KeptByTenant[]> {
  const refs = await itemRefColumns(db);
  if (!refs.length) return [];
  const tenantTables = await tablesWithTenantId(db);
  const parts = refs.map((r) => {
    const join = r.kind === 'code' ? `i.item_id = r.${q(r.col)}::text` : `i.id = r.${q(r.col)}::bigint`;
    const tExpr = tenantTables.has(r.table) ? 'r.tenant_id' : 'NULL::bigint';
    return `SELECT ${tExpr} AS tenant_id, i.id AS item_id FROM ${q(r.table)} r JOIN items i ON ${join} WHERE r.${q(r.col)} IS NOT NULL`;
  });
  const res: any = await db.execute(sql.raw(`
    WITH refs AS (${parts.join(' UNION ALL ')})
    SELECT refs.tenant_id, t.code, t.name, count(DISTINCT refs.item_id)::int AS items
    FROM refs LEFT JOIN tenants t ON t.id = refs.tenant_id
    GROUP BY refs.tenant_id, t.code, t.name
    ORDER BY items DESC`));
  return rowsOf(res).map((r: any) => ({
    tenant_id: r.tenant_id != null ? Number(r.tenant_id) : null,
    code: r.code ?? null, name: r.name ?? null, items: Number(r.items ?? 0),
  }));
}

// Read-only preview (dry-run): how many items would be collected + a bounded sample of their codes, PLUS the
// diagnostic breakdown of who keeps the rest alive (so a god can tell a reset-leftover from an in-use item).
export async function previewUnusedItems(db: DrizzleDb): Promise<{ total: number; item_ids: string[]; sampled: boolean; ref_columns: number; kept_by: KeptByTenant[] }> {
  const [rows, refs, keptBy] = [await unusedItemRows(db), await itemRefColumns(db), await keptByTenant(db)];
  return { total: rows.length, item_ids: rows.slice(0, SAMPLE).map((r) => r.itemId), sampled: rows.length > SAMPLE, ref_columns: refs.length, kept_by: keptBy };
}

// Destructive purge — deletes the unreferenced items and their images. Idempotent: a second run finds nothing
// left to collect and returns zero. Runs inside the request transaction the caller already holds, so the
// image + item deletes commit or roll back together.
export async function purgeUnusedItems(db: DrizzleDb): Promise<{ items_deleted: number; images_deleted: number; item_ids: string[] }> {
  const rows = await unusedItemRows(db);
  if (!rows.length) return { items_deleted: 0, images_deleted: 0, item_ids: [] };
  const ids = rows.map((r) => r.id);
  const codes = rows.map((r) => r.itemId);
  // Images first (item_images.item_id is the text code — a global table, no FK, but keep the pair consistent).
  const imgRes: any = await db.execute(sql`DELETE FROM item_images WHERE item_id IN ${sqlList(codes)}`);
  const itemRes: any = await db.execute(sql`DELETE FROM items WHERE id IN ${sqlList(ids)}`);
  const affected = (res: any) => Number(res?.rowCount ?? res?.affectedRows ?? rowsOf(res).length ?? 0);
  return { items_deleted: affected(itemRes) || ids.length, images_deleted: affected(imgRes), item_ids: codes };
}

// A parenthesised value list for `IN (…)` built from a JS array of scalars. Values are bound (sql`${v}`),
// never string-interpolated, so this is injection-safe even for the text codes.
function sqlList(values: (string | number)[]) {
  const parts = values.map((v) => sql`${v}`);
  return sql`(${sql.join(parts, sql`, `)})`;
}

// ── FORCE purge (DANGEROUS — deletes referenced items too) ──────────────────────────────────────────────
// The normal purge KEEPS an item any company still references. Force purge is the escape hatch for junk/test
// products that must go regardless: it DELETES every referencing row across EVERY tenant (PO/GR/stock/recipe/
// price/… lines), then deletes the item + its image. This corrupts a real company's data if one genuinely
// uses the item, so it is god-only, needs a distinct strong confirm, and the caller must show the blast-radius
// preview first. Targets an explicit item_id list, or ALL items in the catalogue when none is given.

interface ForceTargets { ids: number[]; itemIds: string[] }

async function forceTargets(db: DrizzleDb, itemIds?: string[]): Promise<ForceTargets> {
  const where = itemIds && itemIds.length ? sql`WHERE item_id IN ${sqlList(itemIds)}` : sql``;
  const res: any = await db.execute(sql`SELECT id, item_id FROM items ${where}`);
  const rows = rowsOf(res).map((r: any) => ({ id: Number(r.id), itemId: String(r.item_id) }));
  return { ids: rows.map((r: any) => r.id), itemIds: rows.map((r: any) => r.itemId) };
}

// Blast-radius preview for a force purge: how many referencing rows would be deleted, grouped by the company
// (tenant) that owns them — so a god sees exactly which companies are affected BEFORE committing. Read-only.
export async function forcePurgePreview(db: DrizzleDb, itemIds?: string[]): Promise<{ items: number; total_ref_rows: number; by_tenant: (KeptByTenant & { ref_rows: number })[] }> {
  const targets = await forceTargets(db, itemIds);
  if (!targets.ids.length) return { items: 0, total_ref_rows: 0, by_tenant: [] };
  const refs = await itemRefColumns(db);
  const tenantTables = await tablesWithTenantId(db);
  const scoped = !!(itemIds && itemIds.length);
  // When an explicit id list is given, restrict via a `target(item_id)` VALUES CTE so the codes are BOUND, not
  // string-interpolated. Table/column identifiers come from pg_catalog (safe to raw-embed).
  const parts = refs.map((r) => {
    const join = r.kind === 'code' ? `i.item_id = r.${q(r.col)}::text` : `i.id = r.${q(r.col)}::bigint`;
    const tExpr = tenantTables.has(r.table) ? 'r.tenant_id' : 'NULL::bigint';
    const targetJoin = scoped ? 'JOIN target g ON g.item_id = i.item_id' : '';
    return `SELECT ${tExpr} AS tenant_id FROM ${q(r.table)} r JOIN items i ON ${join} ${targetJoin} WHERE r.${q(r.col)} IS NOT NULL`;
  });
  const refsCte = sql.raw(parts.join(' UNION ALL '));
  const body = sql`SELECT refs.tenant_id, t.code, t.name, count(*)::int AS ref_rows
    FROM refs LEFT JOIN tenants t ON t.id = refs.tenant_id
    GROUP BY refs.tenant_id, t.code, t.name ORDER BY ref_rows DESC`;
  const res: any = scoped
    ? await db.execute(sql`WITH target(item_id) AS (VALUES ${sql.join(targets.itemIds.map((v) => sql`(${v})`), sql`, `)}), refs AS (${refsCte}) ${body}`)
    : await db.execute(sql`WITH refs AS (${refsCte}) ${body}`);
  const by_tenant = rowsOf(res).map((r: any) => ({
    tenant_id: r.tenant_id != null ? Number(r.tenant_id) : null, code: r.code ?? null, name: r.name ?? null,
    items: 0, ref_rows: Number(r.ref_rows ?? 0),
  }));
  const total = by_tenant.reduce((s, r) => s + r.ref_rows, 0);
  return { items: targets.itemIds.length, total_ref_rows: total, by_tenant };
}

// Execute the force purge: delete every referencing row for the target items across all tenants, then the
// images + items. A savepoint wraps each statement so an unforeseen FK/immutability block degrades to a
// reported "blocked" table instead of a raw 500. app.tenant_wipe authorises deleting append-only rows (mirrors
// the tenant-wipe engine). Runs inside the caller's request transaction (atomic).
export async function forcePurgeItems(db: DrizzleDb, itemIds?: string[]): Promise<{ items_deleted: number; ref_rows_deleted: number; images_deleted: number; blocked: string[] }> {
  const targets = await forceTargets(db, itemIds);
  if (!targets.ids.length) return { items_deleted: 0, ref_rows_deleted: 0, images_deleted: 0, blocked: [] };
  await db.execute(sql`SET LOCAL app.tenant_wipe = 'on'`);
  const refs = await itemRefColumns(db);
  const affected = (res: any) => Number(res?.rowCount ?? res?.affectedRows ?? rowsOf(res).length ?? 0);
  const blocked: string[] = [];
  let refRows = 0;
  const savepoint = async (label: string, run: () => Promise<number>) => {
    await db.execute(sql`SAVEPOINT force_purge_stmt`);
    try { const n = await run(); await db.execute(sql`RELEASE SAVEPOINT force_purge_stmt`); return n; }
    catch { await db.execute(sql`ROLLBACK TO SAVEPOINT force_purge_stmt`); blocked.push(label); return 0; }
  };
  // 1. Referencing rows, per column. code cols match the text item_id; id cols match the bigint items.id.
  for (const r of refs) {
    const list = r.kind === 'code' ? sqlList(targets.itemIds) : sqlList(targets.ids);
    refRows += await savepoint(r.table, async () => {
      const res: any = await db.execute(sql`DELETE FROM ${sql.raw(q(r.table))} WHERE ${sql.raw(q(r.col))} IN ${list}`);
      return affected(res);
    });
  }
  // 2. items-self successor pointers that named a doomed item — null them so no surviving item dangles.
  await savepoint('items.superseded_by', async () => affected(await db.execute(sql`UPDATE items SET superseded_by = NULL WHERE superseded_by IN ${sqlList(targets.ids)}`)));
  await savepoint('items.merged_into', async () => affected(await db.execute(sql`UPDATE items SET merged_into = NULL WHERE merged_into IN ${sqlList(targets.ids)}`)));
  // 3. Images, then the items themselves.
  const imagesDeleted = await savepoint('item_images', async () => affected(await db.execute(sql`DELETE FROM item_images WHERE item_id IN ${sqlList(targets.itemIds)}`)));
  const itemsDeleted = await savepoint('items', async () => affected(await db.execute(sql`DELETE FROM items WHERE id IN ${sqlList(targets.ids)}`)));
  return { items_deleted: itemsDeleted, ref_rows_deleted: refRows, images_deleted: imagesDeleted, blocked };
}
