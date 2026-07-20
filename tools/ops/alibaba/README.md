# Alibaba Cloud — การตั้งค่า Tier 0 (เครื่องเดียว) + สำรองข้อมูลขึ้น OSS

> ชุดเครื่องมือสำหรับรัน Invisible ERP แบบ **ลีนสุด (Tier 0)** บน Alibaba Cloud ECS เครื่องเดียว
> ตามแผน [`docs/deployment/alibaba-cloud-plan-th.md`](../../../docs/deployment/alibaba-cloud-plan-th.md)
> — เครื่องเดียวรัน **Caddy (TLS) → web + api → Postgres** พร้อมสำรองข้อมูลอัตโนมัติขึ้น **OSS**
>
> ⚠️ Tier 0 **ไม่มี HA** (เครื่องเดียว = จุดล้มเดียว) จึง **ต้องสำรองข้อมูล + ทดสอบกู้คืนจริง** เสมอ
> เครื่องมือชุดนี้เป็นของใหม่ ไม่กระทบระบบ Railway ที่รันอยู่

## ภาพรวมไฟล์
| ไฟล์ | หน้าที่ |
|---|---|
| `docker-compose.tier0.yml` | สแตกโปรดักชันเครื่องเดียว (caddy + web + api + db) |
| `Caddyfile` | reverse proxy แบบ same-origin: `/api/*` → api, ที่เหลือ → web + ออก HTTPS อัตโนมัติ |
| `.env.example` | ตัวอย่างค่าคอนฟิก — คัดลอกเป็น `.env` แล้วใส่ค่าจริง |
| `ecs-tier0-setup.sh` | สคริปต์ติดตั้งครั้งเดียวบน ECS (Docker, สแตก, cron) — รันซ้ำได้ |
| `backup-cron.sh` | สำรองข้อมูลรายชั่วโมง (เรียก `../pg-backup.sh` → ดิสก์ + OSS) |
| `restore-drill-cron.sh` | ซ้อมกู้คืนรายเดือน (เรียก `../verify-restore.sh`) — หลักฐาน ITGC-OP-01 |
| `docker-compose.tier1.yml` | สแตก Tier 1 (web + api + caddy, ใช้ Postgres ภายนอก = RDS, ไม่มี db container) |
| `migrate-tier0-to-tier1.sh` | ย้ายข้อมูล Tier 0 → ApsaraDB RDS (Tier 1) + พิมพ์ขั้นตอนตัดสลับ |

> งานจริงของการสำรอง/กู้คืนใช้สคริปต์กลางที่มีอยู่แล้ว: [`../pg-backup.sh`](../pg-backup.sh),
> [`../restore.sh`](../restore.sh), [`../verify-restore.sh`](../verify-restore.sh) — ดู [`../BACKUP-RUNBOOK.md`](../BACKUP-RUNBOOK.md)

## ทำไมต้องมี Caddy (same-origin)
แอป web ฝังค่า `NEXT_PUBLIC_API_URL` ตั้งแต่ตอน build และเบราว์เซอร์จะยิงไปที่ origin นั้นตรง ๆ
ส่วน API ทุกเส้นอยู่ใต้ `/api/*` อยู่แล้ว เราจึงให้ทุกอย่างอยู่ **origin เดียว** แล้วให้ Caddy
ส่ง `/api/*` ไป api และที่เหลือไป web — เลี่ยงปัญหา CORS/คุกกี้ข้าม origin (กับดัก "ล็อกอินแล้วเด้งกลับ")
และได้ใบรับรอง TLS ใบเดียวจบ

## ขั้นตอนติดตั้ง (ครั้งเดียว)

### 1) เตรียม ECS
- สร้าง ECS (Ubuntu 22.04 LTS) ภูมิภาค **กรุงเทพฯ** — แนะนำ 4 vCPU / 16 GB สำหรับ Tier 0
- เปิด Security Group เฉพาะ **80, 443, 22** ขาเข้า (อย่าเปิด 5432/8000 สู่อินเทอร์เน็ต)
- ชี้ DNS (A record) ของโดเมนมาที่ public IP ของเครื่อง (เพื่อให้ Caddy ออก HTTPS อัตโนมัติ)
- สร้าง **OSS bucket** (เช่น `ierp-backups`) ในภูมิภาคเดียวกัน

### 2) เอาโค้ดขึ้นเครื่อง + ตั้งค่า
```bash
git clone <repo> /opt/ierp && cd /opt/ierp
cp tools/ops/alibaba/.env.example tools/ops/alibaba/.env
nano tools/ops/alibaba/.env          # ใส่โดเมน, รหัสผ่าน DB, secrets (openssl rand -hex 32), BACKUP_OSS
```

### 3) ตั้งค่า rclone ให้ชี้ OSS (สำหรับสำรองข้อมูลออฟไซต์)
```bash
rclone config
#  name = oss
#  type = s3 ,  provider = Alibaba
#  access_key_id / secret_access_key = (RAM user ที่มีสิทธิ์เขียน OSS)
#  endpoint = oss-ap-southeast-7-internal.aliyuncs.com   # กรุงเทพฯ, internal = ไม่เสียค่า egress จาก ECS
```

### 4) รันสคริปต์ติดตั้ง
```bash
sudo bash tools/ops/alibaba/ecs-tier0-setup.sh
```
สคริปต์จะ: ติดตั้ง Docker + postgresql-client + rclone → build & start สแตก (api รันไมเกรชันให้เอง)
→ ติดตั้ง cron สำรองรายชั่วโมง + ซ้อมกู้คืนรายเดือน

### 5) ตรวจสอบ
```bash
docker compose --env-file tools/ops/alibaba/.env -f tools/ops/alibaba/docker-compose.tier0.yml ps
curl -fsS http://127.0.0.1:8000/healthz && echo ok      # api ภายในเครื่อง
curl -fsSI https://<โดเมนของคุณ> | head -1               # หลัง DNS + TLS พร้อม
```

## ทดสอบแบบ HTTP (ยังไม่มีโดเมน / ไม่เอา TLS)
อยากลองเร็ว ๆ ก่อนซื้อโดเมน? ตั้งสองค่านี้ใน `.env` ให้ตรงกับที่อยู่ที่ใช้เปิดเบราว์เซอร์:
```bash
PUBLIC_SITE_URL=http://<public-ip-ของ-ECS>   # หรือ http://localhost ถ้าเปิดบนเครื่องนั้นเอง
CADDY_SITE_ADDRESS=:80                         # Caddy เสิร์ฟ HTTP ล้วน ไม่ทำ TLS
```
แล้ว `docker compose --env-file .env -f docker-compose.tier0.yml up -d --build`
(เพราะ `NEXT_PUBLIC_API_URL` ฝังตอน build ต้อง `--build` ใหม่ทุกครั้งที่เปลี่ยน `PUBLIC_SITE_URL`)
พอจะขึ้นโปรดักชันจริงค่อยเปลี่ยนกลับเป็นโดเมน แล้ว Caddy จะออก HTTPS ให้อัตโนมัติ

## การสำรองข้อมูล
- **อัตโนมัติ:** cron รันทุกชั่วโมง → ดัมป์ลง `BACKUP_DIR` (ดีฟอลต์ `/var/backups/ierp`) + อัปขึ้น `BACKUP_OSS`
  เก็บย้อนหลัง `RETAIN_DAYS` วัน (ดีฟอลต์ 14) · ล็อก: `/var/log/ierp-backup.log`
- **สั่งเองครั้งเดียว:**
  ```bash
  ENV_FILE=tools/ops/alibaba/.env bash tools/ops/alibaba/backup-cron.sh
  ```

## การซ้อมกู้คืน (อย่าข้าม!)
- **อัตโนมัติ:** cron รันวันที่ 1 ของเดือน เวลา 03:00 → กู้ดัมป์ล่าสุดเข้า DB ชั่วคราว ตรวจตารางหลัก แล้วลบทิ้ง
  ล็อก: `/var/log/ierp-restore-drill.log` — **เก็บผลเป็นหลักฐาน ITGC-OP-01**
- **สั่งเอง:**
  ```bash
  ENV_FILE=tools/ops/alibaba/.env bash tools/ops/alibaba/restore-drill-cron.sh
  ```

## กู้คืนจริงตอนเกิดภัยพิบัติ (DR)
1. ดึงดัมป์ล่าสุดจาก OSS: `rclone copy oss:ierp-backups/prod/<ไฟล์>.dump.gz .`
2. กู้เข้า DB ใหม่: `TARGET_DATABASE_URL=… bash tools/ops/restore.sh <ไฟล์>.dump.gz`
3. ใช้ **`APP_ENC_KEY` เดิม** ไม่งั้นข้อมูลที่เข้ารหัส (TOTP/secret) จะถอดไม่ได้
4. ชี้ `DATABASE_URL` ของ api ไป DB ใหม่ แล้ว redeploy → เช็ก `/healthz`
   (รายละเอียด: [`../BACKUP-RUNBOOK.md`](../BACKUP-RUNBOOK.md))

## อัปเดตเวอร์ชันแอป
```bash
cd /opt/ierp && git pull
docker compose --env-file tools/ops/alibaba/.env -f tools/ops/alibaba/docker-compose.tier0.yml up -d --build
```

## เมื่อโตขึ้น → Tier 1 (แยก Postgres ไป ApsaraDB RDS)
เมื่อทราฟฟิก/ความเสี่ยงสูงขึ้น ให้ย้ายฐานข้อมูลออกไปใช้ **ApsaraDB RDS for PostgreSQL (HA)** มีสคริปต์ช่วย:

```bash
# 1) สร้าง RDS (HA) ภูมิภาคเดียวกัน เปิดให้ ECS เชื่อมต่อได้ (VPC/security group)
# 2) ย้ายข้อมูล Tier 0 → RDS (dump → migrate roles/RLS บน RDS → restore → ตรวจสอบ)
TARGET_DATABASE_URL='postgresql://<user>:<pw>@<rds-host>:5432/invisible_erp_v2' \
  bash tools/ops/alibaba/migrate-tier0-to-tier1.sh
```

สคริปต์จะ **ไม่แก้ `.env` ให้เอง** แต่จะพิมพ์ขั้นตอนตัดสลับท้ายงาน — สรุปคือ:
1. แก้ `.env`: ตั้ง `DATABASE_URL`, `BACKUP_DB_URL`, `DRILL_ADMIN_URL` ให้ชี้ RDS (ดูบล็อก Tier 1 ใน `.env.example`)
2. สลับมาใช้ `docker-compose.tier1.yml` (ไม่มี service `db` แล้ว):
   ```bash
   docker compose --env-file tools/ops/alibaba/.env -f tools/ops/alibaba/docker-compose.tier1.yml up -d --build
   ```
3. เช็ก `/healthz` → รัน **restore drill กับ RDS หนึ่งรอบ** → แล้วค่อย `stop` คอนเทนเนอร์ `db` เดิม
   (เก็บ volume `pgdata` ไว้เป็น rollback จนกว่า drill บน RDS จะผ่าน)

ไมเกรชันบน Tier 1 รันเป็น **สเต็ปปล่อยเวอร์ชันเดี่ยว** (สคริปต์/ดีพลอยจ็อบ) ไม่ใช่ทุก replica boot —
ค่าเริ่มต้น `RUN_MIGRATIONS=0` (ดู [`docs/ops/deployment.md`](../../../docs/ops/deployment.md) §3)

> CI: `.github/workflows/ops-scripts-check.yml` ตรวจสคริปต์เหล่านี้อัตโนมัติทุก PR ที่แตะ `tools/ops/`
> (`bash -n` + shellcheck + `docker compose config` ของทั้ง Tier 0/1)
