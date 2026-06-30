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
  'palette.title': { th: 'ค้นหาเมนู', en: 'Search menu' },
  'palette.description': { th: 'ไปยังหน้าใดก็ได้', en: 'Go to any page' },
  'palette.placeholder': { th: 'พิมพ์เพื่อค้นหาเมนู…', en: 'Search menu…' },
  'palette.empty': { th: 'ไม่พบเมนู', en: 'No menu found' },

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
  'nav.loyalty_partners': { th: 'พันธมิตร & สิทธิพิเศษ', en: 'Partners & Privileges' },
  'nav.loyalty_analytics': { th: 'วิเคราะห์ลอยัลตี้', en: 'Loyalty Analytics' },
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
  'nav.supplier_scorecards': { th: 'คะแนนซัพพลายเออร์', en: 'Supplier Scorecards' },
  'nav.supplier_prices': { th: 'ราคาซัพพลายเออร์', en: 'Supplier Prices' },
  'nav.doc_ai': { th: 'อ่านเอกสารอัตโนมัติ (Document AI)', en: 'Document AI' },
  'nav.supplier_portal': { th: 'พอร์ทัลซัพพลายเออร์ (Supplier)', en: 'Supplier Portal' },

  // ── Production ────────────────────────────────────────────────────────────
  'nav.bom': { th: 'สูตรการผลิต (BoM)', en: 'Bill of Materials (BoM)' },
  'nav.manufacturing': { th: 'ใบสั่งผลิต (Manufacturing)', en: 'Manufacturing Orders' },
  'nav.production': { th: 'การผลิตขั้นสูง (Routing/QA/MRP)', en: 'Advanced Production (Routing/QA/MRP)' },
  'nav.eam': { th: 'ซ่อมบำรุงสินทรัพย์ (EAM)', en: 'Asset Maintenance (EAM)' },

  // ── Finance / AR-AP ───────────────────────────────────────────────────────
  'nav.finance': { th: 'การเงิน', en: 'Finance' },
  'nav.disbursements': { th: 'จ่ายเงินเจ้าหนี้ (Disbursements)', en: 'AP Disbursements' },
  'nav.credit_hold': { th: 'จัดการเครดิต & ระงับบัญชี', en: 'Credit & Hold Management' },
  'nav.advances': { th: 'เงินทดรองจ่าย (Petty cash)', en: 'Petty Cash Advances' },
  'nav.petty_cash': { th: 'กองทุนเงินสดย่อย & ค่าใช้จ่าย', en: 'Petty Cash & Expenses' },

  // ── Finance / Ledger & GL ─────────────────────────────────────────────────
  'nav.accounting': { th: 'บัญชีแยกประเภท', en: 'General Ledger' },
  'nav.revenue': { th: 'รับรู้รายได้', en: 'Revenue Recognition' },
  'nav.assets': { th: 'สินทรัพย์ถาวร', en: 'Fixed Assets' },
  'nav.leases': { th: 'สัญญาเช่า (IFRS 16)', en: 'Leases (IFRS 16)' },
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
  'nav.demand': { th: 'พยากรณ์ความต้องการ (Demand ML)', en: 'Demand Forecast (ML)' },
  'nav.projects': { th: 'โครงการ (Projects)', en: 'Projects' },
  'nav.pm_pipeline': { th: 'ไปป์ไลน์ Win/Loss', en: 'Win/Loss Pipeline' },
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
