// i18n navigation labels — ported from the legacy _LANG dict.
// Thai is the DEFAULT language (legacy t() falls back to TH). Do not assume EN-default.

export type Lang = 'TH' | 'EN';

export const NAV_LABELS: Record<string, { TH: string; EN: string }> = {
  nav_pos: { TH: '🛒 สร้างออเดอร์ (POS)', EN: '🛒 Create Order (POS)' },
  nav_order_cust: { TH: '🛒 สั่งซื้อสินค้า', EN: '🛒 Place Order' },
  nav_dashboard: { TH: '📊 Sales Dashboard', EN: '📊 Sales Dashboard' },
  nav_exec: { TH: '👔 Executive Dashboard', EN: '👔 Executive Dashboard' },
  nav_cust_dash: { TH: '📊 Dashboard ของฉัน', EN: '📊 My Dashboard' },
  nav_cust_my_crm: { TH: '👥 ฐานข้อมูลลูกค้าของฉัน', EN: '👥 My Customers' },
  nav_cust_my_suppliers: { TH: '🏢 ซัพพลายเออร์ของฉัน', EN: '🏢 My Suppliers' },
  nav_cust_my_pos: { TH: '🛒 สร้างใบสั่งซื้อ (My POs)', EN: '🛒 My Purchase Orders' },
  nav_cust_my_users: { TH: '👥 จัดการบัญชีพนักงาน', EN: '👥 My Users' },
  nav_cust_inventory: { TH: '📦 สต๊อกสินค้า & สั่งซื้อซ้ำ', EN: '📦 My Inventory & Reorder' },
  nav_loyalty: { TH: '⭐ Loyalty Points', EN: '⭐ Loyalty Points' },
  nav_survey: { TH: '📝 Survey & Feedback', EN: '📝 Survey & Feedback' },
  nav_cust_pos: { TH: '🏪 POS ขายสินค้า', EN: '🏪 My POS' },
  nav_cust_bom: { TH: '🔬 สูตรผลิต (BoM)', EN: '🔬 Bill of Materials' },
  nav_cust_variance: { TH: '📊 วิเคราะห์ผลต่าง', EN: '📊 Variance Analysis' },
  nav_marketing: { TH: '📣 การตลาด (Marketing)', EN: '📣 Marketing Dashboard' },
  nav_order_mgt: { TH: '🗂️ จัดการคำสั่งซื้อ (Order Mgt)', EN: '🗂️ Order Management' },
  nav_claim_mgt: { TH: '🛠️ ระบบจัดการเคลม', EN: '🛠️ Claim Center' },
  nav_crm: { TH: '👥 ฐานข้อมูลลูกค้า (CRM)', EN: '👥 Customer Database (CRM)' },
  nav_users: { TH: '⚙️ จัดการผู้ใช้งาน', EN: '⚙️ User Management' },
  nav_images: { TH: '🖼️ จัดการรูปภาพ', EN: '🖼️ Image Manager' },
  nav_masterdata: { TH: '📋 จัดการ Master Data', EN: '📋 Master Data Manager' },
  nav_bom_master: { TH: '🔬 คลังสูตรผลิตกลาง (BoM Master)', EN: '🔬 BoM Master Library' },
  nav_planner: { TH: '📐 Planner / วางแผนสินค้า', EN: '📐 Planner' },
  nav_warehouse: { TH: '🏭 คลังสินค้า (Warehouse)', EN: '🏭 Warehouse' },
  nav_procurement: { TH: '🛒 จัดซื้อ (Procurement)', EN: '🛒 Procurement' },
  nav_creditors: { TH: '🏦 เจ้าหนี้ (AP / Creditors)', EN: '🏦 Creditors (AP)' },
  nav_ar: { TH: '💵 ลูกหนี้ (AR / รับชำระ)', EN: '💵 AR / Collections' },
  nav_delivery: { TH: '🚚 ใบส่งสินค้า (Delivery)', EN: '🚚 Delivery Orders' },
  nav_returns: { TH: '↩️ รับคืนสินค้า (Returns)', EN: '↩️ Sales Returns' },
  nav_pricelist: { TH: '🏷️ ราคาพิเศษลูกค้า (Price List)', EN: '🏷️ Price List' },
  nav_lots: { TH: '🔖 Lot/Batch Tracking', EN: '🔖 Lot/Batch Tracking' },
  nav_locations: { TH: '📍 Multi-Location Stock', EN: '📍 Multi-Location Stock' },
  nav_promos: { TH: '🎁 โปรโมชั่น/แคมเปญ', EN: '🎁 Promotions' },
  nav_mobile: { TH: '📱 Mobile Scanner', EN: '📱 Mobile Scanner' },
  nav_track: { TH: '📦 ติดตามสถานะและเคลมสินค้า', EN: '📦 Track Orders & Claims' },
  nav_ai_chat: { TH: '🤖 AI Assistant', EN: '🤖 AI Assistant' },
  logout: { TH: '🚪 ออกจากระบบ', EN: '🚪 Sign Out' },
  user_label: { TH: '👤 ผู้ใช้งาน', EN: '👤 User' },
  dept_label: { TH: '🏢 สังกัด', EN: '🏢 Department' },
  lang_label: { TH: '🌐 ภาษา / Language', EN: '🌐 Language / ภาษา' },
};

export function navLabel(key: string, lang: Lang = 'TH'): string {
  return NAV_LABELS[key]?.[lang] ?? NAV_LABELS[key]?.TH ?? key;
}
