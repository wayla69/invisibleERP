# Invisible ERP

ยกเครื่อง Invisible Enterprise ERP จาก Python (Streamlit + FastAPI + SQLite) → **TypeScript end-to-end**:
**NestJS · Drizzle · PostgreSQL · Next.js** บน Railway

> 📋 แผนการ migrate ฉบับเต็มอยู่ใน [MIGRATION_PLAN.md](MIGRATION_PLAN.md) และ `docs/`
> 📚 บันทึก reverse-engineering ระบบเดิมอยู่ใน `legacy_inventory/`

## โครงสร้าง (monorepo, pnpm workspaces)

```
apps/api      NestJS backend (Fastify, Drizzle, JWT)   → :8000
apps/web      Next.js 15 frontend (App Router)         → :3000
packages/shared   enums, permissions, i18n (TH/EN), Zod schemas
tools/etl     SQLite → Postgres migration (docs/04)
```

## Quickstart (dev)

```bash
# 0. ติดตั้ง deps
pnpm install

# 1. ตั้งค่า env
cp .env.example .env
#   แก้ DATABASE_URL (Postgres) และ JWT_SECRET

# 2. build shared (api/web ใช้ @ierp/shared)
pnpm --filter @ierp/shared build

# 3. สร้าง schema ใน Postgres + seed (admin/admin123)
pnpm --filter @ierp/api db:generate   # สร้าง migration จาก Drizzle schema
pnpm --filter @ierp/api db:migrate    # apply เข้า DB
pnpm --filter @ierp/api db:seed       # permissions + role_permissions + admin user
# (ไม่บังคับ) ข้อมูลตัวอย่างร้านบุฟเฟ่ต์ญี่ปุ่น "Invisible" — tenant INVISIBLE / login invisible/invisible123 (idempotent ทุกตัว)
pnpm --filter @ierp/api db:seed:demo        # แคตตาล็อก: เมนู 252 + บุฟเฟ่ต์ 4 ระดับ + สูตร/BoM + วัตถุดิบ + ครัว/ผังโต๊ะ + รูปเมนู
pnpm --filter @ierp/api db:seed:demo:sales  # ขาย POS ~45 วัน + ออเดอร์ dine-in/KDS ย้อนหลัง + ออเดอร์สด/เดลิเวอรี (Grab/LINE MAN)
pnpm --filter @ierp/api db:seed:demo:loyalty     # สมาชิก ~150 + ระดับ/แต้ม + ของรางวัล + แคมเปญ (CRM/Loyalty)
pnpm --filter @ierp/api db:seed:demo:procurement # ผู้ขาย + ใบสั่งซื้อ/รับของ + ตรวจนับสต๊อก + variance
pnpm --filter @ierp/api db:seed:demo:finance     # ลงบัญชี GL รายเดือน (รายได้/ต้นทุน/ค่าใช้จ่าย) → P&L/กระแสเงินสด  (ต้องรัน :sales ก่อน)
pnpm --filter @ierp/api db:seed:demo:pos         # ตัวเลือกเมนู (modifiers) + โปรโมชัน/กฎราคา
pnpm --filter @ierp/api db:seed:demo:hr          # พนักงาน + ลงเวลา/ลา + รอบจ่ายเงินเดือน/สลิป (HR/Payroll)
pnpm --filter @ierp/api db:seed:demo:branch      # สาขา 3 แห่ง + ติดป้ายสาขาให้ยอดขาย (consolidation)  (ต้องรัน :sales ก่อน)
pnpm --filter @ierp/api db:seed:demo:feedback    # แบบสอบถาม NPS/CSAT + คำตอบลูกค้า
pnpm --filter @ierp/api db:seed:demo:all    # รันทั้งหมดตามลำดับ (catalog → sales → branch → loyalty → procurement → finance → pos → hr → feedback)
# (db:seed:demo:images = ตั้งรูปเมนูใหม่ให้ tenant ที่ seed แล้ว — รวมอยู่ใน db:seed:demo แล้ว)

# 4. รัน (api + web พร้อมกัน)
pnpm dev
#   หรือแยก: pnpm dev:api  /  pnpm dev:web
```

เปิด http://localhost:3000 → login (`admin` / `admin123` — **เปลี่ยนทันที**)

## สถานะ Phase 0 (scaffolding)

มีแล้ว:
- ✅ monorepo + CI (`.github/workflows/ci.yml`)
- ✅ NestJS: `GET /` health, `GET /api/config`, `POST /api/login` (JWT, argon2-ready/scrypt + legacy sha256 verify), `GET /api/auth/me`, `GET /api/inventory/stock` (demo)
- ✅ Drizzle schema แกน (tenants, users, permissions, items, stock_snapshots) + seed
- ✅ Common: JWT/Permissions guards, tenant-ready, ZodValidationPipe, error envelope, DocNumberService (skeleton)
- ✅ Next.js: หน้า login + dashboard shell (เรียก api จริง)
- ✅ packages/shared: RBAC (37 perms, 6 roles, resolution), i18n nav (TH/EN), enums, Zod

## สถานะ Phase 1 (schema เต็ม + ETL) — เสร็จ ✅

- ✅ Drizzle schema **71 ตาราง** (12 ไฟล์ตามโดเมน + enums) → migration `apps/api/drizzle/0000_*.sql`
- ✅ ETL จริง `tools/etl` — อ่าน SQLite (`node:sqlite`), transform ตาม docs/04 (split header/line, resolve `tenant_id`, แตก Permissions CSV), โหลดผ่าน Drizzle
- ✅ **Validate ผ่าน PGlite (Postgres จริง in-memory)** — reconciliation 9/9 ผ่าน (counts + ยอดเงินตรง source=target)

รัน ETL:
```bash
# validate (ไม่ต้องมี Postgres — PGlite in-memory + subset)
NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/etl validate
# prod (เข้าจริง): ตั้ง DATABASE_URL, รัน migrate ก่อน แล้ว
pnpm --filter @ierp/api db:migrate
NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/etl start   # full 1.48M (stream batched)
```

## สถานะ Phase 2 (read endpoints + parity) — เสร็จ ✅

- ✅ Read endpoints ครบ (คง path `/api/*` เดิม): dashboard(+trend), pos(summary/orders/{sale_no}/sessions), inventory(stock/{item_id}, suppliers, purchase-orders), finance(pl/ap/ar/kpi), reports(daily-sales/stock-summary), customers/{name}, notifications — ทุกตัว auth+RBAC (เดิม V1 เปิดโล่ง)
- ✅ คง parity-critical: Voided excl, latest-snapshot, Dec P&L off-by-one, ฿/ไทย ใน notifications, `Customer_Name` จาก tenant
- ✅ **Read-parity harness** `tools/parity` — รัน service จริงของ V2 บน PGlite (latest snapshot จากข้อมูลจริง) เทียบกับค่าจาก SQLite → **ผ่าน 10/10** (pos/summary 1,155.6, stock 458, low_stock 3 ฯลฯ ตรงเป๊ะ)

รัน parity: `NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/parity start`

## สถานะ Phase 3 (write modules) — เสร็จ ✅

- ✅ **DocNumberService** atomic (ตาราง `doc_counters` upsert-returning — แก้ race `COUNT(*)+1` ของ V1) + **StatusLogService** (`doc_status_log`)
- ✅ **POS**: `POST /api/pos/orders` (SO-, credit-hold/limit check, loyalty earn, transaction) · `PATCH /api/orders/{order_no}/status` (state machine + est-delivery wipe parity)
- ✅ **Procurement** `PR→PO→GR`: `POST /procurement/prs|pos|grs`, approve/cancel — GR เพิ่ม `received_qty`, `stock_movement`(GR), `lot_ledger`, **auto-close PO** (Closed/Received), admin-only approval
- ✅ **Finance**: `POST /finance/ar/sync` (INV-), `/ar/receipts` (RCP- + paid/status), `/ap/transactions` (AP-), `PATCH .../pay`
- ✅ **Transactional test** `tools/parity` (writeflow) — รัน service จริงบน PGlite ตรวจผลข้างเคียง → **ผ่าน 24/24** (doc atomic, loyalty, credit-hold, received_qty, lot ledger, auto-close, paid/status)

รัน: `NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/parity writeflow`

## สถานะ Phase 4 (frontend) — เสร็จ ✅

- ✅ Next.js 15 App Router — **13 routes** build ผ่าน: login, dashboard, pos(+new create-order form), inventory(+[itemId]/suppliers/purchase-orders), finance, procurement(+create PO)
- ✅ Auth flow (JWT + `/auth/me`), **RBAC-driven sidebar** (กรองเมนูตาม permissions), TanStack Query (fetch + mutation), i18n ไทย, ฿/วันที่ format, badge/KPI/DataTable components

## สถานะ Phase 5 (AI + analytics) — เสร็จ ✅

- ✅ **Analytics** port จาก Python (ค่าคงที่เป๊ะ): `forecasting` (predict_stockout, replenishment-list — reorder=avg×LT+1.5σ, urgency ≤LT/≤2LT, confidence 30/14), `anomalies` (Z 2.5/3.5, stocktake variance 20/50), `insights` (rule-based Thai fallback + Anthropic) → `GET /api/analytics/{replenishment,anomalies,dashboard-summary}`, `POST /api/analytics/insight`
- ✅ **AI agent** — tool-loop (MAX_LOOP_TURNS 15, MAX_HISTORY 40, model จาก env) ต่อ **8 tools เรียก service จริง** → `POST /api/chat` (V2 ดึงข้อมูลจริงได้ ต่างจาก V1 ที่เป็น passthrough); ไม่มี API key → analytics ใช้ rule-based, chat คืน 503
- ✅ **Analytics test** `tools/parity` (analytics) → **ผ่าน 14/14** (สูตร forecast/anomaly/variance + rule-based insight ตรงค่าที่คำนวณ)

รัน: `NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/parity analytics`

## สถานะ Phase 6 (cutover) — เสร็จ ✅

- ✅ **Cutover runbook** [docs/08](docs/08-cutover-runbook.md) — strangler-fig: dry-run → parallel-run → freeze+delta → cutover → rollback + monitoring
- ✅ เครื่องมือ `tools/cutover/`: `e2e` (boot Nest จริง in-process บน PGlite, ยิง HTTP ครบ flow → **ผ่าน 16/16**), `shadow` (diff read endpoints V1↔V2), `reconcile` (gate SQLite↔Postgres ก่อน cutover)
- ✅ **Railway deploy configs**: `apps/api/railway.json` + `apps/web/railway.json` (build/start/healthcheck/predeploy migrate)
- ✅ e2e จับ parity bug จริง: login คืน 201 (Nest POST default) → แก้เป็น **200** ตรง V1 (`@HttpCode(200)`); DB pool/protocol ผ่าน env (`DB_POOL_MAX`, `DB_SIMPLE`)

รัน: `pnpm --filter @ierp/cutover e2e`

## สถานะ Phase 7 (extensions นอก core) — เสร็จ ✅

- ✅ **Customer Portal** (`modules/portal`, tenant-scoped): dashboard + auto-reorder, cust-POS (SALE-, VAT 7%, ตัดสต๊อก, loyalty), inventory + pending orders, variance EOD, track, mini-ERP (my customers/suppliers/POs)
- ✅ **Marketing/Loyalty** (`modules/marketing`, `modules/loyalty`): campaigns, RFM segments, A/B, abandoned-cart, promotions, price-list, surveys; loyalty config/me/redeem
- ✅ **BOM** (`modules/bom`): master library + costing, push to customers, submissions approval, portal BOM (dual-write), production runs
- ✅ **Reports** (`modules/reports`): **ExcelJS** (daily-sales/monthly-pl/stock-summary `.xlsx`), **Playwright** Thai PDF (sales-confirmation/tax-invoice/receipt/statement, Sarabun, graceful fallback), **Express TXT** (VAT + baht-in-words)
- ✅ **SSE streaming chat**: `@Sse /api/chat/stream` (Anthropic streaming deltas ผ่าน tool-loop) + frontend `/assistant` page
- ✅ **Extension test** `tools/cutover ext` → **26/26** (18 GET smoke + ExcelJS PK-magic + portal POS sale VAT/decrement/loyalty + mini-ERP write)

สร้างด้วย multi-agent workflow (5 agents ขนาน) แล้ว integrate. รัน: `pnpm --filter @ierp/cutover ext`

## สถานะ Phase 8 (frontend extensions) — เสร็จ ✅

- ✅ **Customer Portal UI** (`/portal/*`, layout แยก nav ลูกค้า): dashboard, POS (ฟอร์มขาย + VAT live + ประวัติ), inventory (แก้ reorder + pending orders), track, loyalty (ดู/แลกแต้ม), my-business (ลูกค้า/ซัพพลายเออร์/PO)
- ✅ **Staff UI** เพิ่มในหลังบ้าน: Marketing (แคมเปญ/RFM segments/โปรโมชั่น), BoM (คลังสูตร + สร้าง + อนุมัติคำขอ), Loyalty config
- ✅ **Login redirect ตาม role** (Customer → `/portal`, staff → หลังบ้าน) + reusable `Tabs`/`Msg` components
- ✅ ใช้ component kit เดียวกัน (Card/Kpi/Badge/DataTable/StateView) — minimal + ภาษาไทย; **22 routes** build ผ่าน

## สรุป Phase 0–8 ครบทั้งหมด ✅
backend ครบทุกโดเมน (core + portal + marketing/loyalty/bom + reports + AI) + **frontend ครบ 22 routes** (หลังบ้าน + portal ลูกค้า) + ETL + cutover tooling — **5 test harness ผ่านหมด** (read 10/10, write 24/24, analytics 14/14, e2e 16/16, ext 26/26) บน Postgres จริง (PGlite)

## Deploy (Railway)

2 services จาก repo เดียว:
- **api** — root `apps/api`, build `pnpm install && pnpm --filter @ierp/shared build && pnpm --filter @ierp/api build`, start `node apps/api/dist/main.js`, healthcheck `/`
- **web** — root `apps/web`, build `... && pnpm --filter @ierp/web build`, start `pnpm --filter @ierp/web start`
- **Postgres** plugin (ตั้ง `DATABASE_URL`), Object storage (R2/S3) สำหรับรูป/รายงาน
- ตั้ง `JWT_SECRET`, `CORS_ORIGINS`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` ในแต่ละ service
