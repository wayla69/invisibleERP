// drizzle-orm 0.45 wraps every driver error in a `DrizzleQueryError` whose own `.code` is NOT a SQLSTATE —
// the original postgres-js / PGlite error (carrying the SQLSTATE `code`, `constraint`, `detail`, …) is nested
// under `.cause`. On 0.36 the driver error was surfaced directly, so call-sites read `e.code` as the SQLSTATE.
// These helpers walk the `.cause` chain to recover the underlying driver error, so unique-violation retries /
// dedup logic / the global error→HTTP mapper keep working across the 0.36→0.45 bump (and on 0.36 too: an
// unwrapped error is matched on the first hop).
export interface PgErrorLike {
  code?: string;
  constraint?: string;
  constraint_name?: string;
  detail?: string;
  table?: string;
  message?: string;
}

const SQLSTATE = /^[0-9]{2}[0-9A-Z]{3}$/;

// Recover the underlying driver error (the one whose `code` is a SQLSTATE) from a possibly-wrapped error.
export function pgError(e: unknown): PgErrorLike | undefined {
  let cur: any = e;
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    if (typeof cur.code === 'string' && SQLSTATE.test(cur.code)) return cur as PgErrorLike;
    cur = cur.cause;
  }
  return undefined;
}

export function pgErrorCode(e: unknown): string | undefined {
  return pgError(e)?.code;
}

// unique_violation (23505) — the common "row already exists" / retry-on-collision case.
export function isUniqueViolation(e: unknown): boolean {
  return pgErrorCode(e) === '23505';
}
