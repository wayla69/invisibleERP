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
  Bot,
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

export interface NavGroup {
  title: string;
  items: NavItem[];
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

/** Back-office navigation, grouped. `perms` gate visibility via hasPerm(); `workspace` gates the ERP/POS switcher. */
export const INTERNAL_NAV: NavGroup[] = [
  {
    title: 'ภาพรวม',
    workspace: BOTH,
    items: [
      { label: 'แดชบอร์ด', href: '/dashboard', icon: LayoutDashboard, perms: ['dashboard', 'exec'], workspace: ['erp'] },
      { label: 'ภาพรวมหน้าร้าน', href: '/pos-home', icon: Store, perms: ['pos', 'pos_sell', 'order_mgt', 'dashboard'], workspace: ['pos'] },
    ],
  },
  {
    title: 'การขาย',
    workspace: ['pos'],
    items: [
      { label: 'POS', href: '/pos', icon: ShoppingCart, perms: ['pos', 'order_mgt'] },
      { label: 'โต๊ะ', href: '/tables', icon: Utensils, perms: ['pos', 'order_mgt'] },
      { label: 'ครัว (KDS)', href: '/kds', icon: ChefHat, perms: ['pos'] },
      { label: 'เมนูอาหาร', href: '/menu', icon: BookOpen, perms: ['pos', 'order_mgt'] },
      { label: 'บุฟเฟต์ (แพ็กเกจ)', href: '/buffet', icon: Timer, perms: ['pos', 'order_mgt', 'masterdata'] },
      { label: 'ต้นทุนอาหาร (Food cost)', href: '/food-cost', icon: PieChart, perms: ['pos', 'order_mgt', 'masterdata', 'exec'] },
      { label: 'จัดการเคลม', href: '/claims', icon: ShieldAlert, perms: ['claim_mgt'] },
      { label: 'ใบส่งสินค้า', href: '/delivery', icon: Truck, perms: ['delivery'] },
      { label: 'ควบคุม POS (พักบิล/อนุมัติ)', href: '/pos-control', icon: ClipboardList, perms: ['pos', 'order_mgt'] },
      { label: 'ใบเสร็จ & งานพิมพ์', href: '/print', icon: Printer, perms: ['pos', 'order_mgt'] },
      { label: 'อุปกรณ์ฮาร์ดแวร์ (Peripherals)', href: '/peripherals', icon: Cable, perms: ['pos', 'order_mgt'] },
      // dual-use: pricing & branches are configured back-office but used at POS → cross-listed
      { label: 'กฎราคา & โปรโมชั่น', href: '/pricing', icon: Coins, perms: ['pos', 'order_mgt', 'exec'], workspace: BOTH },
      { label: 'ช่องทางเดลิเวอรี (Aggregators)', href: '/channels', icon: Truck, perms: ['pos', 'order_mgt', 'exec'] },
      { label: 'ลอยัลตี้ & แรงงาน (POS Ops)', href: '/pos-ops', icon: Star, perms: ['pos', 'loyalty', 'users', 'exec'] },
      { label: 'เครื่องรับบัตร & สรุปยอด', href: '/payments/terminals', icon: CreditCard, perms: ['pos', 'creditors', 'exec'] },
      { label: 'มัดจำ & บัญชีเครดิต (House accounts)', href: '/payments/accounts', icon: Wallet, perms: ['pos', 'order_mgt', 'exec'] },
      { label: 'สาขา & ยอดขายรวม (Branches)', href: '/branches', icon: Store, perms: ['branch', 'exec'], workspace: BOTH },
    ],
  },
  {
    title: 'ลูกค้า & การขาย',
    workspace: ['erp'],
    items: [
      { label: 'โอกาสการขาย', href: '/pipeline', icon: Target, perms: ['marketing', 'exec'] },
      { label: 'ใบเสนอราคา', href: '/cpq', icon: FileSignature, perms: ['marketing', 'exec'] },
      { label: 'บริการ & SLA', href: '/service', icon: LifeBuoy, perms: ['marketing', 'exec'] },
      { label: 'CRM 360', href: '/crm', icon: Users, perms: ['marketing', 'exec'] },
      { label: 'การตลาด', href: '/marketing', icon: Megaphone, perms: ['marketing'] },
      // dual-use: loyalty program is run from POS but configured/analysed in ERP → cross-listed
      { label: 'สมาชิก & แต้ม', href: '/loyalty', icon: Star, perms: ['loyalty', 'marketing'], workspace: BOTH },
    ],
  },
  {
    title: 'สต๊อก & จัดซื้อ',
    workspace: ['erp'],
    items: [
      { label: 'สินค้าคงคลัง', href: '/inventory', icon: Package, perms: ['warehouse', 'dashboard', 'planner'] },
      { label: 'ตรวจนับสต๊อก', href: '/stocktake', icon: ClipboardCheck, perms: ['warehouse', 'mobile'] },
      { label: 'เบิก / โอนสินค้า', href: '/goods-issue', icon: ArrowLeftRight, perms: ['warehouse', 'mobile'] },
      { label: 'ล็อต / อายุสินค้า', href: '/lots', icon: Boxes, perms: ['lots', 'warehouse'] },
      { label: 'สแกนมือถือ', href: '/mobile-scan', icon: ScanLine, perms: ['mobile', 'warehouse'] },
      { label: 'รูปภาพสินค้า', href: '/images', icon: Camera, perms: ['images', 'masterdata'] },
      { label: 'ซัพพลายเออร์', href: '/inventory/suppliers', icon: Building2, perms: ['procurement', 'warehouse'] },
      { label: 'ใบสั่งซื้อ', href: '/inventory/purchase-orders', icon: ReceiptText, perms: ['procurement'] },
      { label: 'จัดซื้อจัดจ้าง', href: '/procurement', icon: ShoppingBag, perms: ['procurement'] },
      { label: 'ขอใบเสนอราคา (RFQ)', href: '/procurement/rfqs', icon: ClipboardList, perms: ['procurement'] },
      { label: 'จับคู่เอกสาร 3 ทาง', href: '/procurement/match', icon: CheckCheck, perms: ['procurement'] },
      { label: 'อ่านเอกสารอัตโนมัติ (Document AI)', href: '/doc-ai', icon: FileScan, perms: ['procurement', 'creditors', 'exec'] },
      { label: 'คลังสินค้า (WMS)', href: '/wms', icon: Warehouse, perms: ['warehouse'] },
      { label: 'ต้นทุนสินค้า', href: '/costing', icon: Calculator, perms: ['warehouse', 'exec'] },
      { label: 'เติมสต๊อกอัตโนมัติ', href: '/replenishment', icon: PackagePlus, perms: ['warehouse', 'planner'] },
      { label: 'สูตรการผลิต (BoM)', href: '/bom', icon: FlaskConical, perms: ['bom_master'] },
      { label: 'ใบสั่งผลิต (Manufacturing)', href: '/manufacturing', icon: Factory, perms: ['bom_master', 'warehouse'] },
      { label: 'การผลิตขั้นสูง (Routing/QA/MRP)', href: '/production', icon: Network, perms: ['bom_master', 'warehouse', 'planner'] },
    ],
  },
  {
    title: 'การเงิน',
    workspace: ['erp'],
    items: [
      { label: 'การเงิน', href: '/finance', icon: Banknote, perms: ['ar', 'creditors', 'exec'] },
      { label: 'บัญชีแยกประเภท', href: '/accounting', icon: BookText, perms: ['exec', 'creditors', 'ar'] },
      { label: 'สินทรัพย์ถาวร', href: '/assets', icon: Boxes, perms: ['exec', 'creditors', 'ar'] },
      { label: 'ธนาคาร', href: '/bank', icon: Landmark, perms: ['exec', 'creditors', 'ar'] },
      { label: 'กระทบยอด', href: '/reconciliation', icon: Scale, perms: ['exec', 'creditors', 'ar'] },
      { label: 'รับรู้รายได้', href: '/revenue', icon: CircleDollarSign, perms: ['exec', 'ar'] },
      { label: 'ระหว่างบริษัท', href: '/intercompany', icon: ArrowLeftRight, perms: ['exec', 'creditors'] },
      { label: 'งบการเงินรวม', href: '/consolidation', icon: Layers, perms: ['exec'] },
      { label: 'อัตราแลกเปลี่ยน', href: '/fx', icon: Coins, perms: ['exec', 'creditors', 'ar'] },
    ],
  },
  {
    title: 'บุคลากร & เงินเดือน',
    workspace: ['erp'],
    items: [
      { label: 'บุคลากร (HR)', href: '/hcm', icon: Users, perms: ['exec', 'users', 'creditors'] },
      { label: 'เงินเดือน (Payroll)', href: '/payroll', icon: Briefcase, perms: ['exec', 'users', 'creditors'] },
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
    title: 'วางแผน & วิเคราะห์',
    workspace: ['erp'],
    items: [
      { label: 'งบประมาณ & แผน', href: '/planning', icon: Goal, perms: ['exec', 'planner'] },
      { label: 'โครงการ (Projects)', href: '/projects', icon: FolderKanban, perms: ['exec', 'planner', 'ar'] },
      { label: 'กำไรตามมิติ', href: '/profitability', icon: PieChart, perms: ['exec', 'marketing'] },
      { label: 'BI Analytics', href: '/bi', icon: BarChart3, perms: ['exec', 'dashboard'] },
      { label: 'เครื่องมือวิเคราะห์ (Studio)', href: '/query', icon: BarChart3, perms: ['exec', 'dashboard', 'masterdata'] },
      { label: 'ถามข้อมูล (NL Analytics)', href: '/nl-analytics', icon: MessageSquare, perms: ['exec', 'dashboard', 'masterdata'] },
      { label: 'รายงานตามเวลา (Scheduled)', href: '/scheduled-reports', icon: CalendarClock, perms: ['exec'] },
    ],
  },
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
    title: 'ระบบ',
    workspace: BOTH, // settings/users/master-data are reachable from either workspace
    items: [
      { label: 'ข้อมูลหลัก (Master Data)', href: '/master-data', icon: Database, perms: ['masterdata'] },
      { label: 'ฟิลด์กำหนดเอง (Custom fields)', href: '/custom-fields', icon: SlidersHorizontal, perms: ['masterdata', 'users', 'exec'] },
      { label: 'ออบเจ็กต์กำหนดเอง (Custom objects)', href: '/custom-objects', icon: Boxes, perms: ['masterdata', 'users', 'exec'] },
      { label: 'เลย์เอาต์ฟอร์ม (Form layouts)', href: '/object-layouts', icon: LayoutTemplate, perms: ['masterdata', 'users', 'exec'] },
      { label: 'การแจ้งเตือน (Alert rules)', href: '/alerts', icon: BellRing, perms: ['masterdata', 'users', 'exec', 'dashboard'] },
      { label: 'ระบบอัตโนมัติ (Automation)', href: '/automation', icon: Workflow, perms: ['masterdata', 'users', 'exec'] },
      { label: 'ผู้ช่วยตั้งค่า (AI Config)', href: '/ai-config', icon: Wand2, perms: ['masterdata', 'users', 'exec'] },
      { label: 'มุมมองที่บันทึก (Saved views)', href: '/saved-views', icon: Bookmark, perms: ['dashboard', 'exec', 'masterdata', 'warehouse', 'pos'] },
      { label: 'แดชบอร์ดตามบทบาท (Role dashboards)', href: '/dashboard-designer', icon: LayoutTemplate, perms: ['users', 'exec'] },
      { label: 'เทมเพลตเอกสาร (Document templates)', href: '/document-templates', icon: LayoutTemplate, perms: ['users', 'exec'] },
      { label: 'ธีมแบรนด์ (White-label)', href: '/theme', icon: Palette, perms: ['users', 'exec'] },
      { label: 'เริ่มต้นใช้งาน (Onboarding)', href: '/onboarding', icon: Rocket, perms: ['users', 'exec', 'dashboard'] },
      { label: 'พอร์ทัลนักพัฒนา (Developer)', href: '/developer', icon: Code, perms: ['users'] },
      { label: 'ตัวเชื่อมต่อ (Connectors)', href: '/connectors', icon: Cable, perms: ['users', 'exec'] },
      { label: 'ย้ายข้อมูลเข้า (Migration)', href: '/migration', icon: Upload, perms: ['masterdata', 'users', 'exec'] },
      { label: 'ชุดประเทศ (Localization)', href: '/localization', icon: Globe, perms: ['exec', 'users', 'masterdata'] },
      { label: 'ใบกำกับอิเล็กทรอนิกส์ (e-Invoicing)', href: '/einvoice', icon: FileCheck, perms: ['exec', 'creditors', 'ar'] },
      { label: 'เว็บฮุค (Webhooks)', href: '/webhooks', icon: Webhook, perms: ['users'] },
      { label: 'จัดการผู้ใช้', href: '/admin/users', icon: UserCog, perms: ['users'] },
      { label: 'ตั้งค่ากิจการ', href: '/setup', icon: BadgeCheck, perms: ['users'] },
      { label: 'แพ็กเกจ', href: '/billing', icon: CreditCard, perms: ['users'] },
      { label: 'ตั้งค่า', href: '/settings', icon: Settings, perms: ['users'] },
    ],
  },
];

/** Filter a nav tree to one workspace: keep items whose workspace (item override, else group, else both)
 *  includes `ws`; drop groups left empty. */
export function navForWorkspace(nav: NavGroup[], ws: Workspace): NavGroup[] {
  return nav
    .map((g) => ({ ...g, items: g.items.filter((it) => (it.workspace ?? g.workspace ?? BOTH).includes(ws)) }))
    .filter((g) => g.items.length > 0);
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
