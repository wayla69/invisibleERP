# 04 — Data Migration (ETL: SQLite → PostgreSQL)

ย้ายข้อมูลจาก `Inventory_Master_DB.sqlite` (210MB, `tbl_raw_inventory` 1.48M แถว) → Postgres schema ใหม่ ([docs/03](03-database-schema.md)) แบบ **idempotent / re-runnable** พร้อม reconcile

**ที่อยู่:** `tools/etl/` (TypeScript, ใช้ `better-sqlite3` อ่าน + `pg`/Drizzle เขียน) หรือ standalone script
**หลักการ:** อ่านทีละตาราง → transform → upsert (idempotent) → validate ; เรียงตาม FK ; รันซ้ำได้ผลเดิม

---

## 0. ความท้าทายเฉพาะของ data เดิม (จาก reverse-engineering)

1. **SQLite dynamic typing** — เงิน/จำนวนเก็บปนเป็น text/float; วันที่เป็น text (`YYYY-MM-DD`, บาง field `dd/mm/yyyy`) → ต้อง coerce + parse `dayfirst` ตามแหล่ง
2. **คอลัมน์ชื่อแปลก** — `"Expired Date"` (เว้นวรรค), PascalCase ปน → map ชัดเจน, อย่าใช้ auto-lowercase เฉย ๆ
3. **ไม่มี FK** — join ด้วย business code/ชื่อ → ตอนโหลดต้อง resolve เป็น surrogate FK (`order_no`→`order_id`, `Customer_Name`→`tenant_id`)
4. **tenant 2 ชื่อ** — `Customer_Name` + `Owner_Customer` → map เป็น `tenant_id` เดียว (สร้าง `tenants` ก่อน)
5. **header ซ้ำต่อ line** — `tbl_sales_orders` ต้อง group `Order_No` → 1 order header + N lines + claims
6. **user hash** — SHA-256 ดิบ ขนมาตรง ๆ (อย่า re-hash ตอน ETL; rehash ตอน login)
7. **PG lowercase collision** — `tbl_users` ฝั่ง PG เดิมเป็น lowercase column → normalize ครั้งเดียวเป็น schema ใหม่
8. **master = CSV** ไม่ใช่ DB — ต้องอ่าน `Shared_Data/master_data.csv` แยก → ตาราง `items` (รวมกับ dedup จาก raw_inventory)
9. **1.48M snapshot rows** — โหลดแบบ `COPY`/batch + partition; สร้าง index หลังโหลด

---

## 1. ลำดับการโหลด (เคารพ FK)

```
1. tenants            ← distinct tbl_customers + Customer_Name/Owner_Customer ที่พบ
2. users + permissions + role_permissions + user_permissions   ← tbl_users, tbl_role_permissions (split CSV)
3. items              ← master CSV ∪ DISTINCT(Item_ID) จาก tbl_raw_inventory + meta
4. vendors            ← tbl_suppliers ∪ tbl_creditors (dedupe by name/tax_id)
5. locations
6. stock_snapshots    ← tbl_raw_inventory (COPY, batched, partition by month)
7. orders/order_lines/order_claims   ← group tbl_sales_orders by Order_No
8. cust_pos_sales/items, sales_returns, pending_orders
9. purchase_requests/pr_items → purchase_orders/po_items/po_deliveries → goods_receipts/gr_items → gr_claims
10. ar_invoices/ar_receipts, ap_transactions
11. lot_ledger, location_stock (หรือ rebuild), stock_movements, stocktakes, scan_*
12. bom_master/lines, bom_submissions/lines, cust_bom/lines, cust_prod_*, cust_variance
13. customer_items, customer_inventory, cust_stock_log, my_* (mini-ERP)
14. marketing/loyalty/survey/promotions/price_list/delivery_orders
15. notifications, doc_status_log
16. สร้าง index + analyze + reconcile
```

---

## 2. กฎ transform ต่อโดเมน (ตัวอย่างสำคัญ)

**tenants:**
```
code = trim(Customer_Name)              -- legacy key
name = Customer_Name
+ เพิ่ม tenant สำหรับทุก Owner_Customer ที่ไม่อยู่ใน tbl_customers
สร้าง map: { legacyCustomerName → tenant_id }  ใช้ resolve ทุก FK ต่อจากนี้
```

**users / permissions:**
```
username, password_hash (ขนตรง — SHA-256), role (map 'Staff'→'Sales' หรือ flag), tenant_id = map[Customer_Name]
Permissions CSV → split(',') → user_permissions rows (ข้าม key ที่ไม่อยู่ใน permissions enum, log ทิ้ง)
tbl_role_permissions CSV → role_permissions rows
seed permissions table จาก ALL_PERMISSIONS (key, emoji, label_th/en, grp)
```

**items (master จาก CSV + raw_inventory):**
```
base = read master_data.csv (Item_ID, Item_Description, Unit_Price, Stock_UOM, Conversion_Factor, Category, Base_UOM, Min/Max_Stock, Avg_Daily_Usage, Lead_Time_Days)
augment = DISTINCT Item_ID จาก tbl_raw_inventory ที่ไม่มีใน master (temperature_type, bu_id, uom)
upsert by item_id ; conversion_factor default 1 ; unit_price default 0
```

**stock_snapshots (1.48M):**
```
SELECT BU_ID, Item_ID, Item_Description, UOM, Generate_Date, Temperature_Type,
       "Expired Date" AS expiry_date, AV_QTY, Delivery_QTY, Total_Stock
coerce: Generate_Date → timestamptz ; expiry_date → date (NULL ถ้า parse ไม่ได้) ; AV_QTY/Total_Stock → numeric
โหลดด้วย COPY แบบ batch 50k ; สร้าง partition รายเดือนตาม generate_date ; index (item_id, generate_date DESC) หลังโหลด
```

**orders (de-denormalize):**
```
group tbl_sales_orders by Order_No:
  orders     = { order_no, order_date, tenant_id=map[Customer_Name], status=majority/derived, estimated_delivery, created_by }
  order_lines = ต่อแถวเดิม { item_id, item_description, order_qty, stock_uom, unit_price, total_price, status, received_qty }
  order_claims = แถวที่ Claimed_Qty>0 { order_line_id, claimed_qty, claim_reason, claim_image_key, admin_status, reject_reason }
resolve image path → upload ไป object storage → claim_image_key
```

**vendors (consolidate):**
```
จาก tbl_suppliers: is_supplier=true, vendor_code=Supplier_ID
จาก tbl_creditors: is_creditor=true, vendor_code=Creditor_ID
dedupe by (name, tax_id); ถ้าซ้ำ → merge flags
อัปเดต PO/GR/AP ให้ชี้ vendor_id (เดิมเก็บชื่อ → lookup; ถ้าหาไม่เจอ สร้าง vendor ad-hoc + log)
```

**ตาราง portal/cust → ใส่ tenant_id:**
```
ทุกตาราง tbl_cust_*, tbl_customer_*, tbl_pending_* : tenant_id = map[Customer_Name หรือ Owner_Customer]
แตก survey Q1/Q2/Q3 → survey_answers (question_no 1..3)
abandoned Cart_Data (text) → jsonb (parse; ถ้าพังเก็บ raw ใน jsonb {raw:...})
promotions Item_IDs CSV → promotion_items
```

**files → object storage:**
```
ทุก *_image path (claim_images/, gr_claim_images/, pod_images/, campaign_images/, images/):
  ถ้าไฟล์มีอยู่ → upload → เก็บ key ; ถ้าไม่มี (container ลบไปแล้ว) → key=null + log
```

---

## 3. Idempotency

- ทุก load = **upsert** (`INSERT ... ON CONFLICT (business_key) DO UPDATE`) ตาม natural key (`item_id`, `order_no`, `po_no`, `username`, `sale_no`, ...)
- snapshot (append-only) → ใช้ `ON CONFLICT DO NOTHING` บน `(item_id, generate_date)` กันซ้ำเมื่อ re-run
- เก็บ `etl_runs` table (run_id, table, rows_read, rows_written, started_at, finished_at, checksum) เพื่อ resume/audit

---

## 4. Validation / Reconciliation (gate ปิด Phase 1)

รันหลัง ETL ทุกครั้ง — ต้องผ่านทุกข้อ:

| ตรวจ | วิธี |
|---|---|
| Row count | ต่อตาราง: `count(sqlite)` == `count(pg)` (ยกเว้นที่ตั้งใจ split/merge — มีสูตรคาด) |
| ยอดการเงิน | `SUM(Total)` cust_pos_sales, `SUM(Total_Price)` sales_orders, `SUM(Amount)` AR/AP — เดิม=ใหม่ |
| Stock ล่าสุด | `current_stock` (view) ต่อ item == latest snapshot เดิม |
| Tenant integrity | ทุก `tenant_id` ใน child = มีจริงใน `tenants`; ไม่มี orphan |
| FK orphan | ทุก FK resolve ครบ (order_lines→orders, po_items→purchase_orders, ...) |
| Permission set | per-user resolved perms (V2) == `get_user_perms()` (V1) ต่อ user ตัวอย่าง |
| Doc numbers | unique ไม่ชน; รูปแบบตรง regex เดิม |
| Spot-check | สุ่ม 20 order/PO/invoice เทียบ field-by-field เดิม↔ใหม่ |

ออก **reconciliation report** (CSV/HTML) ทุก run; เก็บเป็น artifact ใน CI

---

## 5. Dry-run + Cutover

1. **Dry-run** (ซ้ำได้) — ETL ลง Postgres staging; รัน read-parity diff (Phase 2) เทียบ API เดิม vs ใหม่บนข้อมูลนี้
2. **Delta sync** — ก่อน cutover รัน ETL อีกรอบ (idempotent) ดึงข้อมูลที่เพิ่มหลัง dry-run
3. **Freeze window** — หยุด write บน V1 ชั่วคราว (maintenance), รัน ETL ครั้งสุดท้าย, reconcile
4. **Cutover** — สลับ traffic ไป V2; V1 เหลือ read-only 2 สัปดาห์
5. **Rollback** — ถ้า reconcile/Smoke ไม่ผ่าน: ชี้ traffic กลับ V1 (ยังไม่ปิด), แก้ ETL, ลองใหม่ (เพราะ idempotent)

> **หมายเหตุปริมาณจริง:** ข้อมูล transactional จริงน้อยมาก (sales_orders 9 แถว, cust_pos 1, ส่วนใหญ่ตาราง 0 แถว) — งานหนักของ ETL อยู่ที่ **`tbl_raw_inventory` 1.48M + master CSV + users** เป็นหลัก ส่วนที่เหลือเร็ว ทำให้ dry-run/cutover ความเสี่ยงต่ำ
