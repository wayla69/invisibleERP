import { resolvePermissions } from '@ierp/shared';

// Map api_keys.scopes (csv) → JwtUser.permissions. A scope is either a known alias, a wildcard
// ('*'/'admin' → the role-default set), or a literal permission key. Extracted from guards.ts into its own
// module so both the JwtAuthGuard (auth-time expansion) and ApiKeyService.issue (mint-time scope-bound, PE-1)
// share ONE definition — a machine key must never resolve to more than what issuance allowed.
export const SCOPE_ALIASES: Record<string, string[]> = {
  read: ['dashboard', 'exec', 'cust_dash', 'cust_inventory'],
  write: ['pos', 'order_mgt', 'warehouse', 'procurement'],
};

// A key is a machine principal — NEVER 'Admin' (no HQ bypass via key). '*'/'admin' expand to the Sales
// role-default set (the historical cap), not the full permission list.
export function scopesToPermissions(scopes: string[]): string[] {
  if (scopes.includes('*') || scopes.includes('admin')) {
    return resolvePermissions('Sales' as Parameters<typeof resolvePermissions>[0]);
  }
  const expanded = scopes.flatMap((s) => SCOPE_ALIASES[s] ?? [s]);
  return expanded.length ? expanded : resolvePermissions('Sales' as Parameters<typeof resolvePermissions>[0]);
}
