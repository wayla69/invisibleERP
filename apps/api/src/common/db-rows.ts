// Driver-shape shim for raw `db.execute(sql\`…\`)` results: node-postgres/PGlite return `{ rows: T[] }`
// while postgres-js returns `T[]` — call-sites were littered with `((res as any).rows ?? res) as any[]`.
// One typed helper instead (2.13 debt paydown). T defaults to a loose record because raw-SQL columns are
// snake_case names the caller narrows per use.
export function rowsOf<T = Record<string, any>>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  return (res as { rows?: T[] } | null | undefined)?.rows ?? [];
}
