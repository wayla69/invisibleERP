# Phase 9 — World-Class Foundations (7 highest-leverage moves)

ยกระดับ Invisible ERP V2 จาก "feature-parity กับระบบเดิม" → **รากฐานระดับโลก** ที่แข่งกับ
SAP / NetSuite / Odoo (ERP) และ Square / Toast / Shopify (POS) ได้ ทั้ง 7 moves ทำพร้อมกัน
และ **พิสูจน์ด้วย harness จริง** (Nest app จริง รันบน PGlite = Postgres จริง, RLS เปิดใช้งาน).

> **ผลตรวจ:** `worldclass` 21/21 ✅ · `e2e` 16/16 ✅ · `ext` 26/26 ✅ · `writeflow` 24/24 ✅ ·
> `analytics` 14/14 ✅ · `unit` (vitest) 9/9 ✅ — รวม **90 checks เขียวทั้งหมด**

---

## 1) Multi-tenant isolation — RLS บังคับที่ฐานข้อมูล (เกราะชั้นสุดท้าย)
ความเสี่ยงอันดับ 1 ของ SaaS หลายผู้เช่า: ลืม `WHERE tenant_id = ?` แล้วข้อมูลรั่วข้ามร้าน
ตอนนี้ **ฐานข้อมูลกันให้เอง** — แม้โค้ดลืม filter ก็รั่วไม่ได้.

- `drizzle/0002_rls.sql` — สร้าง role `app_user`, เปิด `ENABLE/FORCE ROW LEVEL SECURITY` +
  policy `tenant_isolation` ให้ทุกตารางที่มีคอลัมน์ `tenant_id` แบบไดนามิก.
- Policy: `tenant_id = current_setting('app.tenant_id')` **หรือ** `app.bypass_rls = 'on'` (สำหรับ staff/HQ).
- Runtime: ทุก request ถูกห่อใน transaction → `SET LOCAL ROLE app_user` + ตั้ง `app.tenant_id`/`app.bypass_rls`
  จาก JWT (`TenantTxInterceptor` + `AsyncLocalStorage` + Drizzle proxy ที่ route query เข้าทรานแซกชันนั้น).
- พิสูจน์แล้ว: ลูกค้า A query ไม่มี `WHERE` → เห็นเฉพาะข้อมูลตัวเอง; ลูกค้า B เห็นของ B เท่านั้น (ทั้งระดับ DB และระดับ API).

## 2) Double-entry General Ledger (บัญชีคู่ — แกนการเงินจริง)
จาก P&L แบบรวมยอด → **สมุดบัญชีแยกประเภทบัญชีคู่** ที่ตรวจสอบได้.
- ตาราง `accounts` (ผังบัญชี 9 บัญชีมาตรฐาน), `journal_entries`, `journal_lines` (debit/credit `numeric(18,4)`).
- `LedgerService.postEntry()` — บังคับ **เดบิต = เครดิต** (ไม่สมดุล → reject 400), เลขที่ `JE-YYYYMMDD-NNN` อะตอมมิก.
- รายงาน: trial balance, income statement, balance sheet · API: `/api/ledger/*`.
- **ทุกการขายลง GL อัตโนมัติ:** POS sale → Dr เงินสด / Cr รายได้ / Cr ภาษีขาย.

## 3) Payments & tender (เงินจริง + กระทบยอดลิ้นชัก)
- ตาราง `payments`, `payment_refunds`, `till_sessions` (เปิด/ปิดกะ, นับเงิน, ส่วนต่าง).
- `PaymentGateway` interface (Mock / PromptPay / Stripe) — สลับเกตเวย์ได้โดยไม่แตะ business logic.
- บันทึก tender (`PAY-`), refund (`REF-`), void · ผูกกับการขาย POS ทุกครั้ง.

## 4) CI gates + observability (คุณภาพบังคับ ไม่ใช่แล้วแต่ดวง)
- `.github/workflows/ci.yml` — job `test-harnesses` รัน harness ทั้งหมดเป็น **gate** (build → typecheck → unit → harnesses).
- `audit_log` — บันทึก mutation ทุกครั้ง (actor, action, ip, request-id, trace-id) แบบ append-only.
- OpenTelemetry (`startTelemetry`) + Sentry + pino — เปิดด้วย env, ไม่ตั้งก็ไม่พัง.
- Edge: `@fastify/helmet` (security headers) + `@fastify/rate-limit`.

## 5) Currency + Tax abstraction (พร้อมขายทั่วโลก)
- `TaxProvider` interface (`ThaiTaxProvider` 7%, `ZeroTaxProvider`, ต่อเพิ่มได้) — **เลิก hard-code VAT 7%**.
- หลายสกุลเงิน (THB/USD/EUR/JPY/GBP/SGD) + `fx_rate` บน orders/sales/invoices.
- POS/พอร์ทัล เรียก `TaxService.calcTax()` แทนเลขคงที่.

## 6) Self-serve onboarding + billing (โตได้เองแบบ SaaS)
- ตาราง `plans` (free/starter/pro/enterprise), `subscriptions` (trial, สถานะ, Stripe customer).
- `POST /api/auth/signup` (public) — สร้าง tenant + admin + subscription แบบอะตอมมิก แล้วล็อกอินได้ทันที.

## 7) Public API + SSO/MFA (พร้อมเป็นแพลตฟอร์ม)
- `api_keys` (ออก `ierp_…`, เก็บ sha256), `webhooks` + `webhook_deliveries` (HMAC-signed).
- MFA แบบ TOTP (`otplib`) · OIDC/SSO scaffold (เปิดเมื่อ config).
- ฟิลด์ `mfa_enabled`, `totp_secret`, `sso_subject` บน users.

---

## วิธีรันตรวจเอง
```bash
# unit (เร็ว)
pnpm --filter @ierp/api test
# foundations จริง (RLS · GL · payments · tax · billing · platform · audit/edge)
NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover worldclass
# regression เดิมทั้งหมด
NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover e2e
NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover ext
NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/parity writeflow
NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/parity analytics
```

## Phase 9.2 — Hardening จากผลตรวจโค้ด (ทีม review 3 ด้าน)
หลังทำ 7 moves เสร็จ ส่งทีม agent ตรวจแบบ adversarial 3 ด้าน (security/RLS · การเงิน · integration) แล้วแก้ Critical ทั้งหมด:
- **Phantom-sale (เจอ 2 ด้าน):** `portal.pos.service` ห่อ tender+GL ด้วย `try/catch{}` ที่กลืน error — ใน transaction เดียวกับการขาย ถ้า DB error จะ poison tx → COMMIT กลายเป็น ROLLBACK เงียบ → คืน 200 + sale_no แต่ไม่บันทึกอะไร แก้: ทำให้ tender+GL atomic กับการขาย (ล้ม = rollback ทั้งบิล).
- **RLS bypass allowlist:** เปลี่ยนจาก "ทุก role ที่ไม่ใช่ Customer bypass" → **เฉพาะ Admin (HQ) bypass; พนักงานอื่นผูกร้านตัวเอง** (โมเดล "HQ เห็นทุกร้าน, พนักงานผูกร้าน").
- **tenants RLS (`0003_tenants_rls.sql`):** ตาราง `tenants` ไม่มี `tenant_id` เลย loop เดิมข้าม → เพิ่ม policy keyed บน `id` กันข้อมูล credit/tax/ติดต่อรั่วข้ามร้าน.
- **SET ROLE fail → fatal ใน production:** ถ้า `SET ROLE app_user` ล้มเหลวบน prod จะ **ปฏิเสธ request** (503) แทนรันต่อแบบ RLS ปิดเงียบ.
- **Over-refund guard:** refund รวมยอดเก่า ห้ามเกินยอดที่จ่าย; partial refund คงสถานะ Captured จน refund ครบ.

ยืนยัน: `worldclass` ขยายเป็น **26/26** (เพิ่มพิสูจน์ tenants RLS, staff scoping, Admin bypass, over-refund) + e2e/ext/writeflow/analytics/unit เขียวทั้งหมด = **115 checks**.

> ยังเหลือ High/Medium จากผลตรวจ (ApiKeyGuard ยังไม่ wire, audit tenant_id, JPY rounding, postEntry per-line validation, signup 409, till_session ผูก POS, JWT secret/expiry) — บันทึกไว้ทำรอบถัดไป.

## หมายเหตุการ deploy
- Migration `0002_rls.sql` ต้องรันบน Postgres ที่ผู้ใช้แอป **ไม่ใช่ superuser/owner** (superuser ข้าม RLS).
  บน Railway ให้แอปต่อด้วย role ปกติ; `app_user` ถูกใช้ผ่าน `SET LOCAL ROLE` ต่อ request.
- ตั้ง env เสริมได้: `OTEL_EXPORTER_OTLP_ENDPOINT`, `SENTRY_DSN`, `STRIPE_SECRET_KEY` — ไม่ตั้งก็ทำงานปกติ.
