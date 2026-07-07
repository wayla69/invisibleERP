// Master-data change history (master-data audit Phase 6). Shapes raw data_change_log rows (ITGC-AC-14,
// captured append-only by the DB trigger log_data_change) into a per-record, field-level timeline for a
// steward. Sensitive/encrypted columns are masked — the audit shows THAT they changed (who/when), not the
// PII value (which is stored as ciphertext in the row image anyway; masking avoids surfacing even that).

const SENSITIVE_COLS = new Set(['tax_id', 'bank_account', 'address', 'notes', 'password_hash', 'address_line1']);
const MASK = '•••';

function maskVal(col: string, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  return SENSITIVE_COLS.has(col) ? MASK : v;
}

export interface RawChangeRow {
  ts: Date | string | null; op: string | null; actor: string | null;
  changedColumns: string[] | null; oldValue: any; newValue: any;
}

/** Turn append-only change-log rows into a friendly timeline: created / deleted / per-field old→new (masked). */
interface FieldChange { field: string; old: unknown; new: unknown }

export function shapeChangeHistory(rows: RawChangeRow[]) {
  return rows.map((r) => {
    const op = r.op ?? '';
    const empty: FieldChange[] = [];
    if (op === 'INSERT') return { ts: r.ts, action: 'created', actor: r.actor, changes: empty };
    if (op === 'DELETE') return { ts: r.ts, action: 'deleted', actor: r.actor, changes: empty };
    const cols = r.changedColumns ?? [];
    const changes = cols
      .filter((c) => c !== 'id' && c !== 'created_at' && c !== 'tenant_id')
      .map((c) => ({ field: c, old: maskVal(c, r.oldValue?.[c]), new: maskVal(c, r.newValue?.[c]) }));
    return { ts: r.ts, action: 'updated', actor: r.actor, changes };
  }).filter((e) => e.action !== 'updated' || e.changes.length > 0);
}
