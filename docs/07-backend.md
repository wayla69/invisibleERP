# 07 — Backend Architecture (NestJS)

**Stack:** NestJS (Fastify adapter) · Drizzle ORM · PostgreSQL 16 · Zod · `@nestjs/jwt` + argon2 · pg-boss · `@anthropic-ai/sdk`

หลักการ: **3 ชั้นต่อโมดูล** (Controller → Service → Repository) ; โดเมนเดิม (POS/Inventory/Finance/Reports) แปลงเป็น Nest module 1:1 ; cross-cutting (RBAC, tenant, validation, doc-numbering) อยู่ใน `common/`

---

## 1. โครงสร้างไดเรกทอรี

```
apps/api/src/
├─ main.ts                      # bootstrap (Fastify, CORS=explicit origins, global pipes/filters)
├─ app.module.ts
├─ common/
│  ├─ guards/
│  │  ├─ jwt-auth.guard.ts       # ตรวจ Bearer JWT
│  │  ├─ roles.guard.ts          # @Roles('Admin', ...)
│  │  └─ permissions.guard.ts    # @Permissions('procurement', ...)
│  ├─ interceptors/
│  │  └─ tenant.interceptor.ts   # set app.tenant_id (RLS) จาก JWT.customerName
│  ├─ pipes/zod-validation.pipe.ts
│  ├─ filters/all-exceptions.filter.ts   # error envelope {code,message,messageTh}
│  ├─ decorators/  @Roles @Permissions @Tenant @CurrentUser
│  └─ services/
│     ├─ doc-number.service.ts   # สร้างเลขเอกสารจาก sequence (กัน race)
│     └─ status-log.service.ts   # เขียน doc_status_log (แทน _log_status)
├─ database/
│  ├─ schema/                    # Drizzle: index.ts + ไฟล์ต่อโดเมน (items.ts, orders.ts, ...)
│  ├─ drizzle.module.ts          # provider DRIZZLE (pool + db)
│  └─ migrations/                # drizzle-kit
├─ config/
│  └─ config.module.ts           # env: DATABASE_URL, JWT_SECRET, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ...
└─ modules/
   ├─ auth/          (login, me, jwt strategy, password service)
   ├─ pos/           (orders, sales-orders, claims, customer-pos, returns)
   ├─ inventory/     (stock, items, movements, stocktake, lots, locations, scan, images)
   ├─ procurement/   (pr, po, gr, gr-claims, vendors)
   ├─ finance/       (ar, ap, pl, kpi)
   ├─ bom/           (master, submissions, cust-bom, production)
   ├─ customers/     (portal: dashboard, inventory, pending, mini-erp, variance)
   ├─ marketing/     (campaigns, ab, segments, promotions, surveys)
   ├─ loyalty/       (config, points, redeem)
   ├─ reports/       (excel, pdf, daily/monthly/stock)
   ├─ ai/            (agent service, tools, analytics)
   ├─ notifications/
   └─ admin/         (users, roles, permissions)
```

---

## 2. ชั้นและความรับผิดชอบ

**Controller** — HTTP บาง ๆ ผูก path เดิมเป๊ะ:
```ts
@Controller('api/inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Get('stock')
  @Permissions('warehouse', 'dashboard')   // RBAC
  getStock(@Query(new ZodPipe(StockQuery)) q: StockQueryDto) {
    return this.svc.getStock(q);            // คืน {snapshot_date, items, total, low_stock_count}
  }
}
```

**Service** — business logic; รวม pattern ซ้ำ ๆ ของเดิมเป็นเมธอดเดียว:
```ts
@Injectable()
export class InventoryService {
  constructor(private readonly repo: InventoryRepository) {}

  // แทน SELECT MAX(Generate_Date) ที่กระจายทั่วโค้ดเดิม
  async latestSnapshotDate(): Promise<Date> { return this.repo.maxGenerateDate(); }

  async getStock(q: StockQueryDto) {
    const snap = await this.latestSnapshotDate();
    const items = await this.repo.stockAtSnapshot(snap, q);  // search/low_only/limit
    return { snapshot_date: snap, items, total: items.length,
             low_stock_count: items.filter(i => i.av_qty <= 0).length };  // คง ≤0 logic
  }
}
```

**Repository** — ที่เดียวที่แตะ Drizzle; รวม quirks เดิม + **บังคับ `tenantId` param** ทุก query ที่มี tenant:
```ts
@Injectable()
export class PortalInventoryRepository {
  // ทุกเมธอด tenant ต้องรับ tenantId — ลืมแล้ว compile ไม่ผ่าน (กันรั่วข้าม tenant)
  async listInventory(tenantId: number) {
    return this.db.select().from(customerInventory).where(eq(customerInventory.tenantId, tenantId));
  }
}
```

---

## 3. Auth & RBAC & Tenant (แก้ช่องโหว่เดิม)

- **JWT** claims `{ sub, role, customerName, permissions[] }` (แทน HMAC pipe-string เดิม) ; argon2 verify, fallback sha256 เดิม แล้ว rehash ตอน login สำเร็จ
- **`@Roles` / `@Permissions`** decorators + guards อ่าน metadata; seed จาก `role_permissions`/`user_permissions` (resolution: Admin→all, user override, role default)
- **`TenantInterceptor`** — ต่อ request set `SET app.tenant_id = <jwt.customerName→id>` ให้ Postgres RLS เป็น backstop; Admin/HQ → bypass
- **บังคับ auth ทุก data endpoint** (เดิมเปิดโล่ง — ถือเป็น defect ที่แก้ ไม่ลอก)
- **Security fix:** CORS = explicit origins (เลิก `*`) ; `JWT_SECRET` required (ไม่มี default) ; เลิก default `admin/admin123` (force change on first login)

---

## 4. Cross-cutting services

**DocNumberService** — แก้ปัญหา 15 สคีม/race เดิม:
```ts
// คงรูปแบบแสดงผลเดิม แต่ใช้ Postgres sequence ต่อ doc_type/วัน → atomic
async next(docType: 'PO'|'GR'|'SO'|'SALE'|..., ctx?: {tenantCode?: string}): Promise<string>
// 'PO'  → PO-20260620-001
// 'SALE'→ SALE-OSHI-20260620153012  (tenantCode[:4])
```

**StatusLogService** — `log(docType, docNo, from, to, by, remarks)` → `doc_status_log` (แทน `_log_status`)

**State machines** — order (6 states), claim (Waiting/Approved/Rejected), PO (Draft→…→Closed/Cancelled), invoice (Unpaid/Partial/Paid) — บังคับ transition + log

---

## 5. Background jobs (pg-boss)

- report/PDF/Excel generation, analytics scans, marketing reminders, AR invoice sync → คิวบน Postgres (ไม่ต้องตั้ง Redis)
- เดิมหลายอย่าง sync บน page load (`_sync_ar_invoices`, `_sync_lots`, `_sync_loc_stock`) → V2 ทำเป็น job/มี endpoint trigger + idempotent
- แยกเป็น `worker` service เฉพาะเมื่อ report timeout เริ่มกระทบ

---

## 6. ตัวอย่าง module skeleton

```ts
// modules/procurement/procurement.module.ts
@Module({
  imports: [DrizzleModule],
  controllers: [PoController, PrController, GrController, VendorController],
  providers: [PoService, PrService, GrService, VendorService, ProcurementRepository,
              DocNumberService, StatusLogService],
})
export class ProcurementModule {}

// po.service.ts (ตัวอย่าง create PO — คง logic เดิม)
async createPo(dto: CreatePoDto, user: JwtUser) {
  const poNo = await this.docNo.next('PO');                 // PO-YYYYMMDD-NNN (sequence)
  const total = dto.items.reduce((s,i)=> s + i.qty*i.unitPrice, 0);
  const po = await this.repo.insertPo({ poNo, vendorId: dto.vendorId, status:'Pending',
              totalAmount: total, createdBy: user.username, expectedDate: dto.expectedDate });
  await this.repo.insertPoItems(po.id, dto.items);
  await this.statusLog.log('PO', poNo, '', 'Pending', user.username);
  return { success:true, po_number: poNo, total_amount_thb: total, status:'Pending' };
}
```

---

## 7. Testing

- **Unit** — services (business math: ROP, BOM cost, loyalty, aging, effective price) เทียบสูตรเดิมเป๊ะ
- **Integration** — endpoints + DB (testcontainers Postgres)
- **Read-parity diff** (Phase 2 gate) — สคริปต์ยิง endpoint เดิม (FastAPI บน SQLite ที่ migrate แล้ว) vs V2 → เทียบ JSON; whitelist เฉพาะจุดที่จงใจแก้ (Dec P&L, auth, page-total)
- **Contract** — Zod schema = source of truth ของ request/response + AI tool input

## 8. Service decomposition log (docs/38 — characterization-first, facade-preserving)

| Date | Service | Extraction | Notes |
|---|---|---|---|
| 2026-07-08 | `bi` (pilot) | PR-1: `REPORT_TYPES` + `FREQUENCIES` → `modules/bi/report-registry.ts` (pure const module) | Zero DI/constructor change; golden-master 496 paths identical without re-pin; bi 41 · bi-cache 6 · async-jobs 26 green. Next: PR-2 `generate` (generateReport + execScorecard behind a read-port), PR-3 `schedule`. |
| 2026-07-08 | `bi` (pilot) | PR-2: `generateReport` (~50 report-type branches) + `execScorecard` → `modules/bi/bi-generate.service.ts` (463 LOC) | Facade keeps a private `generateReport` delegator passing `this` as the `BiReadPort` (cached read core stays on BiService — structural typing, no forwardRef). 23 `@Optional` deps replicated on the new service; BiService ctor params 1–30 untouched, `BiGenerateService` appended as param 31. bi.service 1,211 → 743 LOC. Golden 496 identical; bi 41 · bi-cache 6 · async-jobs 26 · worldclass 59 green. Next: PR-3 `schedule`. |
| 2026-07-08 | `bi` (pilot) | PR-3: subscription scheduler (create/list/delete · due sweeps · executeSubscription/deliver · runs log) → `modules/bi/bi-schedule.service.ts` (267 LOC) | Facade keeps every public method as a thin delegator passing `this` as the `BiReadPort`; worker `onModuleInit` registration stays on the facade (one-directional ports). `BiScheduleService` appended as ctor param 32. **Pilot COMPLETE**: bi.service 1,211 → 532 LOC across 3 PRs, golden 496 identical on every cut; bi 41 · bi-cache 6 · async-jobs 26 · worldclass 59 · compliance 138 green. |
