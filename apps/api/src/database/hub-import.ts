// Store-hub snapshot importer (LAN-first Phase 1, docs/41).
//
// Seeds a FRESH hub database (migrations already applied — the api container runs db:migrate on boot)
// from a signed snapshot exported by the cloud's `GET /api/hub/snapshot`. Verifies the HMAC before
// touching the database, inserts every row with its ORIGINAL id (id-stable across cloud⇄hub — printed
// table QR tokens keep working and the Phase-2 sync-up can reference the same rows), then bumps each
// serial sequence past the imported max. Idempotent: re-importing a newer snapshot upserts in place.
//
// CLI (on the hub box):  pnpm --filter @ierp/api db:hub:import <snapshot.json>
//   env: DATABASE_URL (hub DB), HUB_SYNC_SECRET (must match the cloud), optional HUB_ADMIN_PASSWORD
//   (creates/rotates a local `hubadmin` Admin so the box is administrable without cloud credentials).
//
// The core is exported as a plain function over a drizzle instance so the `hub-snapshot` cutover
// harness can prove the export→import round-trip on PGlite.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import {
  tenants, users, userPermissions,
  menuCategories, menuItems, modifierGroups, modifierOptions, menuItemModifierGroups,
  buffetPackages, buffetPackageItems,
  kitchenStations, floorZones, diningTables,
} from './schema';

export interface HubImportResult {
  tenant_id: number;
  imported: Record<string, number>;
  skipped_users: boolean;
  hub_admin: string | null;
}

const FORMAT = 'ierp-hub-snapshot';

function verifySignature(snapshot: any, secret: string): void {
  if (snapshot?.format !== FORMAT || snapshot?.version !== 1) {
    throw new Error(`BAD_FORMAT: not a ${FORMAT} v1 file`);
  }
  const { counts: _c, signature, ...payload } = snapshot;
  const want = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  const a = Buffer.from(String(signature ?? ''), 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('BAD_SIGNATURE: snapshot signature does not verify — wrong HUB_SYNC_SECRET or tampered file');
  }
}

// JSON round-trips Dates to ISO strings; drizzle timestamp columns want Date. Cosmetic audit stamps
// (created_at/updated_at) are dropped so column defaults apply; meaningful ones are converted.
function cleanRow<T extends Record<string, any>>(row: T): T {
  const { createdAt, updatedAt, ...rest } = row;
  return rest as T;
}

export async function importHubSnapshot(db: any, snapshot: any, opts: { secret: string; hubAdminPasswordHash?: string | null }): Promise<HubImportResult> {
  verifySignature(snapshot, opts.secret);
  const d = snapshot.data ?? {};
  const t = d.tenant;
  if (!t?.id) throw new Error('BAD_SNAPSHOT: missing tenant');

  const upsert = async (table: any, rows: any[], transform?: (r: any) => any) => {
    for (const raw of rows ?? []) {
      const row = transform ? transform(raw) : cleanRow(raw);
      await db.insert(table).values(row).onConflictDoUpdate({ target: table.id, set: row });
    }
    return (rows ?? []).length;
  };

  const imported: Record<string, number> = {};

  // tenant first (every other row references it)
  const tenantRow = {
    id: t.id, code: t.code, name: t.name, orgId: t.org_id ?? null,
    taxId: t.tax_id ?? null, legalName: t.legal_name ?? null, branchCode: t.branch_code ?? null,
    vatRegistered: t.vat_registered ?? false, vatRate: t.vat_rate ?? undefined, taxCountry: t.tax_country ?? undefined,
    promptpayId: t.promptpay_id ?? null, defaultLanguage: t.default_language ?? undefined,
    functionalCurrency: t.functional_currency ?? undefined,
  };
  await db.insert(tenants).values(tenantRow).onConflictDoUpdate({ target: tenants.id, set: tenantRow });
  imported.tenants = 1;

  imported.menu_categories = await upsert(menuCategories, d.menu_categories);
  imported.menu_items = await upsert(menuItems, d.menu_items);
  imported.modifier_groups = await upsert(modifierGroups, d.modifier_groups);
  imported.modifier_options = await upsert(modifierOptions, d.modifier_options);
  imported.menu_item_modifier_groups = await upsert(menuItemModifierGroups, d.menu_item_modifier_groups);
  imported.buffet_packages = await upsert(buffetPackages, d.buffet_packages);
  imported.buffet_package_items = await upsert(buffetPackageItems, d.buffet_package_items);
  imported.kitchen_stations = await upsert(kitchenStations, d.kitchen_stations);
  imported.floor_zones = await upsert(floorZones, d.floor_zones);
  // runtime table status is NOT carried over — the hub starts a clean service (layout + qr_token kept)
  imported.dining_tables = await upsert(diningTables, d.dining_tables, (r) => ({ ...cleanRow(r), status: 'available' }));

  // Users only ship in a credentialed snapshot (password_hash is NOT NULL — a hash-less user row would
  // be a login-disabled trap). A catalog-only snapshot simply skips staff.
  const skippedUsers = !snapshot.includes_credentials;
  if (!skippedUsers) {
    for (const u of d.users ?? []) {
      const row = {
        id: u.id, username: u.username, role: u.role, tenantId: u.tenant_id, orgId: u.org_id ?? null,
        passwordHash: u.password_hash, mustChangePassword: u.must_change_password ?? false,
        pinHash: u.pin_hash ?? null, pinSetAt: u.pin_set_at ? new Date(u.pin_set_at) : null,
        locale: u.locale ?? null, isActive: u.is_active ?? true,
      };
      await db.insert(users).values(row).onConflictDoUpdate({ target: users.id, set: row });
      for (const perm of u.user_permissions ?? []) {
        await db.insert(userPermissions).values({ userId: u.id, perm }).onConflictDoNothing();
      }
    }
    imported.users = (d.users ?? []).length;
  }

  // Local break-glass admin for the box (optional) — lets the owner administer the hub without any
  // cloud credential ever being copied down. Caller passes the HASH (PasswordService.hash).
  let hubAdmin: string | null = null;
  if (opts.hubAdminPasswordHash) {
    const row = { username: 'hubadmin', role: 'Admin' as const, tenantId: t.id, passwordHash: opts.hubAdminPasswordHash, isActive: true };
    await db.insert(users).values(row).onConflictDoUpdate({ target: users.username, set: { passwordHash: opts.hubAdminPasswordHash, tenantId: t.id, isActive: true } });
    hubAdmin = 'hubadmin';
  }

  // Bump each serial past the imported max so hub-local inserts never collide with imported ids.
  for (const tbl of ['tenants', 'users', 'menu_categories', 'menu_items', 'modifier_groups', 'modifier_options',
    'menu_item_modifier_groups', 'buffet_packages', 'buffet_package_items', 'kitchen_stations', 'floor_zones', 'dining_tables']) {
    await db.execute(sql.raw(
      `SELECT setval(pg_get_serial_sequence('${tbl}','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM "${tbl}"), 1))`,
    ));
  }

  return { tenant_id: Number(t.id), imported, skipped_users: skippedUsers, hub_admin: hubAdmin };
}

// ── CLI ──
async function main() {
  const file = process.argv[2];
  const url = process.env.DATABASE_URL;
  const secret = process.env.HUB_SYNC_SECRET;
  if (!file) { console.error('usage: db:hub:import <snapshot.json>'); process.exit(2); }
  if (!url) { console.error('DATABASE_URL is required'); process.exit(2); }
  if (!secret) { console.error('HUB_SYNC_SECRET is required (must match the cloud that signed the snapshot)'); process.exit(2); }

  const [{ default: postgres }, { drizzle }, { PasswordService }] = await Promise.all([
    import('postgres'), import('drizzle-orm/postgres-js'), import('../modules/auth/password.service'),
  ]);
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    const adminPw = process.env.HUB_ADMIN_PASSWORD;
    const hash = adminPw ? await new PasswordService().hash(adminPw) : null;
    const res = await importHubSnapshot(db, snapshot, { secret, hubAdminPasswordHash: hash });
    console.log(`✅ hub import complete — tenant ${res.tenant_id}`);
    for (const [k, v] of Object.entries(res.imported)) console.log(`   ${k}: ${v}`);
    if (res.skipped_users) console.log('   ⚠ users skipped (catalog-only snapshot — export with include_credentials=1 for staff logins)');
    if (res.hub_admin) console.log(`   local admin: ${res.hub_admin}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('❌ hub import failed:', e.message ?? e); process.exit(1); });
}
