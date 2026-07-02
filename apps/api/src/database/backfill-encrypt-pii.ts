/**
 * One-off, idempotent PII-at-rest encryption backfill (ITGC-AC-19, docs/24 R0-1).
 * The `encryptedText` column type encrypts NEW writes and passes legacy plaintext through on read —
 * this script re-writes the legacy plaintext rows so they are ciphertext at rest too.
 * รัน: pnpm --filter @ierp/api db:backfill:pii   (อ่าน DATABASE_URL + APP_ENC_KEY จาก root .env)
 *
 * Idempotent: only rows whose stored value is NOT already `v1:…` are touched; re-running is a no-op.
 * Requires the same APP_ENC_KEY the API uses (the write path encrypts with it via the Drizzle column type).
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from './schema';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try {
    (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p);
  } catch {
    /* ignore */
  }
}

// (table name, plaintext column, drizzle table, drizzle column key) — every encryptedText column so far.
const TARGETS: { table: string; column: string; t: any; key: string }[] = [
  { table: 'customer_master', column: 'tax_id', t: schema.customerMaster, key: 'taxId' },
  { table: 'customer_master', column: 'notes', t: schema.customerMaster, key: 'notes' },
  { table: 'employees', column: 'national_id', t: schema.employees, key: 'nationalId' },
  { table: 'employees', column: 'sso_no', t: schema.employees, key: 'ssoNo' },
  { table: 'employees', column: 'bank_account', t: schema.employees, key: 'bankAccount' },
  { table: 'payslips', column: 'national_id', t: schema.payslips, key: 'nationalId' },
  { table: 'vendors', column: 'tax_id', t: schema.vendors, key: 'taxId' },
  { table: 'vendors', column: 'bank_account', t: schema.vendors, key: 'bankAccount' },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set (copy .env.example → .env)');

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  // Tenant tables are FORCE-RLS'd (0002_rls.sql); the maintenance session runs with the bypass GUC on,
  // exactly like an HQ/Admin request — the backfill must see every tenant's rows to encrypt them.
  await client`select set_config('app.bypass_rls', 'on', false)`;

  let total = 0;
  for (const { table, column, t, key } of TARGETS) {
    // Raw SQL on purpose: the schema read would DECRYPT (and passthrough plaintext), hiding which rows
    // are still plaintext at rest. `not like 'v1:%'` is the at-rest discriminator (crypto.ts format).
    const rows = await client.unsafe(
      `select id, "${column}" as val from "${table}" where "${column}" is not null and "${column}" <> '' and "${column}" not like 'v1:%'`,
    );
    for (const row of rows) {
      // Write the plaintext back through the Drizzle column type → toDriver encrypts it.
      await db.update(t).set({ [key]: String(row.val) } as any).where(eq(t.id, Number(row.id)));
    }
    if (rows.length) console.log(`  ${table}.${column}: encrypted ${rows.length} legacy row(s)`);
    total += rows.length;
  }

  console.log(total ? `✅ backfill complete — ${total} value(s) encrypted at rest` : '✅ nothing to do — all PII columns already ciphertext at rest');
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
