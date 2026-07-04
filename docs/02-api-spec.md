# 02 — V2 API / Endpoint Specification

**Style:** REST, JSON. คง path `/api/*` เดิมทั้งหมด (mobile app เดิมพึ่งพา) + เพิ่ม write endpoints ที่เดิม Streamlit ทำในตัว
**Validation:** Zod DTO ทุก endpoint (schema เดียวกับ AI tool input)
**Auth:** `Authorization: Bearer <JWT>` ; JWT claims `{ sub, role, customerName, permissions[] }`
**RBAC:** `@Roles()` / `@Permissions()` guard ; **TenantInterceptor** บังคับ scope ทุก resource ที่มี `tenant_id`
**ทุก endpoint ต้อง auth** (แก้ช่องโหว่เดิมที่ data endpoints เปิดโล่ง) — ยกเว้น `POST /api/login`, `GET /`, `GET /api/config`

---

## Conventions

**Error envelope** (สม่ำเสมอทุก endpoint):
```json
{ "error": { "code": "NOT_FOUND", "message": "...", "messageTh": "ไม่พบรายการ" } }
```
HTTP: 400 validation, 401 no/expired token, 403 RBAC/tenant, 404 not found, 409 conflict, 500.

**Pagination:** `?limit=20&offset=0` → response `{ data: [...], count, total? }`
**Filtering:** query params ตาม resource (status, search, dateFrom/dateTo)
**Money:** `numeric(14,2)` คืนเป็น number; แสดง ฿ ที่ frontend
**Dates:** ISO-8601 (`timestamptz`); ภายในเป็น Asia/Bangkok

---

## Auth & System

| Method | Path | Body/Query | Response | หมายเหตุ |
|---|---|---|---|---|
| POST | `/api/login` | `{username, password}` | `{token, username, role, customer_name}` | argon2 verify (fallback sha256→rehash); error ไทย; JWT 30d |
| GET | `/api/auth/me` | — | `{username, role, customer_name, permissions}` | |
| GET | `/` | — | `{status, app, version}` | health (Railway) |
| GET | `/api/config` | — | `{company_name, company_subtitle, theme_primary, theme_secondary, contact_tel, contact_email}` | |

---

## Read API (คง path เดิม — Phase 2)

### Dashboard / Reports
| Method | Path | Query | คืน |
|---|---|---|---|
| GET | `/api/dashboard` | — | today/month sales, low_stock_count, outstanding_ap, top_items_today, recent_orders |
| GET | `/api/dashboard/sales-trend` | `days=7` | `{days, trend:[{date,sales,orders}]}` |
| GET | `/api/reports/daily-sales` | `date?` | `{date, rows, count}` (LEFT JOIN lines) |
| GET | `/api/reports/stock-summary` | — | latest snapshot items |

### POS / Sales (read)
| GET | `/api/pos/summary` | `start_date,end_date` | summary + avg_order_value + top_items + by_payment |
| GET | `/api/pos/orders` | `limit,offset,status?` | `{orders, count}` |
| GET | `/api/pos/orders/{sale_no}` | — | `{order, items}` (ทุกคอลัมน์) |
| GET | `/api/pos/sessions` | — | `{sessions}` (derived Status='Open') |
| GET | `/api/customers/{name}` | — | `{customer_name, orders, stats, ar_balance}` |

### Inventory (read)
| GET | `/api/inventory/stock` | `search?,low_only,limit` | `{snapshot_date, items, total, low_stock_count}` |
| GET | `/api/inventory/stock/{item_id}` | — | `{item, snapshot_date, recent_sales, recent_pos, sales_30d}` |
| GET | `/api/inventory/suppliers` `/{id}` | — | list / `{supplier, recent_pos, ap_balance, lifetime}` |
| GET | `/api/inventory/purchase-orders` `/{po_no}` | `limit,offset,status?` | list / `{po, items}` |

### Finance (read)
| GET | `/api/finance/pl` | `month,year` | revenue/discounts/tax/net/gross_profit (คง Dec boundary หรือแก้+บันทึก) |
| GET | `/api/finance/ap` | `status=Outstanding,limit,offset` | `{transactions, count, total_outstanding}` |
| GET | `/api/finance/ar` | `limit,offset` | `{invoices, count, total_outstanding}` |
| GET | `/api/finance/kpi` | — | mtd/ytd revenue+orders, ap/ar outstanding |

### Notifications & Analytics
| GET | `/api/notifications` | — | `{alerts:[{type,severity,title,subtitle,ref_id,data?}], counts}` — **ไทย** titles, ฿ format |
| GET | `/api/analytics/replenishment` `/{item_id}` | `limit=50` | list `{items,count,critical,warning}` / `{...pred, insight}` |
| GET | `/api/analytics/anomalies` | `days=30` | `get_anomaly_summary` shape |
| POST | `/api/analytics/insight` | `{type, data}` | `{insight}` |
| GET | `/api/analytics/dashboard-summary` | — | `{replenishment, anomalies, insight}` |

### Global search (⌘K spotlight)
| Method | Path | Query | คืน |
|---|---|---|---|
| GET | `/api/search` | `q` (≥2 chars) | `{results:[{type, id, label, sublabel?, href}], count}` — read-only omni-search over 7 record types: `customer`/`vendor`/`item` masters + `sale`/`ar_invoice`/`tax_invoice`/`purchase_order` documents. RLS tenant-scoped; **each result type is gated in-service by the caller's expanded permissions** (customer→`crm\|exec\|ar`, vendor→`procurement\|warehouse\|creditors\|exec`, item→`warehouse\|dashboard\|planner`, sale→`pos\|order_mgt\|dashboard`, ar_invoice→`ar\|exec`, tax_invoice→`ar\|pos\|cust_pos`, purchase_order→`procurement\|warehouse\|dashboard`), so it never widens access. Deep-links: item→`/inventory/{id}` detail; documents→their list carrying `?q={id}` so the list pre-filters to the record. ≤6 per type. `q<2` ⇒ empty. |

### AI Chat
| POST | `/api/chat` | `{message, history?, agent_type?}` | `{reply, history}` หรือ **SSE stream** — V2 ต่อ tools จริง (เดิมต่อไม่ได้) |

---

## Write API (ใหม่ — Phase 3) — RESTful ตาม resource

> เดิม Streamlit เขียน DB ตรง ๆ; V2 ยกเป็น endpoint มี validation + RBAC + workflow state machine + DocNumberService

### POS / Orders
```
POST   /api/pos/orders                 สร้าง sales order (cart lines) → SO-; loyalty earn; credit check
PATCH  /api/orders/{order_no}/status   เปลี่ยนสถานะ (Pending→…→Cancelled); est_delivery rule
DELETE /api/orders/{order_no}          (admin) ลบทั้ง order
POST   /api/orders/{order_no}/export   {format: pdf|express_txt|csv} เอกสารไทย
# Claims
POST   /api/orders/{order_no}/claims          customer แจ้งเคลม (item-level + รูปบังคับ)
PATCH  /api/claims/{id}                        admin Approve/Reject(+reason)
POST   /api/orders/{order_no}/receive          รับครบ → Completed
# Customer POS (portal)
POST   /api/portal/pos/sales           SALE-; VAT 7%; ตัด customer_inventory; loyalty
```

### Procurement (PR → PO → GR)
```
POST   /api/procurement/prs                    PR (planner) → PR-
PATCH  /api/procurement/prs/{pr_no}/approve    (admin)
POST   /api/procurement/pos                     สร้าง PO → PO-
POST   /api/procurement/pos/from-prs            แปลง PR→PO (+ blanket deliveries)
PATCH  /api/procurement/pos/{po_no}/approve     (admin) approve/reject
PATCH  /api/procurement/pos/{po_no}/cancel      (เหตุผลบังคับ; gate ถ้ามี GR)
POST   /api/procurement/grs                      GR → GR-; +Received_Qty; lot ledger; auto-close PO
POST   /api/procurement/gr-claims                GRC-; supplier claim
PATCH  /api/procurement/gr-claims/{no}/resolve   supplier action
POST   /api/suppliers                            (admin direct) / request→approve flow
PATCH  /api/suppliers/{id}
```

### Warehouse / Inventory
```
POST   /api/inventory/movements        Issue/Transfer → MI-/TRF- (audit log, ไม่ตัด snapshot)
POST   /api/inventory/stocktakes       ST- (Draft); save ทุกแถว
POST   /api/inventory/scan-sessions    SCAN- (Open)
POST   /api/inventory/scan-sessions/{no}/lines   เพิ่ม scan line
POST   /api/inventory/scan-sessions/{no}/commit  close → stock movements
POST   /api/inventory/adjust           ADJ- (AI/admin) stock adjustment
# Lots / Locations
POST   /api/inventory/locations                 add location
POST   /api/inventory/transfers                 TRF- + update lot Location_ID
GET    /api/inventory/lots ; /lots/{no}         ledger + trace (FEFO/FIFO)
# Master data (เดิม CSV → ตาราง items)
GET/POST/PATCH/DELETE /api/inventory/items      master CRUD; upsert by item_id
POST   /api/inventory/items/import              Excel/CSV (Replace|Append)
POST   /api/inventory/snapshots/import          ingest stock snapshot (แทน Init_Historical_DB)
# Images → object storage
POST   /api/inventory/items/{id}/image
DELETE /api/inventory/items/{id}/image
```

### Finance (AR / AP)
```
POST   /api/finance/ar/sync            generate invoices (เดิม _sync on load) INV-{order_no}
POST   /api/finance/ar/receipts        RCP-; update Paid_Amount/Status
POST   /api/finance/creditors          creditor CRUD
POST   /api/finance/ap/transactions    AP-; Invoice/Payment
PATCH  /api/finance/ap/transactions/{no}/pay
GET    /api/finance/ar/aging ; /ap/aging   aging buckets (Not Due/1-30/31-60/61-90/>90)
```

### Sales Ops
```
POST   /api/delivery-orders            DO-; POD upload; ไม่ตัด stock
PATCH  /api/delivery-orders/{no}/status  + POD image (Delivered stamps time)
POST   /api/returns                     RTN-; Return_To_Stock → movement
POST   /api/price-list                  effective price rule; "All Customers"=''
POST   /api/promotions                  6 types; Item_IDs
PATCH  /api/promotions/{id}/toggle
```

### BOM
```
GET/POST/PATCH/DELETE /api/bom/master           BOM กลาง + lines (costing)
POST   /api/bom/master/push                     push to customers (idempotent)
GET    /api/bom/submissions                     queue
PATCH  /api/bom/submissions/{id}/approve        → master
# Portal BOM
GET/POST /api/portal/bom                         tenant BOM (dual-write submissions)
POST   /api/portal/bom/{code}/production-runs    PRD-; consume/produce inventory
POST   /api/portal/variance                      EOD count → overwrite stock
```

### Portal — Inventory / Pending / Mini-ERP
```
GET/POST/PATCH /api/portal/inventory             customer_inventory + reorder rules
POST   /api/portal/pending-orders                Draft auto-reorder
PATCH  /api/portal/pending-orders/{no}/submit    → order_cart
GET/POST/DELETE /api/portal/my/customers         (Owner_Customer)
GET/POST/DELETE /api/portal/my/suppliers
POST   /api/portal/my/purchase-orders            MPO-
GET/POST/DELETE /api/portal/my/users             sub-account (permission bundles)
```

### Marketing / Loyalty / Survey
```
POST   /api/marketing/campaigns ; PATCH /{id}/toggle      Popup/Ticker/Banner; image
POST   /api/marketing/campaigns/{id}/target               targeted push
GET    /api/marketing/segments                            RFM segmentation
POST   /api/marketing/ab-tests                            A/B (2 variants)
POST   /api/marketing/abandoned-carts/remind
PUT    /api/loyalty/config                                singleton config
POST   /api/loyalty/redeem                                Min_Redeem; sets discount
GET    /api/loyalty/me                                    customer balance/txn
POST   /api/surveys ; POST /api/surveys/{id}/responses    NPS/CSAT
GET    /api/campaigns/active                              popup/ticker สำหรับ portal load
```

### Admin (Users / RBAC)
```
GET/POST/PATCH/DELETE /api/admin/users           (admin delete-protected)
PUT    /api/admin/users/{username}/permissions   per-user override (empty=inherit)
GET/PUT /api/admin/roles/{role}/permissions      role defaults (Admin full hardcoded)
GET    /api/customers/{name}                     internal CRM detail (orders/stats/ar_balance)
```

---

## Public API (v1) — external integrators (Platform #3)

A **stable, versioned, read-only** surface for third parties. **API-key auth only** —
`Authorization: Bearer ierp_…` (issued at `POST /api/platform/api-keys`); a human JWT is
rejected with `403 API_KEY_REQUIRED`. Each endpoint declares a required **scope**; the key's
granted scopes (`catalog:read`, `inventory:read`, `orders:read`, `invoices:read`, or the
aliases `read`/`write`/`*`) are checked by the `PublicApiGuard` (`403 INSUFFICIENT_SCOPE`).
Calls are **per-key rate-limited** (`429 RATE_LIMITED`, fixed window, env-tunable
`PUBLIC_API_RATE_MAX`/`PUBLIC_API_RATE_WINDOW_MS`). Every row is **RLS-scoped to the key's
tenant** (the shared `items` catalog has no `tenant_id` and is returned in full). Responses use
the `{ data: [...], pagination: { limit, offset, count } }` envelope; `?limit` (≤200) / `?offset`.

| Method | Path | Scope | Response | หมายเหตุ |
|---|---|---|---|---|
| GET | `/api/v1` | — (open) | `{name, version, documentation, endpoints}` | discovery, no key |
| GET | `/api/v1/openapi.json` | — (open) | OpenAPI 3.1 document | the published contract |
| GET | `/api/v1/me` | valid key | `{principal, tenant_id, scopes, version}` | identify the key |
| GET | `/api/v1/items` | `catalog:read` | `{data:[{item_id, description, uom, unit_price, category}], pagination}` | `?q`, `?category` |
| GET | `/api/v1/inventory` | `inventory:read` | `{data:[{item_id, current_stock, reorder_point, reorder_qty, …}], pagination}` | tenant-scoped |
| GET | `/api/v1/orders` | `orders:read` | `{data:[{order_no, order_date, status, currency, …}], pagination}` | `?status` |
| GET | `/api/v1/invoices` | `invoices:read` | `{data:[{invoice_no, amount, paid_amount, outstanding, status, …}], pagination}` | `?status`; `outstanding = amount − paid` |

---

## Enterprise identity — SSO + SCIM (Platform #4)

Per-tenant OIDC single sign-on and SCIM 2.0 provisioning. Tenant admins configure their IdP; users
log in via SSO; the IdP provisions/deprovisions users automatically. Secrets are write-only (OIDC
client secret **AES-256-GCM at rest**; SCIM bearer stored as a `sha256` hash, shown once).

**Tenant config** (perm `users`):

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/platform/identity` | — | sanitized config (`has_client_secret`/`has_scim_token` flags; **never** the secrets) |
| PUT | `/api/platform/identity` | `{sso_enabled, oidc_issuer, oidc_client_id, oidc_client_secret?, oidc_redirect_uri, default_role, scim_enabled}` | sanitized config |
| POST | `/api/platform/identity/scim-token` | — | `{token: "scim_…", prefix}` — **shown once** |

**SSO login** (`@Public`):

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/api/auth/sso/authorize` | `tenant=CODE` | `{authorization_url, state}` → redirect the browser to the IdP (`503 SSO_NOT_CONFIGURED` if off) |
| POST | `/api/auth/sso/callback` | body `{state, code? \| id_token?}` | `{token, username, role}` — verifies the `id_token` (sig/iss/aud/exp), **JIT-provisions** the user by `sso_subject`, mints the standard session JWT. **POST body** (not query) so the token never lands in a URL/log |

`id_token` is verified HS256 against the client secret (RS256/JWKS is a documented follow-on). A
JIT user gets the tenant's `default_role`; repeat logins reuse the same user. Errors:
`BAD_ID_TOKEN`/`BAD_ISSUER`/`BAD_AUDIENCE`/`TOKEN_EXPIRED`/`USER_DEACTIVATED` (`401`).

**SCIM 2.0** (`/scim/v2`, auth: `Authorization: Bearer scim_…` per-tenant token; `401 SCIM_UNAUTHORIZED`):

| Method | Path | Notes |
|---|---|---|
| GET | `/scim/v2/ServiceProviderConfig` | capabilities (patch + filter supported) |
| GET | `/scim/v2/Users?filter=userName eq "x"` | SCIM `ListResponse` (1-based `startIndex`/`count`) |
| GET/POST/PUT/PATCH/DELETE | `/scim/v2/Users[/:id]` | create/replace/patch/deprovision a user |

Create & role-change run through `AdminUsersService` → **same SoD checks** as the admin UI
(`USER_EXISTS` → `409`). **Deprovisioning** (`DELETE`, or `PATCH active=false`) **deactivates**
(`users.is_active=false`) — it never deletes the row; a deactivated account cannot authenticate
(password **or** SSO → `401 USER_DEACTIVATED`).

---

## หมายเหตุการ map สำคัญ

- **`/api/chat`** เดิมเป็น LLM passthrough (ดึง DB ไม่ได้) — V2 ต่อ AgentService ให้เรียก tools จริง ⇒ behavior ดีขึ้น (ระบุใน release note ว่าเป็น improvement ตั้งใจ)
- **Page-only totals** (`/api/finance/ap|ar` รวมเฉพาะหน้า) — คงพฤติกรรมหรือเพิ่ม `grandTotal` แยก field (อย่าเปลี่ยนความหมาย field เดิมเงียบ ๆ)
- **Supplier match by name OR id** (`/api/inventory/suppliers/{id}` drill-down) — คงตรรกะจน schema consolidate supplier/creditor เสร็จ
- **เลขเอกสารทุกชนิด** ออกผ่าน `DocNumberService` (sequence) แต่ string ที่คืนต้องตรงรูปแบบเดิม (ดู [docs/03](03-database-schema.md) §doc-numbering)
