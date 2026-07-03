'use client';

import { useQuery } from '@tanstack/react-query';
import { api, hasSession } from './api';
import { INTERNAL_NAV, allGroupItems } from './nav';
import type { Lang } from './messages';

export interface ModuleFlag { key: string; enabled: boolean; always_on: boolean }
// `navDisabled` = hrefs of sidebar entries an admin has hidden (menu visibility, distinct from module flags).
// `groupOrder` = admin-curated system-wide order of nav-group titles (empty ⇒ code order).
// `itemOrder` = per-container (group/sub-section title → ordered hrefs) order of menu items within it.
export interface ModuleFlags {
  modules: ModuleFlag[];
  disabled: string[];
  navDisabled?: string[];
  groupOrder?: string[];
  itemOrder?: Record<string, string[]>;
}

// Effective module flags for the CURRENT user (any role) — used to hide disabled
// modules from the nav. Read-only endpoint; the admin write endpoint is gated.
export function useModuleFlags() {
  return useQuery<ModuleFlags>({
    queryKey: ['module-flags'],
    queryFn: () => api<ModuleFlags>('/api/modules/effective'),
    enabled: typeof window !== 'undefined' && !!hasSession(),
    staleTime: 30_000,
  });
}

export function humanizeModule(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Module (permission) display metadata ────────────────────────────────────────────────────────────────
// A "module" is a permission key (MODULE_KEYS). Raw keys read cryptically (`pr_raise` → "Pr Raise"), so the
// admin toggle uses these business-friendly names, grouped by category, to mirror the sidebar. `cat` maps to
// MODULE_CATEGORIES. Any key missing here falls back to humanizeModule().
export interface ModuleInfo { th: string; en: string; cat: string }

export const MODULE_CATEGORIES: { key: string; th: string; en: string }[] = [
  { key: 'overview', th: 'ภาพรวม', en: 'Overview' },
  { key: 'sales', th: 'ขายหน้าร้าน & บริการ', en: 'Sales & Service' },
  { key: 'crm', th: 'ลูกค้า, CRM & การตลาด', en: 'Customers, CRM & Marketing' },
  { key: 'pricing', th: 'ราคา & สาขา', en: 'Pricing & Branches' },
  { key: 'inventory', th: 'สินค้าคงคลัง', en: 'Inventory' },
  { key: 'procure', th: 'จัดซื้อ & การผลิต', en: 'Procurement & Production' },
  { key: 'finance', th: 'การเงิน (AR/AP)', en: 'Finance (AR/AP)' },
  { key: 'exec', th: 'ผู้บริหาร, วางแผน & BI', en: 'Executive, Planning & BI' },
  { key: 'people', th: 'บุคลากร', en: 'People' },
  { key: 'controls', th: 'การควบคุม & อนุมัติ', en: 'Controls & Approvals' },
  { key: 'ai', th: 'ผู้ช่วย AI', en: 'AI Assistant' },
  { key: 'system', th: 'ตั้งค่าระบบ', en: 'System Settings' },
  { key: 'portal', th: 'พอร์ทัลลูกค้า', en: 'Customer Portal' },
  { key: 'portal_biz', th: 'พอร์ทัล “ธุรกิจของฉัน”', en: 'Portal — My Business' },
  { key: 'other', th: 'อื่น ๆ', en: 'Other' },
];

const CAT_LABEL: Record<string, { th: string; en: string }> = Object.fromEntries(
  MODULE_CATEGORIES.map((c) => [c.key, { th: c.th, en: c.en }]),
);

export const MODULE_META: Record<string, ModuleInfo> = {
  // Overview
  dashboard: { th: 'แดชบอร์ด', en: 'Dashboard', cat: 'overview' },
  // Sales & service
  pos: { th: 'ขายหน้าร้าน (POS)', en: 'Point of Sale (POS)', cat: 'sales' },
  order_mgt: { th: 'จัดการออเดอร์', en: 'Order Management', cat: 'sales' },
  returns: { th: 'คืนสินค้า', en: 'Returns', cat: 'sales' },
  claim_mgt: { th: 'จัดการเคลม', en: 'Claims', cat: 'sales' },
  delivery: { th: 'การจัดส่ง', en: 'Delivery', cat: 'sales' },
  // Customers, CRM & marketing
  crm: { th: 'CRM 360 / ลูกค้า', en: 'CRM 360 / Customers', cat: 'crm' },
  marketing: { th: 'การตลาด', en: 'Marketing', cat: 'crm' },
  loyalty: { th: 'ลอยัลตี้ & แต้ม', en: 'Loyalty & Points', cat: 'crm' },
  // Pricing & branches
  pricelist: { th: 'ราคาขาย', en: 'Price List', cat: 'pricing' },
  promos: { th: 'โปรโมชัน', en: 'Promotions', cat: 'pricing' },
  branch: { th: 'สาขา', en: 'Branches', cat: 'pricing' },
  // Inventory
  warehouse: { th: 'คลังสินค้า', en: 'Warehouse', cat: 'inventory' },
  lots: { th: 'ล็อต & อายุสินค้า', en: 'Lots & Expiry', cat: 'inventory' },
  locations: { th: 'ตำแหน่งจัดเก็บ', en: 'Storage Locations', cat: 'inventory' },
  mobile: { th: 'สแกนมือถือ', en: 'Mobile Scan', cat: 'inventory' },
  images: { th: 'รูปสินค้า', en: 'Item Images', cat: 'inventory' },
  // Procurement & production
  procurement: { th: 'จัดซื้อ', en: 'Procurement', cat: 'procure' },
  pr_raise: { th: 'คำขอซื้อ (PR)', en: 'Purchase Requisition (PR)', cat: 'procure' },
  bom_master: { th: 'สูตร/BOM & การผลิต', en: 'BOM & Manufacturing', cat: 'procure' },
  vendor_portal: { th: 'พอร์ทัลซัพพลายเออร์', en: 'Supplier Portal', cat: 'procure' },
  // Finance
  ar: { th: 'ลูกหนี้ (AR)', en: 'Accounts Receivable (AR)', cat: 'finance' },
  creditors: { th: 'เจ้าหนี้ (AP)', en: 'Accounts Payable (AP)', cat: 'finance' },
  // Executive, planning & BI
  exec: { th: 'ผู้บริหาร & รายงานการเงิน', en: 'Executive & Financials', cat: 'exec' },
  planner: { th: 'วางแผน', en: 'Planning', cat: 'exec' },
  // People
  ess: { th: 'พนักงาน (Self-Service)', en: 'Employee Self-Service', cat: 'people' },
  // Controls & approvals
  approvals: { th: 'อนุมัติ (Workflow)', en: 'Approvals (Workflow)', cat: 'controls' },
  // AI
  ai_chat: { th: 'ผู้ช่วย AI', en: 'AI Assistant', cat: 'ai' },
  // System
  masterdata: { th: 'ข้อมูลหลัก', en: 'Master Data', cat: 'system' },
  users: { th: 'ผู้ใช้ & สิทธิ์', en: 'Users & Permissions', cat: 'system' },
  // Customer portal
  track: { th: 'ติดตามสถานะ', en: 'Order Tracking', cat: 'portal' },
  survey: { th: 'แบบสอบถาม', en: 'Surveys', cat: 'portal' },
  order_cust: { th: 'สั่งซื้อ (ลูกค้า)', en: 'Customer Ordering', cat: 'portal' },
  cust_dash: { th: 'แดชบอร์ด (ลูกค้า)', en: 'Customer Dashboard', cat: 'portal' },
  cust_inventory: { th: 'สต๊อก (ลูกค้า)', en: 'Customer Inventory', cat: 'portal' },
  cust_pos: { th: 'POS (ลูกค้า)', en: 'Customer POS', cat: 'portal' },
  cust_bom: { th: 'BOM (ลูกค้า)', en: 'Customer BOM', cat: 'portal' },
  cust_variance: { th: 'ผลต่าง (ลูกค้า)', en: 'Customer Variance', cat: 'portal' },
  // Portal — my business
  cust_my_crm: { th: 'ลูกค้าของฉัน', en: 'My Customers', cat: 'portal_biz' },
  cust_my_suppliers: { th: 'ซัพพลายเออร์ของฉัน', en: 'My Suppliers', cat: 'portal_biz' },
  cust_my_pos: { th: 'ใบสั่งซื้อของฉัน', en: 'My Purchase Orders', cat: 'portal_biz' },
  cust_my_users: { th: 'ผู้ใช้ของฉัน', en: 'My Users', cat: 'portal_biz' },
};

export function moduleLabel(key: string, lang: Lang): string {
  const m = MODULE_META[key];
  if (!m) return humanizeModule(key);
  return lang === 'en' ? m.en : m.th;
}

export function moduleCategoryKey(key: string): string {
  return MODULE_META[key]?.cat ?? 'other';
}

export function categoryLabel(catKey: string, lang: Lang): string {
  const c = CAT_LABEL[catKey];
  if (!c) return catKey;
  return lang === 'en' ? c.en : c.th;
}

// The "controls these menus" cross-reference: every sidebar entry this permission gates, computed live from
// nav.ts (its `perms` array) — deduped by href, in nav order. Keeps the settings page honest as nav evolves.
export function menusForPerm(perm: string): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = [];
  const seen = new Set<string>();
  for (const g of INTERNAL_NAV) {
    for (const it of allGroupItems(g)) {
      if ((it.perms ?? []).includes(perm) && !seen.has(it.href)) {
        seen.add(it.href);
        out.push({ label: it.label, href: it.href });
      }
    }
  }
  return out;
}
