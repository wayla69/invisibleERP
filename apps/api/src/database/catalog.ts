/**
 * Permission-catalog sync — the release-time half of the old monolithic seed.
 * Upserts the PERMISSIONS catalog + DEFAULT_ROLE_PERMISSIONS grants (onConflictDoNothing), so a release
 * that introduces a new permission key has its rows in place before the new code serves traffic.
 * Deliberately contains NOTHING credential- or tenant-creating — that stays in seed.ts behind the
 * docs/27 R0-3 prod guard (ALLOW_PROD_SEED=1 + SEED_ADMIN_PASSWORD).
 */
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS, type Role } from '@ierp/shared';
import * as schema from './schema';
import type { drizzle } from 'drizzle-orm/postgres-js';

const grpOf = (key: string) =>
  Object.entries(PERM_GROUPS).find(([, ks]) => (ks as string[]).includes(key))?.[0] ?? null;

export async function syncCatalog(db: ReturnType<typeof drizzle<typeof schema>>) {
  await db
    .insert(schema.permissions)
    .values(PERMISSIONS.map((key) => ({ key, grp: grpOf(key) })))
    .onConflictDoNothing();

  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    await db
      .insert(schema.rolePermissions)
      .values((perms as string[]).map((perm) => ({ role: role as Role, perm })))
      .onConflictDoNothing();
  }
}
