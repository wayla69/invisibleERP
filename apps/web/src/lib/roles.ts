// Role catalogue for the admin user-management UI — human-readable definitions so an admin understands
// what access each role grants before assigning it. Kept web-local (the web app does not import the shared
// TS barrel); the role VOCABULARY mirrors packages/shared enums.ts ROLES and permissions.ts
// DEFAULT_ROLE_PERMISSIONS — keep the two in sync when a role is added or its duties change.
//
// `kind` groups the roles for display:
//   'admin'  = privileged administration roles
//   'duty'   = SoD-clean single-duty roles (the remediated design — each verified 0 SoD conflicts)
//   'broad'  = legacy coarse roles (retained for transition; flagged by SoD until users migrate)
//   'portal' = external customer-portal role

export type RoleKind = 'admin' | 'broad' | 'duty' | 'portal';

export interface RoleMeta {
  label: string;        // friendly English name
  labelTh: string;      // friendly Thai name
  description: string;  // what this role can do (EN)
  descriptionTh: string;// what this role can do (TH)
  kind: RoleKind;
}

// Ordered role list (mirrors @ierp/shared ROLES).
export const ROLES = [
  'Admin', 'Sales', 'Customer', 'Warehouse', 'Procurement', 'Planner',
  'Cashier', 'PosSupervisor', 'ArClerk', 'ApClerk', 'Buyer', 'WarehouseOperator',
  'InventoryController', 'StockCounter', 'GlAccountant', 'FinancialController',
  'MasterDataAdmin', 'PricingManager', 'CreditManager', 'ReturnsClerk', 'AccessAdmin', 'ExecutiveViewer',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_META: Record<Role, RoleMeta> = {
  Admin: { kind: 'admin', label: 'Administrator', labelTh: 'ผู้ดูแลระบบ',
    description: 'Full access to every module and setting in the company, including user management. Only the platform owner (godmimi) may grant this role.',
    descriptionTh: 'เข้าถึงทุกโมดูลและการตั้งค่าของบริษัท รวมถึงการจัดการผู้ใช้ — สิทธิ์นี้มอบได้โดยเจ้าของแพลตฟอร์ม (godmimi) เท่านั้น' },
  AccessAdmin: { kind: 'admin', label: 'Access Administrator', labelTh: 'ผู้ดูแลสิทธิ์ผู้ใช้',
    description: 'Manages users, roles and permissions ONLY — holds no transactional duties (SoD R01). Cannot grant the Admin role.',
    descriptionTh: 'จัดการผู้ใช้ บทบาท และสิทธิ์เท่านั้น ไม่มีสิทธิ์ทำรายการทางธุรกิจ (SoD R01) และให้สิทธิ์ Admin ไม่ได้' },

  Sales: { kind: 'broad', label: 'Sales', labelTh: 'ฝ่ายขาย',
    description: 'Front-office sales: POS, sales orders, claims, customers, deliveries, returns, price lists and promotions, plus sales dashboards.',
    descriptionTh: 'งานขายหน้าร้าน: POS ใบสั่งขาย เคลม ลูกค้า การจัดส่ง การคืนสินค้า ราคาและโปรโมชัน พร้อมแดชบอร์ดการขาย' },
  Warehouse: { kind: 'broad', label: 'Warehouse (broad)', labelTh: 'คลังสินค้า (รวม)',
    description: 'Legacy broad warehouse role: receiving, adjustments, counting and custody together. Prefer the single-duty warehouse roles for SoD.',
    descriptionTh: 'บทบาทคลังแบบรวม: รับของ ปรับยอด นับสต๊อก และดูแลสินค้าในที่เดียว — แนะนำใช้บทบาทแยกหน้าที่เพื่อ SoD' },
  Procurement: { kind: 'broad', label: 'Procurement', labelTh: 'จัดซื้อ',
    description: 'Raises and tracks purchase requisitions and purchase orders, and handles deliveries. Does NOT pay vendors or approve its own POs (SoD R03/R04).',
    descriptionTh: 'ออกและติดตามใบขอซื้อและใบสั่งซื้อ รวมถึงการรับ-ส่ง — ไม่จ่ายเงินผู้ขายและไม่อนุมัติ PO ของตนเอง (SoD R03/R04)' },
  Planner: { kind: 'broad', label: 'Supply-chain Planner', labelTh: 'นักวางแผนซัพพลายเชน',
    description: 'Supply-chain planning and analytics: raise/track POs, view stock, read financial reports. Cannot approve, post/close GL or adjust stock.',
    descriptionTh: 'วางแผนซัพพลายเชนและวิเคราะห์: ออก/ติดตาม PO ดูสต๊อก อ่านรายงานการเงิน — อนุมัติ ลงบัญชี/ปิดงวด หรือปรับสต๊อกไม่ได้' },

  Cashier: { kind: 'duty', label: 'Cashier', labelTh: 'พนักงานเก็บเงิน',
    description: 'Rings up sales at the POS only. Cannot issue refunds, void, or reconcile the till (SoD R08) — those belong to the POS Supervisor.',
    descriptionTh: 'ขายและรับเงินที่ POS เท่านั้น คืนเงิน ยกเลิก หรือปิดยอดลิ้นชักไม่ได้ (SoD R08) — เป็นหน้าที่หัวหน้ากะ' },
  PosSupervisor: { kind: 'duty', label: 'POS Supervisor', labelTh: 'หัวหน้ากะ POS',
    description: 'Authorises refunds/voids and reconciles/closes the till drawer — the independent check on the Cashier.',
    descriptionTh: 'อนุมัติการคืนเงิน/ยกเลิก และกระทบยอด/ปิดลิ้นชัก — เป็นการตรวจสอบอิสระต่อพนักงานเก็บเงิน' },
  ArClerk: { kind: 'duty', label: 'Accounts Receivable Clerk', labelTh: 'พนักงานลูกหนี้',
    description: 'Handles receivables: sales orders, claims and deliveries. Does not maintain customer credit master or post the GL.',
    descriptionTh: 'ดูแลลูกหนี้: ใบสั่งขาย เคลม การจัดส่ง — ไม่แก้ไขวงเงินเครดิตลูกค้าหรือลงบัญชีแยกประเภท' },
  ApClerk: { kind: 'duty', label: 'Accounts Payable Clerk', labelTh: 'พนักงานเจ้าหนี้',
    description: 'Processes vendor payables (AP). Does not maintain the vendor master or raise purchases (SoD R02/R03).',
    descriptionTh: 'ดำเนินการจ่ายเจ้าหนี้ (AP) — ไม่แก้ไขทะเบียนผู้ขายและไม่ออกใบสั่งซื้อ (SoD R02/R03)' },
  Buyer: { kind: 'duty', label: 'Buyer', labelTh: 'ผู้จัดซื้อ',
    description: 'Places purchase orders. A SoD-clean buying role — no paying, approving or vendor-master duties.',
    descriptionTh: 'ออกใบสั่งซื้อ เป็นบทบาทจัดซื้อที่แยกหน้าที่ชัด — ไม่จ่ายเงิน ไม่อนุมัติ และไม่ดูแลทะเบียนผู้ขาย' },
  WarehouseOperator: { kind: 'duty', label: 'Warehouse Operator', labelTh: 'พนักงานคลังสินค้า',
    description: 'Receives goods and handles stock custody (lots, locations, mobile scan, images). Cannot adjust stock or count independently.',
    descriptionTh: 'รับสินค้าและดูแลสต๊อก (ล็อต ตำแหน่ง สแกนมือถือ รูปภาพ) — ปรับยอดหรือนับสต๊อกอิสระไม่ได้' },
  InventoryController: { kind: 'duty', label: 'Inventory Controller', labelTh: 'ผู้ควบคุมสินค้าคงคลัง',
    description: 'Authorises inventory adjustments. Kept separate from physical counting to prevent concealing shrink (SoD R11).',
    descriptionTh: 'อนุมัติการปรับยอดสินค้าคงคลัง แยกจากการนับจริงเพื่อกันการปกปิดสินค้าขาด (SoD R11)' },
  StockCounter: { kind: 'duty', label: 'Stock Counter', labelTh: 'พนักงานนับสต๊อก',
    description: 'Performs physical stock counts only — the independent count against the Inventory Controller’s adjustments.',
    descriptionTh: 'นับสต๊อกจริงเท่านั้น — เป็นการนับอิสระเทียบกับการปรับยอดของผู้ควบคุมสินค้าคงคลัง' },
  GlAccountant: { kind: 'duty', label: 'GL Accountant', labelTh: 'นักบัญชีแยกประเภท',
    description: 'Prepares journal entries and reconciliations and reads financial reports. Journals post as Draft and need a separate approver; cannot close the period (SoD R05).',
    descriptionTh: 'จัดทำรายการบัญชีและกระทบยอด อ่านรายงานการเงิน — รายการลงเป็นฉบับร่างและต้องมีผู้อนุมัติแยก ปิดงวดไม่ได้ (SoD R05)' },
  FinancialController: { kind: 'duty', label: 'Financial Controller', labelTh: 'ผู้ควบคุมการเงิน',
    description: 'Closes the fiscal period/year, maintains the chart of accounts and posting rules, and approves financial workflow items. The independent approver over GL Accountants.',
    descriptionTh: 'ปิดงวด/ปีบัญชี ดูแลผังบัญชีและกฎการลงบัญชี และอนุมัติรายการทางการเงิน — เป็นผู้อนุมัติอิสระเหนือนักบัญชี' },
  MasterDataAdmin: { kind: 'duty', label: 'Master-Data Administrator', labelTh: 'ผู้ดูแลข้อมูลหลัก',
    description: 'Maintains master data and BOMs (items, vendors, config). Holds no transactional duties, so changes are segregated from operations (SoD R13).',
    descriptionTh: 'ดูแลข้อมูลหลักและสูตรการผลิต (สินค้า ผู้ขาย การตั้งค่า) ไม่มีสิทธิ์ทำรายการ จึงแยกจากงานปฏิบัติการ (SoD R13)' },
  PricingManager: { kind: 'duty', label: 'Pricing Manager', labelTh: 'ผู้จัดการราคา',
    description: 'Maintains price lists and promotions. Kept separate from selling so no one can set a price and sell at it (SoD R10).',
    descriptionTh: 'ดูแลรายการราคาและโปรโมชัน แยกจากการขายเพื่อกันการตั้งราคาแล้วขายเอง (SoD R10)' },
  CreditManager: { kind: 'duty', label: 'Credit Manager', labelTh: 'ผู้จัดการสินเชื่อ',
    description: 'Maintains customer/credit master data. Kept separate from order entry so credit limits are not raised then sold against (SoD R09).',
    descriptionTh: 'ดูแลข้อมูลลูกค้า/วงเงินเครดิต แยกจากการรับออร์เดอร์เพื่อกันการเพิ่มวงเงินแล้วขายเชื่อเอง (SoD R09)' },
  ReturnsClerk: { kind: 'duty', label: 'Returns Clerk', labelTh: 'พนักงานรับคืนสินค้า',
    description: 'Processes returns. The matching refund requires an independent approver (SoD R12).',
    descriptionTh: 'ดำเนินการรับคืนสินค้า — การคืนเงินที่เกี่ยวข้องต้องมีผู้อนุมัติอิสระ (SoD R12)' },
  ExecutiveViewer: { kind: 'duty', label: 'Executive Viewer', labelTh: 'ผู้บริหาร (ดูอย่างเดียว)',
    description: 'Read-only access to financial reports, dashboards, planning and marketing analytics. Makes no transactions.',
    descriptionTh: 'ดูรายงานการเงิน แดชบอร์ด การวางแผน และการตลาดแบบอ่านอย่างเดียว ไม่ทำรายการใด ๆ' },

  Customer: { kind: 'portal', label: 'Customer (portal)', labelTh: 'ลูกค้า (พอร์ทัล)',
    description: 'External customer-portal user: place orders, view own dashboards/inventory/BOM, loyalty, surveys, order tracking and self-service business tools.',
    descriptionTh: 'ผู้ใช้พอร์ทัลลูกค้าภายนอก: สั่งซื้อ ดูแดชบอร์ด/สต๊อก/BOM ของตน สะสมแต้ม แบบสอบถาม ติดตามออร์เดอร์ และเครื่องมือบริการตนเอง' },
};
