# 08 — Cutover Runbook (Phase 6: Parallel-run & Cutover)

ย้าย traffic จาก V1 (Python: Streamlit + FastAPI + SQLite) → V2 (NestJS + Postgres + Next.js) แบบ **strangler-fig** — V1+V2 รันคู่กัน, reconcile, สลับ, freeze, ปิด V1

เครื่องมือ Phase 6 อยู่ใน `tools/cutover/`:
- `e2e` — boot Nest app จริง (in-process, PGlite) ยิง HTTP ครบ flow (validate artifact) → **ผ่าน 16/16**
- `shadow` — parallel-run diff: ยิง endpoint เดียวกันไป V1+V2 เทียบ JSON
- `reconcile` — gate ก่อน cutover: เทียบ SQLite source กับ Postgres target (exit code)

---

## 0. Pre-flight (ก่อนเริ่ม)

- [ ] V2 ผ่าน CI ทุก workspace (build + typecheck) และ test harness ทั้ง 4: `parity start` (read 10/10), `writeflow` (24/24), `analytics` (14/14), `cutover e2e` (16/16)
- [ ] Railway: service `api` + `web` + Postgres plugin + object storage (R2/S3) พร้อม (ดู §6)
- [ ] env ครบทุก service: `DATABASE_URL`, `JWT_SECRET` (สุ่มยาว), `CORS_ORIGINS`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
- [ ] สำรอง `Inventory_Master_DB.sqlite` (snapshot ก่อน migrate)

---

## 1. Phase 1 — ETL dry-run (ไม่กระทบ production)

```bash
# โหลด SQLite → Postgres staging (idempotent)
DATABASE_URL=<pg-staging> NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/api db:migrate
DATABASE_URL=<pg-staging> LEGACY_SQLITE_PATH=<sqlite> NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/etl start
```
- [ ] ETL จบไม่มี error; ดู ETL summary
- [ ] รัน reconcile gate:
```bash
DATABASE_URL=<pg-staging> LEGACY_SQLITE_PATH=<sqlite> NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover reconcile
```
  ต้อง **GATE PASSED** (row counts + ยอดเงิน source=target)

---

## 2. Phase 2 — Parallel-run (V1+V2 คู่กัน, read-only เทียบ)

Deploy V2 `api` ชี้ Postgres staging แล้วเปิดคู่กับ V1 (ยังไม่รับ traffic จริง):
```bash
V1_URL=https://<v1-api> V2_URL=https://<v2-api> \
  V1_TOKEN=<t1> V2_TOKEN=<t2> pnpm --filter @ierp/cutover shadow
```
- [ ] shadow diff: read endpoints ทั้งหมด **match** (ยกเว้นที่จงใจแก้ — บันทึกไว้: Dec P&L off-by-one ถ้าเลือก fix, auth ที่เพิ่ม, `generated_at`/`snapshot_date` ที่ต่างโดยธรรมชาติ)
- [ ] ชี้ mobile app เดิม (React Native) มา V2 API ใน staging → smoke ฟังก์ชันหลัก
- [ ] UAT ต่อโดเมน (POS / Inventory / Finance) บน V2 frontend

---

## 3. Phase 3 — Freeze window & delta sync (เริ่มหน้าต่าง maintenance)

1. [ ] ประกาศ maintenance; หยุด **write** บน V1 (อ่านได้)
2. [ ] รัน ETL อีกครั้ง (idempotent — เก็บ delta ที่เพิ่มหลัง dry-run):
   - upsert by business key; snapshot append-only `ON CONFLICT (item_id, generate_date) DO NOTHING`
3. [ ] รัน reconcile gate อีกครั้ง → ต้อง **GATE PASSED**
4. [ ] รัน `db:seed` (ถ้ายังไม่มี admin) แล้วบังคับเปลี่ยนรหัส admin (เลิก `admin/admin123`)

---

## 4. Phase 4 — Cutover (สลับ traffic)

1. [ ] ชี้ V2 `api` ไป **Postgres production** (ที่ migrate แล้ว); `web` ชี้ V2 api
2. [ ] สลับ DNS/Railway domain → V2 (`api` + `web`)
3. [ ] Smoke production (มี token จริง):
   - `GET /` =200, login =200, `GET /api/dashboard|inventory/stock|finance/kpi` =200 ข้อมูลถูก, สร้าง 1 order ทดสอบ → `SO-` ออก
   - หรือใช้ `tools/cutover e2e` pattern เป็น checklist
4. [ ] เปิด write บน V2; ปิด maintenance

---

## 5. Phase 5 — Post-cutover & rollback

- **Monitor (48 ชม.):** error rate, p95 latency, DB connections, AI cost/latency, เลขเอกสารไม่ชน (unique), ยอดเงิน dashboard เทียบ V1 snapshot
- **Freeze V1 read-only 2 สัปดาห์** (เผื่อ rollback / อ้างอิง) แล้วจึงปิด
- **Rollback (ถ้า reconcile/smoke ไม่ผ่าน):**
  1. ชี้ DNS กลับ V1 (ยังเปิด read-only อยู่ → เปิด write กลับ)
  2. แก้ปัญหา (ETL idempotent → รันซ้ำได้), redo จาก Phase 1
  3. ไม่มี data loss เพราะ V1 ยัง authoritative จนกว่าจะ cutover สำเร็จ + monitor ผ่าน

---

## 6. Railway deploy (2 services จาก repo เดียว)

| Service | Root | Build | Start | Healthcheck |
|---|---|---|---|---|
| **api** | repo root | `pnpm install && pnpm --filter @ierp/shared build && pnpm --filter @ierp/api build` | `node apps/api/dist/main.js` | `/` |
| **web** | repo root | `pnpm install && pnpm --filter @ierp/shared build && pnpm --filter @ierp/web build` | `pnpm --filter @ierp/web start` | `/login` |

- **Postgres** plugin → `DATABASE_URL` (ใช้ `postgresql://`; ถ้า Railway ให้ `postgres://` แก้ scheme — ดู `database.module` warn)
- **Object storage (R2/S3)** สำหรับรูป/รายงาน (เลิก shared SQLite volume เดิม)
- predeploy: `pnpm --filter @ierp/api db:migrate`
- config เริ่มต้น: `apps/api/railway.json`, `apps/web/railway.json`

> หมายเหตุ Postgres pooler/proxy: ถ้าใช้ตัวที่ไม่รองรับ extended protocol ตั้ง `DB_SIMPLE=1` (api จะใช้ simple protocol). Railway Postgres ตรง ๆ ไม่ต้องตั้ง.
