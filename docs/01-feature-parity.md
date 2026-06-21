# 01 — Feature-Parity Matrix (Checklist 100%)

ทุกแถวคือฟีเจอร์/endpoint/tool ของระบบเดิม → ปลายทางใน V2 ใช้เป็น **checklist ปิดเฟส** (ฟีเจอร์จะถือว่า "ครบ" เมื่อมี V2 module + endpoint + UI + test)

สัญลักษณ์โดเมน V2: `pos` `inventory` `procurement` `finance` `bom` `portal` `marketing` `loyalty` `admin` `ai` `reports` `notifications`

---

## A. Streamlit Pages (เมนู `nav_*`) → V2 Route/Module

| # | เพจเดิม (`nav_*`) | tabs | หน้าที่ | V2 route | V2 module | parity-critical (ห้ามตก) |
|---|---|---|---|---|---|---|
| 1 | `nav_pos` / `nav_order_cust` | manual/excel | สร้าง sales order เข้า `tbl_sales_orders` | `(internal)/pos`, `(portal)/order` | `pos` | UOM conv (`q_large + q_small/conv`); SO no = `SO-YYYYMMDD-HHMM`; loyalty earn; credit-hold/limit check; Excel template หัวคอลัมน์ไทย |
| 2 | `nav_dashboard` | 6 (ภาพรวม/orders/claims/shortage/raw/PL) | analytics ยอดขายภายใน | `(internal)/dashboard` | `pos`+`reports` | Claim Rate, status funnel, P&L COGS=master Unit_Price, 20% GM target |
| 3 | `nav_exec` | 4 (overview/sales/wh/proc) | exec cross-dept | `(internal)/executive` | `reports` | PO value, active suppliers, movements, try/except resilient |
| 4 | `nav_order_mgt` | — | back-office จัดการ order + export | `(internal)/orders` | `pos` | 6-state workflow; Estimated_Delivery wipe bug; PDF/TXT/CSV(Express ไทย) export |
| 5 | `nav_claim_mgt` | — | admin ตัดสิน claim (ไทยล้วน) | `(internal)/claims` | `pos` | Waiting→Approved/Rejected; reject ต้องมีเหตุผล; rowid-scoped; claim PDF |
| 6 | `nav_cust_dash` | 6 | dashboard ลูกค้า + auto-reorder | `(portal)/dashboard` | `portal` | popup/ticker; **auto-reorder side-effect** on load (PND-); MoM compare |
| 7 | `nav_cust_pos` | 3 | POS ลูกค้าขายปลีก | `(portal)/pos` | `portal`+`loyalty` | VAT 7%; SALE- no; ตัด `tbl_customer_inventory`; loyalty; receipt PDF |
| 8 | `nav_cust_bom` | 4 | BOM/สูตร + production run | `(portal)/bom` | `bom`+`portal` | cost rollup (Conv_Factor); dual-write `tbl_bom_submissions` (HQ approval); PRD- run |
| 9 | `nav_cust_variance` | 3 | นับ EOD vs system | `(portal)/variance` | `portal` | threshold 10%/5%; overwrite Current_Stock; shift enum |
| 10 | `nav_cust_inventory` | 4 | สต๊อก + reorder + pending | `(portal)/inventory` | `portal` | RP/RQ; status RP*1.3; Draft→Submitted; `order_cart` vs `cart` |
| 11 | `nav_track` | — | ติดตาม order + แจ้งเคลม | `(portal)/track` | `pos`+`portal` | composite status ("Partial Claim"); claim image upload บังคับ; item-level status split |
| 12 | `nav_planner` | 4 (stock/planner/whatif/dead) | วางแผน reorder + PR | `(internal)/planner` | `inventory`+`procurement` | ROP=ADU×LT+Min; Suggest=Max-AV; what-if stress; deadstock; PR (admin approve) |
| 13 | `nav_warehouse` | 4 (issue/stocktake/QR/history) | issue/transfer/นับ/QR | `(internal)/warehouse` | `inventory` | movement = audit (ไม่ตัด raw_inventory); MI-/ST- no; QR payload format; stocktake Draft-only |
| 14 | `nav_procurement` | 7 | PR→PO→GR→claims→suppliers | `(internal)/procurement` | `procurement` | **tab bindings สลับ** (แก้จงใจ); 3 PO numbering schemes; GR→PO close + lot ledger; GRC- |
| 15 | `nav_images` | 3 | จัดการรูปสินค้า | `(internal)/images` | `inventory` | filename=Item_ID; replace ลบทุก ext ก่อน; → object storage |
| 16 | `nav_masterdata` | 4 | CRUD master catalog (**CSV ไฟล์**) | `(internal)/master-data` | `inventory` | master = CSV ไม่ใช่ DB → V2 ทำเป็นตาราง `items`; upsert by Item_ID; 5 styled templates |
| 17 | `nav_bom_master` | 5 | BOM กลาง + push + approve | `(internal)/bom-master` | `bom` | costing; push to customer (delete+insert); submission approve |
| 18 | `nav_ar` | 4 | ลูกหนี้ + aging | `(internal)/ar` | `finance` | `_sync_ar_invoices` on load (INV-{Order_No}); credit-term digit extract; aging buckets; receipt RCP- |
| 19 | `nav_delivery` | 2 | ใบส่งของ + POD | `(internal)/delivery` | `finance`/`logistics` | DO-; POD image; ไม่ตัด stock |
| 20 | `nav_returns` | 2 | รับคืน + credit note | `(internal)/returns` | `pos`/`inventory` | RTN-; Return_To_Stock → stock_movement (Move_Type='Return') |
| 21 | `nav_pricelist` | 3 | ราคาพิเศษลูกค้า | `(internal)/price-list` | `pos` | Effective = Special หรือ Base×(1-disc); "All Customers"='' |
| 22 | `nav_lots` | 4 | lot/batch + expiry + FEFO | `(internal)/lots` | `inventory` | `_sync_lots` on load; FEFO/FIFO; expiry buckets |
| 23 | `nav_locations` | 3 | multi-location + transfer | `(internal)/locations` | `inventory` | `_sync_loc_stock` **DELETE+rebuild** on load; TRF-; update lot Location_ID |
| 24 | `nav_promos` | 3 | กฎโปรโมชั่น | `(internal)/promotions` | `marketing` | 6 promo types; Item_IDs CSV→junction; Max_Uses |
| 25 | `nav_mobile` | 3 | QR scanner → stock | `(internal)/mobile-scan` | `inventory` | QR parse `KEY:VALUE\|...`; SCAN- session; close→commit movements |
| 26 | `nav_creditors` | 4 | เจ้าหนี้ AP + aging | `(internal)/creditors` | `finance` | AP- txn; creditor vs supplier (consolidate); aging |
| 27 | `nav_users` | 5 (add/edit/perm/role/del) | จัดการผู้ใช้ + RBAC | `(internal)/admin/users` | `admin` | **PERM_GROUPS taxonomy**; per-user override; Admin full hardcoded; admin delete-protected |
| 28 | `nav_marketing` | 9 | campaigns/AB/segment/push/loyalty cfg/abandoned/survey | `(internal)/marketing` | `marketing` | RFM segment rules; AB CTR/CVR; loyalty config singleton; abandon rate |
| 29 | `nav_loyalty` | 2 | ลูกค้าดู/แลกแต้ม | `(portal)/loyalty` | `loyalty` | gating on Enabled; Min_Redeem; sets `loyalty_discount` (cross-page) |
| 30 | `nav_survey` | — | ลูกค้าตอบ survey (ไทยล้วน) | `(portal)/survey` | `marketing` | NPS/CSAT; Q1-Q3 fixed; recommend enum ไทย |
| 31 | `nav_cust_my_crm` | 2 | ลูกค้าของลูกค้า | `(portal)/my/customers` | `portal` | scope `Owner_Customer` |
| 32 | `nav_cust_my_suppliers` | 2 | ซัพพลายเออร์ของลูกค้า | `(portal)/my/suppliers` | `portal` | scope `Owner_Customer` |
| 33 | `nav_cust_my_pos` | — | ลูกค้าออก PO เอง | `(portal)/my/purchase-orders` | `portal` | MPO- no; ไม่มี Item_ID (free text) |
| 34 | `nav_cust_my_users` | — | ลูกค้าสร้าง sub-account | `(portal)/my/users` | `portal`+`admin` | **hash sha256 inline** (ไม่ใช่ make_hash); permission bundles; scope same customer |
| 35 | `nav_crm` | 3 | customer master ภายใน | `(internal)/customers` | `pos`/`admin` | Credit_Term/Limit/Hold feed AR + POS gating |
| 36 | `nav_ai_chat` | — | Claude chat over ERP | `(internal)/assistant` + `(portal)/assistant` | `ai` | ERPAgent 19 tools; quick prompts ไทย; history 20 |

> **หมายเหตุ dead/legacy:** `_build_menu_for_role`/`ALL_NAV_KEYS` (RBAC ระบบเก่า) ไม่ต้องพอร์ต — ใช้ `MENU_GROUPS`+`ALL_PERMISSIONS` (ระบบ live) เป็นแหล่งจริง

---

## B. REST Endpoints (FastAPI เดิม) → V2

ทุก path เดิมคงไว้ (mobile app ใช้อยู่) — ดูสัญญาเต็ม [docs/02-api-spec.md](02-api-spec.md)

| เดิม | V2 | หมายเหตุ parity |
|---|---|---|
| `POST /api/login` | คงเดิม | คืน `{token, username, role, customer_name}`; error ไทย; JWT แทน HMAC |
| `GET /api/auth/me` | คงเดิม | endpoint เดียวที่เดิม verify token |
| `GET /` , `GET /api/config` | คงเดิม | health + config (theme/contact) |
| `GET /api/dashboard` | คงเดิม | 6 sub-queries; Voided excl; AV_QTY≤0; top items/recent |
| `GET /api/dashboard/sales-trend` | คงเดิม | `days` param |
| `GET /api/pos/summary` | คงเดิม | start/end required; avg_order_value |
| `GET /api/pos/orders` `{sale_no}` | คงเดิม | SELECT * → ต้องคงทุกคอลัมน์ |
| `GET /api/pos/sessions` | คงเดิม | derived จาก Status='Open' |
| `GET /api/inventory/stock` `{item_id}` | คงเดิม | latest snapshot; `"Expired Date"`→Expiry_Date; drill-down |
| `GET /api/inventory/suppliers` `{supplier_id}` | คงเดิม | match by name OR id |
| `GET /api/inventory/purchase-orders` `{po_no}` | คงเดิม | approval fields + per-line received |
| `GET /api/finance/pl` | คงเดิม | **Dec off-by-one** (แก้จงใจ + บันทึก) |
| `GET /api/finance/ap` `/ar` | คงเดิม | page-only total; default status="Outstanding" |
| `GET /api/finance/kpi` | คงเดิม | MTD/YTD; `strftime`→`EXTRACT/to_char` |
| `POST /api/chat` | **ยกระดับ** | เดิมดึง DB ไม่ได้ — V2 ต่อ tools จริง (improvement) |
| `GET /api/reports/daily-sales` `/stock-summary` | คงเดิม | LEFT JOIN; snapshot |
| `GET /api/customers/{name}` | คงเดิม | key = ชื่อ; orders รวม Voided แต่ stats ไม่รวม |
| `GET /api/notifications` | คงเดิม | 3 sources; **ไทย** titles (เกินกำหนด); ฿ format; severity enum |
| `GET /api/analytics/replenishment` `{item_id}` | คงเดิม | forecasting; urgency |
| `GET /api/analytics/anomalies` | คงเดิม | Z 2.5/3.5 |
| `POST /api/analytics/insight` | คงเดิม | type replenishment/anomaly |
| `GET /api/analytics/dashboard-summary` | คงเดิม | repl+anomaly+insight |

**Write endpoints ใหม่ (เดิม Streamlit ทำในตัว ไม่มี REST):** ดู [docs/02](02-api-spec.md) §"Write API" — POS, PR/PO/GR, stocktake, movement, AR/AP, returns, DO, price-list, lots, locations, promos, BOM, users/RBAC, marketing, loyalty, survey, portal writes

---

## C. AI Tools (19) → V2 `ai` module

พอร์ตเป็น tool ที่เรียก **service layer เดียวกับ REST** (agent + คน ใช้ code path เดียว → ได้ RBAC/tenant อัตโนมัติ)

| กลุ่ม | tools | parity |
|---|---|---|
| POS | get_sales_summary, get_recent_orders, get_order_detail, get_open_sessions, **void_order**\* | void เฉพาะ POSAgent (RBAC gate) |
| Inventory | get_stock_levels, get_stock_item, get_supplier_list, create_purchase_order, **adjust_stock**\*, get_purchase_orders | PO no `PO-YYYYMMDD-rand4`; adjust เฉพาะ InventoryAgent; supplier fallback |
| Finance | get_pl_summary, get_kpi_dashboard, get_cash_position, get_accounts_payable, get_accounts_receivable | revenue-only + `note`; Dec boundary |
| Reports | get_available_reports, generate_daily_report, generate_monthly_pl, generate_stock_report | Excel `#1E3C72` header; `generate_ap_aging_report` เป็น phantom (เลือก implement) |

\* `void_order`/`adjust_stock` ต้อง **ไม่** อยู่ใน general agent toolset (privilege gate เดิม)

---

## D. Analytics (5) → V2 `ai`/`analytics` service

| function | parity (ค่าคงที่เป๊ะ) |
|---|---|
| `predict_stockout` | series gap-fill จาก first-sale; `recent=series[-30:]`; safety=1.5σ; ROP=avg×LT+safety; urgency ≤LT/≤2LT |
| `get_replenishment_list` | candidate `LIMIT 200`; sort critical→soonest; truncate limit |
| `detect_stock_anomalies` | baseline `days+60`, recent `days`; z>2.5 flag, >3.5 critical; dim mismatch (คงไว้) |
| `detect_stocktake_variance` | latest stocktake only; ≥20% flag, ≥50% critical |
| `get_*_insight` (LLM) | model centralize; **rule-based fallback** เมื่อไม่มี key; Thai-only output; max_tokens 300/300/200 |

---

## E. Cross-cutting (ต้องมีใน V2)

| สิ่งที่ต้องมี | เดิม | V2 |
|---|---|---|
| i18n TH/EN | `_LANG` dict + hard-coded Thai | `packages/shared/i18n` (next-intl), TH default; externalize hard-coded Thai |
| RBAC | `ALL_PERMISSIONS` (~38 keys) + per-user override | `permissions` enum + `role_permissions`/`user_permissions` join; guards |
| Multi-tenant | `Customer_Name`/`Owner_Customer` | `tenant_id` FK + RLS |
| Doc numbering | 15 schemes (race-prone) | `DocNumberService` (Postgres sequence), คงรูปแบบแสดงผล |
| Status audit | `tbl_doc_status_log` (`_log_status`) | `doc_status_log` + service hook |
| Notifications | `tbl_notifications` (bilingual) + sidebar badge | `notifications` module + realtime/poll |
| Thai documents | fpdf + bahttext + Express TXT | Playwright+Sarabun + baht-in-words lib + Express TXT exporter |
| Snapshot stock | `tbl_raw_inventory` `MAX(Generate_Date)` | `stock_snapshots` (partitioned) + `latestSnapshotDate()` service |
