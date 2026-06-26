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
  Camera,
  CheckCheck,
  ChefHat,
  CircleDollarSign,
  ClipboardCheck,
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
  Goal,
  Landmark,
  Layers,
  LayoutDashboard,
  LayoutTemplate,
  LifeBuoy,
  Megaphone,
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
 *  unchanged** — this is a regrouping/relabelling only, never a route change. */
export const INTERNAL_NAV: NavGroup[] = [
  {
    title: 'ภาพรวม',
    workspace: BOTH,
    items: [
      { label: 'แดชบอร์ด', href: '/dashboard', icon: LayoutDashboard, perms: ['dashboard', 'exec'], workspace: ['erp'] },
      { label: 'ภาพรวมหน้าร้าน', href: '/pos-home', icon: Store, perms: ['pos', 'pos_sell', 'order_mgt', 'dashboard'], workspace: ['pos'] },
    ],
  },

  // ─── POS surface ────────────────────────────────────────────────────────────────────────────────
  {
    title: 'ขายหน้าร้าน',
    workspace: ['pos'],
    items: [
      { label: 'ขายหน้าร้าน (Register)', href: '/pos/register', icon: ShoppingCart, perms: ['pos', 'order_mgt'] },
      { label: 'รายการออเดอร์', href: '/pos', icon: ReceiptText, perms: ['pos', 'order_mgt'] },
      { label: 'คืนสินค้า & คืนเงิน', href: '/returns', icon: RotateCcw, perms: ['returns', 'pos', 'order_mgt'] },
      { label: 'บัตรของขวัญ / เครดิตร้าน', href: '/giftcards', icon: CreditCard, perms: ['pos', 'creditors', 'exec'] },
      { label: 'โต๊ะ', href: '/tables', icon: Utensils, perms: ['pos', 'order_mgt'] },
      { label: 'จองโต๊ะ & รอคิว', href: '/reservations', icon: CalendarClock, perms: ['pos', 'order_mgt'] },
      { label: 'ทิปพนักงาน', href: '/tips', icon: HandCoins, perms: ['order_mgt', 'exec', 'pos'] },
      { label: 'ครัว (KDS)', href: '/kds', icon: ChefHat, perms: ['pos'] },
      { label: 'เมนูอาหาร', href: '/menu', icon: BookOpen, perms: ['pos', 'order_mgt'] },
      { label: 'บุฟเฟต์ (แพ็กเกจ)', href: '/buffet', icon: Timer, perms: ['pos', 'order_mgt', 'masterdata'] },
      { label: 'ควบคุม POS (พักบิล/อนุมัติ)', href: '/pos-control', icon: ClipboardList, perms: ['pos', 'order_mgt'] },
      { label: 'ปิดกะ (Z-Report)', href: '/pos/close-of-day', icon: ReceiptText, perms: ['pos', 'pos_till', 'pos_close'] },
      { label: 'ใบเสร็จ & งานพิมพ์', href: '/print', icon: Printer, perms: ['pos', 'order_mgt'] },
    ],
  },
  {
    title: 'ร้าน & การจัดส่ง',
    workspace: ['pos'],
    items: [
      { label: 'จัดการเคลม', href: '/claims', icon: ShieldAlert, perms: ['claim_mgt'] },
      { label: 'ใบส่งสินค้า', href: '/delivery', icon: Truck, perms: ['delivery'] },
      { label: 'ช่องทางเดลิเวอรี (Aggregators)', href: '/channels', icon: Truck, perms: ['pos', 'order_mgt', 'exec'] },
    ],
  },
  {
    title: 'อุปกรณ์ & การชำระเงิน',
    workspace: ['pos'],
    items: [
      { label: 'อุปกรณ์ฮาร์ดแวร์ (Peripherals)', href: '/peripherals', icon: Cable, perms: ['pos', 'order_mgt'] },
      { label: 'เครื่องรับบัตร & สรุปยอด', href: '/payments/terminals', icon: CreditCard, perms: ['pos', 'creditors', 'exec'] },
      { label: 'มัดจำ & บัญชีเครดิต (House accounts)', href: '/payments/accounts', icon: Wallet, perms: ['pos', 'order_mgt', 'exec'] },
    ],
  },
  {
    title: 'วิเคราะห์ร้านอาหาร',
    workspace: ['pos'],
    items: [
      { label: 'ต้นทุนอาหาร (Food cost)', href: '/food-cost', icon: PieChart, perms: ['pos', 'order_mgt', 'masterdata', 'exec'] },
      { label: 'วิเคราะห์ร้านอาหาร (Analytics)', href: '/restaurant-analytics', icon: BarChart3, perms: ['dashboard', 'exec', 'planner', 'order_mgt'] },
      { label: 'แผนการผลิต (Production plan)', href: '/production-plan', icon: Boxes, perms: ['pos', 'order_mgt', 'masterdata', 'planner', 'exec'] },
    ],
  },

  // ─── ERP: customers & commercial ────────────────────────────────────────────────────────────────
  {
    title: 'ลูกค้า & CRM',
    workspace: ['erp'],
    items: [
      { label: 'โอกาสการขาย', href: '/pipeline', icon: Target, perms: ['marketing', 'exec'] },
      { label: 'ใบเสนอราคา', href: '/cpq', icon: FileSignature, perms: ['marketing', 'exec'] },
      { label: 'บริการ & SLA', href: '/service', icon: LifeBuoy, perms: ['marketing', 'exec'] },
      { label: 'CRM 360', href: '/crm', icon: Users, perms: ['marketing', 'exec'] },
      { label: 'การตลาด', href: '/marketing', icon: Megaphone, perms: ['marketing'] },
      { label: 'แคมเปญ LINE (Automation)', href: '/campaigns', icon: Megaphone, perms: ['marketing', 'crm'] },
    ],
  },
  {
    // Loyalty runs at POS but is configured/analysed in ERP → BOTH. POS Ops is POS-only.
    title: 'ลอยัลตี้',
    workspace: BOTH,
    items: [
      { label: 'ลอยัลตี้ & แรงงาน (POS Ops)', href: '/pos-ops', icon: Star, perms: ['pos', 'loyalty', 'users', 'exec'], workspace: ['pos'] },
      { label: 'สมาชิก & แต้ม', href: '/loyalty/members', icon: Star, perms: ['loyalty', 'marketing'] },
      { label: 'ของรางวัล & คูปอง', href: '/loyalty/rewards', icon: Gift, perms: ['loyalty', 'marketing'] },
      { label: 'ภารกิจ & แสตมป์', href: '/loyalty/missions', icon: Target, perms: ['loyalty', 'marketing'] },
      { label: 'วงล้อนำโชค', href: '/loyalty/wheels', icon: Disc3, perms: ['loyalty', 'marketing'] },
      { label: 'แคมเปญ', href: '/loyalty/campaigns', icon: Megaphone, perms: ['marketing', 'exec'] },
      { label: 'พันธมิตร & สิทธิพิเศษ', href: '/loyalty/partners', icon: Handshake, perms: ['loyalty', 'marketing'] },
      { label: 'วิเคราะห์ลอยัลตี้', href: '/loyalty/analytics', icon: BarChart3, perms: ['marketing', 'exec'] },
      // previously unreachable from the sidebar (only typed-URL) — wired in per Phase 0 audit
      { label: 'ตั้งค่าลอยัลตี้', href: '/loyalty', icon: SlidersHorizontal, perms: ['loyalty', 'marketing'], workspace: ['erp'] },
    ],
  },
  {
    // dual-use commercial config: priced/branched back-office, used at POS → BOTH, kept together so it
    // reads as one coherent group in either surface.
    title: 'ราคา & สาขา',
    workspace: BOTH,
    items: [
      { label: 'กฎราคา & โปรโมชั่น', href: '/pricing', icon: Coins, perms: ['pos', 'order_mgt', 'exec'] },
      { label: 'สาขา & ยอดขายรวม (Branches)', href: '/branches', icon: Store, perms: ['branch', 'exec'] },
    ],
  },

  // ─── ERP: supply chain ──────────────────────────────────────────────────────────────────────────
  {
    title: 'สินค้าคงคลัง',
    workspace: ['erp'],
    items: [
      { label: 'สินค้าคงคลัง', href: '/inventory', icon: Package, perms: ['warehouse', 'dashboard', 'planner'] },
      { label: 'ตรวจนับสต๊อก', href: '/stocktake', icon: ClipboardCheck, perms: ['warehouse', 'mobile'] },
      { label: 'ของเสีย / ทิ้ง', href: '/waste', icon: Trash2, perms: ['warehouse', 'pos', 'order_mgt'] },
      { label: 'เบิก / โอนสินค้า', href: '/goods-issue', icon: ArrowLeftRight, perms: ['warehouse', 'mobile'] },
      { label: 'ล็อต / อายุสินค้า', href: '/lots', icon: Boxes, perms: ['lots', 'warehouse'] },
      { label: 'สแกนมือถือ', href: '/mobile-scan', icon: ScanLine, perms: ['mobile', 'warehouse'] },
      { label: 'รูปภาพสินค้า', href: '/images', icon: Camera, perms: ['images', 'masterdata'] },
      { label: 'คลังสินค้า (WMS)', href: '/wms', icon: Warehouse, perms: ['warehouse'] },
      { label: 'ต้นทุนสินค้า', href: '/costing', icon: Calculator, perms: ['warehouse', 'exec'] },
      { label: 'บัญชีสต๊อก & มูลค่า', href: '/inventory-ledger', icon: Wallet, perms: ['warehouse', 'dashboard'] },
      { label: 'เติมสต๊อกอัตโนมัติ', href: '/replenishment', icon: PackagePlus, perms: ['warehouse', 'planner'] },
    ],
  },
  {
    title: 'จัดซื้อ',
    workspace: ['erp'],
    items: [
      { label: 'ซัพพลายเออร์', href: '/inventory/suppliers', icon: Building2, perms: ['procurement', 'warehouse'] },
      { label: 'ใบสั่งซื้อ', href: '/inventory/purchase-orders', icon: ReceiptText, perms: ['procurement'] },
      { label: 'จัดซื้อจัดจ้าง', href: '/procurement', icon: ShoppingBag, perms: ['procurement'] },
      { label: 'ขอใบเสนอราคา (RFQ)', href: '/procurement/rfqs', icon: ClipboardList, perms: ['procurement'] },
      { label: 'จับคู่เอกสาร 3 ทาง', href: '/procurement/match', icon: CheckCheck, perms: ['procurement'] },
      { label: 'คะแนนซัพพลายเออร์', href: '/supplier-scorecards', icon: Award, perms: ['procurement', 'exec'] },
      { label: 'อ่านเอกสารอัตโนมัติ (Document AI)', href: '/doc-ai', icon: FileScan, perms: ['procurement', 'creditors', 'exec'] },
      // vendor self-service surface — visible only to users granted the vendor_portal permission
      { label: 'พอร์ทัลซัพพลายเออร์ (Supplier)', href: '/supplier', icon: PackageCheck, perms: ['vendor_portal'] },
    ],
  },
  {
    title: 'การผลิต',
    workspace: ['erp'],
    items: [
      { label: 'สูตรการผลิต (BoM)', href: '/bom', icon: FlaskConical, perms: ['bom_master'] },
      { label: 'ใบสั่งผลิต (Manufacturing)', href: '/manufacturing', icon: Factory, perms: ['bom_master', 'warehouse'] },
      { label: 'การผลิตขั้นสูง (Routing/QA/MRP)', href: '/production', icon: Network, perms: ['bom_master', 'warehouse', 'planner'] },
      { label: 'ซ่อมบำรุงสินทรัพย์ (EAM)', href: '/eam', icon: Wrench, perms: ['exec', 'warehouse', 'creditors'] },
    ],
  },

  // ─── ERP: finance ───────────────────────────────────────────────────────────────────────────────
  // PEAK-style cycle grouping (see docs/16-peak-style-erp-convergence.md): the daily รายรับ/รายจ่าย
  // book sits on top, period-close GL next, then treasury; reporting + multi-entity/FX collapse by
  // default to keep the group compact. **No href/perms changed** — pure shelving (cf. doc 15 §2).
  {
    title: 'การเงิน',
    workspace: ['erp'],
    subgroups: [
      {
        title: 'รายรับ–รายจ่าย (AR/AP)',
        items: [
          { label: 'การเงิน', href: '/finance', icon: Banknote, perms: ['ar', 'creditors', 'exec'] },
          { label: 'เงินทดรองจ่าย (Petty cash)', href: '/advances', icon: HandCoins, perms: ['creditors', 'exec'] },
          { label: 'กองทุนเงินสดย่อย & ค่าใช้จ่าย', href: '/petty-cash', icon: HandCoins, perms: ['creditors', 'exec'] },
        ],
      },
      {
        title: 'สมุดบัญชี & แยกประเภท',
        items: [
          { label: 'บัญชีแยกประเภท', href: '/accounting', icon: BookText, perms: ['exec', 'creditors', 'ar'] },
          { label: 'รับรู้รายได้', href: '/revenue', icon: CircleDollarSign, perms: ['exec', 'ar'] },
          { label: 'สินทรัพย์ถาวร', href: '/assets', icon: Boxes, perms: ['exec', 'creditors', 'ar'] },
          { label: 'สัญญาเช่า (IFRS 16)', href: '/leases', icon: Scale, perms: ['exec', 'gl_post'] },
          { label: 'ปิดงวดบัญชี (Period-close)', href: '/finance/period-close', icon: CalendarClock, perms: ['gl_close', 'exec'] },
        ],
      },
      {
        title: 'ธนาคาร & กระทบยอด',
        items: [
          { label: 'ธนาคาร', href: '/bank', icon: Landmark, perms: ['exec', 'creditors', 'ar'] },
          { label: 'นำเงินสดฝากธนาคาร', href: '/cash-banking', icon: Vault, perms: ['exec', 'ar'] },
          { label: 'กระทบยอด', href: '/reconciliation', icon: Scale, perms: ['exec', 'creditors', 'ar'] },
          { label: 'รายการรออนุมัติ', href: '/approvals', icon: ClipboardCheck, perms: ['exec', 'approvals', 'creditors'] },
        ],
      },
      {
        title: 'งบ & วิเคราะห์การเงิน',
        defaultOpen: false, // reporting/health — opened on demand
        items: [
          { label: 'สุขภาพการเงิน (Financial health)', href: '/financial-health', icon: CircleDollarSign, perms: ['exec', 'dashboard', 'ar', 'creditors'] },
          { label: 'งบการเงินรวม', href: '/consolidation', icon: Layers, perms: ['exec'] },
        ],
      },
      {
        title: 'ระหว่างบริษัท & สกุลเงิน',
        defaultOpen: false, // advanced multi-entity / treasury — collapsed by default
        items: [
          { label: 'ระหว่างบริษัท', href: '/intercompany', icon: ArrowLeftRight, perms: ['exec', 'creditors'] },
          { label: 'อัตราแลกเปลี่ยน', href: '/fx', icon: Coins, perms: ['exec', 'creditors', 'ar'] },
        ],
      },
    ],
  },
  {
    title: 'ภาษี',
    workspace: ['erp'],
    items: [
      { label: 'ใบกำกับภาษี', href: '/tax/invoices', icon: FileText, perms: ['exec', 'ar', 'creditors'] },
      { label: 'รายงานภาษี', href: '/tax/reports', icon: FileSpreadsheet, perms: ['exec', 'ar', 'creditors'] },
      { label: 'หัก ณ ที่จ่าย', href: '/tax/wht', icon: FileMinus, perms: ['exec', 'creditors'] },
      // dual-use: the fiscal/e-Tax journal is generated at POS, reconciled in ERP → cross-listed
      { label: 'ภาษีอิเล็กทรอนิกส์ (e-Tax/Journal)', href: '/pos-fiscal', icon: FileSpreadsheet, perms: ['exec', 'ar', 'pos'], workspace: BOTH },
    ],
  },
  {
    title: 'บุคลากร & เงินเดือน',
    workspace: ['erp'],
    items: [
      { label: 'บุคลากร (HR)', href: '/hcm', icon: Users, perms: ['exec', 'users', 'creditors'] },
      { label: 'จัดตารางเวร & แรงงาน', href: '/scheduling', icon: CalendarRange, perms: ['pos', 'users', 'exec'] },
      { label: 'กฎ OT & แจ้งเตือนแรงงาน', href: '/labor/ot-rules', icon: Timer, perms: ['pos', 'users', 'exec'] },
      { label: 'เงินเดือน (Payroll)', href: '/payroll', icon: Briefcase, perms: ['exec', 'users', 'creditors'] },
      // self-service is for every employee (incl. POS staff) → cross-listed to both surfaces
      { label: 'พื้นที่พนักงาน (ESS)', href: '/ess', icon: IdCard, perms: ['ess'], workspace: BOTH },
      // manager surface: approve/reject employee expense claims (perm `approvals`, independent of `ess`)
      { label: 'อนุมัติเบิกพนักงาน', href: '/expense-approvals', icon: ReceiptText, perms: ['approvals'], workspace: BOTH },
    ],
  },
  {
    title: 'วางแผน & BI',
    workspace: ['erp'],
    items: [
      { label: 'งบประมาณ & แผน', href: '/planning', icon: Goal, perms: ['exec', 'planner'] },
      { label: 'งบประมาณเทียบจริง (Budget vs Actual)', href: '/budget', icon: PiggyBank, perms: ['exec', 'planner'] },
      { label: 'พยากรณ์ความต้องการ (Demand ML)', href: '/demand', icon: LineChart, perms: ['exec', 'planner', 'warehouse'] },
      { label: 'โครงการ (Projects)', href: '/projects', icon: FolderKanban, perms: ['exec', 'planner', 'ar'] },
      { label: 'กำไรตามมิติ', href: '/profitability', icon: PieChart, perms: ['exec', 'marketing'] },
      { label: 'ข้อมูลเชิงลึก (Insights)', href: '/insights', icon: Lightbulb, perms: ['exec', 'dashboard', 'planner', 'warehouse'] },
      { label: 'BI Analytics', href: '/bi', icon: BarChart3, perms: ['exec', 'dashboard'] },
      { label: 'เครื่องมือวิเคราะห์ (Studio)', href: '/query', icon: BarChart3, perms: ['exec', 'dashboard', 'masterdata'] },
      { label: 'ถามข้อมูล (NL Analytics)', href: '/nl-analytics', icon: MessageSquare, perms: ['exec', 'dashboard', 'masterdata'] },
      { label: 'รายงานตามเวลา (Scheduled)', href: '/scheduled-reports', icon: CalendarClock, perms: ['exec'] },
    ],
  },

  // ─── Cross-cutting (BOTH surfaces) ──────────────────────────────────────────────────────────────
  {
    title: 'การควบคุม',
    workspace: BOTH, // approvals & SoD apply to both POS managers and back-office
    items: [
      { label: 'อนุมัติงาน', href: '/workflow', icon: Workflow, perms: ['exec', 'creditors', 'procurement', 'users'] },
      { label: 'แยกหน้าที่ (SoD)', href: '/sod', icon: ShieldAlert, perms: ['exec', 'users'] },
      { label: 'ร่องรอยตรวจสอบ (Audit trail)', href: '/audit', icon: ScrollText, perms: ['users'] },
      { label: 'เฝ้าระวังการควบคุม (Controls)', href: '/controls', icon: ShieldAlert, perms: ['exec', 'users', 'creditors'] },
      { label: 'ระบบ & การขยายขนาด (Ops)', href: '/ops', icon: Activity, perms: ['exec', 'users'] },
    ],
  },
  {
    title: 'ผู้ช่วย AI',
    workspace: BOTH,
    items: [
      { label: 'AI Assistant', href: '/assistant', icon: Bot, perms: ['ai_chat', 'dashboard'] },
      { label: 'AI Actions (อนุมัติ)', href: '/ai-actions', icon: Bot, perms: ['approvals', 'ai_chat'] },
      { label: 'ผู้ช่วยอัจฉริยะ (Copilot)', href: '/copilot', icon: Bot, perms: ['ai_chat', 'dashboard'] },
    ],
  },
  {
    // settings/users/master-data are reachable from either workspace. Segmented into collapsible
    // sub-sections so the (formerly 22-item flat) System group is scannable.
    title: 'ตั้งค่าระบบ',
    workspace: BOTH,
    subgroups: [
      {
        title: 'ข้อมูลหลัก',
        items: [
          { label: 'ข้อมูลหลัก (Master Data)', href: '/master-data', icon: Database, perms: ['masterdata'] },
          { label: 'ฟิลด์กำหนดเอง (Custom fields)', href: '/custom-fields', icon: SlidersHorizontal, perms: ['masterdata', 'users', 'exec'] },
          { label: 'ออบเจ็กต์กำหนดเอง (Custom objects)', href: '/custom-objects', icon: Boxes, perms: ['masterdata', 'users', 'exec'] },
          { label: 'เลย์เอาต์ฟอร์ม (Form layouts)', href: '/object-layouts', icon: LayoutTemplate, perms: ['masterdata', 'users', 'exec'] },
          { label: 'มุมมองที่บันทึก (Saved views)', href: '/saved-views', icon: Bookmark, perms: ['dashboard', 'exec', 'masterdata', 'warehouse', 'pos'] },
        ],
      },
      {
        title: 'ปรับแต่ง',
        defaultOpen: false, // advanced configuration — collapsed by default
        items: [
          { label: 'การแจ้งเตือน (Alert rules)', href: '/alerts', icon: BellRing, perms: ['masterdata', 'users', 'exec', 'dashboard'] },
          { label: 'ระบบอัตโนมัติ (Automation)', href: '/automation', icon: Workflow, perms: ['masterdata', 'users', 'exec'] },
          { label: 'ผู้ช่วยตั้งค่า (AI Config)', href: '/ai-config', icon: Wand2, perms: ['masterdata', 'users', 'exec'] },
          { label: 'แดชบอร์ดตามบทบาท (Role dashboards)', href: '/dashboard-designer', icon: LayoutTemplate, perms: ['users', 'exec'] },
          { label: 'เทมเพลตเอกสาร (Document templates)', href: '/document-templates', icon: LayoutTemplate, perms: ['users', 'exec'] },
          { label: 'ธีมแบรนด์ (White-label)', href: '/theme', icon: Palette, perms: ['users', 'exec'] },
          { label: 'โมดูลทดลอง (Labs)', href: '/settings/labs', icon: SlidersHorizontal, perms: ['md_config', 'exec', 'users'] },
        ],
      },
      {
        title: 'เชื่อมต่อ & ขยาย',
        defaultOpen: false, // integration/developer tooling — collapsed by default
        items: [
          { label: 'ตัวเชื่อมต่อ (Connectors)', href: '/connectors', icon: Cable, perms: ['users', 'exec'] },
          { label: 'เว็บฮุค (Webhooks)', href: '/webhooks', icon: Webhook, perms: ['users'] },
          { label: 'พอร์ทัลนักพัฒนา (Developer)', href: '/developer', icon: Code, perms: ['users'] },
          { label: 'ย้ายข้อมูลเข้า (Migration)', href: '/migration', icon: Upload, perms: ['masterdata', 'users', 'exec'] },
          { label: 'ชุดประเทศ (Localization)', href: '/localization', icon: Globe, perms: ['exec', 'users', 'masterdata'] },
          { label: 'ใบกำกับอิเล็กทรอนิกส์ (e-Invoicing)', href: '/einvoice', icon: FileCheck, perms: ['exec', 'creditors', 'ar'] },
        ],
      },
      {
        title: 'ผู้ดูแลระบบ',
        items: [
          { label: 'เริ่มต้นใช้งาน (Onboarding)', href: '/onboarding', icon: Rocket, perms: ['users', 'exec', 'dashboard'] },
          { label: 'จัดการผู้ใช้', href: '/admin/users', icon: UserCog, perms: ['users'] },
          { label: 'ตั้งค่ากิจการ', href: '/setup', icon: BadgeCheck, perms: ['users'] },
          { label: 'แพ็กเกจ', href: '/billing', icon: CreditCard, perms: ['users'] },
          { label: 'ตั้งค่า', href: '/settings', icon: Settings, perms: ['users'] },
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
    title: 'เมนู',
    items: [
      { label: 'หน้าหลัก', href: '/portal/dashboard', icon: LayoutDashboard },
      { label: 'ขายสินค้า (POS)', href: '/portal/pos', icon: Store },
      { label: 'สต๊อก & สั่งซื้อ', href: '/portal/inventory', icon: Package },
      { label: 'ติดตามคำสั่งซื้อ', href: '/portal/track', icon: Truck },
      { label: 'ตรวจนับสิ้นวัน', href: '/portal/variance', icon: ClipboardCheck },
      { label: 'สูตรการผลิต (BoM)', href: '/portal/bom', icon: FlaskConical },
      { label: 'แบบสำรวจ', href: '/portal/survey', icon: FileText },
      { label: 'แต้มสะสม', href: '/portal/loyalty', icon: Star },
      { label: 'ธุรกิจของฉัน', href: '/portal/my', icon: Briefcase },
      { label: 'พนักงานของฉัน', href: '/portal/my/users', icon: Users },
    ],
  },
];
