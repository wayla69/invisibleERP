// C1/C3 (Platform Phase 20 + roadmap C3) — UI message catalog, keyed by message id, per locale. `th` is the
// source-of-truth fallback; `en` is complete; ms/vi/id are seeded for common chrome. Nav labels use th+en
// only — additional locales fall back to th. Pure data (no imports); extend per screen as translations land.
export type Lang = 'th' | 'en' | 'ms' | 'vi' | 'id';

export const MESSAGES: Record<string, Partial<Record<Lang, string>>> = {
  // ── Common chrome ─────────────────────────────────────────────────────────
  'common.search': { th: 'ค้นหา…', en: 'Search…', ms: 'Cari…', vi: 'Tìm…', id: 'Cari…' },
  'common.save': { th: 'บันทึก', en: 'Save', ms: 'Simpan', vi: 'Lưu', id: 'Simpan' },
  'common.cancel': { th: 'ยกเลิก', en: 'Cancel', ms: 'Batal', vi: 'Hủy', id: 'Batal' },
  'common.language': { th: 'ภาษา', en: 'Language', ms: 'Bahasa', vi: 'Ngôn ngữ', id: 'Bahasa' },
  'common.logout': { th: 'ออกจากระบบ', en: 'Log out', ms: 'Log keluar', vi: 'Đăng xuất', id: 'Keluar' },
  'common.settings': { th: 'ตั้งค่า', en: 'Settings', ms: 'Tetapan', vi: 'Cài đặt', id: 'Pengaturan' },
  'common.user_account': { th: 'บัญชีผู้ใช้', en: 'User account', ms: 'Akaun pengguna', vi: 'Tài khoản', id: 'Akun pengguna' },
  'ws.erp': { th: 'ระบบหลังร้าน (ERP)', en: 'Back office (ERP)', ms: 'Pejabat belakang (ERP)', vi: 'Văn phòng (ERP)', id: 'Kantor belakang (ERP)' },
  'ws.pos': { th: 'หน้าร้าน (POS)', en: 'Storefront (POS)', ms: 'Kedai (POS)', vi: 'Cửa hàng (POS)', id: 'Toko (POS)' },

  // ── Sidebar chrome ────────────────────────────────────────────────────────
  'nav.favorites': { th: 'รายการโปรด', en: 'Favourites', ms: 'Kegemaran', vi: 'Yêu thích', id: 'Favorit' },
  'nav.recents': { th: 'ล่าสุด', en: 'Recent', ms: 'Terkini', vi: 'Gần đây', id: 'Terkini' },
  'nav.fav_add': { th: 'เพิ่ม {label} ในรายการโปรด', en: 'Add {label} to favourites', ms: 'Tambah {label} ke kegemaran', vi: 'Thêm {label} vào yêu thích', id: 'Tambah {label} ke favorit' },
  'nav.fav_remove': { th: 'เอา {label} ออกจากรายการโปรด', en: 'Remove {label} from favourites', ms: 'Buang {label} dari kegemaran', vi: 'Xoá {label} khỏi yêu thích', id: 'Hapus {label} dari favorit' },
  'nav.fav_add_short': { th: 'เพิ่มในรายการโปรด', en: 'Add to favourites', ms: 'Tambah ke kegemaran', vi: 'Thêm vào yêu thích', id: 'Tambah ke favorit' },
  'nav.fav_remove_short': { th: 'เอาออกจากรายการโปรด', en: 'Remove from favourites', ms: 'Buang dari kegemaran', vi: 'Xoá khỏi yêu thích', id: 'Hapus dari favorit' },
  'nav.move_up': { th: 'ย้าย {label} ขึ้น', en: 'Move {label} up', ms: 'Gerak {label} ke atas', vi: 'Di chuyển {label} lên', id: 'Pindah {label} ke atas' },
  'nav.move_down': { th: 'ย้าย {label} ลง', en: 'Move {label} down', ms: 'Gerak {label} ke bawah', vi: 'Di chuyển {label} xuống', id: 'Pindah {label} ke bawah' },
  'nav.move_up_short': { th: 'ย้ายขึ้น', en: 'Move up', ms: 'Ke atas', vi: 'Lên trên', id: 'Ke atas' },
  'nav.move_down_short': { th: 'ย้ายลง', en: 'Move down', ms: 'Ke bawah', vi: 'Xuống dưới', id: 'Ke bawah' },

  // ── Command palette ───────────────────────────────────────────────────────
  'palette.title': { th: 'ค้นหา', en: 'Search' },
  'palette.description': { th: 'ไปยังหน้าใดก็ได้ หรือค้นหาลูกค้า ผู้ขาย สินค้า', en: 'Go to any page, or find a customer, vendor or product' },
  'palette.placeholder': { th: 'พิมพ์เพื่อค้นหาเมนู หรือ ลูกค้า/ผู้ขาย/สินค้า…', en: 'Search menu, or a customer / vendor / product…' },
  'palette.empty': { th: 'ไม่พบรายการ', en: 'No results' },
  'palette.records': { th: 'ข้อมูล', en: 'Records' },
  'search.type.customer': { th: 'ลูกค้า', en: 'Customer' },
  'search.type.vendor': { th: 'ผู้ขาย', en: 'Vendor' },
  'search.type.item': { th: 'สินค้า', en: 'Product' },
  'search.type.sale': { th: 'การขาย', en: 'Sale' },
  'search.type.ar_invoice': { th: 'ใบแจ้งหนี้', en: 'AR invoice' },
  'search.type.tax_invoice': { th: 'ใบกำกับภาษี', en: 'Tax invoice' },
  'search.type.purchase_order': { th: 'ใบสั่งซื้อ', en: 'Purchase order' },
  'search.type.member': { th: 'สมาชิก', en: 'Member' },
  'search.type.project': { th: 'โปรเจกต์', en: 'Project' },
  'search.type.requisition': { th: 'คำขอซื้อ', en: 'Requisition' },
  'search.type.ap_invoice': { th: 'เจ้าหนี้/บิล', en: 'AP bill' },
  'search.type.employee': { th: 'พนักงาน', en: 'Employee' },

  // ── Nav group titles ──────────────────────────────────────────────────────
  'nav.group.overview': { th: 'ภาพรวม', en: 'Overview' },
  'nav.group.pos_sales': { th: 'ขายหน้าร้าน', en: 'Point of Sale' },
  'nav.group.store': { th: 'ร้าน & การจัดส่ง', en: 'Store & Delivery' },
  'nav.group.devices': { th: 'อุปกรณ์ & การชำระเงิน', en: 'Devices & Payments' },
  'nav.group.restaurant': { th: 'วิเคราะห์ร้านอาหาร', en: 'Restaurant Analytics' },
  'nav.group.crm': { th: 'ลูกค้า & CRM', en: 'Customers & CRM' },
  'nav.group.loyalty': { th: 'ลอยัลตี้', en: 'Loyalty' },
  'nav.group.pricing': { th: 'ราคา & สาขา', en: 'Pricing & Branches' },
  'nav.group.inventory': { th: 'สินค้าคงคลัง', en: 'Inventory' },
  'nav.group.procurement': { th: 'จัดซื้อ', en: 'Procurement' },
  'nav.group.production': { th: 'การผลิต', en: 'Production' },
  'nav.group.finance': { th: 'การเงิน', en: 'Finance' },
  'nav.group.tax': { th: 'ภาษี', en: 'Tax' },
  'nav.group.hr': { th: 'บุคลากร & เงินเดือน', en: 'HR & Payroll' },
  'nav.group.pm': { th: 'จัดการโครงการ', en: 'Project Management' },
  'nav.group.planning': { th: 'วางแผน & BI', en: 'Planning & BI' },
  'nav.group.controls': { th: 'การควบคุม', en: 'Controls' },
  'nav.group.ai': { th: 'ผู้ช่วย AI', en: 'AI Assistant' },
  'nav.group.settings': { th: 'ตั้งค่าระบบ', en: 'System Settings' },
  'nav.group.portal_menu': { th: 'เมนู', en: 'Menu' },

  // ── Nav subgroup titles ───────────────────────────────────────────────────
  'nav.sub.ar_ap': { th: 'รายรับ–รายจ่าย (AR/AP)', en: 'Receivables & Payables (AR/AP)' },
  'nav.sub.ledger': { th: 'สมุดบัญชี & แยกประเภท', en: 'Ledger & GL' },
  'nav.sub.banking': { th: 'ธนาคาร & กระทบยอด', en: 'Banking & Reconciliation' },
  'nav.sub.fin_reports': { th: 'งบ & วิเคราะห์การเงิน', en: 'Financial Statements' },
  'nav.sub.interco': { th: 'ระหว่างบริษัท & สกุลเงิน', en: 'Intercompany & FX' },
  'nav.sub.master_data': { th: 'ข้อมูลหลัก', en: 'Master Data' },
  'nav.sub.customise': { th: 'ปรับแต่ง', en: 'Customise' },
  'nav.sub.integrations': { th: 'เชื่อมต่อ & ขยาย', en: 'Integrations & Extensions' },
  'nav.sub.admin': { th: 'ผู้ดูแลระบบ', en: 'Administration' },

  // ── Overview ──────────────────────────────────────────────────────────────
  'nav.dashboard': { th: 'แดชบอร์ด', en: 'Dashboard' },
  'nav.pos_home': { th: 'ภาพรวมหน้าร้าน', en: 'Store Overview' },

  // ── POS Sales ─────────────────────────────────────────────────────────────
  'nav.pos_register': { th: 'ขายหน้าร้าน (Register)', en: 'Point of Sale (Register)' },
  'nav.pos_orders': { th: 'รายการออเดอร์', en: 'Orders' },
  'nav.returns': { th: 'คืนสินค้า & คืนเงิน', en: 'Returns & Refunds' },
  'nav.refund_auth': { th: 'อนุมัติการคืนเงิน (Refund Auth)', en: 'Refund Authorisation' },
  'nav.giftcards': { th: 'บัตรของขวัญ / เครดิตร้าน', en: 'Gift Cards & Store Credit' },
  'nav.tables': { th: 'โต๊ะ', en: 'Tables' },
  'nav.reservations': { th: 'จองโต๊ะ & รอคิว', en: 'Reservations & Queue' },
  'nav.tips': { th: 'ทิปพนักงาน', en: 'Staff Tips' },
  'nav.kds': { th: 'ครัว (KDS)', en: 'Kitchen (KDS)' },
  'nav.menu': { th: 'เมนูอาหาร', en: 'Menu' },
  'nav.buffet': { th: 'บุฟเฟต์ (แพ็กเกจ)', en: 'Buffet (Packages)' },
  'nav.pos_control': { th: 'ควบคุม POS (พักบิล/อนุมัติ)', en: 'POS Control (Hold/Approve)' },
  'nav.till': { th: 'จัดการลิ้นชัก (Till)', en: 'Till Management' },
  'nav.close_of_day': { th: 'ปิดกะ (Z-Report)', en: 'Close of Day (Z-Report)' },
  'nav.pos_pin': { th: 'ตั้ง PIN หน้าร้าน', en: 'My POS PIN' },
  'nav.print': { th: 'ใบเสร็จ & งานพิมพ์', en: 'Receipts & Printing' },

  // ── Store & Delivery ──────────────────────────────────────────────────────
  'nav.claims': { th: 'จัดการเคลม', en: 'Claims Management' },
  'nav.delivery': { th: 'ใบส่งสินค้า', en: 'Delivery Notes' },
  'nav.channels': { th: 'ช่องทางเดลิเวอรี (Aggregators)', en: 'Delivery Channels (Aggregators)' },

  // ── Devices & Payments ────────────────────────────────────────────────────
  'nav.peripherals': { th: 'อุปกรณ์ฮาร์ดแวร์ (Peripherals)', en: 'Hardware Peripherals' },
  'nav.terminals': { th: 'เครื่องรับบัตร & สรุปยอด', en: 'Card Terminals & Settlement' },
  'nav.payment_accounts': { th: 'มัดจำ & บัญชีเครดิต (House accounts)', en: 'Deposits & House Accounts' },

  // ── Restaurant Analytics ──────────────────────────────────────────────────
  'nav.food_cost': { th: 'ต้นทุนอาหาร (Food cost)', en: 'Food Cost' },
  'nav.restaurant_analytics': { th: 'วิเคราะห์ร้านอาหาร (Analytics)', en: 'Restaurant Analytics' },
  'nav.production_plan': { th: 'แผนการผลิต (Production plan)', en: 'Production Plan' },

  // ── Customers & CRM ───────────────────────────────────────────────────────
  'nav.pipeline': { th: 'โอกาสการขาย', en: 'Sales Pipeline' },
  'nav.cpq': { th: 'ใบเสนอราคา', en: 'Quotations (CPQ)' },
  'nav.service': { th: 'บริการ & SLA', en: 'Service & SLA' },
  'nav.crm': { th: 'CRM 360', en: 'CRM 360' },
  'nav.marketing': { th: 'การตลาด', en: 'Marketing' },
  'nav.campaigns': { th: 'แคมเปญ LINE (Automation)', en: 'LINE Campaigns (Automation)' },

  // ── Loyalty ───────────────────────────────────────────────────────────────
  'nav.pos_ops': { th: 'ลอยัลตี้ & แรงงาน (POS Ops)', en: 'Loyalty & Labour (POS Ops)' },
  'nav.loyalty_members': { th: 'สมาชิก & แต้ม', en: 'Members & Points' },
  'nav.loyalty_rewards': { th: 'ของรางวัล & คูปอง', en: 'Rewards & Coupons' },
  'nav.loyalty_missions': { th: 'ภารกิจ & แสตมป์', en: 'Missions & Stamps' },
  'nav.loyalty_wheels': { th: 'วงล้อนำโชค', en: 'Spin Wheel' },
  'nav.loyalty_campaigns': { th: 'แคมเปญ', en: 'Campaigns' },
  'nav.loyalty_segments': { th: 'เซกเมนต์ลูกค้า', en: 'Segments' },
  'nav.loyalty_journeys': { th: 'เจอร์นีย์ลูกค้า', en: 'Journeys' },
  'nav.loyalty_partners': { th: 'พันธมิตร & สิทธิพิเศษ', en: 'Partners & Privileges' },
  'nav.loyalty_analytics': { th: 'วิเคราะห์ลอยัลตี้', en: 'Loyalty Analytics' },
  'nav.loyalty_receipt_approvals': { th: 'อนุมัติใบเสร็จ', en: 'Receipt Approvals' },
  'nav.loyalty_settings': { th: 'ตั้งค่าลอยัลตี้', en: 'Loyalty Settings' },

  // ── Pricing & Branches ────────────────────────────────────────────────────
  'nav.pricing': { th: 'กฎราคา & โปรโมชั่น', en: 'Pricing Rules & Promotions' },
  'nav.branches': { th: 'สาขา & ยอดขายรวม (Branches)', en: 'Branches & Consolidated Sales' },

  // ── Inventory ─────────────────────────────────────────────────────────────
  'nav.inventory': { th: 'สินค้าคงคลัง', en: 'Inventory' },
  'nav.stocktake': { th: 'ตรวจนับสต๊อก', en: 'Stocktake' },
  'nav.stock_adjustment': { th: 'อนุมัติปรับสต๊อก', en: 'Approve Stock Adjustment' },
  'nav.waste': { th: 'ของเสีย / ทิ้ง', en: 'Waste & Disposals' },
  'nav.receiving': { th: 'รับสินค้า (GR)', en: 'Goods Receipt (GR)' },
  'nav.goods_issue': { th: 'เบิก / โอนสินค้า', en: 'Issue & Transfer' },
  'nav.lots': { th: 'ล็อต / อายุสินค้า', en: 'Lots & Expiry' },
  'nav.mobile_scan': { th: 'สแกนมือถือ', en: 'Mobile Scan' },
  'nav.images': { th: 'รูปภาพสินค้า', en: 'Product Images' },
  'nav.wms': { th: 'คลังสินค้า (WMS)', en: 'Warehouse (WMS)' },
  'nav.costing': { th: 'ต้นทุนสินค้า', en: 'Product Costing' },
  'nav.inventory_ledger': { th: 'บัญชีสต๊อก & มูลค่า', en: 'Stock Ledger & Valuation' },
  'nav.replenishment': { th: 'เติมสต๊อกอัตโนมัติ', en: 'Auto Replenishment' },

  // ── Procurement ───────────────────────────────────────────────────────────
  'nav.requisitions': { th: 'คำขอซื้อ (PR)', en: 'Purchase Requisitions (PR)' },
  'nav.suppliers': { th: 'ซัพพลายเออร์', en: 'Suppliers' },
  'nav.purchase_orders': { th: 'ใบสั่งซื้อ', en: 'Purchase Orders' },
  'nav.procurement': { th: 'จัดซื้อจัดจ้าง (PO)', en: 'Procurement (PO)' },
  'nav.rfqs': { th: 'ขอใบเสนอราคา (RFQ)', en: 'Request for Quotation (RFQ)' },
  'nav.po_match': { th: 'จับคู่เอกสาร 3 ทาง', en: '3-Way Match' },
  'nav.ap_intake': { th: 'สแกนใบแจ้งหนี้จับคู่ PO', en: 'Invoice Scan → PO Match' },
  'nav.supplier_scorecards': { th: 'คะแนนซัพพลายเออร์', en: 'Supplier Scorecards' },
  'nav.supplier_prices': { th: 'ราคาซัพพลายเออร์', en: 'Supplier Prices' },
  'nav.doc_ai': { th: 'อ่านเอกสารอัตโนมัติ (Document AI)', en: 'Document AI' },
  'nav.supplier_portal': { th: 'พอร์ทัลซัพพลายเออร์ (Supplier)', en: 'Supplier Portal' },

  // ── Production ────────────────────────────────────────────────────────────
  'nav.bom': { th: 'สูตรการผลิต (BoM)', en: 'Bill of Materials (BoM)' },
  'nav.manufacturing': { th: 'ใบสั่งผลิต (Manufacturing)', en: 'Manufacturing Orders' },
  'nav.production': { th: 'การผลิตขั้นสูง (Routing/QA/MRP)', en: 'Advanced Production (Routing/QA/MRP)' },
  'nav.aps_schedule': { th: 'จัดตารางการผลิต (APS)', en: 'Production Schedule (APS)' },
  'nav.eam': { th: 'ซ่อมบำรุงสินทรัพย์ (EAM)', en: 'Asset Maintenance (EAM)' },

  // ── Finance / AR-AP ───────────────────────────────────────────────────────
  'nav.finance': { th: 'การเงิน', en: 'Finance' },
  'nav.disbursements': { th: 'จ่ายเงินเจ้าหนี้ (Disbursements)', en: 'AP Disbursements' },
  'nav.customer_cards': { th: 'การ์ดลูกหนี้', en: 'Customer Cards (AR)' },
  'nav.vendor_cards': { th: 'การ์ดเจ้าหนี้', en: 'Vendor Cards (AP)' },
  'nav.credit_hold': { th: 'จัดการเครดิต & ระงับบัญชี', en: 'Credit & Hold Management' },
  'nav.advances': { th: 'เงินทดรองจ่าย (Petty cash)', en: 'Petty Cash Advances' },
  'nav.petty_cash': { th: 'กองทุนเงินสดย่อย & ค่าใช้จ่าย', en: 'Petty Cash & Expenses' },

  // ── Finance / Ledger & GL ─────────────────────────────────────────────────
  'nav.chart_of_accounts': { th: 'ผังบัญชี', en: 'Chart of Accounts' },
  'nav.financial_statements': { th: 'งบการเงิน', en: 'Financial Statements' },
  'nav.accounting': { th: 'บัญชีแยกประเภท', en: 'General Ledger' },
  'nav.revenue': { th: 'รับรู้รายได้', en: 'Revenue Recognition' },
  'nav.assets': { th: 'สินทรัพย์ถาวร', en: 'Fixed Assets' },
  'nav.leases': { th: 'สัญญาเช่า (IFRS 16)', en: 'Leases (IFRS 16)' },
  'nav.deferred_tax': { th: 'ภาษีเงินได้รอตัดบัญชี', en: 'Deferred Tax' },
  'nav.cost_centers': { th: 'ศูนย์ต้นทุน & กำไรตามมิติ', en: 'Cost Centres & P&L' },
  'nav.gl_schedules': { th: 'รายการบัญชีตั้งเวลา', en: 'Recurring & Prepaid' },
  'nav.period_close': { th: 'ปิดงวดบัญชี (Period-close)', en: 'Period Close' },

  // ── Finance / Banking ─────────────────────────────────────────────────────
  'nav.bank': { th: 'ธนาคาร', en: 'Banking' },
  'nav.cash_banking': { th: 'นำเงินสดฝากธนาคาร', en: 'Cash Deposit' },
  'nav.reconciliation': { th: 'กระทบยอด', en: 'Reconciliation' },
  'nav.approvals': { th: 'รายการรออนุมัติ', en: 'Pending Approvals' },

  // ── Finance / Statements ──────────────────────────────────────────────────
  'nav.financial_health': { th: 'สุขภาพการเงิน (Financial health)', en: 'Financial Health' },
  'nav.consolidation': { th: 'งบการเงินรวม', en: 'Consolidated Financials' },

  // ── Finance / Intercompany & FX ───────────────────────────────────────────
  'nav.intercompany': { th: 'ระหว่างบริษัท', en: 'Intercompany' },
  'nav.fx': { th: 'อัตราแลกเปลี่ยน', en: 'FX Rates' },

  // ── Tax ───────────────────────────────────────────────────────────────────
  'nav.tax_invoices': { th: 'ใบกำกับภาษี', en: 'Tax Invoices' },
  'nav.tax_reports': { th: 'รายงานภาษี', en: 'Tax Reports' },
  'nav.wht': { th: 'หัก ณ ที่จ่าย', en: 'Withholding Tax' },
  'nav.pos_fiscal': { th: 'ภาษีอิเล็กทรอนิกส์ (e-Tax/Journal)', en: 'e-Tax / Fiscal Journal' },

  // ── HR & Payroll ──────────────────────────────────────────────────────────
  'nav.hcm': { th: 'บุคลากร (HR)', en: 'People (HR)' },
  'nav.scheduling': { th: 'จัดตารางเวร & แรงงาน', en: 'Scheduling & Labour' },
  'nav.ot_rules': { th: 'กฎ OT & แจ้งเตือนแรงงาน', en: 'OT Rules & Labour Alerts' },
  'nav.payroll': { th: 'เงินเดือน (Payroll)', en: 'Payroll' },
  'nav.ess': { th: 'พื้นที่พนักงาน (ESS)', en: 'Employee Self-Service (ESS)' },
  'nav.expense_approvals': { th: 'อนุมัติเบิกพนักงาน', en: 'Expense Approvals' },

  // ── Planning & BI ─────────────────────────────────────────────────────────
  'nav.planning': { th: 'งบประมาณ & แผน', en: 'Budgets & Plans' },
  'nav.budget': { th: 'งบประมาณเทียบจริง (Budget vs Actual)', en: 'Budget vs Actual' },
  'nav.demand': { th: 'พยากรณ์ความต้องการ (สถิติ + backtest)', en: 'Demand Forecast (statistical)' }, // docs/27 R4-5: classical models honestly labeled — not ML
  'nav.projects': { th: 'โครงการ (Projects)', en: 'Projects' },
  'nav.pm_portfolio': { th: 'พอร์ตโครงการ', en: 'Portfolio' },
  'nav.pm_action_center': { th: 'ศูนย์งานที่ต้องทำ', en: 'Action Center' },
  'nav.pm_pipeline': { th: 'ไปป์ไลน์ Win/Loss', en: 'Win/Loss Pipeline' },
  'nav.pm_crm': { th: 'ลีด & โอกาสการขาย', en: 'Leads & Opportunities' },
  'nav.pm_close': { th: 'ปิดงวดโครงการ', en: 'Project Period Close' },
  'nav.pm_settings': { th: 'แม่แบบ & อัตราค่าแรง', en: 'Templates & Rate Cards' },
  'nav.profitability': { th: 'กำไรตามมิติ', en: 'Profitability by Dimension' },
  'nav.insights': { th: 'ข้อมูลเชิงลึก (Insights)', en: 'Insights' },
  'nav.bi': { th: 'BI Analytics', en: 'BI Analytics' },
  'nav.query': { th: 'เครื่องมือวิเคราะห์ (Studio)', en: 'Analytics Studio' },
  'nav.nl_analytics': { th: 'ถามข้อมูล (NL Analytics)', en: 'Natural Language Analytics' },
  'nav.scheduled_reports': { th: 'รายงานตามเวลา (Scheduled)', en: 'Scheduled Reports' },

  // ── Controls ──────────────────────────────────────────────────────────────
  'nav.workflow': { th: 'อนุมัติงาน', en: 'Workflow Approvals' },
  'nav.sod': { th: 'แยกหน้าที่ (SoD)', en: 'Segregation of Duties (SoD)' },
  'nav.audit': { th: 'ร่องรอยตรวจสอบ (Audit trail)', en: 'Audit Trail' },
  'nav.controls': { th: 'เฝ้าระวังการควบคุม (Controls)', en: 'Controls Monitoring' },
  'nav.ops': { th: 'ระบบ & การขยายขนาด (Ops)', en: 'System & Scaling (Ops)' },

  // ── AI ────────────────────────────────────────────────────────────────────
  'nav.assistant': { th: 'AI Assistant', en: 'AI Assistant' },
  'nav.ai_actions': { th: 'AI Actions (อนุมัติ)', en: 'AI Actions (Approve)' },
  'nav.copilot': { th: 'ผู้ช่วยอัจฉริยะ (Copilot)', en: 'Intelligent Copilot' },

  // ── Settings / Master Data ────────────────────────────────────────────────
  'nav.master_data': { th: 'ข้อมูลหลัก (Master Data)', en: 'Master Data' },
  'nav.custom_fields': { th: 'ฟิลด์กำหนดเอง (Custom fields)', en: 'Custom Fields' },
  'nav.custom_objects': { th: 'ออบเจ็กต์กำหนดเอง (Custom objects)', en: 'Custom Objects' },
  'nav.object_layouts': { th: 'เลย์เอาต์ฟอร์ม (Form layouts)', en: 'Form Layouts' },
  'nav.saved_views': { th: 'มุมมองที่บันทึก (Saved views)', en: 'Saved Views' },

  // ── Settings / Customise ──────────────────────────────────────────────────
  'nav.alerts': { th: 'การแจ้งเตือน (Alert rules)', en: 'Alert Rules' },
  'nav.automation': { th: 'ระบบอัตโนมัติ (Automation)', en: 'Automation' },
  'nav.ai_config': { th: 'ผู้ช่วยตั้งค่า (AI Config)', en: 'AI Configuration' },
  'nav.dashboard_designer': { th: 'แดชบอร์ดตามบทบาท (Role dashboards)', en: 'Role Dashboards' },
  'nav.document_templates': { th: 'เทมเพลตเอกสาร (Document templates)', en: 'Document Templates' },
  'nav.theme': { th: 'ธีมแบรนด์ (White-label)', en: 'Brand Theme (White-label)' },
  'nav.labs': { th: 'โมดูลทดลอง (Labs)', en: 'Labs (Experimental)' },

  // ── Settings / Integrations ───────────────────────────────────────────────
  'nav.connectors': { th: 'ตัวเชื่อมต่อ (Connectors)', en: 'Connectors' },
  'nav.messaging_providers': { th: 'ผู้ให้บริการข้อความ', en: 'Messaging providers' },
  'nav.webhooks': { th: 'เว็บฮุค (Webhooks)', en: 'Webhooks' },
  'nav.developer': { th: 'พอร์ทัลนักพัฒนา (Developer)', en: 'Developer Portal' },
  'nav.migration': { th: 'ย้ายข้อมูลเข้า (Migration)', en: 'Data Migration' },
  'nav.localization': { th: 'ชุดประเทศ (Localization)', en: 'Localization' },
  'nav.einvoice_nav': { th: 'ใบกำกับอิเล็กทรอนิกส์ (e-Invoicing)', en: 'e-Invoicing' },

  // ── Settings / Admin ──────────────────────────────────────────────────────
  'nav.onboarding': { th: 'เริ่มต้นใช้งาน (Onboarding)', en: 'Onboarding' },
  'nav.admin_users': { th: 'จัดการผู้ใช้', en: 'User Management' },
  'nav.setup': { th: 'ตั้งค่ากิจการ', en: 'Company Setup' },
  'nav.billing': { th: 'แพ็กเกจ', en: 'Billing' },
  'nav.settings_page': { th: 'ตั้งค่า', en: 'Settings' },

  // ── Dashboard (ERP home) ──────────────────────────────────────────────────
  'dash.title': { th: 'แดชบอร์ด', en: 'Dashboard' },
  'dash.subtitle': { th: 'ภาพรวมธุรกิจแบบเรียลไทม์', en: 'Real-time business overview' },
  'dash.live': { th: 'สด', en: 'Live' },
  'dash.offline': { th: 'ออฟไลน์', en: 'Offline' },
  'dash.live_tip': { th: 'รับข้อมูลสดแบบเรียลไทม์', en: 'Receiving live updates' },
  'dash.offline_tip': { th: 'ออฟไลน์ — รีเฟรชทุก 60 วินาที', en: 'Offline — refreshes every 60s' },
  'dash.refresh': { th: 'รีเฟรช', en: 'Refresh' },
  'dash.refresh_aria': { th: 'รีเฟรชข้อมูล', en: 'Refresh data' },
  'dash.role_kpis': { th: 'ตัวชี้วัดตามบทบาท', en: 'Your role KPIs' },
  'dash.today_sales': { th: 'ยอดขายวันนี้', en: "Today's sales" },
  'dash.month_sales': { th: 'ยอดขายเดือนนี้', en: "This month's sales" },
  'dash.low_stock': { th: 'สต๊อกต่ำ (≤0)', en: 'Low stock (≤0)' },
  'dash.outstanding_ap': { th: 'เจ้าหนี้คงค้าง (AP)', en: 'Outstanding payables (AP)' },
  'dash.orders_n': { th: '{n} ออเดอร์', en: '{n} orders' },
  'dash.need_restock': { th: 'ต้องเติมสินค้า', en: 'Needs restocking' },
  'dash.ap_due': { th: 'ยอดค้างชำระ', en: 'Amount due' },
  'dash.trend_title': { th: 'แนวโน้มยอดขาย (14 วัน)', en: 'Sales trend (14 days)' },
  'dash.trend_aria': { th: 'กราฟแนวโน้มยอดขายย้อนหลัง 14 วัน', en: '14-day sales trend chart' },
  'dash.top_items': { th: 'สินค้าขายดีวันนี้', en: 'Top items today' },
  'dash.top_items_aria': { th: 'กราฟสินค้าขายดีวันนี้ตามรายได้', en: 'Top items today by revenue chart' },
  'dash.no_sales_data': { th: 'ยังไม่มีข้อมูลยอดขาย', en: 'No sales data yet' },
  'dash.no_sales_today': { th: 'ยังไม่มียอดขายวันนี้', en: 'No sales today yet' },
  'dash.recent_orders': { th: 'ออเดอร์ล่าสุด', en: 'Recent orders' },
  'dash.no_orders': { th: 'ยังไม่มีออเดอร์', en: 'No orders yet' },
  'dash.col_item': { th: 'สินค้า', en: 'Item' },
  'dash.col_qty': { th: 'จำนวน', en: 'Qty' },
  'dash.col_revenue': { th: 'รายได้', en: 'Revenue' },
  'dash.col_no': { th: 'เลขที่', en: 'No.' },
  'dash.col_date': { th: 'วันที่', en: 'Date' },
  'dash.col_total': { th: 'ยอด', en: 'Total' },
  'dash.col_payment': { th: 'ชำระ', en: 'Payment' },
  'dash.col_status': { th: 'สถานะ', en: 'Status' },
  'dash.loading': { th: 'กำลังโหลด…', en: 'Loading…' },
  'dash.load_failed': { th: 'โหลดข้อมูลไม่สำเร็จ', en: 'Failed to load' },

  // ── Onboarding page ───────────────────────────────────────────────────────
  'onb.title': { th: 'เริ่มต้นใช้งาน (Onboarding)', en: 'Getting started (Onboarding)' },
  'onb.subtitle': { th: 'ทำตามขั้นตอนเพื่อตั้งค่าระบบ และติดตั้งชุดเริ่มต้นตามประเภทธุรกิจ (สร้างออบเจ็กต์ตัวอย่างให้ — ไม่กระทบบัญชี แยกตามกิจการ)', en: 'Follow the steps to set up the system, and install a starter pack for your industry (seeds sample objects — no accounting impact, per company)' },
  'onb.steps_title': { th: 'ขั้นตอนการตั้งค่า', en: 'Setup steps' },
  'onb.packs_title': { th: 'ชุดเริ่มต้นตามธุรกิจ', en: 'Industry starter packs' },
  'onb.objects_n': { th: '{n} ออบเจ็กต์', en: '{n} objects' },
  'onb.installed': { th: 'ติดตั้งแล้ว', en: 'Installed' },
  'onb.install': { th: 'ติดตั้ง', en: 'Install' },
  'onb.applied': { th: 'ติดตั้งแล้ว — สร้างออบเจ็กต์ใหม่ {n} รายการ', en: 'Installed — created {n} new objects' },

  // ── POS home (store overview) ─────────────────────────────────────────────
  'pos.title': { th: 'ภาพรวมหน้าร้าน (POS)', en: 'Store overview (POS)' },
  'pos.subtitle': { th: 'ยอดขายและกะวันนี้', en: "Today's sales & shifts" },
  'pos.quick_register': { th: 'เปิดหน้าขาย (Register)', en: 'Open register' },
  'pos.quick_control': { th: 'ควบคุม POS (พักบิล/อนุมัติ)', en: 'POS control (park / approve)' },
  'pos.quick_terminals': { th: 'เครื่องรับบัตร & สรุปยอด', en: 'Card terminals & totals' },
  'pos.quick_branches': { th: 'สาขา & ยอดขายรวม', en: 'Branches & total sales' },
  'pos.bills_n': { th: '{n} บิล', en: '{n} bills' },
  'pos.avg_bill': { th: 'บิลเฉลี่ย/รายการ', en: 'Average bill' },
  'pos.per_bill': { th: 'มูลค่าต่อบิล', en: 'Value per bill' },
  'pos.vat': { th: 'ภาษีมูลค่าเพิ่ม (VAT)', en: 'VAT' },
  'pos.vat_hint': { th: 'ภาษีขายวันนี้', en: 'Output tax today' },
  'pos.discount': { th: 'ส่วนลดวันนี้', en: 'Discounts today' },
  'pos.discount_hint': { th: 'โปรโมชั่น/ส่วนลด', en: 'Promotions / discounts' },
  'pos.by_payment': { th: 'ยอดขายตามวิธีชำระเงิน', en: 'Sales by payment method' },
  'pos.no_payments': { th: 'ยังไม่มีรายการชำระเงิน', en: 'No payments yet' },
  'pos.open_tills': { th: 'กะที่เปิดอยู่ (Open tills)', en: 'Open tills' },
  'pos.col_cashier': { th: 'พนักงาน', en: 'Cashier' },
  'pos.col_bills': { th: 'บิล', en: 'Bills' },
  'pos.col_session_total': { th: 'ยอดรวม', en: 'Total' },
  'pos.recent_bills': { th: 'บิลล่าสุด', en: 'Recent bills' },
  'pos.no_tills_title': { th: 'ยังไม่มีกะที่เปิดอยู่', en: 'No open tills' },
  'pos.no_tills_desc': { th: 'เปิดกะขายที่หน้า POS เพื่อเริ่มรับออเดอร์', en: 'Open a till on the POS screen to start taking orders' },
  'pos.no_bills_title': { th: 'ยังไม่มีบิลวันนี้', en: 'No bills today' },
  'pos.no_bills_desc': { th: 'บิลจะแสดงที่นี่เมื่อมีการขายผ่าน POS', en: 'Bills appear here once sales are made on POS' },

  // ── Dashboard · Today's actions launcher ──────────────────────────────────
  'today.title': { th: 'สิ่งที่ต้องทำวันนี้', en: "Today's actions" },
  'today.approvals': { th: 'รออนุมัติของฉัน', en: 'My pending approvals' },
  'today.ap_pending': { th: 'คำขอจ่ายรออนุมัติ', en: 'Payment requests to approve' },
  'today.ar_overdue': { th: 'ลูกหนี้เกินกำหนด', en: 'Overdue receivables' },
  'today.low_stock': { th: 'สต๊อกต่ำ (≤0)', en: 'Low stock (≤0)' },
  'today.n_overdue': { th: '{n} เกินกำหนด', en: '{n} overdue' },
  'today.pending': { th: 'รอดำเนินการ', en: 'Pending' },
  'today.none': { th: 'ไม่มีค้าง', en: 'All clear' },
  'today.approve_pay': { th: 'รออนุมัติจ่าย', en: 'Awaiting payment approval' },
  'today.follow_up': { th: 'ต้องติดตามทวงถาม', en: 'Needs follow-up' },
  'today.need_restock': { th: 'ต้องเติมสินค้า', en: 'Needs restocking' },
  'today.enough': { th: 'เพียงพอ', en: 'Sufficient' },

  // ── Dashboard · Getting-started first-run panel ───────────────────────────
  'getstarted.title': { th: 'เริ่มต้นใช้งาน', en: 'Getting started' },
  'getstarted.percent_done': { th: '{p}% เสร็จแล้ว', en: '{p}% complete' },
  'getstarted.mark_done': { th: 'ทำเครื่องหมายว่าเสร็จ', en: 'Mark as done' },
  'getstarted.mark_done_x': { th: 'ทำเครื่องหมายว่าเสร็จ: {label}', en: 'Mark as done: {label}' },
  'getstarted.see_all': { th: 'ดูขั้นตอนทั้งหมด →', en: 'See all steps →' },

  // ── Customer portal ───────────────────────────────────────────────────────
  'nav.portal_home': { th: 'หน้าหลัก', en: 'Home' },
  'nav.portal_pos': { th: 'ขายสินค้า (POS)', en: 'Point of Sale (POS)' },
  'nav.portal_inventory': { th: 'สต๊อก & สั่งซื้อ', en: 'Stock & Orders' },
  'nav.portal_track': { th: 'ติดตามคำสั่งซื้อ', en: 'Track Orders' },
  'nav.portal_variance': { th: 'ตรวจนับสิ้นวัน', en: 'End-of-Day Count' },
  'nav.portal_bom': { th: 'สูตรการผลิต (BoM)', en: 'Bill of Materials (BoM)' },
  'nav.portal_survey': { th: 'แบบสำรวจ', en: 'Surveys' },
  'nav.portal_loyalty': { th: 'แต้มสะสม', en: 'Loyalty Points' },
  'nav.portal_my': { th: 'ธุรกิจของฉัน', en: 'My Business' },
  'nav.portal_my_users': { th: 'พนักงานของฉัน', en: 'My Team' },
};
