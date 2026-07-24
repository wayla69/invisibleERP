# Invisible ERP — แผนการ Migrate (Master Plan)

> Invisible Enterprise ERP / Invisible Consulting
> เป้าหมาย: ยกเครื่องระบบเดิม (Python 100%) → **Invisible ERP** ที่ใช้ภาษา/ฐานข้อมูล/สถาปัตยกรรมใหม่ โดยคง **ฟังก์ชันหลักครบ 100%**
> เอกสารนี้สังเคราะห์จากการ reverse-engineer ระบบเดิมทั้งหมด (17,000+ บรรทัด Python, 65 ตาราง, 30 REST endpoints, MCP tools, analytics)

---

## 0. เอกสารชุดนี้ประกอบด้วย

| ไฟล์ | เนื้อหา |
|---|---|
| **MIGRATION_PLAN.md** (ฉบับนี้) | ภาพรวม, สถาปัตยกรรม, แผนเฟส, ความเสี่ยง, การตัดสินใจที่ต้องเคาะ |
| [ARCHITECTURE_DECISION.md](ARCHITECTURE_DECISION.md) | เหตุผลการเลือก stack (TypeScript/NestJS/Drizzle/Postgres/Next.js) + scorecard |
| [docs/01-feature-parity.md](docs/01-feature-parity.md) | **Feature-Parity Matrix** — ของเดิมทุกชิ้น → ปลายทาง V2 (ใช้เป็น checklist 100%) |
| [docs/02-api-spec.md](docs/02-api-spec.md) | API/Endpoint ทั้งหมดของ V2 (REST) — map จากเดิม + เพิ่ม write endpoints |
| [docs/03-database-schema.md](docs/03-database-schema.md) | Schema PostgreSQL ใหม่ + mapping ตารางเดิม → ใหม่ |
| [docs/04-data-migration.md](docs/04-data-migration.md) | ETL SQLite → Postgres (transform/validate/cutover) |
| [docs/05-frontend.md](docs/05-frontend.md) | สถาปัตยกรรม Frontend Next.js (40 เพจ, RBAC, i18n) |
| [docs/06-ai-integration.md](docs/06-ai-integration.md) | พอร์ต AI Agent + Analytics (Anthropic SDK) |
| [docs/07-backend.md](docs/07-backend.md) | โครงสร้าง Backend NestJS แบบลงรายละเอียด |
| [docs/08-cutover-runbook.md](docs/08-cutover-runbook.md) | **Cutover runbook** (Phase 6) — parallel-run, reconcile gate, freeze, rollback, Railway deploy |
| [legacy_inventory/](legacy_inventory/) | บันทึก reverse-engineering ระบบเดิม (อ้างอิงดิบ 10 ไฟล์) |

---

## 1. ทำไมต้องทำ V2 (ปัญหาของระบบเดิมที่ V2 ต้องแก้)

ระบบเดิมทำงานได้และฟีเจอร์ครบมาก แต่ติดเพดานทางเทคนิคหลายจุดที่ยืนยันจากโค้ดจริง:

1. **Monolith ไฟล์เดียว 12,878 บรรทัด** (`ERPPOS_Invisible.py`) — เพิ่มฟีเจอร์/แก้บั๊กยาก, ทดสอบไม่ได้, มี dead code และ latent bug หลายจุด (เช่น procurement tab bindings สลับกัน, POS อ่าน `order_cart` ผิด key)
2. **ฐานข้อมูล SQLite ไฟล์เดียวบน Railway Volume** — `tbl_raw_inventory` 1.48 ล้านแถวไม่มี index; สอง service (API + Streamlit) เขียนไฟล์ SQLite เดียวกันบน network volume → write contention เสี่ยงพังจริง
3. **Routing ผูกกับข้อความ label** — `_menu_is()` เทียบ `menu` กับสตริง TH/EN; เปลี่ยนชื่อเมนูนิดเดียว routing พังเงียบ ๆ
4. **RBAC สองระบบซ้อนกัน** (`ALL_NAV_KEYS` เก่า vs `ALL_PERMISSIONS` ที่ใช้จริง) เก็บปนใน column เดียว
5. **API ไม่มี auth/RBAC/tenant-scoping เลย** — มี token แต่ endpoint ข้อมูลแทบไม่เช็ค; ใครก็ดึงข้อมูลทุก customer ได้ (ช่องโหว่ ต้องแก้ ไม่ใช่ลอก)
6. **เลขเอกสาร race-prone** — `_next_doc_no` ใช้ `COUNT(*)+1` และมี 3 สคีมที่ต่างกันสำหรับ PO เดียว → ชนกันได้เมื่อมีผู้ใช้พร้อมกัน
7. **Security debt** — password SHA-256 ไม่ salt, `JWT_SECRET` default ค่าตายตัว, CORS `*`, default `admin/admin123`
8. **Stock เป็น snapshot ไม่ใช่ transactional** — Issue/Transfer/Stocktake/GR ไม่ปรับ `tbl_raw_inventory`; ยอดคงเหลือคำนวณจาก snapshot ล่าสุด (เป็น design ตั้งใจ ต้องเข้าใจก่อนแก้)

> **หลักการ V2:** ของที่เป็น *ฟีเจอร์ธุรกิจ* คงไว้ 100% — ของที่เป็น *ช่องโหว่/บั๊ก* แก้อย่างจงใจและบันทึกไว้ (ดู parity matrix คอลัมน์ "หมายเหตุ")

---

## 2. สถาปัตยกรรมเป้าหมาย (สรุป)

รายละเอียดและเหตุผลเต็มอยู่ใน [ARCHITECTURE_DECISION.md](ARCHITECTURE_DECISION.md)

| ชั้น | เดิม (V1) | ใหม่ (V2) |
|---|---|---|
| ภาษา | Python | **TypeScript** (Node 22 LTS) — ภาษาเดียวทั้ง front/back |
| Backend | FastAPI (read-only) + Streamlit (logic ทั้งหมด) | **NestJS** (Fastify adapter) — โมดูลตามโดเมน |
| API | REST อ่านอย่างเดียว + Streamlit ทำ write ในตัว | **REST** (คง path `/api/*` เดิม) + Zod validation; เพิ่ม write endpoints ครบ |
| ORM | SQL ดิบ (`?` placeholders) | **Drizzle ORM** (introspect schema เดิมเป็นจุดเริ่ม) |
| Database | SQLite ไฟล์เดียวบน volume | **PostgreSQL 16** (Railway managed) — enums, FK, RLS, partitioning |
| Frontend | Streamlit 12,878 บรรทัด | **Next.js 15** (App Router) — Server/Client Components |
| AI | `anthropic` (Python), agent loop ใน `agents/` | **`@anthropic-ai/sdk`** — พอร์ต ReAct loop ตรง ๆ |
| Reports | openpyxl (Excel) + fpdf (PDF ไทย) | **ExcelJS** + **Playwright (Chromium) HTML→PDF** + ฟอนต์ Sarabun |
| Auth | HMAC token + SHA-256 | **JWT** (`@nestjs/jwt`) + **argon2** (verify SHA-256 เดิม แล้ว re-hash) |
| Jobs | — (sync บน page load) | **pg-boss** (Postgres-backed) — report/analytics นอก request thread |
| File storage | filesystem (`images/`, `claim_images/`) | **Object storage (R2/S3)** — container restart ไม่หาย |
| Deploy | 2 service (API+Streamlit) แชร์ SQLite volume | **Railway**: service `api` + `web` + Postgres + object storage (เลิกใช้ shared volume) |

### โครงสร้าง Monorepo

```
invisible-erp-v2/
├─ apps/
│  ├─ api/                 # NestJS backend
│  │  └─ src/
│  │     ├─ common/        # guards, interceptors, pipes, decorators
│  │     ├─ database/      # Drizzle schema (65→~70 tables by domain) + migrations
│  │     ├─ modules/       # auth, pos, inventory, procurement, finance,
│  │     │                 # bom, customers(portal), marketing, loyalty,
│  │     │                 # reports, ai, admin, notifications
│  │     └─ main.ts
│  └─ web/                 # Next.js 15 frontend
│     └─ src/app/
│        ├─ (auth)/        # login
│        ├─ (internal)/    # staff pages (~28)
│        └─ (portal)/      # customer-portal pages (~12)
├─ packages/
│  ├─ shared/              # Zod schemas, types, enums, i18n dict (TH/EN)
│  └─ db/                  # Drizzle schema shared (ถ้าต้องการ)
├─ tools/
│  └─ etl/                 # SQLite→Postgres migration scripts
├─ drizzle.config.ts
├─ package.json            # pnpm workspaces / Turborepo
└─ railway.json
```

---

## 3. หลักการ Feature-Parity 100%

ระบบเดิมมี: **~40 เพจ** (Streamlit), **~140 sub-tabs**, **30 REST endpoints**, **19 AI tools**, **5 analytics functions**, **65 ตาราง**, **15 doc-numbering schemes**

ดู checklist เต็มที่ [docs/01-feature-parity.md](docs/01-feature-parity.md) — ทุกแถวต้องมีปลายทาง V2 ก่อนปิดเฟส

**กฎเหล็กที่ต้องคงไว้ (parity-critical — สรุปจาก reverse-engineering):**

- **ภาษาไทยเป็น default** (`t()` fallback เป็น TH) — ห้าม assume EN-default
- **VAT 7%** hard-coded ในใบกำกับภาษี + Express TXT; baht-in-words (`bahttext`)
- **Multi-tenant scoping** = `Customer_Name` (portal-as-buyer) และ `Owner_Customer` (mini-ERP) — ใน V2 รวมเป็น `tenant_id` แต่ตรรกะ isolation ต้องเป๊ะ
- **Voided exclusion**: `Status != 'Voided'` ในทุก aggregate รายได้
- **Snapshot stock**: ยอดคงเหลือ = `MAX(Generate_Date)` snapshot ล่าสุด เสมอ
- **คอลัมน์ `"Expired Date"` มีเว้นวรรค** → rename เป็น `expiry_date` แต่ ETL ต้อง map ถูก
- **UOM conversion**: `Available_Selling_Qty = floor(AV_QTY / Conversion_Factor)`; BOM `Qty_Buy = Qty_Use / Conv_Factor`
- **ค่าคงที่ analytics**: `Z_THRESHOLD=2.5`, safety `1.5σ`, lead-time fallback `7.0`, variance `20%`/critical `50%`, lookback `60d`, candidate `LIMIT 200`
- **AI**: `MAX_LOOP_TURNS=15`, `MAX_HISTORY=40`, Thai system prompt + Thai fallback, RBAC gating ของ `void_order`/`adjust_stock`, rule-based fallback เมื่อไม่มี API key
- **เลขเอกสาร**: คงรูปแบบที่แสดงผล (`PO-YYYYMMDD-NNN`, `SALE-{cust[:4]}-{ts}` ฯลฯ) แต่เปลี่ยนกลไกเป็น Postgres sequence (กัน race)

---

## 4. แผนการ Migrate แบบเฟส (Strangler-Fig — บังคับใช้ ไม่ทำ big-bang)

เหตุผล: ระบบใหญ่เกินกว่าจะ rewrite รวดเดียวแล้วมั่นใจ; ทำทีละโดเมนโดยให้ V1 ยังรันคู่ขนานจน V2 ครอบทุกเพจ

```
Phase 0 ─ Scaffolding & CI ──────────────────► เปิดโครง, CI/CD, env, สร้าง 1 endpoint demo
Phase 1 ─ Database + ETL ────────────────────► Postgres schema + ETL SQLite→PG (re-runnable)
Phase 2 ─ Read APIs + Auth ──────────────────► คง /api/* เดิม, อ่านอย่างเดียว, diff JSON เทียบ V1
Phase 3 ─ Write/Transactional modules ───────► POS, PR→PO→GR, stocktake, AR/AP, returns, DO
Phase 4 ─ Frontend (Next.js) ────────────────► สร้าง 40 เพจทีละโดเมน, Streamlit อยู่ read-only
Phase 5 ─ AI + Analytics ────────────────────► พอร์ต agent loop + analytics + chat streaming
Phase 6 ─ Parallel-run & Cutover ────────────► รันคู่, reconcile, สลับ DNS, ปิด V1
```

### Phase 0 — Scaffolding & CI
- **ส่งมอบ:** monorepo (pnpm/Turborepo), NestJS + Next.js skeleton, Railway services (`api`, `web`, Postgres), GitHub Actions (lint/test/build), `drizzle-kit` ตั้งค่า, `@anthropic-ai/sdk` พร้อม model config ผ่าน env
- **Exit:** deploy ขึ้น Railway ได้, `GET /` health ผ่าน, มี 1 endpoint demo + 1 หน้า login เปล่า

### Phase 1 — Database + ETL
- **ส่งมอบ:** Postgres schema ตาม [docs/03](docs/03-database-schema.md) (enums, FK, surrogate PK, `tenant_id`, แยก `items` ↔ `stock_snapshots`), Drizzle models, migration files; ETL ตาม [docs/04](docs/04-data-migration.md) แปลง SQLite → PG แบบ idempotent
- **Exit:** รัน ETL ซ้ำได้ผลเดิม; reconcile row counts + ยอดรวมการเงิน (sales/AP/AR/stock) เดิม=ใหม่ ตรงทุกตัว

### Phase 2 — Read APIs + Auth
- **ส่งมอบ:** JWT auth (login/me), RBAC guards + TenantInterceptor, และ **endpoint อ่านทั้งหมดที่คง path เดิม** (`/api/dashboard`, `/api/pos/*`, `/api/inventory/*`, `/api/finance/*`, `/api/notifications`, `/api/analytics/*`, `/api/reports/*`)
- **Exit:** **Read-parity diff suite** — ยิง endpoint เดิม vs ใหม่บนข้อมูลชุดเดียวกัน เทียบ JSON ทีละ byte (ยกเว้นจุดที่จงใจแก้ เช่น Dec P&L off-by-one — บันทึกไว้); ชี้ mobile app เดิมมาที่ API ใหม่ได้

### Phase 3 — Write/Transactional modules
- **ส่งมอบ:** endpoint เขียนครบตามที่ Streamlit ทำ — POS (sales order + cust-POS), PR→PO→GR + GR claims, stocktake/stock movement, AR (invoice/receipt) + AP, returns, delivery orders, price list, lots, locations, promotions, BOM, users/RBAC admin, marketing/loyalty/survey, customer portal writes; **DocNumberService** (sequence) + **status-workflow state machines**
- **Exit:** ทุก transaction มี integration test; เลขเอกสารรูปแบบตรงเดิม; effect ต่อ stock/lot/loyalty/AR ตรงตาม parity matrix

### Phase 4 — Frontend (Next.js)
- **ส่งมอบ:** 40 เพจตาม [docs/05](docs/05-frontend.md) ทีละโดเมน (POS → Inventory → Finance → Customer Portal → Marketing), nav จาก RBAC, i18n TH/EN (พอร์ต `_LANG`), shadcn/ui + TanStack Table/Query, AI chat UI, ปุ่ม download Excel/PDF ไทย
- **Exit:** ทุกเพจที่ปล่อยแล้ว ปิดเพจคู่ใน Streamlit (read-only) ได้; UAT ผ่านต่อโดเมน

### Phase 5 — AI + Analytics
- **ส่งมอบ:** พอร์ต `BaseAgent` loop → `AgentService` (tools = service layer เดียวกับ REST), analytics (forecasting/anomalies/llm_insights) ค่าคงที่เป๊ะ, `/api/chat` streaming (SSE), `/api/analytics/*`, prompt caching
- **Exit:** chat ดึงข้อมูลจริงผ่าน tools ได้ (เดิม `/api/chat` ดึงไม่ได้ — ถือเป็น improvement), analytics ตัวเลขตรง spec, rule-based fallback ทำงานเมื่อไม่มี key

### Phase 6 — Parallel-run & Cutover
- **ส่งมอบ:** รัน V1+V2 คู่กันช่วงสุดท้าย, ETL delta sync, runbook cutover + rollback
- **Exit:** reconcile ครบ → สลับ traffic → freeze V1 (read-only) 2 สัปดาห์ → ปิด V1

---

## 5. Risk Register

| # | ความเสี่ยง | ผล | การลด |
|---|---|---|---|
| R1 | NestJS boilerplate ช้าตอนเริ่ม (ทีมถนัด Python) | velocity ตก | เริ่ม service แบบ minimal, เลื่อน Redis/worker, ใช้ Nest CLI generators |
| R2 | Map ชื่อคอลัมน์อัปลักษณ์ผิด → คืน null เงียบ ๆ | ข้อมูลเพี้ยน | Read-parity diff suite (Phase 2) เป็น guardrail; ETL reconcile |
| R3 | เลขเอกสาร 3 สคีม/race เดิม ถ้า "รวบ" จะเปลี่ยน ID | เอกสารชน/ผิด | คงรูปแบบแสดงผลเดิม, เปลี่ยนเฉพาะกลไกเป็น sequence; ทดสอบ concurrency |
| R4 | Multi-tenant: ลืม `WHERE tenant_id` → ข้อมูลข้ามลูกค้ารั่ว | ความลับรั่ว | TenantInterceptor + repository บังคับ `tenantId` param + **Postgres RLS** backstop |
| R5 | Thai PDF/Excel เพี้ยน | เอกสารส่งลูกค้าเสีย | Playwright+Sarabun (ดีกว่า fpdf เดิม); ทดสอบ visual กับเอกสารจริง |
| R6 | AI cost/latency ตอน concurrent | ค่าใช้จ่าย/ช้า | prompt caching, streaming, turn/token budget, per-tenant rate limit |
| R7 | `tbl_raw_inventory` 1.48M แถว ตอน ETL | ช้า/หน่วง | partition `stock_snapshots` ตาม `generate_date`, COPY แบบ batch, index หลังโหลด |
| R8 | Snapshot vs transactional stock เข้าใจผิดแล้ว "แก้" | ผิด data model ทั้งระบบ | คง snapshot model ใน V2; movement = audit log (ดู parity note) |
| R9 | สอง password hasher เดิม (make_hash vs sha256 inline) | sub-user login ไม่ได้ | ETL ขน hash ดิบมา; verify-sha256-then-argon2-rehash |
| R10 | POS offline ไม่มีทั้ง V1/V2 | ร้านล่มตอนเน็ตหลุด | แจ้ง product owner เป็น workstream แยก (ไม่ใช่ scope parity) |

---

## 6. การตัดสินใจที่ต้องเคาะกับเจ้าของระบบ (Open Decisions)

ดูคำถามท้าย session — ประเด็นที่กระทบทิศทาง:

1. **ยืนยัน stack** TypeScript/NestJS/Next.js/Postgres หรือต้องการพิจารณาทางเลือกอื่น (Go / .NET)
2. **ขอบเขตเฟสแรก** — ทำ feature-parity ครบก่อน หรือเริ่มเฉพาะแกน (POS/Inventory/Finance) แล้วค่อยตาม portal/marketing
3. **i18n** — คงพฤติกรรมเดิม (หลายส่วนเป็นไทยล้วนแม้เลือก EN) หรือทำ EN/TH เต็มทุกหน้า
4. **Historical ingest** — `Init_Historical_DB.py` ผูก Outlook/Windows; V2 ต้องการตัวแทน portable (IMAP/อัปโหลด) ไหม
5. **ข้อมูลจริง** — มี order/sale จริงน้อย (sales_orders 9 แถว, cust_pos 1) แต่ `tbl_raw_inventory` 1.48M — ยืนยันว่า ETL โฟกัส inventory + master + users เป็นหลัก

---

## 7. สรุปสั้น

V2 = **TypeScript end-to-end บน NestJS + Drizzle + PostgreSQL + Next.js** บน Railway, พอร์ต AI ด้วย `@anthropic-ai/sdk`, ย้ายแบบ **strangler-fig** ทีละโดเมนโดยมี **read-parity diff** และ **ETL reconcile** เป็นเครื่องมือกันพลาด คงฟีเจอร์ธุรกิจครบ 100% และแก้ช่องโหว่ความปลอดภัย/เลขเอกสาร/RBAC อย่างจงใจระหว่างทาง

รายละเอียดเชิงลึกอยู่ในไฟล์ `docs/01`–`docs/07`
