# 05 — Frontend Architecture (Next.js 15)

แทน Streamlit monolith 12,878 บรรทัด ด้วย **Next.js 15 (App Router)** — แยก staff (internal) กับ customer portal, RBAC-driven nav, i18n TH/EN

**Stack:** Next.js 15 (App Router) · TypeScript · **shadcn/ui** · **TanStack Table** (data grid) · **TanStack Query** (data/mutations) · **next-intl** (i18n) · **Sarabun/Noto Sans Thai** webfont · Recharts/Tremor (charts แทน plotly) · zod (form validation)

---

## 1. Route structure (mirror `nav_*` เดิม)

```
apps/web/src/app/
├─ (auth)/
│  └─ login/page.tsx                 # ฟอร์ม login (Thai placeholders), เก็บ JWT
├─ (internal)/                       # staff — ~28 เพจ, layout มี sidebar RBAC
│  ├─ layout.tsx                     # nav จาก permissions ของ user
│  ├─ pos/ , orders/ , claims/ , customers/
│  ├─ dashboard/ , executive/ , planner/
│  ├─ warehouse/ , procurement/ , images/ , master-data/ , bom-master/
│  ├─ ar/ , creditors/ , delivery/ , returns/ , price-list/ , lots/ , locations/
│  ├─ promotions/ , marketing/ , mobile-scan/
│  ├─ admin/users/
│  └─ assistant/                     # AI chat
└─ (portal)/                         # customer — ~12 เพจ, tenant-scoped
   ├─ layout.tsx
   ├─ dashboard/ , pos/ , inventory/ , bom/ , variance/ , track/
   ├─ loyalty/ , survey/ , order/ , assistant/
   └─ my/ (customers/ , suppliers/ , purchase-orders/ , users/)   # mini-ERP
```

`st.tabs` เดิม → nested routes หรือ shadcn `<Tabs>` (lazy child); `st.data_editor` → TanStack Table editable; `st.rerun` → TanStack Query invalidation (ไม่มี full reload)

---

## 2. Navigation / IA (RBAC-driven)

- พอร์ต `MENU_GROUPS` (9 กลุ่ม) เป็น **typed config** `packages/shared/nav.ts`:
```ts
export const NAV_GROUPS = [
  { group: 'customerPortal', emoji:'👤', items:[
     {perm:'order_cust', route:'/order'}, {perm:'cust_pos', route:'/pos'}, ... ]},
  { group: 'sales', emoji:'💰', items:[ {perm:'pos', route:'/pos'}, {perm:'order_mgt', route:'/orders'}, ... ]},
  ...
] as const
```
- Sidebar filter ตาม `user.permissions` (เดิม `get_user_perms`); ซ่อนกลุ่มว่าง
- **เลิก** routing-by-label string (`_menu_is`) และ JS-injected gold headers ที่เปราะ — ใช้ native route + role badge
- Notification badge (🔴) จาก `/api/notifications` counts

---

## 3. i18n (TH default — parity-critical)

- พอร์ต `_LANG` dict (TH/EN, ~40 nav keys + อีกหลายสิบ) → `packages/shared/i18n/{th,en}.json` ผ่าน **next-intl**
- **TH เป็น default** (เดิม `t()` fallback TH)
- **Externalize hard-coded Thai** — เดิมหลายเพจ (Claim Mgt, Marketing tab4, Survey, Loyalty, My-Business) เป็นไทยล้วน ไม่มี EN; ตัดสินใจกับ product owner: ทำ EN เต็ม หรือคงไทยล้วนบางเพจ (ดู open decision #3 ใน MIGRATION_PLAN)
- Sarabun bundle (ฟอนต์ไทยทั้ง UI และ PDF)

---

## 4. Data & State

- **TanStack Query** — fetch/cache ต่อ resource; mutation + optimistic update + invalidate (แทน `st.rerun`)
- **Server Components** สำหรับเพจ read-heavy (dashboards, AR/AP aging, stock snapshot) → SSR ไทย, เร็ว
- **Client Components** สำหรับ interactive (POS entry, planner what-if sliders, AI chat, data_editor grids)
- Auth: JWT ใน httpOnly cookie (หรือ memory + refresh); middleware redirect ถ้าไม่มี token; แนบ Bearer ทุก request

---

## 5. Component / Design system

- **shadcn/ui** เป็นฐาน; พอร์ต design tokens เดิม: brand `RUBY #9B111E`, `BURGUNDY #800020`, report navy `#1E3C72`; KPI card variants (blue/green/orange/purple/red/teal), status badges (pending/processing/shipped/completed/claimed/cancelled) → เป็น component + Tailwind variants
- **DataTable** (TanStack) — กลาง: search, multi-filter, sort, CSV export (`utf-8-sig` BOM เดิม), pagination — ใช้ซ้ำทุกเพจ list
- **KpiCard, StatusBadge, MoneyText (฿ format `:,.2f`), ThaiDate** — atoms ใช้ทั่วระบบ
- **Charts** — Recharts/Tremor แทน plotly (area/bar/donut/funnel/scatter ตามเพจเดิม)

---

## 6. เพจที่ rebuild ยาก (flag ชัด — งบเวลาเผื่อ)

| เพจ | ความท้าทาย | แนวทาง V2 |
|---|---|---|
| Master Data / BOM upload-edit | `st.data_editor` + Excel template หัวไทย | TanStack editable grid + xlsx parse client/server; เก็บ template เป็น ExcelJS |
| Warehouse stocktake / Mobile Scanner | QR scanner + data_editor + payload format | `html5-qrcode`/`@zxing/browser`; คง QR payload `ITEM_ID:..\|DESC:..\|UOM:..\|...` |
| POS / Customer POS | cart, line discount, UOM conv, loyalty, receipt | Client state (zustand) + mutation; receipt PDF ผ่าน backend job |
| Planner what-if | sliders → recompute | client compute (สูตรเดิม) + chart |
| Track Order claim | image upload บังคับต่อ line | react-dropzone → presigned upload → claim_image_key |
| Marketing (9 tabs) | segment/AB/push | แตกเป็น sub-routes; charts |

---

## 7. Reports UX (Thai Excel/PDF)

- ปุ่ม "Export" → เรียก backend (`POST /api/orders/{no}/export`, `/api/reports/*`) → backend สร้างไฟล์ (ExcelJS / Playwright PDF + Sarabun) → คืน presigned URL → browser download
- คงเอกสารไทยเดิม: Sales Confirmation PDF, Express TXT (VAT 7% + baht-in-words + fixed-width + utf-8-sig), Claim Summary PDF, Statement PDF, PO PDF, Tax Invoice (ใบกำกับภาษี), Receipt, QR label sheet
- PDF ไทยผ่าน Chromium = ตัดบรรทัด/วรรณยุกต์ถูกต้อง (ดีกว่า fpdf เดิม)
