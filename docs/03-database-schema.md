# 03 — PostgreSQL Schema ใหม่ (V2)

ออกแบบจาก 65 ตาราง SQLite เดิม → schema สะอาด: **surrogate PK + FK จริง, enums, `tenant_id`, แยก item master/stock, sequence สำหรับเลขเอกสาร, RLS multi-tenant**

**Drizzle ORM** — แนวทาง: `drizzle-kit introspect` schema เดิมเป็นจุดเริ่ม แล้ว refactor ตามด้านล่าง
**กฎตั้งชื่อ:** ตาราง/คอลัมน์เป็น `snake_case` พหูพจน์ (`sales_orders`, `created_at`); เงินเป็น `numeric(14,2)`; เวลา `timestamptz`

---

## 0. การตัดสินใจระดับ schema (สรุปจาก reverse-engineering)

1. **Surrogate PK ทุกตาราง** — เดิม join ด้วย business code/ชื่อ (เช่น `tbl_sales_orders` ไม่มี PK เลย). V2: `id bigserial PK` + เก็บ business code เป็น `unique`
2. **`tenant_id` รวมศูนย์** — เดิมมี 2 ชื่อ (`Customer_Name`, `Owner_Customer`) → `tenant_id bigint REFERENCES tenants(id)`. ทุก portal/cust table มี `tenant_id` + **RLS** `USING (tenant_id = current_setting('app.tenant_id')::bigint)`
3. **แยก item master ↔ stock fact** — `tbl_raw_inventory` เป็นทั้ง master และ snapshot 1.48M แถว → `items` (master, unique `item_id`) + `stock_snapshots` (partition by `generate_date`) + view `current_stock`
4. **Enums** — ทุก `Status/Type/Method/Shift/Action/Currency/Priority` เป็น Postgres `enum`
5. **เลิก CSV/serialized** — `Permissions` CSV → `role_permissions`/`user_permissions` join; `Promotions.Item_IDs` → `promotion_items`; `survey Q1-3` → `survey_answers`; `Cart_Data`/`abandoned` → `jsonb`
6. **รวม vendor** — `tbl_suppliers` ⟷ `tbl_creditors` ทับซ้อน → `vendors` เดียว (มี flag `is_supplier`/`is_creditor`) **หรือ** คงสองตารางช่วงแรกแล้วค่อยรวม (ลด migration risk — แนะนำคงก่อน, รวมภายหลัง)
7. **Doc numbering** → ตาราง `doc_sequences` + Postgres `sequence` ต่อชนิด/ต่อวัน (คงรูปแบบ string เดิม)
8. **Header/line de-norm** — `tbl_sales_orders` ซ้ำ header ต่อ line → แยก `orders` + `order_lines` (+ `order_claims`)

---

## 1. System / Auth / Tenancy

```sql
CREATE TYPE role_enum AS ENUM ('Admin','Sales','Customer','Warehouse','Procurement','Planner');

CREATE TABLE tenants (                      -- จาก tbl_customers (tenant key)
  id            bigserial PRIMARY KEY,
  code          text UNIQUE NOT NULL,        -- legacy Customer_Name (ชื่อเดิม)
  name          text NOT NULL,
  contact_name  text, phone text, email text, tax_id text, address text,
  credit_term   text,                        -- "Net 30" ฯลฯ (digit-extract ที่ AR)
  credit_limit  numeric(14,2) DEFAULT 0,
  credit_hold   boolean DEFAULT false,
  outstanding_ar numeric(14,2) DEFAULT 0,    -- cached
  created_at timestamptz DEFAULT now()
);

CREATE TABLE users (                         -- tbl_users (dual SQLite/PG เดิม)
  id            bigserial PRIMARY KEY,
  username      text UNIQUE NOT NULL,
  password_hash text NOT NULL,               -- argon2 (legacy sha256 รองรับ verify+rehash)
  role          role_enum NOT NULL DEFAULT 'Sales',  -- เดิม PG default 'Staff' (bug) → แก้
  tenant_id     bigint REFERENCES tenants(id),       -- เดิม Customer_Name
  created_at timestamptz DEFAULT now()
);

CREATE TABLE permissions (                   -- ~38 keys จาก ALL_PERMISSIONS
  key text PRIMARY KEY, emoji text, label_th text, label_en text, grp text
);
CREATE TABLE role_permissions (role role_enum, perm text REFERENCES permissions(key), PRIMARY KEY(role,perm));
CREATE TABLE user_permissions (user_id bigint REFERENCES users(id), perm text REFERENCES permissions(key), PRIMARY KEY(user_id,perm));
-- resolution: Admin→all (code) ; user_permissions ถ้ามี ; else role_permissions

CREATE TABLE notifications (                 -- tbl_notifications (bilingual)
  id bigserial PRIMARY KEY,
  target_tenant_id bigint REFERENCES tenants(id), target_role role_enum,
  message text, message_en text, is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE doc_status_log (                -- tbl_doc_status_log (polymorphic audit)
  id bigserial PRIMARY KEY, doc_type text, doc_no text,
  old_status text, new_status text, changed_by text, changed_at timestamptz DEFAULT now(), remarks text
);
```

---

## 2. Items & Stock (แยกจาก tbl_raw_inventory)

```sql
CREATE TABLE items (                         -- master (เดิม CSV + dedup raw_inventory)
  id bigserial PRIMARY KEY,
  item_id text UNIQUE NOT NULL,              -- business code (universal FK เดิม)
  item_description text, uom text, base_uom text,
  conversion_factor numeric DEFAULT 1,       -- floor(AV_QTY/conv) = sellable
  unit_price numeric(14,2) DEFAULT 0,        -- master price (cost proxy ใน P&L/BOM)
  category text, temperature_type text, bu_id text,
  min_stock numeric DEFAULT 0, max_stock numeric DEFAULT 9999,
  avg_daily_usage numeric DEFAULT 0, lead_time_days numeric DEFAULT 3,
  image_key text,                            -- object storage (เดิม filename=item_id)
  created_at timestamptz DEFAULT now()
);

CREATE TABLE stock_snapshots (               -- tbl_raw_inventory (1.48M, append-only)
  id bigserial,
  generate_date timestamptz NOT NULL,        -- snapshot key (MAX = current)
  item_id text NOT NULL,
  item_description text, uom text, temperature_type text, bu_id text,
  expiry_date date,                          -- เดิม "Expired Date" (เว้นวรรค!)
  av_qty numeric, delivery_qty integer, total_stock numeric
) PARTITION BY RANGE (generate_date);        -- partition รายเดือน
CREATE INDEX ON stock_snapshots (item_id, generate_date DESC);

-- current stock = latest snapshot (แทน MAX(Generate_Date) ทุกที่)
CREATE VIEW current_stock AS
  SELECT s.* FROM stock_snapshots s
  WHERE s.generate_date = (SELECT max(generate_date) FROM stock_snapshots);
```

**Warehouse:**
```sql
CREATE TYPE move_type_enum AS ENUM ('Issue','Transfer','GR','Return','Stock In','Stock Out');
CREATE TABLE stock_movements (id bigserial PK, move_date timestamptz, doc_no text, move_type move_type_enum,
  item_id text, item_description text, uom text, qty numeric,
  from_location text, to_location text, ref_doc text, remarks text, created_by text);
  -- NOTE: audit log; ไม่ปรับ stock_snapshots (คง snapshot model)

CREATE TYPE stocktake_status AS ENUM ('Draft','Posted');
CREATE TABLE stocktakes (id bigserial PK, st_no text, st_date date, item_id text, uom text,
  system_qty numeric, physical_qty numeric, difference numeric, counted_by text,
  status stocktake_status DEFAULT 'Draft', remarks text);

CREATE TABLE locations (location_id text PRIMARY KEY, location_name text, zone text DEFAULT 'Main',
  type text DEFAULT 'Storage', capacity numeric, temperature text DEFAULT 'Ambient', active boolean DEFAULT true, notes text);
CREATE TABLE location_stock (id bigserial PK, location_id text REFERENCES locations(location_id),
  item_id text, lot_no text, qty numeric, uom text, expiry_date date, last_updated timestamptz);
  -- NOTE: เดิม rebuild ทั้งตารางตอน load → V2 ทำเป็น materialized view หรือ rebuild job

CREATE TYPE lot_status AS ENUM ('Active','Consumed','Expired','Quarantine');
CREATE TABLE lot_ledger (id bigserial PK, lot_no text, item_id text, uom text,
  location_id text DEFAULT 'WH-MAIN', gr_no text, qty_in numeric, qty_out numeric, balance numeric,
  mfg_date date, expiry_date date, status lot_status DEFAULT 'Active', move_date timestamptz, ref_doc text, created_by text);

CREATE TABLE scan_sessions (id bigserial PK, session_no text UNIQUE, session_type text, location_id text,
  doc_ref text, status text DEFAULT 'Open', created_by text, created_at timestamptz, closed_at timestamptz);
CREATE TABLE scan_lines (id bigserial PK, session_no text, scanned_at timestamptz, qr_data text,
  item_id text, lot_no text, expiry_date date, qty numeric DEFAULT 1, uom text, action text, location_id text, confirmed boolean DEFAULT false);
```

---

## 3. Sales / POS

```sql
CREATE TYPE order_status AS ENUM ('Pending','Processing','Shipped','Completed','Claimed','Cancelled');
CREATE TYPE claim_status AS ENUM ('Waiting','Approved','Rejected');

CREATE TABLE orders (                        -- header (แยกจาก tbl_sales_orders ที่ denorm)
  id bigserial PRIMARY KEY, order_no text UNIQUE NOT NULL,   -- SO-YYYYMMDD-HHMM
  order_date date, tenant_id bigint REFERENCES tenants(id),
  status order_status DEFAULT 'Pending', estimated_delivery date, created_by text, created_at timestamptz DEFAULT now()
);
CREATE TABLE order_lines (
  id bigserial PRIMARY KEY, order_id bigint REFERENCES orders(id),
  item_id text, item_description text, order_qty numeric, stock_uom text,
  unit_price numeric(14,2), total_price numeric(14,2),
  status order_status DEFAULT 'Pending', received_qty numeric DEFAULT 0
);
CREATE TABLE order_claims (                   -- เดิมฝังใน sales_orders line
  id bigserial PRIMARY KEY, order_line_id bigint REFERENCES order_lines(id),
  claimed_qty numeric, claim_reason text, claim_image_key text,
  admin_status claim_status DEFAULT 'Waiting', reject_reason text
);

-- Customer-portal POS (retail)
CREATE TYPE pos_status AS ENUM ('Completed','Voided','Open');
CREATE TABLE cust_pos_sales (id bigserial PK, sale_no text UNIQUE, sale_date date, tenant_id bigint,
  subtotal numeric(14,2), discount numeric(14,2), tax_amount numeric(14,2), total numeric(14,2),
  payment_method text DEFAULT 'Cash', points_used numeric DEFAULT 0, points_earned numeric DEFAULT 0,
  status pos_status DEFAULT 'Completed', notes text, created_by text);
CREATE TABLE cust_pos_items (id bigserial PK, sale_id bigint REFERENCES cust_pos_sales(id),
  item_id text, item_description text, qty numeric, uom text, unit_price numeric(14,2),
  discount_pct numeric DEFAULT 0, amount numeric(14,2), is_custom boolean DEFAULT false);

CREATE TABLE sales_returns (id bigserial PK, return_no text UNIQUE, return_date date, tenant_id bigint,
  order_no text, return_type text DEFAULT 'Return', status text DEFAULT 'Approved',
  total_amount numeric(14,2), remarks text, created_by text, created_at timestamptz);
CREATE TABLE return_items (id bigserial PK, return_id bigint REFERENCES sales_returns(id), item_id text,
  return_qty numeric, uom text, unit_price numeric(14,2), amount numeric(14,2), reason text, return_to_stock boolean DEFAULT true);

CREATE TABLE pending_orders (id bigserial PK, pending_no text UNIQUE, tenant_id bigint, created_at timestamptz,
  status text DEFAULT 'Draft', trigger_type text DEFAULT 'Auto', total_items integer, notes text);
CREATE TABLE pending_order_items (id bigserial PK, pending_id bigint REFERENCES pending_orders(id),
  item_id text, suggested_qty numeric, final_qty numeric, uom text, unit_price numeric(14,2), trigger_reason text);
```

---

## 4. Procurement

```sql
CREATE TYPE po_status AS ENUM ('Draft','Pending','Approved','Received','Closed','Cancelled');
CREATE TABLE purchase_requests (id bigserial PK, pr_no text UNIQUE, pr_date date, requested_by text,
  status text DEFAULT 'Draft', approved_by text, approved_at timestamptz, remarks text, priority text DEFAULT 'Normal');
CREATE TABLE pr_items (id bigserial PK, pr_id bigint REFERENCES purchase_requests(id), item_id text,
  request_qty numeric, uom text, required_date date, reason text, po_no text, status text DEFAULT 'Open');

CREATE TABLE purchase_orders (id bigserial PK, po_no text UNIQUE, po_date date,
  vendor_id bigint REFERENCES vendors(id),        -- เดิมเก็บชื่อ string → FK จริง
  status po_status DEFAULT 'Draft', approved_by text, approved_at timestamptz,
  remarks text, total_amount numeric(14,2), created_by text, expected_date date);
CREATE TABLE po_items (id bigserial PK, po_id bigint REFERENCES purchase_orders(id), item_id text,
  order_qty numeric, unit_price numeric(14,2), uom text, amount numeric(14,2), received_qty numeric DEFAULT 0, status text DEFAULT 'Open');
CREATE TABLE po_deliveries (id bigserial PK, po_id bigint, delivery_no integer, item_id text,
  scheduled_qty numeric, scheduled_date date, received_qty numeric DEFAULT 0, status text DEFAULT 'Pending');

CREATE TABLE goods_receipts (id bigserial PK, gr_no text UNIQUE, gr_date date, po_id bigint, vendor_id bigint, received_by text, remarks text);
CREATE TABLE gr_items (id bigserial PK, gr_id bigint REFERENCES goods_receipts(id), po_no text, item_id text,
  po_qty numeric, received_qty numeric, uom text, lot_no text, expiry_date date, unit_cost numeric(14,2), remarks text);
CREATE TABLE gr_claims (id bigserial PK, claim_no text UNIQUE, claim_date date, gr_no text, po_no text, vendor_id bigint,
  item_id text, gr_qty numeric, claim_qty numeric, uom text, reason text, image_key text,
  status text DEFAULT 'Open', supplier_action text, resolved_by text, resolved_at timestamptz, remarks text);

-- vendors = รวม suppliers + creditors (หรือคงสองตารางช่วงแรก)
CREATE TABLE vendors (id bigserial PK, vendor_code text UNIQUE, name text NOT NULL,
  is_supplier boolean DEFAULT true, is_creditor boolean DEFAULT false,
  contact text, phone text, email text, address text, tax_id text,
  payment_terms text DEFAULT 'Cash', lead_time_days integer DEFAULT 3, rating numeric DEFAULT 3.0,
  bank_name text, bank_account text, credit_limit numeric(14,2), currency text DEFAULT 'THB',
  category text DEFAULT 'Supplier', active boolean DEFAULT true, notes text);
CREATE TABLE supplier_requests (id bigserial PK, req_date date, supplier_name text, contact text, phone text,
  email text, address text, payment_terms text, lead_time_days integer, requested_by text,
  status text DEFAULT 'Pending', approved_by text, approved_at timestamptz, remarks text);
```

---

## 5. Finance (AR / AP)

```sql
CREATE TYPE invoice_status AS ENUM ('Unpaid','Partial','Paid','Cancelled');
CREATE TABLE ar_invoices (id bigserial PK, invoice_no text UNIQUE,   -- INV-{order_no}
  invoice_date date, due_date date, tenant_id bigint, order_no text,
  amount numeric(14,2), paid_amount numeric(14,2) DEFAULT 0, status invoice_status DEFAULT 'Unpaid',
  remarks text, created_by text, created_at timestamptz);
CREATE TABLE ar_receipts (id bigserial PK, receipt_no text UNIQUE,    -- RCP-
  receipt_date date, tenant_id bigint, invoice_no text, amount numeric(14,2),
  method text DEFAULT 'Transfer', ref_no text, remarks text, created_by text, created_at timestamptz);

CREATE TABLE ap_transactions (id bigserial PK, txn_no text UNIQUE,    -- AP-
  vendor_id bigint, ref_doc text, txn_type text, invoice_no text, invoice_date date, due_date date,
  amount numeric(14,2), paid_amount numeric(14,2) DEFAULT 0, currency text DEFAULT 'THB',
  status invoice_status DEFAULT 'Unpaid', remarks text, created_by text, created_at timestamptz);
-- NOTE: ไม่มี GL/journal/chart-of-accounts (เดิมเป็น sub-ledger เท่านั้น) — P&L/KPI คำนวณ ไม่เก็บ
```

---

## 6. BOM / Production

```sql
CREATE TABLE bom_master (id bigserial PK, bom_code text UNIQUE, product_name text, yield_qty numeric DEFAULT 1,
  yield_uom text, labor_cost numeric(14,2), overhead_cost numeric(14,2), other_cost numeric(14,2),
  selling_price numeric(14,2), notes text, created_at timestamptz, created_by text);
CREATE TABLE bom_master_lines (id bigserial PK, bom_id bigint REFERENCES bom_master(id), item_id text,
  buy_uom text, use_uom text, conv_factor numeric DEFAULT 1, qty_use_uom numeric, qty_buy_uom numeric,
  unit_cost numeric(14,2), line_cost numeric(14,2), notes text);
  -- costing: qty_buy = qty_use/conv ; line_cost = qty_buy*unit_cost ; total = Σ+labor+oh+other

CREATE TABLE bom_submissions (id bigserial PK, bom_code text, tenant_id bigint, product_name text,
  yield_qty numeric, yield_uom text, labor_cost numeric, overhead_cost numeric, other_cost numeric,
  selling_price numeric, notes text, submitted_at timestamptz, status text DEFAULT 'Pending');
CREATE TABLE bom_submission_lines (LIKE bom_master_lines INCLUDING ALL);  -- + tenant_id

CREATE TABLE cust_bom (id bigserial PK, bom_code text, tenant_id bigint, product_name text, product_item_id text,
  yield_qty numeric, yield_uom text, labor_cost numeric, overhead_cost numeric, other_cost numeric,
  selling_price numeric, active boolean DEFAULT true, notes text, created_at timestamptz);
CREATE TABLE cust_bom_lines (LIKE bom_master_lines INCLUDING ALL);  -- + tenant_id

CREATE TABLE cust_prod_runs (id bigserial PK, run_no text UNIQUE, bom_code text, tenant_id bigint, run_date date,
  batch_qty numeric DEFAULT 1, status text DEFAULT 'Completed', total_cost numeric(14,2), created_by text);
CREATE TABLE cust_prod_items (id bigserial PK, run_id bigint REFERENCES cust_prod_runs(id), item_id text,
  theoretical_qty numeric, actual_qty numeric, variance numeric, uom text);
CREATE TABLE cust_variance (id bigserial PK, var_date date, tenant_id bigint, item_id text, bom_code text,
  theoretical_use numeric, actual_use numeric, variance numeric, variance_pct numeric, uom text, reason text, shift text DEFAULT 'Day');
```

---

## 7. Customer Portal (tenant-scoped, RLS)

```sql
CREATE TABLE customer_items (id bigserial PK, tenant_id bigint, item_id text, item_name text, category text,
  unit_price numeric(14,2), uom text, description text, created_at timestamptz, synced_central boolean DEFAULT true);
CREATE TABLE customer_inventory (id bigserial PK, tenant_id bigint, item_id text, item_description text, uom text,
  current_stock numeric, reorder_point numeric, reorder_qty numeric, last_updated timestamptz, notes text);
CREATE TABLE cust_stock_log (id bigserial PK, tenant_id bigint, item_id text, log_date timestamptz, log_type text,
  qty_change numeric, balance_after numeric, ref_doc text, notes text, created_by text);

-- Mini-ERP (เดิม Owner_Customer → tenant_id)
CREATE TABLE my_customers (id bigserial PK, tenant_id bigint, customer_name text, phone text, address text, notes text);
CREATE TABLE my_suppliers (id bigserial PK, tenant_id bigint, supplier_name text, contact_name text, phone text, address text);
CREATE TABLE my_purchase_orders (id bigserial PK, po_no text UNIQUE, tenant_id bigint, po_date date,
  supplier_name text, total_amount numeric(14,2), status text DEFAULT 'Issued', remarks text);
CREATE TABLE my_po_items (id bigserial PK, my_po_id bigint REFERENCES my_purchase_orders(id),
  item_description text, qty numeric, uom text, unit_price numeric(14,2), amount numeric(14,2));

-- เปิด RLS ทุกตารางที่มี tenant_id:
ALTER TABLE customer_inventory ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_inventory USING (tenant_id = current_setting('app.tenant_id')::bigint);
-- (Admin/HQ bypass ผ่าน role ที่ตั้ง app.tenant_id = 0 / BYPASSRLS)
```

---

## 8. Marketing / Loyalty / Survey

```sql
CREATE TABLE marketing_campaigns (id bigserial PK, campaign_id text UNIQUE, campaign_name text,
  campaign_type text DEFAULT 'Popup', content_text text, image_key text, ticker_text text,
  start_date date, end_date date, target_type text DEFAULT 'All', target_value text, priority integer,
  active boolean DEFAULT true, created_by text, created_at timestamptz);
CREATE TABLE campaign_reads (id bigserial PK, campaign_id text, tenant_id bigint, read_at timestamptz, action text DEFAULT 'Closed');
CREATE TABLE ab_tests (id bigserial PK, test_id text UNIQUE, test_name text, campaign_id text,
  status text DEFAULT 'Running', start_date date, end_date date, winner text, created_by text, created_at timestamptz);
CREATE TABLE ab_variants (id bigserial PK, test_id text, variant text, content_text text, image_key text,
  impressions integer DEFAULT 0, clicks integer DEFAULT 0, conversions integer DEFAULT 0);

CREATE TABLE promotions (id bigserial PK, promo_id text UNIQUE, promo_name text, promo_type text,
  start_date date, end_date date, min_qty numeric, min_amount numeric(14,2),
  discount_pct numeric, discount_amt numeric(14,2), free_item_id text, free_qty numeric,
  customer_group text DEFAULT 'All', category text, max_uses integer, used_count integer DEFAULT 0, active boolean DEFAULT true, notes text);
CREATE TABLE promotion_items (promo_id bigint REFERENCES promotions(id), item_id text, PRIMARY KEY(promo_id,item_id)); -- เดิม Item_IDs CSV

CREATE TABLE price_list (id bigserial PK, list_name text DEFAULT 'Standard', tenant_id bigint, item_id text,
  base_price numeric(14,2), special_price numeric(14,2), discount_pct numeric, min_qty numeric DEFAULT 1,
  valid_from date, valid_to date, active boolean DEFAULT true);  -- effective = special>0 ? special : base*(1-disc)

CREATE TABLE loyalty_config (id smallint PRIMARY KEY DEFAULT 1, enabled boolean DEFAULT false,
  points_per_baht numeric DEFAULT 1.0, baht_per_point numeric DEFAULT 0.1, min_redeem numeric DEFAULT 100,
  expiry_days integer DEFAULT 365, updated_at timestamptz, CONSTRAINT singleton CHECK (id=1));
CREATE TABLE loyalty_points (id bigserial PK, tenant_id bigint UNIQUE, balance numeric DEFAULT 0, lifetime numeric DEFAULT 0, last_updated timestamptz);
CREATE TABLE loyalty_txn (id bigserial PK, tenant_id bigint, txn_date timestamptz, txn_type text, points numeric, balance_after numeric, ref_doc text, notes text);
CREATE TABLE abandoned_carts (id bigserial PK, tenant_id bigint, cart_data jsonb, created_at timestamptz, notified_at timestamptz, recovered boolean DEFAULT false);

CREATE TABLE surveys (id bigserial PK, survey_id text UNIQUE, survey_name text, survey_type text DEFAULT 'NPS', trigger text DEFAULT 'Post-Delivery', active boolean DEFAULT true, created_at timestamptz);
CREATE TABLE survey_responses (id bigserial PK, survey_id text, tenant_id bigint, order_no text, response_date date, nps_score integer, comments text);
CREATE TABLE survey_answers (id bigserial PK, response_id bigint REFERENCES survey_responses(id), question_no integer, answer text); -- เดิม Q1-Q3 fixed → EAV
```

---

## 9. Logistics

```sql
CREATE TABLE delivery_orders (id bigserial PK, do_no text UNIQUE, do_date date, tenant_id bigint, address text,
  driver text, vehicle text, status text DEFAULT 'Pending', delivered_at timestamptz, pod_image_key text, remarks text, created_by text);
CREATE TABLE do_items (id bigserial PK, do_id bigint REFERENCES delivery_orders(id), order_no text, item_id text, qty numeric, uom text, status text DEFAULT 'Pending');
```

---

## 10. Document Numbering (sequence-based, คงรูปแบบเดิม)

```sql
-- ตารางคุมรูปแบบ + Postgres sequence ต่อชนิด/ต่อวัน (atomic, แก้ race เดิม)
CREATE TABLE doc_number_config (
  doc_type text PRIMARY KEY,    -- 'PO','GR','ST','PR','DO','RCP','GRC','AP','RTN','SO','SALE','PRD','PND','MPO','TRF','SCAN','ADJ','INV'
  format   text NOT NULL        -- เช่น 'PO-{YYYYMMDD}-{NNN:03d}', 'SALE-{tenant4}-{YYYYMMDDHHMMSS}'
);
-- DocNumberService สร้างเลขจาก format + nextval ของ sequence ต่อวัน (เก็บ counter ใน table หรือ advisory lock)
```

**รูปแบบที่ต้องคงเป๊ะ (จาก reverse-engineering):**

| doc_type | format เดิม | หมายเหตุ |
|---|---|---|
| PO | `PO-YYYYMMDD-NNN` | เดิมมี 3 สคีม (helper per-day, PR→PO all-time count, AI random4) → V2 รวมเป็น sequence เดียว |
| GR/ST | `GR-/ST-YYYYMMDD-NNN` | |
| PR/DO/RCP/GRC/AP/RTN | `{PFX}-YYYYMMDD-NNN` | per-day NNN |
| SO | `SO-YYYYMMDD-HHMM` | นาที resolution (เดิมชนได้) → เพิ่ม seq กันชน |
| SALE/PRD/PND/MPO | `{PFX}-{tenant[:N]}-YYYYMMDDHHMMSS` | tenant prefix (เดิมชนถ้าชื่อขึ้นต้นเหมือนกัน) |
| TRF/SCAN/ADJ | `{PFX}-YYYYMMDDHHMMSS` | |
| INV | `INV-{order_no}` | 1:1 จาก order |

---

## 11. Mapping ตารางเดิม → ใหม่ (สรุป)

| เดิม (SQLite) | ใหม่ (Postgres) | การเปลี่ยน |
|---|---|---|
| `tbl_raw_inventory` | `items` + `stock_snapshots` (+view `current_stock`) | แยก master/fact; `"Expired Date"`→`expiry_date`; partition; index |
| `tbl_sales_orders` (no PK, denorm) | `orders`+`order_lines`+`order_claims` | แยก header/line/claim; +PK; +FK tenant |
| `tbl_users.Permissions` (CSV) | `user_permissions` join | de-serialize |
| `tbl_role_permissions` (CSV) | `role_permissions` join + `permissions` enum | de-serialize |
| `tbl_customers` (PK=ชื่อ) | `tenants` (id PK, code=ชื่อเดิม) | surrogate key |
| `Customer_Name` / `Owner_Customer` | `tenant_id` FK | รวมเป็น key เดียว + RLS |
| `tbl_suppliers` + `tbl_creditors` | `vendors` (flags) | consolidate (หรือคงก่อน) |
| `tbl_promotions.Item_IDs` (CSV) | `promotion_items` | junction |
| `tbl_survey_responses.Q1-3` | `survey_answers` (EAV) | flexible |
| `tbl_abandoned_carts.Cart_Data` | `jsonb` | |
| ทุก `Status/Type/...` TEXT | enums | CHECK ในตัว |
| master CSV (`Shared_Data/*.csv`) | `items` table | เลิกใช้ CSV |
| filesystem `images/`,`claim_images/`,`pod_images/` | object storage + `*_image_key` | container-safe |
