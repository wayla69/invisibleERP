/**
 * One-off, idempotent PII-at-rest encryption backfill (ITGC-AC-19, docs/27 R0-1).
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
import { blindIndex } from './encrypted-column';

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
  { table: 'customer_master', column: 'phone', t: schema.customerMaster, key: 'phone' },
  { table: 'customer_master', column: 'email', t: schema.customerMaster, key: 'email' },
  { table: 'employees', column: 'national_id', t: schema.employees, key: 'nationalId' },
  { table: 'employees', column: 'sso_no', t: schema.employees, key: 'ssoNo' },
  { table: 'employees', column: 'bank_account', t: schema.employees, key: 'bankAccount' },
  { table: 'payslips', column: 'national_id', t: schema.payslips, key: 'nationalId' },
  { table: 'vendors', column: 'tax_id', t: schema.vendors, key: 'taxId' },
  { table: 'vendors', column: 'bank_account', t: schema.vendors, key: 'bankAccount' },
  { table: 'pos_members', column: 'phone', t: schema.posMembers, key: 'phone' },
  { table: 'pos_members', column: 'email', t: schema.posMembers, key: 'email' },
];

// 0284 — blind-index backfill (phone/email, exact-match search). Runs BEFORE the ciphertext rewrite below,
// though order doesn't actually matter: `db.select()` decrypts/passes-through either way, so this always
// reads plaintext regardless of whether TARGETS above has already re-encrypted the row in a prior run.
const BIDX_TARGETS: { table: string; t: any; dataKey: string; bidxKey: string; bidxColumn: string }[] = [
  { table: 'pos_members', t: schema.posMembers, dataKey: 'phone', bidxKey: 'phoneBidx', bidxColumn: 'phone_bidx' },
  { table: 'pos_members', t: schema.posMembers, dataKey: 'email', bidxKey: 'emailBidx', bidxColumn: 'email_bidx' },
  { table: 'customer_master', t: schema.customerMaster, dataKey: 'phone', bidxKey: 'phoneBidx', bidxColumn: 'phone_bidx' },
  { table: 'customer_master', t: schema.customerMaster, dataKey: 'email', bidxKey: 'emailBidx', bidxColumn: 'email_bidx' },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set (copy .env.example → .env)');

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  // Tenant tables are FORCE-RLS'd (0002_rls.sql); the maintenance session runs with the bypass GUC on,
  // exactly like an HQ/Admin request — the backfill must see every tenant's rows to encrypt them.
  await client`select set_config('app.bypass_rls', 'on', false)`;

  let bidxTotal = 0;
  for (const { table, t, dataKey, bidxKey, bidxColumn } of BIDX_TARGETS) {
    const rows = await client.unsafe(`select id from "${table}" where "${bidxColumn}" is null`);
    let n = 0;
    for (const row of rows) {
      // Read through Drizzle (fromDriver decrypts / passes through legacy plaintext either way) so this
      // works whether or not TARGETS below has already re-encrypted the row on a prior run.
      const [full] = await db.select({ v: t[dataKey] }).from(t).where(eq(t.id, Number(row.id))).limit(1);
      const val = full?.v;
      if (!val) continue;
      await db.update(t).set({ [bidxKey]: blindIndex(String(val)) }).where(eq(t.id, Number(row.id)));
      n++;
    }
    if (n) console.log(`  ${table}.${bidxColumn}: backfilled ${n} row(s)`);
    bidxTotal += n;
  }

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

  console.log(total || bidxTotal ? `✅ backfill complete — ${total} value(s) encrypted at rest, ${bidxTotal} blind-index value(s) backfilled` : '✅ nothing to do — all PII columns already ciphertext at rest');
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
