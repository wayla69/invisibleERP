/**
 * Set category-themed placeholder images on the Invisible demo menu.
 *
 * Idempotent UPDATE of menu_items.image_url for the INVISIBLE tenant — use this
 * to add/refresh images on an already-seeded tenant without a full re-seed
 * (db:seed:demo also sets these at insert time for fresh seeds).
 *
 * Run:  pnpm --filter @ierp/api db:seed:demo:images
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from './schema';
import { menuImageDataUri } from './demo/menu-image';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try {
    (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p);
  } catch {
    /* ignore */
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    const tenant = (await tx.select().from(schema.tenants).where(eq(schema.tenants.code, 'INVISIBLE')))[0];
    if (!tenant) throw new Error('INVISIBLE tenant not found — run db:seed:demo first');
    const T = tenant.id;

    // map sku → category code (image theme keys off the category)
    const cats = await tx.select().from(schema.menuCategories).where(eq(schema.menuCategories.tenantId, T));
    const codeById = new Map(cats.map((c) => [c.id, c.code]));
    const items = await tx.select().from(schema.menuItems).where(eq(schema.menuItems.tenantId, T));

    let updated = 0;
    for (const it of items) {
      const catCode = it.categoryId != null ? codeById.get(it.categoryId) ?? '' : '';
      const uri = menuImageDataUri(catCode, it.nameEn || it.name);
      await tx
        .update(schema.menuItems)
        .set({ imageUrl: uri })
        .where(and(eq(schema.menuItems.tenantId, T), eq(schema.menuItems.id, it.id)));
      updated++;
    }
    console.log(`✅ Set images on ${updated} menu items (tenant ${T}).`);
  });

  await client.end();
}

main().catch((e) => {
  console.error('Demo image seed failed:', e);
  process.exit(1);
});
