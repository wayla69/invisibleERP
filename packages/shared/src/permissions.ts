import type { Role } from './enums.js';

// The fine-grained permission keys (ALL_PERMISSIONS in the legacy app) — the LIVE RBAC system.
// Tokens gate nav routes; ported verbatim. Admin bypasses to all.
export const PERMISSIONS = [
  'pos', 'dashboard', 'order_mgt', 'claim_mgt', 'crm', 'users', 'warehouse', 'procurement',
  'pr_raise', // company-wide purchase-requisition raising (low-risk; PR ≠ PO. Implied by 'procurement'.)
  'creditors', 'ar', 'delivery', 'returns', 'pricelist', 'lots', 'locations', 'promos', 'mobile',
  'images', 'masterdata', 'bom_master', 'planner', 'exec', 'order_cust', 'cust_dash',
  'cust_inventory', 'cust_pos', 'cust_bom', 'cust_variance', 'loyalty', 'survey',
  'cust_my_crm', 'cust_my_suppliers', 'cust_my_pos', 'cust_my_users', 'marketing', 'track', 'ai_chat',
  'approvals', // Phase 15 — approval-workflow actions (my-approvals / act / delegations)
  'branch',    // Multi-branch — manage outlets, consolidate branch sales, master-bundle for offline POS
  'ess',           // Phase D3 — employee self-service (own timesheets/leave/payslips/expenses)
  'vendor_portal', // Phase D3 — supplier portal (own POs, acknowledge, submit invoice)
  // ── SoD sub-permissions (single-duty splits of coarse permissions; see PERMISSION_IMPLICATIONS) ──
  'pos_sell', 'pos_refund', 'pos_till', 'pos_close',
  'wh_receive', 'wh_adjust', 'wh_count', 'wh_custody',
  'gl_post', 'gl_close', 'gl_coa', 'gl_posting_rules', 'recon_prep', 'fin_report',
  'md_vendor', 'md_item', 'md_config',
  // ── CRM single-duty splits (loyalty back-office; see SoD R14–R16). Standalone granular perms: NOT implied
  //    by a coarse perm (so a transacting/portal role can't inherit them and trip R14–R16); assigned directly
  //    to SoD-clean CRM roles. Endpoints gate `crm_* OR coarse` so existing coarse roles keep working. ──
  'crm_member', 'crm_points_adjust', 'crm_reward', 'crm_campaign',
  // ── Project progress billing (งวดงาน) single-duty split (docs/35 P1, PROJ-15; SoD R17) — raising a
  //    progress claim is segregated from certifying it (bill work not done / withhold retention improperly). ──
  'proj_billing', 'proj_billing_certify',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// The single-duty sub-permissions (excluded from the system-wide module toggle list below — they are
// access-control granularity, not user-facing modules).
export const SUB_PERMISSIONS: Permission[] = [
  'pos_sell', 'pos_refund', 'pos_till', 'pos_close',
  'wh_receive', 'wh_adjust', 'wh_count', 'wh_custody',
  'gl_post', 'gl_close', 'gl_coa', 'gl_posting_rules', 'recon_prep', 'fin_report',
  'md_vendor', 'md_item', 'md_config',
  'crm_member', 'crm_points_adjust', 'crm_reward', 'crm_campaign',
  'proj_billing', 'proj_billing_certify',
];

// ── Module enable/disable (system-wide feature flags) ──────────────────────
// A "module" maps 1:1 to a permission key. An admin can switch whole modules
// off system-wide; disabled modules vanish from every user's nav and are
// blocked at the API. These can never be disabled (admins must keep access).
export const ALWAYS_ON_MODULES: Permission[] = ['users'];
export const MODULE_KEYS: Permission[] = PERMISSIONS.filter((p) => !SUB_PERMISSIONS.includes(p));

// PERM_GROUPS taxonomy (from the legacy User-Management page) — preserve the grouping for the admin UI.
export const PERM_GROUPS: Record<string, Permission[]> = {
  'Customer Portal': ['order_cust', 'cust_pos', 'cust_dash', 'cust_inventory', 'cust_bom', 'cust_variance', 'loyalty', 'survey', 'track'],
  'My Business': ['cust_my_crm', 'cust_my_suppliers', 'cust_my_pos', 'cust_my_users', 'branch'],
  'Sales & Orders': ['pos', 'order_mgt', 'claim_mgt', 'crm', 'delivery', 'returns', 'pricelist', 'promos'],
  'Dashboard & Analytics': ['dashboard', 'exec', 'planner', 'marketing'],
  'Warehouse': ['warehouse', 'lots', 'locations', 'mobile', 'images'],
  'Finance & AR/AP': ['ar', 'creditors', 'gl_coa', 'gl_posting_rules', 'proj_billing', 'proj_billing_certify'],
  'Procurement': ['procurement', 'pr_raise'],
  'Administration': ['masterdata', 'bom_master', 'users', 'ai_chat', 'approvals'],
  'Self-Service & Suppliers': ['ess', 'vendor_portal'],
};

// Canonical role → default permission seed (init_db DEFAULT_PERMS, verbatim).
// Admin is resolved to ALL permissions in code (not data-driven) — see resolvePermissions().
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  Admin: [...PERMISSIONS],
  // 'pr_raise' is seeded into every internal staff role: raising a purchase requisition is company-wide
  // (PR ≠ PO). Customer-portal roles are excluded; Procurement/Planner inherit it via implication.
  Sales: ['pos', 'dashboard', 'exec', 'order_mgt', 'claim_mgt', 'crm', 'ar', 'delivery', 'returns', 'pricelist', 'promos', 'marketing', 'planner', 'approvals', 'pr_raise'],
  Customer: ['order_cust', 'cust_pos', 'cust_dash', 'cust_inventory', 'cust_bom', 'cust_variance', 'loyalty', 'survey', 'track', 'cust_my_crm', 'cust_my_suppliers', 'cust_my_pos', 'cust_my_users', 'branch'],
  Warehouse: ['warehouse', 'lots', 'locations', 'mobile', 'images', 'masterdata', 'pr_raise'],
  // Procurement is now a SoD-clean buying role (0 conflicts): it buys (procurement) and may raise PRs
  // (pr_raise) — it no longer bundles paying (creditors), approving (approvals) or the vendor master
  // (masterdata). AP is the ApClerk's duty; vendor-master is MasterDataAdmin's (SoD R02/R03/R07/R13).
  Procurement: ['procurement', 'pr_raise', 'delivery'],
  // Planner is now a SoD-clean supply-chain/analytics role (0 conflicts): can raise and track POs
  // (procurement), view stock (wh_count/wh_custody/lots/locations), read financial reports (fin_report)
  // — but cannot approve workflow items (approvals), post/close GL (exec → R05), adjust stock
  // (wh_adjust → R11), receive goods (wh_receive → R04), or maintain master data (masterdata → R13).
  Planner: ['planner', 'dashboard', 'procurement', 'pr_raise', 'fin_report', 'wh_count', 'wh_custody', 'lots', 'locations'],
  // ── SoD-clean single-duty roles (the remediated design — each verified to produce 0 SoD conflicts) ──
  Cashier: ['pos_sell', 'pr_raise'],
  PosSupervisor: ['pos_refund', 'pos_till', 'pos_close', 'pr_raise'],
  ArClerk: ['ar', 'order_mgt', 'claim_mgt', 'delivery', 'pr_raise', 'proj_billing'],
  ApClerk: ['creditors', 'pr_raise'],
  Buyer: ['procurement'],
  WarehouseOperator: ['wh_receive', 'wh_custody', 'lots', 'locations', 'mobile', 'images', 'pr_raise'],
  InventoryController: ['wh_adjust', 'pr_raise'],
  StockCounter: ['wh_count', 'pr_raise'],
  GlAccountant: ['gl_post', 'recon_prep', 'fin_report', 'pr_raise'],
  FinancialController: ['gl_close', 'gl_coa', 'gl_posting_rules', 'approvals', 'fin_report', 'pr_raise', 'proj_billing_certify'],
  MasterDataAdmin: ['masterdata', 'bom_master', 'pr_raise'], // coarse 'masterdata' expands to md_vendor/item/config (conflict-free: no transactional perms)
  PricingManager: ['pricelist', 'promos', 'pr_raise'],
  CreditManager: ['crm', 'pr_raise'],
  ReturnsClerk: ['returns', 'pr_raise'],
  AccessAdmin: ['users'],
  ExecutiveViewer: ['fin_report', 'dashboard', 'planner', 'marketing', 'pr_raise'],
};

// ── SoD sub-permission model ────────────────────────────────────────────────
// A coarse permission IMPLIES its single-duty sub-permissions. This is the backward-compat bridge:
// existing roles/tokens keep working (a holder of 'pos' effectively has pos_sell/pos_refund/pos_till),
// while new granular roles can be granted just one sub-permission. The bundling is ALSO why coarse
// permissions are flagged by SoD analysis — e.g. 'pos' alone holds both sides of the sell/refund rule.
export const PERMISSION_IMPLICATIONS: Partial<Record<Permission, Permission[]>> = {
  pos: ['pos_sell', 'pos_refund', 'pos_till', 'pos_close'],
  warehouse: ['wh_receive', 'wh_adjust', 'wh_count', 'wh_custody'],
  exec: ['gl_post', 'gl_close', 'recon_prep', 'fin_report'],
  masterdata: ['md_vendor', 'md_item', 'md_config'],
  // A buyer or planner can always raise a requisition (PR is the lowest-risk step of P2P).
  procurement: ['pr_raise'],
  planner: ['pr_raise'],
};

// Expand a permission set to include every implied sub-permission (idempotent, deduped). The original
// coarse permission is RETAINED so legacy @Permissions('pos') checks still pass.
export function expandPermissions(perms: readonly Permission[]): Permission[] {
  const out = new Set<Permission>(perms);
  for (const p of perms) for (const sub of PERMISSION_IMPLICATIONS[p] ?? []) out.add(sub);
  return [...out];
}

/**
 * Permission resolution (parity-critical precedence — get_user_perms):
 *   1. Admin → ALL permissions
 *   2. per-user override (if non-empty) takes precedence over role
 *   3. role defaults
 * The resolved set is then EXPANDED so coarse permissions imply their sub-permissions.
 */
export function resolvePermissions(role: Role, userOverride?: Permission[] | null): Permission[] {
  const base: Permission[] =
    role === 'Admin' ? [...PERMISSIONS]
    : userOverride && userOverride.length > 0 ? userOverride
    : DEFAULT_ROLE_PERMISSIONS[role] ?? [];
  return expandPermissions(base);
}

// ── Segregation-of-Duties conflict rule registry ────────────────────────────
// A holder of duties on BOTH sides of a rule has a conflict. Rules reference single-duty sub-permissions
// and are evaluated against the EXPANDED permission set (so a coarse 'pos'/'exec'/'warehouse'/'masterdata'
// holder is correctly flagged, while a granular single-duty role is not).
export interface SodRule {
  id: string;
  dutyA: string;
  dutyB: string;
  a: Permission[];
  b: Permission[];
  severity: 'High' | 'Medium';
  risk: string;
  mitigation: string;
}

export const SOD_RULES: SodRule[] = [
  { id: 'R01', dutyA: 'Access administration', dutyB: 'Any transactional duty',
    a: ['users'], b: ['pos_sell', 'pos_refund', 'order_mgt', 'procurement', 'creditors', 'ar', 'returns', 'pricelist', 'promos', 'md_vendor', 'md_item', 'md_config', 'wh_receive', 'wh_adjust', 'gl_post'],
    severity: 'High', risk: 'Grant/modify own access and also transact — self-authorize and conceal.', mitigation: 'Isolate access admin to a dedicated non-transacting role; log permission changes; quarterly UAR.' },
  { id: 'R02', dutyA: 'Maintain vendor master', dutyB: 'Disburse AP / pay vendors',
    a: ['md_vendor'], b: ['creditors'], severity: 'High', risk: 'Create a fictitious vendor and pay it.', mitigation: 'Separate vendor-master maintenance from AP payment; review vendor-change report.' },
  { id: 'R03', dutyA: 'Raise purchase requisition / PO', dutyB: 'Approve & pay AP',
    a: ['procurement'], b: ['creditors'], severity: 'High', risk: 'Originate a purchase and pay it.', mitigation: 'Split buying from paying; route via maker-checker approvals.' },
  { id: 'R04', dutyA: 'Purchase ordering', dutyB: 'Goods receipt / custody',
    a: ['procurement'], b: ['wh_receive'], severity: 'High', risk: 'Order goods and confirm receipt — defeats 3-way match.', mitigation: 'Separate procurement from receiving; rely on 3-way match.' },
  { id: 'R05', dutyA: 'Post journal entries', dutyB: 'Close fiscal period / year',
    a: ['gl_post'], b: ['gl_close'], severity: 'High', risk: 'Post entries and close the period — conceal misstatement.', mitigation: 'Restrict close to a finance approver distinct from JE preparers; JE maker-checker.' },
  { id: 'R06', dutyA: 'Prepare reconciliation', dutyB: 'Certify reconciliation',
    a: ['recon_prep'], b: ['approvals'], severity: 'Medium', risk: 'Prepare and self-certify a reconciliation.', mitigation: 'Preparer must differ from certifier.' },
  { id: 'R07', dutyA: 'Initiate transactions', dutyB: 'Approve workflow items',
    a: ['procurement', 'pos_sell', 'ar', 'creditors', 'order_mgt'], b: ['approvals'], severity: 'High', risk: 'Initiate a transaction and approve it.', mitigation: 'Approver must differ from initiator; enforce in the approval engine.' },
  { id: 'R08', dutyA: 'Record sale', dutyB: 'Issue refund / reconcile till',
    a: ['pos_sell'], b: ['pos_refund', 'pos_till'], severity: 'High', risk: "'pos' bundles sell + refund/void + till close — one cashier can ring, refund and reconcile their own drawer.", mitigation: 'Split pos_sell / pos_refund / pos_till; manager auth for refund/void; independent till count.' },
  { id: 'R09', dutyA: 'Maintain customer / credit master', dutyB: 'Enter sales orders',
    a: ['crm', 'md_vendor'], b: ['pos_sell', 'order_mgt', 'order_cust'], severity: 'Medium', risk: 'Raise a credit limit then sell on credit.', mitigation: 'Separate credit-master maintenance from order entry; review credit-change report.' },
  { id: 'R10', dutyA: 'Maintain prices / promotions', dutyB: 'Enter sales',
    a: ['pricelist', 'promos'], b: ['pos_sell', 'order_mgt'], severity: 'Medium', risk: 'Set a price/discount and sell at it.', mitigation: 'Separate price/promo maintenance from selling; review price-override report.' },
  { id: 'R11', dutyA: 'Adjust inventory', dutyB: 'Stock custody & counting',
    a: ['wh_adjust'], b: ['wh_count'], severity: 'Medium', risk: "'warehouse' bundles adjust + count — conceal shrink via adjustments.", mitigation: 'Separate adjustment authority from physical count; independent variance approval.' },
  { id: 'R12', dutyA: 'Process returns', dutyB: 'Issue refund',
    a: ['returns'], b: ['pos_refund'], severity: 'Medium', risk: 'Process a return and issue the matching refund unchecked.', mitigation: 'Independent refund approval on returns; over-return guard + detective review.' },
  { id: 'R13', dutyA: 'Maintain master data / config', dutyB: 'Transact on it',
    a: ['md_item', 'md_config', 'bom_master'], b: ['pos_sell', 'order_mgt', 'procurement', 'creditors', 'ar'], severity: 'Medium', risk: 'Change config/master data and transact against it without review.', mitigation: 'Segregate config from operations; review master-data change log.' },
  // ── CRM / loyalty single-duty conflicts (Phase 4) — points are a TFRS-15 liability, so loyalty value
  //    issuance must be segregated from its use/creation just like cash duties. ──
  { id: 'R14', dutyA: 'Configure rewards / vouchers', dutyB: 'POS redemption at till',
    a: ['crm_reward'], b: ['pos_sell'], severity: 'High', risk: 'Create a reward/voucher and redeem it for oneself at the till.', mitigation: 'Separate reward-catalog configuration from POS redemption; review reward-change + redemption reports.' },
  { id: 'R15', dutyA: 'Manual points adjustment', dutyB: 'Member master maintenance',
    a: ['crm_points_adjust'], b: ['crm_member'], severity: 'High', risk: 'Enrol a ghost member and credit points to it.', mitigation: 'Separate member enrolment from points adjustment; over-threshold adjust routes via maker-checker approval.' },
  { id: 'R16', dutyA: 'Campaign issuance of point-bearing value', dutyB: 'Points adjustment',
    a: ['crm_campaign'], b: ['crm_points_adjust'], severity: 'High', risk: 'Self-issue loyalty value through two channels (campaign coupons + manual adjustment).', mitigation: 'Separate campaign issuance from points adjustment; review issuance + adjustment logs.' },
  { id: 'R17', dutyA: 'Raise progress claim (งวดงาน)', dutyB: 'Certify progress claim',
    a: ['proj_billing'], b: ['proj_billing_certify'], severity: 'High', risk: 'Raise and certify one’s own progress claim — bill work not done and withhold/release retention improperly.', mitigation: 'Separate claim preparer from certifier; maker-checker enforced in-app (SOD_SELF_APPROVAL, PROJ-15).' },
];

export interface SodConflict { ruleId: string; dutyA: string; dutyB: string; severity: 'High' | 'Medium'; permsHeld: Permission[]; }

// Detect SoD conflicts in a permission set (coarse or granular — the set is expanded first).
export function detectSodConflicts(perms: readonly Permission[]): SodConflict[] {
  const set = new Set<Permission>(expandPermissions(perms));
  const hits: SodConflict[] = [];
  for (const r of SOD_RULES) {
    const a = r.a.filter((p) => set.has(p));
    const b = r.b.filter((p) => set.has(p));
    if (a.length && b.length) {
      hits.push({ ruleId: r.id, dutyA: r.dutyA, dutyB: r.dutyB, severity: r.severity, permsHeld: [...new Set([...a, ...b])] });
    }
  }
  return hits;
}

// ── ITGC-AC-06: MFA policy ──────────────────────────────────────────────────
// Privileged / financially-significant duties that REQUIRE a second factor. A user whose EFFECTIVE
// permissions intersect this set (or who is an Admin) must enrol TOTP. Evaluated on the expanded set so
// a coarse 'exec'/'pos' holder is correctly captured. Cashiers/customers and read-only roles are exempt.
export const MFA_REQUIRED_PERMISSIONS: Permission[] = [
  'users',            // access administration
  'gl_post', 'gl_close', // journal posting / period close
  'creditors', 'ar',  // AP disbursement / AR
  'approvals',        // workflow approvals
  'md_vendor', 'md_config', // sensitive master data
];

// Does this role + override require MFA? (Admin always does.)
export function requiresMfa(role: Role, userOverride?: Permission[] | null): boolean {
  if (role === 'Admin') return true;
  const eff = new Set<Permission>(resolvePermissions(role, userOverride ?? null));
  return MFA_REQUIRED_PERMISSIONS.some((p) => eff.has(p));
}

// Permission → nav route (V2 App Router). null = no direct page (handled inside another).
export const PERM_TO_ROUTE: Partial<Record<Permission, string>> = {
  pos: '/pos', order_mgt: '/orders', claim_mgt: '/claims', crm: '/customers',
  dashboard: '/dashboard', exec: '/executive', planner: '/planner',
  warehouse: '/warehouse', lots: '/lots', locations: '/locations', mobile: '/mobile-scan',
  images: '/images', masterdata: '/master-data', bom_master: '/bom-master',
  procurement: '/procurement', pr_raise: '/requisitions', wh_receive: '/receiving',
  creditors: '/creditors', ar: '/ar',
  delivery: '/delivery', returns: '/returns', pricelist: '/price-list',
  promos: '/promotions', marketing: '/marketing', users: '/admin/users', ai_chat: '/assistant',
  // portal
  order_cust: '/order', cust_pos: '/pos', cust_dash: '/dashboard', cust_inventory: '/inventory',
  cust_bom: '/bom', cust_variance: '/variance', loyalty: '/loyalty', survey: '/survey', track: '/track',
  cust_my_crm: '/my/customers', cust_my_suppliers: '/my/suppliers', cust_my_pos: '/my/purchase-orders', cust_my_users: '/my/users',
  approvals: '/approvals',
  branch: '/branches',
};
