import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeftRight,
  BadgeCheck,
  BarChart3,
  Banknote,
  BookOpen,
  BookText,
  Bot,
  Boxes,
  Briefcase,
  Building2,
  Calculator,
  Camera,
  CheckCheck,
  ChefHat,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardList,
  Coins,
  CreditCard,
  Database,
  FileMinus,
  FileSignature,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  Factory,
  Goal,
  Landmark,
  Layers,
  LayoutDashboard,
  LifeBuoy,
  Megaphone,
  Package,
  PackagePlus,
  PieChart,
  ReceiptText,
  Scale,
  ScanLine,
  Settings,
  ShieldAlert,
  ShoppingBag,
  ShoppingCart,
  Star,
  Store,
  Target,
  Truck,
  UserCog,
  Users,
  Utensils,
  Warehouse,
  Workflow,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  perms?: string[];
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/** Back-office navigation, grouped. `perms` gate visibility via hasPerm(). */
export const INTERNAL_NAV: NavGroup[] = [
  {
    title: 'ภาพรวม',
    items: [{ label: 'แดชบอร์ด', href: '/dashboard', icon: LayoutDashboard, perms: ['dashboard', 'exec'] }],
  },
  {
    title: 'การขาย',
    items: [
      { label: 'POS', href: '/pos', icon: ShoppingCart, perms: ['pos', 'order_mgt'] },
      { label: 'โต๊ะ', href: '/tables', icon: Utensils, perms: ['pos', 'order_mgt'] },
      { label: 'ครัว (KDS)', href: '/kds', icon: ChefHat, perms: ['pos'] },
      { label: 'เมนูอาหาร', href: '/menu', icon: BookOpen, perms: ['pos', 'order_mgt'] },
      { label: 'จัดการเคลม', href: '/claims', icon: ShieldAlert, perms: ['claim_mgt'] },
      { label: 'ใบส่งสินค้า', href: '/delivery', icon: Truck, perms: ['delivery'] },
      { label: 'ควบคุม POS (พักบิล/อนุมัติ)', href: '/pos-control', icon: ClipboardList, perms: ['pos', 'order_mgt'] },
      { label: 'กฎราคา & โปรโมชั่น', href: '/pricing', icon: Coins, perms: ['pos', 'order_mgt', 'exec'] },
      { label: 'ช่องทางเดลิเวอรี (Aggregators)', href: '/channels', icon: Truck, perms: ['pos', 'order_mgt', 'exec'] },
      { label: 'ลอยัลตี้ & แรงงาน (POS Ops)', href: '/pos-ops', icon: Star, perms: ['pos', 'loyalty', 'users', 'exec'] },
      { label: 'เครื่องรับบัตร & สรุปยอด', href: '/payments/terminals', icon: CreditCard, perms: ['pos', 'creditors', 'exec'] },
    ],
  },
  {
    title: 'ลูกค้า & การขาย',
    items: [
      { label: 'โอกาสการขาย', href: '/pipeline', icon: Target, perms: ['marketing', 'exec'] },
      { label: 'ใบเสนอราคา', href: '/cpq', icon: FileSignature, perms: ['marketing', 'exec'] },
      { label: 'บริการ & SLA', href: '/service', icon: LifeBuoy, perms: ['marketing', 'exec'] },
      { label: 'CRM 360', href: '/crm', icon: Users, perms: ['marketing', 'exec'] },
      { label: 'การตลาด', href: '/marketing', icon: Megaphone, perms: ['marketing'] },
      { label: 'สมาชิก & แต้ม', href: '/loyalty', icon: Star, perms: ['loyalty', 'marketing'] },
    ],
  },
  {
    title: 'สต๊อก & จัดซื้อ',
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
      { label: 'คลังสินค้า (WMS)', href: '/wms', icon: Warehouse, perms: ['warehouse'] },
      { label: 'ต้นทุนสินค้า', href: '/costing', icon: Calculator, perms: ['warehouse', 'exec'] },
      { label: 'เติมสต๊อกอัตโนมัติ', href: '/replenishment', icon: PackagePlus, perms: ['warehouse', 'planner'] },
      { label: 'สูตรการผลิต (BoM)', href: '/bom', icon: FlaskConical, perms: ['bom_master'] },
      { label: 'ใบสั่งผลิต (Manufacturing)', href: '/manufacturing', icon: Factory, perms: ['bom_master', 'warehouse'] },
    ],
  },
  {
    title: 'การเงิน',
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
    items: [
      { label: 'เงินเดือน (Payroll)', href: '/payroll', icon: Briefcase, perms: ['exec', 'users', 'creditors'] },
    ],
  },
  {
    title: 'ภาษี',
    items: [
      { label: 'ใบกำกับภาษี', href: '/tax/invoices', icon: FileText, perms: ['exec', 'ar', 'creditors'] },
      { label: 'รายงานภาษี', href: '/tax/reports', icon: FileSpreadsheet, perms: ['exec', 'ar', 'creditors'] },
      { label: 'หัก ณ ที่จ่าย', href: '/tax/wht', icon: FileMinus, perms: ['exec', 'creditors'] },
      { label: 'ภาษีอิเล็กทรอนิกส์ (e-Tax/Journal)', href: '/pos-fiscal', icon: FileSpreadsheet, perms: ['exec', 'ar', 'pos'] },
    ],
  },
  {
    title: 'วางแผน & วิเคราะห์',
    items: [
      { label: 'งบประมาณ & แผน', href: '/planning', icon: Goal, perms: ['exec', 'planner'] },
      { label: 'กำไรตามมิติ', href: '/profitability', icon: PieChart, perms: ['exec', 'marketing'] },
      { label: 'BI Analytics', href: '/bi', icon: BarChart3, perms: ['exec', 'dashboard'] },
    ],
  },
  {
    title: 'การควบคุม',
    items: [
      { label: 'อนุมัติงาน', href: '/workflow', icon: Workflow, perms: ['exec', 'creditors', 'procurement', 'users'] },
      { label: 'แยกหน้าที่ (SoD)', href: '/sod', icon: ShieldAlert, perms: ['exec', 'users'] },
    ],
  },
  {
    title: 'ผู้ช่วย AI',
    items: [{ label: 'AI Assistant', href: '/assistant', icon: Bot, perms: ['ai_chat', 'dashboard'] }],
  },
  {
    title: 'ระบบ',
    items: [
      { label: 'ข้อมูลหลัก (Master Data)', href: '/master-data', icon: Database, perms: ['masterdata'] },
      { label: 'จัดการผู้ใช้', href: '/admin/users', icon: UserCog, perms: ['users'] },
      { label: 'ตั้งค่ากิจการ', href: '/setup', icon: BadgeCheck, perms: ['users'] },
      { label: 'แพ็กเกจ', href: '/billing', icon: CreditCard, perms: ['users'] },
      { label: 'ตั้งค่า', href: '/settings', icon: Settings, perms: ['users'] },
    ],
  },
];

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
