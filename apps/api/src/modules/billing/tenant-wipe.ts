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

// FK-safe fixpoint delete: a table blocked by a still-referencing row retries after its dependents clear;
// if a whole pass makes no progress, the transaction is left to roll back (caller's request tx).
export async function wipeTenantRefs(
  db: DrizzleDb, tenantId: number, tables: string[], preserveTables: Set<string>,
  blockedCode: string, blockedMessage: (names: string) => string, blockedMessageTh: (names: string) => string,
): Promise<{ targeted: number; rowsDeleted: number }> {
  let remaining = tables.filter((n) => !preserveTables.has(n));
  const targeted = remaining.length;
  let rowsDeleted = 0;
  while (remaining.length) {
    const blocked: string[] = [];
    for (const name of remaining) {
      const ident = sql.raw(`"${name.replace(/"/g, '""')}"`); // identifier from information_schema, not user input
      await db.execute(sql`SAVEPOINT tenant_wipe_tbl`);
      try {
        const r: any = await db.execute(sql`DELETE FROM ${ident} WHERE tenant_id = ${tenantId}`);
        await db.execute(sql`RELEASE SAVEPOINT tenant_wipe_tbl`);
        rowsDeleted += Number(r?.rowCount ?? r?.affectedRows ?? 0);
      } catch {
        await db.execute(sql`ROLLBACK TO SAVEPOINT tenant_wipe_tbl`);
        blocked.push(name);
      }
    }
    if (blocked.length === remaining.length) {
      const names = blocked.slice(0, 8).join(', ') + (blocked.length > 8 ? '…' : '');
      throw new ConflictException({ code: blockedCode, message: blockedMessage(names), messageTh: blockedMessageTh(names) });
    }
    remaining = blocked;
  }
  return { targeted, rowsDeleted };
}
