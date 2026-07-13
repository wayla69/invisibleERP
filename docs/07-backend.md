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
- **Unit (2.4 — docs/38 sub-services):** guard-path suites over the decomposed plain classes — `test/ledger-posting.test.ts` (GL-05 balanced-by-construction incl. scale-4 bigint drift, PERIOD_LOCKED/CLOSED, WS1.1 control-account, SoD self-approve/self-reverse, GL-17 NOT_POSTED/ALREADY_REVERSED) and `test/procurement-po.test.ts` (Phase-16 screening port called-before-insert with 422 propagation, empty-PO and unknown-PO guards) — drizzle-shaped read fakes, no PGlite; write paths stay harness-tested (basics/compliance/golden). Slice 2 adds `test/ledger-recurring.test.ts` (GL-08 template BAD_FREQUENCY/UNBALANCED incl. scale-4 drift; GL-09 BAD_AMOUNT/BAD_MONTHS) and `test/procurement-pr.test.ts` (convertPrToPo PR_NOT_APPROVED/BAD_REQUEST/EMPTY_PO/ITEM_REQUIRED/BAD_QTY; cancelPr 0228 ownership/state; reorderPr NOTHING_LOW via the lowStock port). Slice 3 adds `test/ledger-posting-write.test.ts` (postEntry WRITE path via an insert-capable tx fake: Posted header + postedAt, one R1-2 snapshot bump + GL-17 POST audit row in the same tx, ux_je_idem dedupe short-circuit, Draft branch skips bump/audit, zero-leg drop) and `test/projects-evm.test.ts` (PROJ-06 closed-form BAC/PV/EV/AC/CPI/SPI/EAC incl. cancelled-task exclusion, budget fallback, null-ratio guards, no-planned-end PV rule).
- **Load smoke (relative)** — `pnpm --filter @ierp/cutover load` boots the compiled API on PGlite and measures p50/p95 + req/s on hot reads (stock / trial-balance / catalog) and the GL write path, comparing p95 against the pinned `tools/cutover/load-baseline.json` (fails at ≥2.5× — machine noise stays under it, an algorithmic regression doesn't). `UPDATE_LOADBASE=1 …` re-pins (commit the diff with a justification). Deliberately NOT a CI gate (shared-runner timing flake); run before/after perf-sensitive changes and on release candidates. In-process PGlite = relative code-cost signal, not an absolute prod benchmark.
- **Integration** — endpoints + DB (testcontainers Postgres)
- **Read-parity diff** (Phase 2 gate) — สคริปต์ยิง endpoint เดิม (FastAPI บน SQLite ที่ migrate แล้ว) vs V2 → เทียบ JSON; whitelist เฉพาะจุดที่จงใจแก้ (Dec P&L, auth, page-total)
- **Contract** — Zod schema = source of truth ของ request/response + AI tool input

## 8. Service decomposition log (docs/38 — characterization-first, facade-preserving)

| Date | Service | Extraction | Notes |
|---|---|---|---|
| 2026-07-08 | `bi` (pilot) | PR-1: `REPORT_TYPES` + `FREQUENCIES` → `modules/bi/report-registry.ts` (pure const module) | Zero DI/constructor change; golden-master 496 paths identical without re-pin; bi 41 · bi-cache 6 · async-jobs 26 green. Next: PR-2 `generate` (generateReport + execScorecard behind a read-port), PR-3 `schedule`. |
| 2026-07-08 | `bi` (pilot) | PR-2: `generateReport` (~50 report-type branches) + `execScorecard` → `modules/bi/bi-generate.service.ts` (463 LOC) | Facade keeps a private `generateReport` delegator passing `this` as the `BiReadPort` (cached read core stays on BiService — structural typing, no forwardRef). 23 `@Optional` deps replicated on the new service; BiService ctor params 1–30 untouched, `BiGenerateService` appended as param 31. bi.service 1,211 → 743 LOC. Golden 496 identical; bi 41 · bi-cache 6 · async-jobs 26 · worldclass 59 green. Next: PR-3 `schedule`. |
| 2026-07-08 | `bi` (pilot) | PR-3: subscription scheduler (create/list/delete · due sweeps · executeSubscription/deliver · runs log) → `modules/bi/bi-schedule.service.ts` (267 LOC) | Facade keeps every public method as a thin delegator passing `this` as the `BiReadPort`; worker `onModuleInit` registration stays on the facade (one-directional ports). `BiScheduleService` appended as ctor param 32. **Pilot COMPLETE**: bi.service 1,211 → 532 LOC across 3 PRs, golden 496 identical on every cut; bi 41 · bi-cache 6 · async-jobs 26 · worldclass 59 · compliance 138 green. |
| 2026-07-08 | `projects` | PR-1: pure helpers (`r2/r4/clampPct/depsCsv/peopleCsv/csvToList/clamp15/riskScore/ragFor/addDays`) → `projects.helpers.ts`; row shapers (`shapeTask` … `shapeBoqLine`) → `projects.shapes.ts` | Verbatim moves, no DI/constructor change (the goldenmaster constructs `new ProjectsService(db, ledger)` POSITIONALLY — sub-services for PR-2+ must be built in the ctor BODY, never appended as DI params). projects.service 1,659 → 1,600 LOC. Golden 496 identical; projects 254 · basics 293 green. Next: PR-2 `resourcing` (least-coupled), PR-3 `wbs`, PR-4 `evm`. |
| 2026-07-08 | `projects` | PR-2: resourcing (PROJ-05 — rate cards, assignment, utilization, forward capacity) → `projects-resourcing.service.ts` | Plain class constructed in the ProjectsService ctor BODY (`new ProjectsResourcingService(db, rowOf)`) — not a DI param, honoring the positional goldenmaster canary. Facade delegates the 6 public methods; `portfolioEvm`/`forecast` ride the delegators. projects.service 1,600 → 1,518 LOC. Golden 496 identical; projects 254 · basics 293 · hcm 8 green. |
| 2026-07-08 | `projects` | PR-3: WBS (tasks/milestones/RACI incl. `taskRollup`) → `projects-wbs.service.ts` | Ctor-BODY construction with two callback ports: `rowOf` + `billFn` (the one wbs→billing edge, `reachMilestone`→`bill`, stays a port so wbs is independent of costs). Facade delegates 8 public methods; `get`/`snapProject` use `wbs.taskRollup`. projects.service → 1,396 LOC. Golden 496 identical; projects 254 (incl. tender→project conversion) · basics 293 · hcm 8 green. Next: PR-4 `evm` (final prescribed cut). |
| 2026-07-08 | `projects` | PR-4: EVM/CPM/programs/baselines/health (PROJ-06/07) → `projects-evm.service.ts` (301 LOC) | Ctor-BODY construction from db + the wbs sub-service (`taskRollup`) + four ports (`rowOf`/`getOf`/`fmtOf`/`emit`). Facade delegates 11 public methods; internal `ragOf` users route via the sub-service. **projects decomposition COMPLETE per docs/38 §3** (wbs · resourcing · evm extracted; costs/portfolio/boq/templates/risks/close-review stay on the facade by design): projects.service 1,659 → **1,151 LOC** across 4 PRs, golden 496 identical on every cut. |
| 2026-07-08 | `procurement` | PR-1: `n` helper + DTO interfaces (re-exported for caller compat) + `shapeVendor*` shapers → `procurement.shared.ts` | Canary-proof cut. Constraint recorded: goldenmaster AND writeflow construct `new ProcurementService(db, docNo, statusLog)` POSITIONALLY → sub-services for PR-2+ (grn → po → pr per the recon) must be ctor-BODY built; the 3-way-match path stays untouched in `modules/match`. Golden 496 identical; writeflow 36 · match 83 · basics 293 green. |
| 2026-07-08 | `procurement` | PR-2: GRN cluster (`createGr` — EXP-03 approval gate + costing capitalization + commitment consumption + stock/lot ledgers — `receiveAllRemaining`/`receiveItem`, GR print/email/register) → `procurement-grn.service.ts` (192 LOC) | Ctor-BODY construction per the PR-1 constraint: `new ProcurementGrnService(db, docNo, statusLog, notifyRequesters, costing?, commitments?, grPdf?, docEmail?)` — the one shared helper (`notifyPoPrRequesters`, D2 LINE notify) injected as a callback port. Facade delegates 7 public methods; EXP-03 + parity comments moved verbatim. procurement.service 1,463 → 1,327 LOC. Golden 496 identical; writeflow 36 · match 83 · basics 293 green. Next: PR-3 `po`, PR-4 `pr`. |
| 2026-07-08 | `procurement` | PR-3: PO lifecycle (`createPo` — Phase-16 supplier screening + M0/M2 project dimension + M1/PROJ-12 BoQ-line encumbrance + workflow routing — `approvePo` engine-first/legacy-Admin fallback, `emitPo` webhook fan-out + D2 notify, `cancelPo` GR-guard + commitment release, `getPoForPrint`) → `procurement-po.service.ts` (187 LOC) | Ctor-BODY construction with THREE callback ports (`assertSupplierAllowed` / `resolveProjectId` / `notifyRequesters` — the supplier-screening + PR/vendor surfaces stay on the facade) + optional workflow/webhooks/commitments/docTemplates. Facade delegates 4 public methods. procurement.service 1,327 → 1,183 LOC. Golden 496 identical; writeflow 36 · match 83 · basics 293 · e2e green. Next: PR-4 `pr` (final prescribed cut). |
| 2026-07-08 | `procurement` | PR-4: requisitions (`createPr` M0 project dimension + workflow routing, `approvePr` engine-first/legacy-Admin, `cancelPr` 0228 own-doc withdraw, `listPrs` scoping + item-name backfill, one-tap `reorderPr`, `convertPrToPo` legacy + split multi-supplier fan-out) → `procurement-pr.service.ts` (249 LOC) | Ctor-BODY construction with FOUR callback ports (`resolveProjectId` / `lowStock` / `setPreferredVendor` / `createPo` — conversion rides the same screened/encumbered/workflow PO path) + optional workflow/lineNotify. Facade delegates 6 public methods. **procurement decomposition COMPLETE per docs/38 §3** (grn · po · pr extracted; vendor/supplier + catalog surfaces stay on the facade; `modules/match` untouched): procurement.service 1,463 → **979 LOC** across 4 PRs, golden 496 identical on every cut. Remaining §4 target: `ledger` LAST. |
| 2026-07-08 | `ledger` | PR-1: cash-flow cluster (GL-07 — indirect `cashFlowStatement` incl. add-backs/working-capital off `aggregateByType`, DIRECT `cashFlowDirect` dominant-contra attribution, AR/AP `cashFlowForecast`, private `cashBalanceAsOf`, module classifiers `cashContraCategory`/`prevDay`) → `ledger-cashflow.service.ts` (195 LOC) | The most self-contained GL cut per docs/38 §4 (posting stays LAST). Ctor-BODY construction (harnesses construct `new LedgerService(db, docNo)` positionally) with TWO callback ports: `aggregateByType` (also feeds trialBalance/incomeStatement/balanceSheet/closeYear — stays on the facade) + `ledgerCond` (multi-ledger scope predicate). Facade delegates 3 public methods. ledger.service 1,266 → 1,107 LOC. Golden 496 identical; basics 293 · compliance 138 · worldclass 59 · multiledger green. Next: PR-2 `recurring`+`prepaid` (GL-08/09), PR-3 `posting` (GL-05, most SoD-sensitive, LAST). |
| 2026-07-08 | `ledger` | PR-2: recurring journals (GL-08 — balanced-template validation up front, DRAFT-posting due sweep idempotent via `REC-<id>-<date>` source_ref) + prepaid amortization (GL-09 — straight-line, last-period remainder, idempotent per (schedule, period)) → `ledger-recurring.service.ts` (159 LOC, incl. the `FREQUENCIES`/`addByFrequency` cadence helpers) | Ctor-BODY construction with ONE callback port: `postEntry` (the GL-05/idempotency core — stays on the facade until the final posting cut). DTO types imported type-only from the facade (no runtime cycle). Facade delegates 7 public methods. ledger.service 1,107 → 988 LOC. Golden 496 identical; basics 293 · compliance 138 · worldclass 59 · multiledger 17 · async-jobs 26 green. Next: PR-3 `posting` (GL-05, most SoD-sensitive, LAST). |
| 2026-07-08 | `ledger` | PR-3: posting core (GL-05/GL-17 — `postEntry` balanced-by-construction in bigint minor units + period LOCKED/CLOSED gates + WS1.1 control-account guard + ux_je_idem dedupe + R1-2 snapshot bump + POST audit row atomically; maker-checker `approveEntry`/`rejectEntry` (approver ≠ preparer even for Admin); GL-17 contra `reverseEntry` + `attemptVoidPosted` immutability guard; `listJournal`/`pendingJournal`/`listGlAudit`; private `bumpPeriodBalances`/`entriesList`) → `ledger-posting.service.ts` (338 LOC) | The FINAL prescribed cut (docs/38 §4 — posting LAST, most SoD-sensitive). Ctor-BODY construction, **fully self-contained: zero callback ports** (needs only db + docNo); recurring/prepaid's postEntry port and every internal facade caller (postAdjustment/closeYear/accrueLiability/postOpeningBalances/loyalty) ride the delegator. Facade delegates 8 public methods. **ledger decomposition COMPLETE per docs/38 §3** (cashflow · recurring/prepaid · posting; COA/periods/close/reporting stay on the facade): ledger.service 1,266 → **689 LOC** across 3 PRs, golden 496 identical on every cut. **docs/38 workstream 2.1 COMPLETE — all four god services decomposed** (bi 1,211→532 · projects 1,659→1,151 · procurement 1,463→979 · ledger 1,266→689). |
| 2026-07-12 | (all) | docs/46 Phase 0: service-size accretion ratchet — `tools/ci/check-service-size.mjs` + `service-size-baseline.json` added to the `build` gate (third down-only ratchet, after ts-debt + use-client) | The docs/46 audit found the docs/38 facades re-accreting within 4 days (bi-generate 463→777 LOC / +68%, ledger 689→926 / +34%) because appending to a facade was still the cheapest move for a new feature. The guard grandfathers the 14 `apps/api/src/modules` files currently over 600 LOC at their exact LOC + constructor-param counts (both may only go DOWN — the ctor rule caps the `BiGenerateService` 30-odd-`@Optional()`-deps pattern) and fails any NEW module file passing 600 LOC. Scope is every non-test module `.ts` (services, controllers, and the single-file `.module.ts` services) so logic can't dodge the suffix. `node tools/ci/check-service-size.mjs --update` regenerates after a conscious extraction; a justified exception bumps the baseline with a note (use-client precedent). No behaviour change; next: docs/46 Phase 1 (BI report provider registry). |
| 2026-07-12 | `bi` | docs/46 Phase 1: report dispatch → provider registry. Seam: `report-registry.ts` gains `BiReportGenerator`/`BiReportSource` (still a pure const/type module); `BiReportRegistrarService` (new, in BiModule + `DiscoveryModule`) discovers `biReports()` providers app-wide at boot and registers them with `BiGenerateService`, whose `generateReport` consults the registry BEFORE the legacy if-chain. Migration: **52 report branches moved verbatim** into 26 module-owned `*-bi-reports.ts` providers (ledger, finance ×4-type, tax ×5-type, crm/crm-pipeline/account-health, hcm — incl. the five HR-9 inline-SQL workforce reports and their 6 foreign-schema imports — projects, procurement, billing, assets, eam, leases, match, budget, flux, governance, pdpa, nps, loyalty, journeys, retention, realestate, revenue, revrec-disclosure, scheduled-changes). | ZERO constructor change on BiService/BiGenerateService (positional goldenmaster contract): the now-unused `@Optional()` deps stay dead-but-positioned pending a conscious re-pin PR. Remaining on bi-generate by design: the 4 read-port types, `exec_scorecard`/`marketing_roi` composites, `line_daily_digest` (Phase 3 ledger-read-API case), `data_retention_purge`, `key_rotation_sweep`. bi-generate 777→336 LOC — off the size-ratchet grandfather list (14→13). **New report types = REPORT_TYPES entry + owning-module generator; the ratchet blocks the old append path.** Golden 518 identical (no re-pin); bi 44 · async-jobs 26 · basics 414 · worldclass 59 · compliance 179 · hcm-analytics 23 · revrec 34 · pipeline 108 · line-crm 143 · cashreport 34 · projects 259 · module-qr 73; unit+coverage 464 (new `test/tax-bi-reports.test.ts`); ts-debt + use-client flat. |
| 2026-07-12 | `finance` | docs/46 Phase 2: GOV-01 pending-approvals → contributor interface. `common/approval-queues.ts` defines `ApprovalQueue`/`ApprovalQueueSource` + the shared `approvalAgeDays`; `ApprovalQueueRegistrarService` (finance module + `DiscoveryModule`) discovers sources app-wide at boot; `FinanceService.pendingApprovals` aggregates queues in a canonical `QUEUE_ORDER` matching the historical inline order (stable age-sort tie order — and therefore the full response — byte-identical). **14 of 17 queues moved verbatim** to 9 module-owned `*-approval-queues.ts` providers: ledger (GL-05/BANK-02 · GL-24 · GL-27), payroll (PAY-03), assets (FA-08/FA-09), inventory (INV-07), petty-cash (EXP-08), payments (REV-13/REV-16), fx (FX-04), masterdata (MDM-03/MDM-01), budget (BUD-01). | Finance keeps only its OWN queues inline (EXP-06 AP disbursements, REV-21 AR cash applications, REV-23 netting). finance.service.ts 938→916 LOC; 13 dead cross-domain schema imports pruned; ctor untouched (writeflow's positional 3-arg construction unaffected — empty registry ⇒ inline-only, and writeflow never calls pendingApprovals). **A new maker-checker = an ApprovalQueueSource in its owning module; the size ratchet blocks new inline queries.** Golden 518 identical; writeflow 36 · refund-approval 9 · basics 414 · compliance 179 · worldclass 59; unit+coverage 464; ts-debt flat. |
| 2026-07-12 | `ledger` | docs/46 Phase 3: narrow ledger read API + import-boundary ratchet. New `ledger-read.service.ts` (`LedgerReadService`, exported by LedgerModule): `accountNet(accounts, {tenantId, asOf})` — Σ debit−credit over Posted entries; `cashPosition(tenantId)` — the CASH_ACCOUNTS classifier stays with the ledger; `entryRefNo(source, sourceRef)` — the read-side companion of `alreadyPosted`. Migrated verbatim-equivalent: treasury-pool `poolPosition` (was a raw `journal_lines⋈journal_entries` join), revenue's REVREC crash-recovery entry-no lookup, BI `line_daily_digest`'s cash position (removes BI's last journal-table + `CASH_ACCOUNTS` imports; `LedgerReadService` appended as bi-generate's END ctor param). | Guard: `tools/ci/check-import-boundaries.mjs` + `ledger-boundary-baseline.json` (build gate, 4th down-only ratchet) — files outside `modules/ledger` referencing `journalEntries`/`journalLines` grandfathered (23, was 26) and the set may only shrink; by-identifier detection catches both barrel and direct-path imports. Finance's REC-04 `reconcileControls` + consolidation eliminations stay grandfathered by design (an independent cross-check should read both sides). Golden 518 identical; treasury-pool 46 · revrec 34 · bi 44 · async-jobs 26 · line-crm 143 · basics 414; unit+coverage 464. |
| 2026-07-13 | `finance` | docs/46 Phase 4a: FinanceService decomposed per the docs/38 recipe — 4 cuts, each a facade-preserving verbatim move into a plain class constructed in the ctor BODY (writeflow builds the facade positionally with 3 args, so sub-services are never DI params). Cut 1 `finance-documents.service.ts` (statements of account + the multi-currency running-balance engine, AR billing-invoice + ใบสำคัญรับเงิน print/HTML/PDF/email). Cut 2 `finance-advances.service.ts` (EXP-07 + M4 project dimension + FU1 BoQ commitment consumption). Cut 3 `finance-ap.service.ts` (createApTxn incl. ภ.พ.36 reverse-charge self-assessment; EXP-06 request→approve/reject SoD; TAX-03 WHT on the pre-VAT base; Phase-16 3-way-match gate) — shared `vatSplit`/`vatLegFromCode` stay on the facade as callback ports. Cut 4 `finance-ar.service.ts` (syncArInvoices w/ docs/33 determination, createReceipt w/ FOR UPDATE + idempotency, REV-14 write-off). | Facade 916→**380 LOC**; keeps reads (pl/ap/ar/kpi/aging), the REC-04 reconcile pack (by design), the Phase-2 GOV-01 aggregator, `listWriteOffs` (journal-table read grandfathered by the boundary ratchet), the shared VAT helpers, and 24 thin delegators — public API byte-identical, ctor untouched. Off the service-size grandfather list (13→12). Gated per cut: writeflow 36 + basics 414; full battery on completion: golden 518 identical · compliance 179 · worldclass 59 · refund-approval 9 · unit+coverage 464; all four ratchets green. |
| 2026-07-13 | `crm-pipeline` | docs/46 Phase 4b: CrmPipelineService decomposed per the docs/38 recipe — 4 ctor-BODY cuts. Cut 1 `crm-pipeline-analytics.service.ts` (pipelineSummary/winLoss/funnel/sourceRoi/forecast — self-contained, zero ports). Cut 2 `crm-pipeline-legacy.service.ts` (the Batch 2A `/api/pipeline` adapter — already single-spine per CRM-1, so EXTRACTED rather than deleted; stage-machine primitives as ports, `StageRow` exported type-only). Cut 3 `crm-lead-engine.service.ts` (versioned scoring incl. LEAD_SCORE_VERSION/COEFFS re-exported; follow-up settings/round-robin — `nextRoundRobinOwner` public for createLead; REV-22 center + sweep; ports leadByNo/emitEvent). Cut 4 `crm-pipeline-comms.service.ts` (merge fields + dispatch + CRM-6 thread token; port oppByNo). | Facade 1,109→**545 LOC** (keeps stages master · leads + conversion · opportunities CRUD · REV-17 stage machine · activities · capture/import · delegators); ctor untouched; off the service-size grandfather list (12→11). Gated: pipeline 116 every cut; crm 56 · line-crm 143 · bi 44 · golden 518 identical · unit+coverage 472; all four ratchets green. |
