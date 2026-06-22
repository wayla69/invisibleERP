import type { Role } from './enums.js';

// The 37 fine-grained permission keys (ALL_PERMISSIONS in the legacy app) — the LIVE RBAC system.
// Tokens gate nav routes; ported verbatim. Admin bypasses to all.
export const PERMISSIONS = [
  'pos', 'dashboard', 'order_mgt', 'claim_mgt', 'crm', 'users', 'warehouse', 'procurement',
  'creditors', 'ar', 'delivery', 'returns', 'pricelist', 'lots', 'locations', 'promos', 'mobile',
  'images', 'masterdata', 'bom_master', 'planner', 'exec', 'order_cust', 'cust_dash',
  'cust_inventory', 'cust_pos', 'cust_bom', 'cust_variance', 'loyalty', 'survey',
  'cust_my_crm', 'cust_my_suppliers', 'cust_my_pos', 'cust_my_users', 'marketing', 'track', 'ai_chat',
  'approvals', // Phase 15 — approval-workflow actions (my-approvals / act / delegations)
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// ── Module enable/disable (system-wide feature flags) ──────────────────────
// A "module" maps 1:1 to a permission key. An admin can switch whole modules
// off system-wide; disabled modules vanish from every user's nav and are
// blocked at the API. These can never be disabled (admins must keep access).
export const ALWAYS_ON_MODULES: Permission[] = ['users'];
export const MODULE_KEYS: Permission[] = [...PERMISSIONS];

// PERM_GROUPS taxonomy (from the legacy User-Management page) — preserve the grouping for the admin UI.
export const PERM_GROUPS: Record<string, Permission[]> = {
  'Customer Portal': ['order_cust', 'cust_pos', 'cust_dash', 'cust_inventory', 'cust_bom', 'cust_variance', 'loyalty', 'survey', 'track'],
  'My Business': ['cust_my_crm', 'cust_my_suppliers', 'cust_my_pos', 'cust_my_users'],
  'Sales & Orders': ['pos', 'order_mgt', 'claim_mgt', 'crm', 'delivery', 'returns', 'pricelist', 'promos'],
  'Dashboard & Analytics': ['dashboard', 'exec', 'planner', 'marketing'],
  'Warehouse': ['warehouse', 'lots', 'locations', 'mobile', 'images'],
  'Finance & AR/AP': ['ar', 'creditors'],
  'Procurement': ['procurement'],
  'Administration': ['masterdata', 'bom_master', 'users', 'ai_chat', 'approvals'],
};

// Canonical role → default permission seed (init_db DEFAULT_PERMS, verbatim).
// Admin is resolved to ALL permissions in code (not data-driven) — see resolvePermissions().
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  Admin: [...PERMISSIONS],
  Sales: ['pos', 'dashboard', 'exec', 'order_mgt', 'claim_mgt', 'crm', 'ar', 'delivery', 'returns', 'pricelist', 'promos', 'marketing', 'planner', 'approvals'],
  Customer: ['order_cust', 'cust_pos', 'cust_dash', 'cust_inventory', 'cust_bom', 'cust_variance', 'loyalty', 'survey', 'track', 'cust_my_crm', 'cust_my_suppliers', 'cust_my_pos', 'cust_my_users'],
  Warehouse: ['warehouse', 'lots', 'locations', 'mobile', 'images', 'masterdata'],
  Procurement: ['procurement', 'creditors', 'ar', 'delivery', 'masterdata', 'approvals'],
  Planner: ['dashboard', 'exec', 'warehouse', 'procurement', 'planner', 'masterdata', 'approvals'],
};

/**
 * Permission resolution (parity-critical precedence — get_user_perms):
 *   1. Admin → ALL permissions
 *   2. per-user override (if non-empty) takes precedence over role
 *   3. role defaults
 */
export function resolvePermissions(role: Role, userOverride?: Permission[] | null): Permission[] {
  if (role === 'Admin') return [...PERMISSIONS];
  if (userOverride && userOverride.length > 0) return userOverride;
  return DEFAULT_ROLE_PERMISSIONS[role] ?? [];
}

// Permission → nav route (V2 App Router). null = no direct page (handled inside another).
export const PERM_TO_ROUTE: Partial<Record<Permission, string>> = {
  pos: '/pos', order_mgt: '/orders', claim_mgt: '/claims', crm: '/customers',
  dashboard: '/dashboard', exec: '/executive', planner: '/planner',
  warehouse: '/warehouse', lots: '/lots', locations: '/locations', mobile: '/mobile-scan',
  images: '/images', masterdata: '/master-data', bom_master: '/bom-master',
  procurement: '/procurement', creditors: '/creditors', ar: '/ar',
  delivery: '/delivery', returns: '/returns', pricelist: '/price-list',
  promos: '/promotions', marketing: '/marketing', users: '/admin/users', ai_chat: '/assistant',
  // portal
  order_cust: '/order', cust_pos: '/pos', cust_dash: '/dashboard', cust_inventory: '/inventory',
  cust_bom: '/bom', cust_variance: '/variance', loyalty: '/loyalty', survey: '/survey', track: '/track',
  cust_my_crm: '/my/customers', cust_my_suppliers: '/my/suppliers', cust_my_pos: '/my/purchase-orders', cust_my_users: '/my/users',
  approvals: '/approvals',
};
