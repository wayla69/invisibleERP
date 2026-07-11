import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  ArrowLeftRight,
  BadgeCheck,
  BarChart3,
  Banknote,
  BellRing,
  Bookmark,
  BookOpen,
  BookText,
  CalendarClock,
  CalendarRange,
  Trash2,
  Vault,
  Bot,
  Disc3,
  Handshake,
  Boxes,
  Briefcase,
  Cable,
  Building2,
  Calculator,
  Ship,
  Camera,
  CheckCheck,
  ChefHat,
  CircleDollarSign,
  KeyRound,
  ClipboardCheck,
  ListChecks,
  ClipboardList,
  Code,
  Coins,
  CreditCard,
  Rocket,
  Database,
  FileMinus,
  FileScan,
  FileCheck,
  FileSignature,
  FileSpreadsheet,
  FileText,
  Globe,
  Gift,
  HandCoins,
  Award,
  FlaskConical,
  Factory,
  FolderKanban,
  Network,
  UserPlus,
  GraduationCap,
  Goal,
  Landmark,
  Layers,
  ListTree,
  LayoutDashboard,
  Gauge,
  Lock,
  LayoutTemplate,
  LifeBuoy,
  ShieldCheck,
  Filter,
  Megaphone,
  Route,
  MessageSquare,
  Package,
  PackagePlus,
  Palette,
  PieChart,
  ReceiptText,
  RotateCcw,
  Scale,
  ScanLine,
  ScrollText,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  ShoppingBag,
  ShoppingCart,
  Star,
  Printer,
  Store,
  Target,
  Timer,
  Truck,
  Upload,
  UserCog,
  Users,
  Utensils,
  Wallet,
  Wand2,
  Webhook,
  Warehouse,
  Workflow,
  Wrench,
  IdCard,
  LineChart,
  PackageCheck,
  PiggyBank,
  Lightbulb,
  Tag,
} from 'lucide-react';

/** Top-level workspace. The internal app is split into two surfaces selectable via the sidebar
 *  switcher: POS (front-of-house / store ops) and ERP (back office). The customer PORTAL_NAV is a
 *  separate third surface and is unaffected. Items/groups tagged with both workspaces are cross-listed. */
export type Workspace = 'erp' | 'pos';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  perms?: string[];
  /** Workspaces this item belongs to. Defaults to the parent group's `workspace` when omitted. */
  workspace?: Workspace[];
}

/** Optional third level: a collapsible sub-section inside a NavGroup. Used to break very long groups
 *  (e.g. System settings) into labelled, foldable sections without changing any route. */
export interface NavSubGroup {
  title: string;
  items: NavItem[];
  /** Whether the sub-section starts expanded. Defaults to `true`; set `false` for advanced/infrequent
   *  sections so the group opens compact. A saved user toggle (localStorage) overrides this. */
  defaultOpen?: boolean;
  /** Workspaces this sub-section belongs to. Items may override per-item. Defaults to the parent group's. */
  workspace?: Workspace[];
}

export interface NavGroup {
  title: string;
  /** Flat items rendered directly under the group label. Optional when the group uses `subgroups`. */
  items?: NavItem[];
  /** Optional collapsible sub-sections rendered after any flat `items`. */
  subgroups?: NavSubGroup[];
  /** Workspaces this group belongs to. Items may override per-item. Defaults to both. */
  workspace?: Workspace[];
}

export const WORKSPACES: { id: Workspace; label: string; icon: LucideIcon; home: string }[] = [
  { id: 'erp', label: 'ERP', icon: Building2, home: '/dashboard' },
  { id: 'pos', label: 'POS', icon: Store, home: '/pos-home' },
];

/** The landing route for a workspace. */
export const workspaceHome = (ws: Workspace): string => WORKSPACES.find((w) => w.id === ws)?.home ?? '/dashboard';

const BOTH: Workspace[] = ['erp', 'pos'];

/** Back-office navigation, grouped. `perms` gate visibility via hasPerm(); `workspace` gates the ERP/POS
 *  switcher. Restructured 2026-06-25 (see docs/15-ui-ux-menu-restructure-plan.md): clearer per-domain
 *  groups, a dedicated Loyalty group, and a `subgroups`-segmented System group. **Every `href` is
 *  unchanged** — this is a regrouping/relabelling only, never a route change.
 *  C3 (2026-06-28): all title/label strings are now i18n keys resolved via t() in app-shell. */
export const INTERNAL_NAV: NavGroup[] = [
  {
    title: 'nav.group.overview',
    workspace: BOTH,
    items: [
      { label: 'nav.dashboard', href: '/dashboard', icon: LayoutDashboard, perms: ['dashboard', 'exec'], workspace: ['erp'] },
      { label: 'nav.pos_home', href: '/pos-home', icon: Store, perms: ['pos', 'pos_sell', 'order_mgt', 'dashboard'], workspace: ['pos'] },
    ],
  },

  // ─── POS surface ────────────────────────────────────────────────────────────────────────────────
  {
    title: 'nav.group.pos_sales',
    workspace: ['pos'],
    items: [
      // pos_sell = primary sell perm; coarse 'pos' holders (e.g. Sales role) still pass via implication.
      { label: 'nav.pos_register', href: '/pos/register', icon: ShoppingCart, perms: ['pos_sell', 'pos', 'order_mgt'] },
      { label: 'nav.pos_orders', href: '/pos', icon: ReceiptText, perms: ['pos', 'order_mgt'] },
      // SoD R12 complement: AR staff (ar) and refund supervisors (pos_refund) must also reach /returns
      // to view the return record before acting. The "บันทึกคืนสินค้า" record button inside the page
      // is further gated on canRefund (pos_refund|pos|ar) — the nav perm only controls visibility.
      { label: 'nav.returns', href: '/returns', icon: RotateCcw, perms: ['returns', 'pos', 'order_mgt', 'ar', 'pos_refund'] },
      // SoD R08/R12: refund authorization is a supervisor duty (pos_refund), not a cashier duty (pos_sell).
      { label: 'nav.refund_auth', href: '/pos/refunds', icon: Banknote, perms: ['pos_refund', 'pos'] },
      { label: 'nav.giftcards', href: '/giftcards', icon: CreditCard, perms: ['pos', 'creditors', 'exec'] },
      { label: 'nav.tables', href: '/tables', icon: Utensils, perms: ['pos', 'order_mgt'] },
      { label: 'nav.reservations', href: '/reservations', icon: CalendarClock, perms: ['pos', 'order_mgt'] },
      { label: 'nav.tips', href: '/tips', icon: HandCoins, perms: ['order_mgt', 'exec', 'pos'] },
      { label: 'nav.kds', href: '/kds', icon: ChefHat, perms: ['pos'] },
      { label: 'nav.menu', href: '/menu', icon: BookOpen, perms: ['pos', 'order_mgt'] },
      { label: 'nav.buffet', href: '/buffet', icon: Timer, perms: ['pos', 'order_mgt', 'masterdata'] },
      { label: 'nav.pos_control', href: '/pos-control', icon: ClipboardList, perms: ['pos', 'order_mgt'] },
      // SoD R08: till management (open/close/variance) is pos_till — segregated from pos_sell cashier.
      { label: 'nav.till', href: '/pos/till', icon: CircleDollarSign, perms: ['pos_till', 'pos'] },
      { label: 'nav.close_of_day', href: '/pos/close-of-day', icon: ReceiptText, perms: ['pos', 'pos_till', 'pos_close'] },
      // Self-service: any POS staffer sets their own quick-login PIN (ITGC-AC-17).
      { label: 'nav.pos_pin', href: '/pos-pin', icon: KeyRound, perms: ['pos_sell', 'pos', 'pos_till', 'order_mgt'] },
      { label: 'nav.print', href: '/print', icon: Printer, perms: ['pos', 'order_mgt'] },
    ],
  },
  {
    title: 'nav.group.store',
    workspace: ['pos'],
    items: [
      { label: 'nav.claims', href: '/claims', icon: ShieldAlert, perms: ['claim_mgt'] },
      { label: 'nav.delivery', href: '/delivery', icon: Truck, perms: ['delivery'] },
      { label: 'nav.channels', href: '/channels', icon: Truck, perms: ['pos', 'order_mgt', 'exec'] },
    ],
  },
  {
    title: 'nav.group.devices',
    workspace: ['pos'],
    items: [
      { label: 'nav.peripherals', href: '/peripherals', icon: Cable, perms: ['pos', 'order_mgt'] },
      { label: 'nav.terminals', href: '/payments/terminals', icon: CreditCard, perms: ['pos', 'creditors', 'exec'] },
      { label: 'nav.payment_accounts', href: '/payments/accounts', icon: Wallet, perms: ['pos', 'order_mgt', 'exec'] },
    ],
  },
  {
    title: 'nav.group.restaurant',
    workspace: ['pos'],
    items: [
      { label: 'nav.food_cost', href: '/food-cost', icon: PieChart, perms: ['pos', 'order_mgt', 'masterdata', 'exec'] },
      { label: 'nav.restaurant_analytics', href: '/restaurant-analytics', icon: BarChart3, perms: ['dashboard', 'exec', 'planner', 'order_mgt'] },
      { label: 'nav.production_plan', href: '/production-plan', icon: Boxes, perms: ['pos', 'order_mgt', 'masterdata', 'planner', 'exec'] },
    ],
  },

  // ─── ERP: customers & commercial ────────────────────────────────────────────────────────────────
  {
    title: 'nav.group.crm',
    workspace: ['erp'],
    items: [
      // CRM-2 (docs/41): ONE sales-CRM workspace at /crm (kanban board + leads + accounts + contacts;
      // deep-linkable tabs /crm?tab=…; deal page /crm/deals/[oppNo]; account page /crm/accounts/[accountNo]).
      // The old /pipeline and /projects/crm pages now redirect here. The retail member CRM 360 (branch KPI,
      // member lookup, messaging) moved to /crm/members.
      { label: 'nav.crm_workspace', href: '/crm', icon: Target, perms: ['crm', 'marketing', 'exec', 'ar'] },
      { label: 'nav.crm_members', href: '/crm/members', icon: Users, perms: ['marketing', 'exec'] },
      { label: 'nav.customer_master', href: '/customers', icon: Users, perms: ['crm', 'ar', 'exec'] },
      { label: 'nav.cpq', href: '/cpq', icon: FileSignature, perms: ['marketing', 'exec'] },
      { label: 'nav.service', href: '/service', icon: LifeBuoy, perms: ['marketing', 'exec'] },
      { label: 'nav.service_renewals', href: '/service/renewals', icon: CalendarClock, perms: ['marketing', 'exec'] },
      { label: 'nav.warranty', href: '/service/warranty', icon: ShieldCheck, perms: ['marketing', 'exec'] },
      { label: 'nav.marketing', href: '/marketing', icon: Megaphone, perms: ['marketing'] },
      { label: 'nav.campaigns', href: '/campaigns', icon: Megaphone, perms: ['marketing', 'crm'] },
    ],
  },
  {
    // Loyalty runs at POS but is configured/analysed in ERP → BOTH. POS Ops is POS-only.
    title: 'nav.group.loyalty',
    workspace: BOTH,
    items: [
      { label: 'nav.pos_ops', href: '/pos-ops', icon: Star, perms: ['pos', 'loyalty', 'users', 'exec'], workspace: ['pos'] },
      { label: 'nav.loyalty_members', href: '/loyalty/members', icon: Star, perms: ['loyalty', 'marketing'] },
      { label: 'nav.loyalty_rewards', href: '/loyalty/rewards', icon: Gift, perms: ['loyalty', 'marketing'] },
      { label: 'nav.loyalty_missions', href: '/loyalty/missions', icon: Target, perms: ['loyalty', 'marketing'] },
      { label: 'nav.loyalty_wheels', href: '/loyalty/wheels', icon: Disc3, perms: ['loyalty', 'marketing'] },
      { label: 'nav.loyalty_campaigns', href: '/loyalty/campaigns', icon: Megaphone, perms: ['marketing', 'exec'] },
      { label: 'nav.loyalty_segments', href: '/loyalty/segments', icon: Filter, perms: ['marketing', 'exec'] },
      { label: 'nav.loyalty_journeys', href: '/loyalty/journeys', icon: Route, perms: ['marketing', 'exec'] },
      { label: 'nav.loyalty_partners', href: '/loyalty/partners', icon: Handshake, perms: ['loyalty', 'marketing'] },
      { label: 'nav.loyalty_analytics', href: '/loyalty/analytics', icon: BarChart3, perms: ['marketing', 'exec'] },
      // LYL-17 — review queue for member-submitted receipt photos (points post on approval)
      { label: 'nav.loyalty_receipt_approvals', href: '/loyalty/receipt-approvals', icon: ReceiptText, perms: ['crm_points_adjust', 'loyalty', 'exec'], workspace: ['erp'] },
      // previously unreachable from the sidebar (only typed-URL) — wired in per Phase 0 audit
      { label: 'nav.loyalty_settings', href: '/loyalty', icon: SlidersHorizontal, perms: ['loyalty', 'marketing'], workspace: ['erp'] },
    ],
  },
  {
    // dual-use commercial config: priced/branched back-office, used at POS → BOTH, kept together so it
    // reads as one coherent group in either surface.
    title: 'nav.group.pricing',
    workspace: BOTH,
    items: [
      // SoD R10: price/promo maintenance is a separate duty from selling (pos/order_mgt).
      // Only PricingManager (pricelist, promos) or exec/admin may reach this screen.
      { label: 'nav.pricing', href: '/pricing', icon: Coins, perms: ['pricelist', 'promos', 'exec'] },
      { label: 'nav.branches', href: '/branches', icon: Store, perms: ['branch', 'exec'] },
    ],
  },

  // ─── ERP: supply chain ──────────────────────────────────────────────────────────────────────────
  {
    title: 'nav.group.inventory',
    workspace: ['erp'],
    items: [
      { label: 'nav.inventory', href: '/inventory', icon: Package, perms: ['warehouse', 'dashboard', 'planner'] },
      // SoD R11: counting (wh_count) is separated from posting adjustments (wh_adjust).
      { label: 'nav.stocktake', href: '/stocktake', icon: ClipboardCheck, perms: ['wh_count', 'warehouse', 'mobile'] },
      // SoD R11: wh_adjust (Inventory Controller) posts variance from counts and approves write-offs.
      { label: 'nav.stock_adjustment', href: '/stock-adjustment', icon: SlidersHorizontal, perms: ['wh_adjust', 'warehouse'] },
      // INV-17: ABC-classified, cadence-driven blind cycle-count program (counting = wh_count; posting reuses /stock-adjustment).
      { label: 'nav.cycle_counts', href: '/stock-ops/cycle-counts', icon: ListChecks, perms: ['wh_count', 'wh_adjust', 'warehouse'] },
      { label: 'nav.waste', href: '/waste', icon: Trash2, perms: ['warehouse', 'pos', 'order_mgt'] },
      { label: 'nav.receiving', href: '/receiving', icon: PackageCheck, perms: ['wh_receive', 'warehouse'] },
      { label: 'nav.goods_issue', href: '/goods-issue', icon: ArrowLeftRight, perms: ['warehouse', 'mobile'] },
      // INV-2/INV-16: two-step inter-warehouse transfer ORDERS (ship→receive, in-transit GL + cutoff aging).
      { label: 'nav.transfer_orders', href: '/stock-ops/transfer-orders', icon: Truck, perms: ['wh_custody', 'warehouse'] },
      { label: 'nav.lots', href: '/lots', icon: Boxes, perms: ['lots', 'warehouse'] },
      { label: 'nav.quality_coa', href: '/quality/coa', icon: FlaskConical, perms: ['quality', 'quality_approve', 'exec'] },
      { label: 'nav.mobile_scan', href: '/mobile-scan', icon: ScanLine, perms: ['mobile', 'warehouse'] },
      { label: 'nav.images', href: '/images', icon: Camera, perms: ['images', 'masterdata'] },
      { label: 'nav.wms', href: '/wms', icon: Warehouse, perms: ['warehouse'] },
      { label: 'nav.costing', href: '/costing', icon: Calculator, perms: ['warehouse', 'exec'] },
      // INV-1 (COST-01) — landed-cost allocation voucher: apportion freight/duty/insurance/broker into unit cost.
      { label: 'nav.landed_cost', href: '/costing/landed-cost', icon: Ship, perms: ['procurement', 'wh_receive', 'exec'] },
      { label: 'nav.std_cost', href: '/costing/std-cost', icon: Layers, perms: ['masterdata', 'exec', 'planner'] },
      { label: 'nav.inventory_ledger', href: '/inventory-ledger', icon: Wallet, perms: ['warehouse', 'dashboard'] },
      { label: 'nav.replenishment', href: '/replenishment', icon: PackagePlus, perms: ['warehouse', 'planner'] },
    ],
  },
  {
    title: 'nav.group.procurement',
    workspace: ['erp'],
    items: [
      // Quick Capture (docs/34): any staffer holding a bill snaps/uploads it → AI extracts → NeedsReview
      // draft for Accounting. Low-risk `pr_raise` duty (never books/GL), cross-listed to BOTH surfaces.
      { label: 'nav.ap_capture', href: '/capture', icon: Camera, perms: ['pr_raise', 'procurement', 'creditors'], workspace: BOTH },
      // PR is company-wide (anyone can request) → cross-listed to BOTH surfaces so POS staff can raise one
      // without switching workspaces; buying (PO) + receiving (GR) stay role-segregated (SoD R03/R04).
      { label: 'nav.requisitions', href: '/requisitions', icon: FileText, perms: ['pr_raise', 'procurement', 'planner'], workspace: BOTH },
      // Friendly "shop" front-end for the same PR: browse the catalog by category → basket → checkout a PR.
      // Same low-risk pr_raise duty, cross-listed to BOTH so POS/store staff can order supplies too.
      { label: 'nav.shop', href: '/shop', icon: ShoppingCart, perms: ['pr_raise', 'procurement', 'planner'], workspace: BOTH },
      { label: 'nav.suppliers', href: '/inventory/suppliers', icon: Building2, perms: ['procurement', 'warehouse'] },
      { label: 'nav.purchase_orders', href: '/inventory/purchase-orders', icon: ReceiptText, perms: ['procurement'] },
      { label: 'nav.procurement', href: '/procurement', icon: ShoppingBag, perms: ['procurement'] },
      { label: 'nav.rfqs', href: '/procurement/rfqs', icon: ClipboardList, perms: ['procurement'] },
      { label: 'nav.po_match', href: '/procurement/match', icon: CheckCheck, perms: ['procurement'] },
      // scan → PO auto-map → automated 3-way match (EXP-10); booking the bill stays a creditors action
      { label: 'nav.ap_intake', href: '/procurement/ap-intake', icon: ScanLine, perms: ['procurement', 'creditors'] },
      { label: 'nav.supplier_scorecards', href: '/supplier-scorecards', icon: Award, perms: ['procurement', 'exec'] },
      // QMS-4 — Supplier Corrective Action Request (SCAR / 8D) register + QC-04 closure maker-checker.
      { label: 'nav.supplier_scar', href: '/quality/scar', icon: ClipboardCheck, perms: ['quality', 'quality_approve', 'procurement', 'creditors', 'exec'] },
      { label: 'nav.supplier_prices', href: '/supplier-prices', icon: Tag, perms: ['procurement', 'md_vendor', 'planner', 'exec'] },
      { label: 'nav.doc_ai', href: '/doc-ai', icon: FileScan, perms: ['procurement', 'creditors', 'exec'] },
      // vendor self-service surface — visible only to users granted the vendor_portal permission
      { label: 'nav.supplier_portal', href: '/supplier', icon: PackageCheck, perms: ['vendor_portal'] },
    ],
  },
  {
    title: 'nav.group.production',
    workspace: ['erp'],
    items: [
      { label: 'nav.bom', href: '/bom', icon: FlaskConical, perms: ['bom_master'] },
      { label: 'nav.manufacturing', href: '/manufacturing', icon: Factory, perms: ['bom_master', 'warehouse'] },
      { label: 'nav.production', href: '/production', icon: Network, perms: ['bom_master', 'warehouse', 'planner'] },
      { label: 'nav.aps_schedule', href: '/production/schedule', icon: CalendarRange, perms: ['bom_master', 'warehouse', 'planner'] },
      { label: 'nav.quality_ncr', href: '/quality/ncr', icon: ShieldAlert, perms: ['quality', 'quality_approve', 'exec'] },
      { label: 'nav.eam', href: '/eam', icon: Wrench, perms: ['exec', 'warehouse', 'creditors'] },
      { label: 'nav.capa', href: '/quality/capa', icon: ClipboardCheck, perms: ['quality', 'quality_approve', 'exec'] },
    ],
  },

  // ─── ERP: finance ───────────────────────────────────────────────────────────────────────────────
  // PEAK-style cycle grouping (see docs/16-peak-style-erp-convergence.md): the daily รายรับ/รายจ่าย
  // book sits on top, period-close GL next, then treasury; reporting + multi-entity/FX collapse by
  // default to keep the group compact. **No href/perms changed** — pure shelving (cf. doc 15 §2).
  {
    title: 'nav.group.finance',
    workspace: ['erp'],
    subgroups: [
      {
        title: 'nav.sub.ar_ap',
        items: [
          { label: 'nav.finance', href: '/finance', icon: Banknote, perms: ['ar', 'creditors', 'exec'] },
          { label: 'nav.customer_cards', href: '/finance/customers', icon: Users, perms: ['ar', 'exec'] },
          { label: 'nav.vendor_cards', href: '/finance/vendors', icon: Truck, perms: ['creditors', 'exec'] },
          // AP (book bills, request payment) = accounting/creditors on /finance; releasing the cash
          // (approve disbursement) = finance, on its own page (SoD R07 — approver ≠ requester).
          { label: 'nav.disbursements', href: '/disbursements', icon: Wallet, perms: ['approvals', 'gl_close', 'exec'] },
          { label: 'nav.credit_hold', href: '/finance/credit-hold', icon: ShieldAlert, perms: ['ar', 'crm', 'exec'] },
          { label: 'nav.advances', href: '/advances', icon: HandCoins, perms: ['creditors', 'exec'] },
          { label: 'nav.petty_cash', href: '/petty-cash', icon: HandCoins, perms: ['creditors', 'exec'] },
        ],
      },
      {
        title: 'nav.sub.ledger',
        items: [
          // SoD R05: gl_post (GlAccountant) can reach the journal/posting tabs;
          // gl_close (FinancialController) also reaches the JE-approval tab (guarded in-page).
          { label: 'nav.chart_of_accounts', href: '/chart-of-accounts', icon: ListTree, perms: ['gl_post', 'gl_close', 'gl_coa', 'approvals', 'exec', 'creditors', 'ar'] },
          { label: 'nav.accounting', href: '/accounting', icon: BookText, perms: ['gl_post', 'gl_close', 'approvals', 'exec', 'creditors', 'ar'] },
          { label: 'nav.revenue', href: '/revenue', icon: CircleDollarSign, perms: ['exec', 'ar'] },
          { label: 'nav.assets', href: '/assets', icon: Boxes, perms: ['exec', 'creditors', 'ar'] },
          { label: 'nav.leases', href: '/leases', icon: Scale, perms: ['exec', 'gl_post'] },
          { label: 'nav.deferred_tax', href: '/deferred-tax', icon: Calculator, perms: ['gl_close', 'gl_post', 'exec'] },
          { label: 'nav.cost_centers', href: '/cost-centers', icon: PieChart, perms: ['exec', 'masterdata'] },
          { label: 'nav.posting_rules', href: '/setup/posting-rules', icon: Route, perms: ['gl_posting_rules', 'exec'] },
          { label: 'nav.gl_schedules', href: '/gl-schedules', icon: CalendarClock, perms: ['gl_post', 'gl_close', 'exec'] },
          { label: 'nav.period_close', href: '/finance/period-close', icon: CalendarClock, perms: ['gl_close', 'exec'] },
        ],
      },
      {
        title: 'nav.sub.banking',
        items: [
          { label: 'nav.bank', href: '/bank', icon: Landmark, perms: ['exec', 'creditors', 'ar'] },
          { label: 'nav.cash_banking', href: '/cash-banking', icon: Vault, perms: ['exec', 'ar'] },
          // SoD R06: recon_prep (GlAccountant) prepares; approvals/gl_close (FinancialController) certifies.
          // The certify button is hidden in-page for recon_prep-only users.
          { label: 'nav.reconciliation', href: '/reconciliation', icon: Scale, perms: ['recon_prep', 'approvals', 'gl_close', 'exec', 'creditors', 'ar'] },
          { label: 'nav.approvals', href: '/approvals', icon: ClipboardCheck, perms: ['exec', 'approvals', 'creditors'] },
        ],
      },
      {
        title: 'nav.sub.fin_reports',
        items: [
          { label: 'nav.command_center', href: '/finance/command-center', icon: Gauge, perms: ['exec', 'fin_report', 'dashboard', 'ar', 'creditors'] },
          { label: 'nav.close_cockpit', href: '/finance/close-cockpit', icon: ClipboardCheck, perms: ['exec', 'fin_report', 'gl_close', 'dashboard'] },
          { label: 'nav.treasury', href: '/finance/treasury', icon: Vault, perms: ['exec', 'fin_report', 'ar', 'dashboard'] },
          { label: 'nav.segment_profit', href: '/finance/profitability', icon: PieChart, perms: ['exec', 'fin_report', 'dashboard'] },
          { label: 'nav.financial_statements', href: '/financial-statements', icon: FileText, perms: ['exec', 'fin_report', 'creditors', 'ar'] },
          { label: 'nav.financial_health', href: '/financial-health', icon: CircleDollarSign, perms: ['exec', 'dashboard', 'ar', 'creditors'] },
          { label: 'nav.consolidation', href: '/consolidation', icon: Layers, perms: ['exec'] },
        ],
      },
      {
        title: 'nav.sub.interco',
        defaultOpen: false, // advanced multi-entity / treasury — collapsed by default
        items: [
          { label: 'nav.intercompany', href: '/intercompany', icon: ArrowLeftRight, perms: ['exec', 'creditors'] },
          { label: 'nav.fx', href: '/fx', icon: Coins, perms: ['exec', 'creditors', 'ar'] },
        ],
      },
    ],
  },
  {
    title: 'nav.group.tax',
    workspace: ['erp'],
    items: [
      { label: 'nav.tax_invoices', href: '/tax/invoices', icon: FileText, perms: ['exec', 'ar', 'creditors'] },
      { label: 'nav.tax_reports', href: '/tax/reports', icon: FileSpreadsheet, perms: ['exec', 'ar', 'creditors'] },
      { label: 'nav.wht', href: '/tax/wht', icon: FileMinus, perms: ['exec', 'creditors'] },
      { label: 'nav.tax_utp', href: '/tax/utp', icon: Scale, perms: ['gl_close', 'gl_post', 'exec'] },
      // dual-use: the fiscal/e-Tax journal is generated at POS, reconciled in ERP → cross-listed
      { label: 'nav.pos_fiscal', href: '/pos-fiscal', icon: FileSpreadsheet, perms: ['exec', 'ar', 'pos'], workspace: BOTH },
    ],
  },
  {
    title: 'nav.group.hr',
    workspace: ['erp'],
    items: [
      { label: 'nav.hcm', href: '/hcm', icon: Users, perms: ['exec', 'users', 'creditors', 'hr', 'hr_admin'] },
      { label: 'hx.perf.nav_title', href: '/hcm/performance', icon: Award, perms: ['hr', 'hr_admin', 'exec'] },
      // HR-1 (docs/42) — org structure, positions & headcount governance (HR-01)
      { label: 'nav.hcm_org', href: '/hcm/org', icon: Network, perms: ['hr', 'hr_admin', 'exec'] },
      // HR-6 (docs/42 Wave 2) — compensation bands + benefits (HR-06 comp-change maker-checker within band)
      { label: 'nav.hcm_comp', href: '/hcm/comp', icon: Coins, perms: ['hr', 'hr_admin', 'exec'] },
      // HR-5 (docs/42) — onboarding/offboarding lifecycle & access-revocation completeness (HR-05)
      { label: 'nav.hcm_onboarding', href: '/hcm/onboarding', icon: ClipboardCheck, perms: ['hr', 'hr_admin', 'exec'] },
      // HR-4 (docs/42, Wave 2) — recruiting / ATS (HR-04)
      { label: 'hx.rec.nav_title', href: '/hcm/recruiting', icon: UserPlus, perms: ['hr', 'hr_admin', 'exec'] },
      // HR-7 (docs/42, Wave 3) — training & certifications (HR-07 mandatory-training / certification compliance)
      { label: 'hx.train.nav_title', href: '/hcm/training', icon: GraduationCap, perms: ['hr', 'hr_admin', 'exec'] },
      { label: 'nav.scheduling', href: '/scheduling', icon: CalendarRange, perms: ['pos', 'users', 'exec'] },
      { label: 'nav.ot_rules', href: '/labor/ot-rules', icon: Timer, perms: ['pos', 'users', 'exec'] },
      { label: 'nav.payroll', href: '/payroll', icon: Briefcase, perms: ['exec', 'users', 'creditors'] },
      // self-service is for every employee (incl. POS staff) → cross-listed to both surfaces
      { label: 'nav.ess', href: '/ess', icon: IdCard, perms: ['ess'], workspace: BOTH },
      // HR-8 (docs/42, Wave 3) — ESS profile self-service: profile-change requests (HR-08 maker-checker) +
      // personal documents + team directory. Cross-listed to every employee.
      { label: 'nav.hcm_ess', href: '/hcm/ess', icon: FileText, perms: ['ess', 'hr', 'hr_admin', 'exec'], workspace: BOTH },
      // manager surface: approve/reject employee expense claims (perm `approvals`, independent of `ess`)
      { label: 'nav.expense_approvals', href: '/expense-approvals', icon: ReceiptText, perms: ['approvals'], workspace: BOTH },
    ],
  },
  // ─── Project Management (PPM) — its own workspace home (docs/20 C1). URL-stable: hrefs unchanged. ───
  {
    title: 'nav.group.pm',
    workspace: ['erp'],
    items: [
      { label: 'nav.pm_portfolio', href: '/projects/portfolio', icon: LayoutDashboard, perms: ['exec', 'planner', 'ar'] },
      { label: 'nav.pm_action_center', href: '/projects/action-center', icon: BellRing, perms: ['exec', 'planner', 'ar'] },
      { label: 'nav.projects', href: '/projects', icon: FolderKanban, perms: ['exec', 'planner', 'ar'] },
      // Construction/real-estate vertical (docs/35): tender→award, progress billing (งวดงาน), subcontracts.
      { label: 'nav.pm_tenders', href: '/projects/tenders', icon: FileSignature, perms: ['proj_tender', 'marketing', 'exec'] },
      { label: 'nav.pm_billing', href: '/projects/billing', icon: ReceiptText, perms: ['proj_billing', 'ar', 'exec'] },
      { label: 'nav.pm_subcontracts', href: '/projects/subcontracts', icon: Handshake, perms: ['proj_subcon', 'procurement', 'exec'] },
      // CRM-2: /projects/crm merged into the /crm workspace (redirect kept for deep links); the Win/Loss
      // analytics dashboard stays here and is also linked from the /crm workspace header.
      { label: 'nav.pm_pipeline', href: '/projects/pipeline', icon: Target, perms: ['exec', 'planner', 'ar', 'crm'] },
      { label: 'nav.pm_close', href: '/projects/close', icon: Lock, perms: ['exec'] },
      { label: 'nav.pm_settings', href: '/projects/settings', icon: SlidersHorizontal, perms: ['exec', 'planner'] },
    ],
  },
  // ─── Real Estate (developer vertical, docs/35 P4). Permission-gated (re_sales) — invisible without it. ───
  {
    title: 'nav.group.realestate',
    workspace: ['erp'],
    items: [
      { label: 'nav.re_developments', href: '/realestate', icon: Building2, perms: ['re_sales', 're_contract_approve', 'exec'] },
    ],
  },
  {
    title: 'nav.group.planning',
    workspace: ['erp'],
    items: [
      { label: 'nav.planning', href: '/planning', icon: Goal, perms: ['exec', 'planner'] },
      { label: 'nav.budget', href: '/budget', icon: PiggyBank, perms: ['exec', 'planner'] },
      { label: 'nav.demand', href: '/demand', icon: LineChart, perms: ['exec', 'planner', 'warehouse'] },
      { label: 'nav.profitability', href: '/profitability', icon: PieChart, perms: ['exec', 'marketing'] },
      { label: 'nav.insights', href: '/insights', icon: Lightbulb, perms: ['exec', 'dashboard', 'planner', 'warehouse'] },
      { label: 'nav.bi', href: '/bi', icon: BarChart3, perms: ['exec', 'dashboard'] },
      { label: 'nav.query', href: '/query', icon: BarChart3, perms: ['exec', 'dashboard', 'masterdata'] },
      { label: 'nav.nl_analytics', href: '/nl-analytics', icon: MessageSquare, perms: ['exec', 'dashboard', 'masterdata'] },
      { label: 'nav.scheduled_reports', href: '/scheduled-reports', icon: CalendarClock, perms: ['exec'] },
    ],
  },

  // ─── Cross-cutting (BOTH surfaces) ──────────────────────────────────────────────────────────────
  {
    title: 'nav.group.controls',
    workspace: BOTH, // approvals & SoD apply to both POS managers and back-office
    items: [
      { label: 'nav.workflow', href: '/workflow', icon: Workflow, perms: ['exec', 'creditors', 'procurement', 'users'] },
      { label: 'nav.sod', href: '/sod', icon: ShieldAlert, perms: ['exec', 'users'] },
      { label: 'nav.sod_register', href: '/admin/sod', icon: ShieldCheck, perms: ['exec', 'users'] },
      { label: 'nav.audit', href: '/audit', icon: ScrollText, perms: ['users'] },
      { label: 'nav.controls', href: '/controls', icon: ShieldAlert, perms: ['exec', 'users', 'creditors'] },
      { label: 'nav.control_console', href: '/controls/rcm', icon: ClipboardCheck, perms: ['exec', 'users'] },
      { label: 'nav.governance', href: '/governance', icon: Landmark, perms: ['exec', 'users'] },
      { label: 'nav.ops', href: '/ops', icon: Activity, perms: ['exec', 'users'] },
    ],
  },
  {
    title: 'nav.group.ai',
    workspace: BOTH,
    items: [
      { label: 'nav.assistant', href: '/assistant', icon: Bot, perms: ['ai_chat', 'dashboard'] },
      { label: 'nav.ai_actions', href: '/ai-actions', icon: Bot, perms: ['approvals', 'ai_chat'] },
      { label: 'nav.copilot', href: '/copilot', icon: Bot, perms: ['ai_chat', 'dashboard'] },
    ],
  },
  {
    // settings/users/master-data are reachable from either workspace. Segmented into collapsible
    // sub-sections so the (formerly 22-item flat) System group is scannable.
    title: 'nav.group.settings',
    workspace: BOTH,
    subgroups: [
      {
        title: 'nav.sub.master_data',
        items: [
          { label: 'nav.master_data', href: '/master-data', icon: Database, perms: ['masterdata'] },
          { label: 'nav.masterdata_changes', href: '/masterdata/change-requests', icon: ShieldCheck, perms: ['masterdata', 'md_vendor', 'exec'] },
          { label: 'nav.item_categories', href: '/setup/item-categories', icon: Layers, perms: ['md_item', 'masterdata', 'exec'] },
          { label: 'nav.tax_codes', href: '/setup/tax-codes', icon: Coins, perms: ['md_config', 'masterdata', 'exec'] },
          { label: 'nav.item_posting', href: '/setup/items', icon: Boxes, perms: ['md_item', 'masterdata', 'exec'] },
          { label: 'nav.warehouse_accounts', href: '/setup/warehouses', icon: Warehouse, perms: ['md_item', 'masterdata', 'exec'] },
          { label: 'nav.custom_fields', href: '/custom-fields', icon: SlidersHorizontal, perms: ['masterdata', 'users', 'exec'] },
          { label: 'nav.custom_objects', href: '/custom-objects', icon: Boxes, perms: ['masterdata', 'users', 'exec'] },
          { label: 'nav.object_layouts', href: '/object-layouts', icon: LayoutTemplate, perms: ['masterdata', 'users', 'exec'] },
          { label: 'nav.saved_views', href: '/saved-views', icon: Bookmark, perms: ['dashboard', 'exec', 'masterdata', 'warehouse', 'pos'] },
        ],
      },
      {
        title: 'nav.sub.customise',
        defaultOpen: false, // advanced configuration — collapsed by default
        items: [
          { label: 'nav.alerts', href: '/alerts', icon: BellRing, perms: ['masterdata', 'users', 'exec', 'dashboard'] },
          { label: 'nav.automation', href: '/automation', icon: Workflow, perms: ['masterdata', 'users', 'exec'] },
          { label: 'nav.ai_config', href: '/ai-config', icon: Wand2, perms: ['masterdata', 'users', 'exec'] },
          { label: 'nav.dashboard_designer', href: '/dashboard-designer', icon: LayoutTemplate, perms: ['users', 'exec'] },
          { label: 'nav.document_templates', href: '/document-templates', icon: LayoutTemplate, perms: ['users', 'exec'] },
          { label: 'nav.theme', href: '/theme', icon: Palette, perms: ['users', 'exec'] },
          { label: 'nav.labs', href: '/settings/labs', icon: SlidersHorizontal, perms: ['md_config', 'exec', 'users'] },
        ],
      },
      {
        title: 'nav.sub.integrations',
        defaultOpen: false, // integration/developer tooling — collapsed by default
        items: [
          { label: 'nav.connectors', href: '/connectors', icon: Cable, perms: ['users', 'exec'] },
          { label: 'nav.messaging_providers', href: '/settings/messaging', icon: MessageSquare, perms: ['users', 'exec'] },
          { label: 'nav.webhooks', href: '/webhooks', icon: Webhook, perms: ['users'] },
          { label: 'nav.developer', href: '/developer', icon: Code, perms: ['users'] },
          { label: 'nav.migration', href: '/migration', icon: Upload, perms: ['masterdata', 'users', 'exec'] },
          { label: 'nav.localization', href: '/localization', icon: Globe, perms: ['exec', 'users', 'masterdata'] },
          { label: 'nav.einvoice_nav', href: '/einvoice', icon: FileCheck, perms: ['exec', 'creditors', 'ar'] },
        ],
      },
      {
        title: 'nav.sub.admin',
        items: [
          { label: 'nav.onboarding', href: '/onboarding', icon: Rocket, perms: ['users', 'exec', 'dashboard'] },
          { label: 'nav.admin_users', href: '/admin/users', icon: UserCog, perms: ['users'] },
          { label: 'nav.access_recert', href: '/admin/access-recert', icon: ShieldCheck, perms: ['users'] },
          { label: 'nav.setup', href: '/setup', icon: BadgeCheck, perms: ['users'] },
          { label: 'nav.billing', href: '/billing', icon: CreditCard, perms: ['users'] },
          { label: 'nav.settings_page', href: '/settings', icon: Settings, perms: ['users'] },
        ],
      },
    ],
  },
];

/** Every NavItem in a group, flattening any `subgroups` after the flat `items`. Used wherever the whole
 *  group needs to be treated as one list (command palette, active-label lookup). */
export function allGroupItems(g: NavGroup): NavItem[] {
  return [...(g.items ?? []), ...(g.subgroups?.flatMap((s) => s.items) ?? [])];
}

/** Order groups by an admin-curated list of group `title`s (system-wide sidebar category order). Groups
 *  present in `order` sort by its index; groups absent (e.g. newly shipped) keep their code order, after the
 *  ordered ones. Stable, non-mutating. Empty/undefined `order` ⇒ unchanged. */
export function orderGroups<T extends { title: string }>(groups: T[], order?: string[]): T[] {
  if (!order || order.length === 0) return groups;
  const rank = new Map(order.map((k, i) => [k, i]));
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => {
      const ra = rank.get(a.g.title);
      const rb = rank.get(b.g.title);
      if (ra != null && rb != null) return ra - rb;
      if (ra != null) return -1;
      if (rb != null) return 1;
      return a.i - b.i;
    })
    .map((x) => x.g);
}

/** Order nav items within a container by an admin-curated list of `href`s (same fallback rules as
 *  orderGroups: known-order first, unknown keep code order). Stable, non-mutating. */
export function orderItems(items: NavItem[], order?: string[]): NavItem[] {
  if (!order || order.length === 0) return items;
  const rank = new Map(order.map((h, i) => [h, i]));
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const ra = rank.get(a.it.href);
      const rb = rank.get(b.it.href);
      if (ra != null && rb != null) return ra - rb;
      if (ra != null) return -1;
      if (rb != null) return 1;
      return a.i - b.i;
    })
    .map((x) => x.it);
}

/** Total visible-item count of a group across flat items + subgroups. */
function groupItemCount(g: NavGroup): number {
  return (g.items?.length ?? 0) + (g.subgroups?.reduce((n, s) => n + s.items.length, 0) ?? 0);
}

/** Filter a nav tree to one workspace: keep items whose workspace (item override, else sub-section, else
 *  group, else both) includes `ws`; drop empty sub-sections and then empty groups. */
export function navForWorkspace(nav: NavGroup[], ws: Workspace): NavGroup[] {
  const keep = (it: NavItem, parentWs?: Workspace[]) => (it.workspace ?? parentWs ?? BOTH).includes(ws);
  return nav
    .map((g) => ({
      ...g,
      items: (g.items ?? []).filter((it) => keep(it, g.workspace)),
      subgroups: (g.subgroups ?? [])
        .map((s) => ({ ...s, items: s.items.filter((it) => keep(it, s.workspace ?? g.workspace)) }))
        .filter((s) => s.items.length > 0),
    }))
    .filter((g) => groupItemCount(g) > 0);
}

/** Pick the landing workspace from a user's permissions: POS-only operators land in POS; everyone else
 *  (back-office, dual-role, Admin) lands in ERP. Admin/dual users can switch freely. */
const POS_PERMS = ['pos', 'pos_sell', 'pos_refund', 'pos_till', 'order_mgt', 'claim_mgt', 'delivery'];
const ERP_PERMS = ['ar', 'creditors', 'procurement', 'warehouse', 'wh_receive', 'exec', 'gl_post', 'gl_close', 'masterdata', 'bom_master', 'planner', 'users'];
export function defaultWorkspace(perms: string[] | undefined, role?: string): Workspace {
  if (role === 'Admin') return 'erp';
  const set = new Set(perms ?? []);
  const hasPos = POS_PERMS.some((p) => set.has(p));
  const hasErp = ERP_PERMS.some((p) => set.has(p));
  return hasPos && !hasErp ? 'pos' : 'erp';
}

/** Customer-portal navigation (no permission gating). */
export const PORTAL_NAV: NavGroup[] = [
  {
    title: 'nav.group.portal_menu',
    items: [
      { label: 'nav.portal_home', href: '/portal/dashboard', icon: LayoutDashboard },
      { label: 'nav.portal_pos', href: '/portal/pos', icon: Store },
      { label: 'nav.portal_inventory', href: '/portal/inventory', icon: Package },
      { label: 'nav.portal_track', href: '/portal/track', icon: Truck },
      { label: 'nav.portal_variance', href: '/portal/variance', icon: ClipboardCheck },
      { label: 'nav.portal_bom', href: '/portal/bom', icon: FlaskConical },
      { label: 'nav.portal_survey', href: '/portal/survey', icon: FileText },
      { label: 'nav.portal_loyalty', href: '/portal/loyalty', icon: Star },
      { label: 'nav.portal_my', href: '/portal/my', icon: Briefcase },
      { label: 'nav.portal_my_users', href: '/portal/my/users', icon: Users },
    ],
  },
];
