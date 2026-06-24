# Platform Customization & Extensibility — Process Narrative

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-27-PLAT |
| Process owner | `<<Platform Admin / Controller>>` |
| Approver | `<<CFO / Head of IT>>` |
| Version | **0.6 DRAFT · 2026-06-24** |
| Review cadence | Annual + on significant change |
| Related RCM controls | No new RCM control (operational/configuration features); reinforces ITGC-AC-03 (RLS), ITGC-AC-04 (secrets at rest), ITGC-AC-10 (audit trail), MDM-02 (master-data validation) |
| Related policy | `compliance/policies/` (Access Control; IPE; Change Management) |

## 2. Purpose

This is an **umbrella narrative** for the cross-cutting *platform-customization* capabilities that let a tenant adapt the ERP to its business **without code** — added incrementally as Platform Phases 1–12 (custom fields … object layouts), plus two consolidation capabilities (the notification inbox and the public REST API). It exists so an auditor or new administrator can see, in one place, **what is configurable, who may configure it, through which endpoint, and under which controls**, and then follow the link to the owning cycle narrative for detail. None of these features posts to the general ledger, and each is **tenant-isolated by Row-Level Security (RLS)** and gated by an explicit permission.

> **Design invariants** (verified by the `ext` control/integration harness for every feature): (a) **no GL impact** — configuration and operational features never post journal entries; (b) **tenant isolation** — every tenant-scoped table is RLS-scoped so one tenant can never read or write another's configuration; (c) **least privilege** — each surface is gated by a specific permission (`users`, `exec`, `masterdata`, or `dashboard`); (d) **documentation-as-done** — each feature updated its owning cycle narrative, the user manual, and UAT in the same change.

## 3. Scope

**In scope:** the fourteen platform-customization capabilities (§7). **Out of scope:** the financially-significant business cycles they extend (see the per-feature cross-references), and the global, code-governed **module on/off** feature flags (`module_configs`, a platform-wide switch — see `08-itgc.md` / user manual §11.3).

## 4. References

- ISO 9001:2015 cl. 4.4 (process approach), cl. 7.5 (documented information).
- `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx`; `compliance/policies/`.
- Permissions / SoD model: `packages/shared/src/permissions.ts`. Web navigation: `apps/web/src/lib/nav.ts`.
- Control/integration harness: `tools/cutover/src/ext.ts` (the cross-feature suite — 137 checks at time of writing).
- Per-feature owning narratives: `02` (workflows), `08` (audit viewer, webhooks), `17` (custom fields, alerts, bulk import), `23` (branding), `26` (scheduled reports, saved views, role dashboards).

## 5. Definitions & abbreviations

| Term | Meaning |
|---|---|
| UDF | User-defined (custom) field |
| RLS | Row-Level Security (PostgreSQL `tenant_isolation` policy) |
| Dry-run | Validation that reports all errors **without** writing to the database |
| HMAC | Hash-based message authentication code (SHA-256), for webhook payload signing |
| IPE | Information Produced by the Entity (a report relied upon in a control/decision) |
| Egress | Outbound delivery to an external system (webhooks) |

## 6. Roles & responsibilities (RACI)

| Activity | Tenant Admin (`users`) | Exec (`exec`) | MasterData Admin (`masterdata`) | Dashboard user (`dashboard`) | System |
|---|---|---|---|---|---|
| Define custom fields | C | C | **A/R** | I | I |
| Configure approval workflows | **A/R** | C | I | I | enforces SoD/SLA |
| Define alert rules | C | C | **A/R** | C | runs sweep |
| Schedule reports / saved views | I | **A/R** | I | C | runs sweep / delivers |
| Configure role dashboards | **A/R** | C | I | R (views own) | resolves + permission-filters |
| Review audit trail | **A/R** | I | I | I | append-only, RLS-scoped |
| Bulk-import master data | I | I | **A/R** | I | validates per-row |
| Register outbound webhooks | **A/R** | I | I | I | signs + delivers + retries |
| Brand the org (logo/tagline) | **A/R** | I | I | I | renders on receipts |
| Customize document templates | **A/R** | C | I | I | renders on documents (presentation only) |
| Define custom objects & records | C | C | **A/R** | I | reuses the custom-fields typed store |
| Design object form layouts | C | C | **A/R** | I | resolved against live field defs, per role |

## 7. Process narrative — the eleven capabilities

Each entry: **what it does · endpoint(s) · permission · storage/migration · controls · owning narrative.**

1. **Custom fields (UDFs) — Phase 1.** Tenant-defined typed fields on any entity (customer, item, order, …). `POST/GET /api/custom-fields/defs`, `PUT /api/custom-fields/values`, `POST /values/bulk`. Perm `masterdata`/`users`/`exec`. Tables `custom_field_defs` + `custom_field_values` (typed columns), migration `0078`; RLS-scoped. Server-side validation: `UNKNOWN_FIELD`, `REQUIRED_FIELD`, `BAD_OPTION`, `BAD_NUMBER`, `BAD_DATE`. Web `/custom-fields` + a reusable `<CustomFields>` panel. *Detail: `17-master-data-management.md` §7.9.*
2. **Configurable approval workflows — Phase 2.** No-code, multi-level approval definitions with **SLA + escalation + dimension routing** and maker-checker/SoD enforcement. `GET/POST/PUT /api/workflow/definitions`, `POST /api/workflow/run-escalations`; wired into PO approval. Perm `exec`/`users`/approvals. Additive columns migration `0079`. *Detail: `02-procure-to-pay.md` §7.3; user manual `10-approvals.md`.*
3. **Alert / notification rules engine — Phase 3.** No-code rules over a **built-in metric catalog** (`low_stock_count`, `approvals_overdue`, `open_pr_count`); a cron-callable sweep fires in-app notifications and optional LINE/SMS/email with a cooldown, logging each fire. `GET /api/alerts/metrics|preview|events`, `GET/POST/PATCH/DELETE /api/alerts/rules`, `POST /api/alerts/run`. Perm `masterdata`/`users`/`exec`/`dashboard`. Tables `alert_rules` + `alert_events`, migration `0080`. Errors `BAD_METRIC`/`BAD_OPERATOR`/`BAD_CHANNEL`/`NO_TARGET`. Web `/alerts`. *Detail: `17-master-data-management.md` §7.10.*
4. **Scheduled reports + saved views — Phase 4.** A cron-callable sweep generates due report subscriptions (kpi_board / sales_cube / finance_trend / pipeline_trend) and delivers them (in-app + email), recording each run; plus per-user/per-module saved list views (personal or shared). `POST /api/bi/subscriptions/run`, `/:id/run`, `GET /api/bi/runs|report-types`; `GET/POST/DELETE /api/saved-views`. Perm `exec` (reports), any list perm (views). Tables `report_runs` + `saved_views`, migration `0081`. Errors `BAD_REPORT_TYPE`/`BAD_FREQUENCY`/`VIEW_NOT_FOUND`. Web `/scheduled-reports`, `/saved-views`. *Detail: `26-reporting-bi-ai.md` §5a/§5b.*
5. **Role-based dashboards — Phase 5.** An admin configures, **per role**, which KPI widgets appear on the home dashboard, drawn from an 11-metric catalog; at view time each user gets their role's layout **filtered to the widgets their own permissions allow**, with live values. `GET /api/dashboard/widgets/catalog`, `GET/PUT /api/dashboard/layouts/:role`, `GET /api/dashboard/layout/me`. Perm `users`/`exec` (configure), `dashboard`/`exec` (view). Table `dashboard_layouts`, migration `0082`. Errors `BAD_ROLE`/`BAD_WIDGET`. Web `/dashboard-designer` + a permission-filtered "role KPIs" strip on `/dashboard`. *Detail: `26-reporting-bi-ai.md` §3a.*
6. **Audit-trail viewer — Phase 6.** A read-only, paginated, filterable view + CSV export over the append-only `audit_log` (the immutability trigger is untouched). `GET /api/admin/audit`, `GET /api/admin/audit/export`. Perm `users`. SELECT-only; **RLS-scoped** (a tenant admin sees only its tenant's events; HQ/Admin sees all). Query indexes migration `0083`. Web `/audit`. *Control: **ITGC-AC-10** (detective review of the tamper-evident trail). Detail: `08-itgc.md` §7.A.8.*
7. **Validated bulk import — Phase 7.** A **dry-run validate → preview → commit** flow over the existing master-data import (8 entities), accumulating per-row errors instead of failing fast, with an optional skip-errors partial commit. `POST /api/admin/master-data/:entity/import/validate` and `/import/checked`. Perm `masterdata`. No schema change. Errors `REQUIRED_EMPTY`/`BAD_NUMBER`/`BAD_DATE`/`DUP_IN_FILE`/`EXISTS`. Web `/master-data` preview. *Control: **MDM-02** (master-data validation). Detail: `17-master-data-management.md` §7.3a.*
8. **Outbound webhooks — Phase 8.** Tenants register endpoints and subscribe to business events (`po.approved`, `po.rejected`, `alert.fired`); a dispatcher delivers **HMAC-SHA256-signed** payloads (10s-bounded) with a capped retry, recording every attempt. `GET/POST/DELETE /api/platform/webhooks`, `GET /api/platform/webhooks/events|deliveries`, `POST /api/platform/webhooks/deliveries/:id/redeliver`, `POST /api/platform/webhooks/dispatch`. Perm `users`. Signing secret **AES-256-GCM encrypted at rest** (shown once). Additive migration `0084`; the `webhook_deliveries` egress log is tenant-scoped via its FK to the (RLS-scoped) `webhooks`. Web `/webhooks`. *Controls: **ITGC-AC-04** (secret at rest); reuses the inbound HMAC scheme. Detail: `08-itgc.md` §7.A.9.*
9. **Tenant branding — Phase 9.** A tenant admin sets a **logo + tagline** (and a `branding_prefs` blob) on the org profile; these are **genuinely rendered** on the customer-facing receipt header. `GET/PATCH /api/tenant/profile` (extended). Perm `users`. Additive `tenants` columns, migration `0086`; RLS self-scoped to the caller's own tenant. Logo accepted as an `https` URL or a small image data-URI (other schemes rejected; **attribute-encoded** on output). Web `/setup` Branding card. *Detail: `23-customer-onboarding-provisioning.md` §7.6a.*
10. **Notification inbox — Phase #2 (consolidation).** A **per-user** in-app inbox unifying the notifications already produced by the alert engine (#3), scheduled reports (#4), and workflow escalations — each row targets a `(tenant, role)` pair or is a tenant-wide broadcast (`target_role` NULL). **Any authenticated user** gets a personal inbox scoped server-side to their own tenant + role; read state is tracked **per user** (so one recipient marking-read never affects another). `GET /api/notifications/inbox` (paginated, unread-first; `unread_only` filter), `GET /api/notifications/unread-count`, `POST /api/notifications/:id/read`, `POST /api/notifications/mark-all-read`. No `@Permissions` gate (universal); the `notifications` table is **not** RLS-scoped, so every query filters by `target_tenant_id` explicitly. New table `notification_reads` (per-user read markers, unique `(notification_id, username)`), migration `0087`; mark-read is **guarded** so a user can only ever mark a notification actually visible to them. Web: a header **bell** (unread badge, 30s poll) + a full `/notifications` page. *Consumes the producers in #3/#4 and `20`/`02` workflow escalations; no new RCM control.*
11. **Public REST API (v1) — Phase #3.** A stable, versioned, **scope-limited read API** for third-party integrators, built on the existing API-key auth (a `Bearer ierp_…` key, issued at `/api/platform/api-keys`, verified by the global guard into an `apikey:<prefix>` machine principal carrying its granted scopes). `GET /api/v1` (discovery) + `GET /api/v1/openapi.json` are **open**; `GET /api/v1/me` identifies the key; `GET /api/v1/items` (`catalog:read`), `/inventory` (`inventory:read`), `/orders` (`orders:read`), `/invoices` (`invoices:read`) return a paginated `{data, pagination}` envelope. **API-key only** (human JWTs → `403 API_KEY_REQUIRED`); a dedicated `PublicApiGuard` enforces **scope** (`403 INSUFFICIENT_SCOPE`, legacy `read`/`write`/`*` aliases honoured) and a **per-key fixed-window rate limit** (`429 RATE_LIMITED`, env-tunable). Tenant isolation is the **same RLS** the rest of the app uses — the key's `tenant_id` scopes every row (the shared `items` catalog has no tenant_id and is returned in full). **No schema change** (pure surface over existing tables); curated OpenAPI 3.1 document. *Controls: scope-gating + rate-limiting are **preventive** access controls reinforcing ITGC-AC-07 (key issuance/auth); no new RCM control.*
12. **Document templates — Phase 10.** A no-code, **presentation-only** designer for customer-facing documents — the **receipt** is live; abbreviated/full tax invoices, quotations, POs and payslips are authorable now and rendered as their wiring lands. A tenant defines templates with header/body/footer/paper knobs (show logo, extra header note, show/hide branch·address·tax-id, accent colour, body font scale, thank-you text + extra footer lines, paper width); one per (tenant, doc_type) is the **default** consumed at render time. A template can **never change amounts** and can **never blank the document's core** (the seller name + the total always render, and mandatory tax-document fields are never omitted); it posts **nothing** to the GL. `GET /api/document-templates` (+ `/doc-types`, `/active?doc_type=`), `POST /api/document-templates`, `PUT /:id`, `POST /:id/default`, `DELETE /:id`, `POST /preview` (live sample render). Perm `users`/`exec`. Table `document_templates`, migration `0088`; RLS-scoped. The active receipt template is resolved inside the `printing` module via a shared pure renderer (`printing/receipt-render.ts`, used by both the live render and the preview). Web `/document-templates`. *Verified by the `ext` harness (catalog/create/default/active/preview/core-integrity/RLS/no-GL); extends Phase 9 branding.*
13. **Custom objects — Phase 11.** Tenant-defined record types ("custom apps") with no code: define an object, give it fields, capture records — without us shipping a module. An object's fields and typed values **reuse the Phase 1 custom-fields store** (entity = `object_key`), so the same validation (type/required/select-option) applies; records get their own registry (`custom_object_records`) so they can be enumerated and carry a display name. Pure metadata — **no GL**, RLS-scoped, audited. `GET/POST /api/custom-objects`, `GET/DELETE /api/custom-objects/:key`, `GET/POST /api/custom-objects/:key/records`, `GET/PUT/DELETE /api/custom-objects/:key/records/:id`; field defs are managed through the existing `/api/custom-fields` API. Perm `masterdata`/`users`/`exec`. Tables `custom_objects` + `custom_object_records`, migration `0089`; RLS-scoped. Web `/custom-objects`. *Verified by the `ext` harness (define/dup/fields/record CRUD/reused validation/RLS/no-GL).*
14. **Object layouts — Phase 12.** A no-code form/layout designer for a custom object (Phase 11): arrange fields into **sections**, set a 1- or 2-**column** layout, **reorder**, **hide** fields, and optionally target a **role** — stored as presentation-only config and **resolved against the object's live field defs** at render time, so a newly-added field always surfaces (appended) and stale references drop. The custom-object data-entry form renders by the resolved layout. `GET /api/object-layouts` (+ `/resolve?object_key=&role=`), `POST /api/object-layouts`, `PUT /:id`, `POST /:id/default`, `DELETE /:id`, `POST /preview`. Perm `masterdata`/`users`/`exec`. Table `object_layouts`, migration `0090`; RLS-scoped; **no GL**. Web `/object-layouts`. *Verified by the `ext` harness (built-in fallback/create/resolve/hide/auto-surface-new-field/preview/RLS/no-GL).*

## 8. Process flow

```mermaid
flowchart TD
    A[Tenant admin configures a platform feature] --> B{Permission gate users / exec / masterdata / dashboard}
    B -- No --> B1[403 Forbidden]
    B -- Yes --> C{Input valid? per-feature validation codes}
    C -- No --> C1[400 with code + message TH/EN]
    C -- Yes --> D[Write config — RLS-scoped to caller's tenant]
    D --> E{Operational sweep? alerts.run / subscriptions.run / webhooks.dispatch}
    E -- Yes --> F[Evaluate live data RLS-scoped, deliver, log; no GL]
    E -- No --> G[Config consumed at read/render time: dashboards, custom-field panels, branded receipts]
    D --> H[Every mutation captured in append-only audit_log ITGC-AC-10]
```

**Swimlane note.** The *Tenant Admin / MasterData Admin / Exec* lanes configure their respective surfaces under least-privilege permissions; the *system* enforces RLS isolation, per-feature input validation, and the append-only audit trail, and runs the cron-callable sweeps (alerts, scheduled reports, webhook dispatch) that operate on **live, tenant-scoped** data without posting to the GL.

## 9. Control matrix

| Capability | Risk | Control | Type | RCM ID | Evidence |
|---|---|---|---|---|---|
| All | Cross-tenant config read/write | RLS tenant isolation on every config table; self-scoped tenant edits | Preventive | ITGC-AC-03 | `ext` isolation checks; RLS policies |
| All | Unauthorized configuration | Permission gate (`users`/`exec`/`masterdata`/`dashboard`) | Preventive | ITGC-AC-02 | 403 checks in `ext` |
| Audit viewer | Undetected/tampered change record | Append-only `audit_log` (trigger) + detective read/export | Detective | ITGC-AC-10 | `compliance.ts`, `ext` |
| Webhooks | Forged/replayed egress; secret disclosure | HMAC-SHA256 signed payload + timestamp; secret AES-256-GCM at rest | Preventive | ITGC-AC-04 | `ext` webhook checks |
| Bulk import | Bad master data loaded silently | Dry-run + per-row validation; block-or-skip commit | Preventive | MDM-02 | `ext` bulk-import checks |
| Role dashboards | KPI leakage to under-privileged role | Resolved layout filtered to the viewer's permissions | Preventive | ITGC-AC-02 | `ext` dashboard checks |
| Public API | Over-broad machine access; key abuse | API-key-only surface + per-endpoint **scope** gate (`INSUFFICIENT_SCOPE`); per-key **rate limit** (`RATE_LIMITED`); RLS scopes every row to the key's tenant | Preventive | ITGC-AC-07 | `ext` public-API checks (scope-deny, isolation, 429) |
| Document templates | Tampered/blanked customer document; amount or mandatory-field manipulation | Presentation-only config (carries no amounts); core fields (seller, total) always render; mandatory tax-document fields never omitted; no GL post | Preventive | (operational) | `ext` doc-template checks (core integrity + no-GL) |
| Custom objects | Cross-tenant record read/write; untyped/invalid data | RLS on objects + records; field values validated via the reused custom-fields machinery (type/required/option); no GL post | Preventive | (operational) | `ext` custom-object checks |
| Object layouts | A field silently dropped from a form; cross-tenant config | Presentation-only config resolved against live field defs (new fields auto-surface, none silently lost); RLS on layouts; no GL post | Preventive | (operational) | `ext` object-layout checks |

## 10. Inputs & outputs

**Inputs:** admin configuration (field definitions, workflow/alert rules, report subscriptions, dashboard layouts, webhook endpoints, branding); the caller's JWT (tenant + permissions). **Outputs:** stored, RLS-scoped configuration; operational side-effects with **no GL impact** — in-app notifications (surfaced in a per-user inbox with per-user read state in `notification_reads`), emailed reports + a `report_runs` log, signed webhook deliveries + a `webhook_deliveries` log, branded receipts; and an append-only `audit_log` entry per mutation.

## 11. Records & retention

| Record | Retention |
|---|---|
| Configuration tables (fields, rules, layouts, subscriptions, webhooks, branding) | `<<retention per policy>>` |
| Operational logs (`alert_events`, `report_runs`, `webhook_deliveries`) | `<<retention per policy>>` |
| `audit_log` (append-only) | `<<7 years / per ITGC-AC-10>>` |

## 12. KPIs / metrics

- Configuration-validation rejection rate (data-quality signal across features).
- Alert/report/webhook delivery success vs failure (operational health).
- Webhook retry exhaustion count; audit-viewer usage in UARs.

## 13. Exception & error handling

Per-feature validation codes are consolidated here (all `400` unless noted): UDFs — `UNKNOWN_FIELD`/`REQUIRED_FIELD`/`BAD_OPTION`/`BAD_NUMBER`/`BAD_DATE`; alerts — `BAD_METRIC`/`BAD_OPERATOR`/`BAD_CHANNEL`/`NO_TARGET`; scheduled reports/views — `BAD_REPORT_TYPE`/`BAD_FREQUENCY`/`VIEW_NOT_FOUND` (404); dashboards — `BAD_ROLE`/`BAD_WIDGET`; bulk import — `REQUIRED_EMPTY`/`BAD_NUMBER`/`BAD_DATE`/`DUP_IN_FILE`/`EXISTS`; webhooks — `WEBHOOK_NOT_FOUND` (404)/`DELIVERY_NOT_FOUND` (404); branding — invalid `logo_url` rejected; document templates — `BAD_DOC_TYPE`/`NAME_REQUIRED`/`NAME_EXISTS`/`TEMPLATE_NOT_FOUND` (404); custom objects — `BAD_OBJECT`/`BAD_LABEL`/`OBJECT_EXISTS`/`OBJECT_NOT_FOUND` (404)/`RECORD_NOT_FOUND` (404) (record field values reuse the custom-fields codes); object layouts — `BAD_OBJECT`/`NAME_REQUIRED`/`NAME_EXISTS`/`LAYOUT_NOT_FOUND` (404); public API — `API_KEY_REQUIRED` (`403`, human JWT on `/api/v1`), `INSUFFICIENT_SCOPE` (`403`, missing scope), `RATE_LIMITED` (`429`, per-key window exceeded). Unauthorized access → `403` (missing key → `401`); cross-tenant access is silently RLS-filtered (no leak).

## 14. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-24 | Platform | Initial umbrella narrative consolidating Platform Phases 1–9 (custom fields, approval workflows, alert rules, scheduled reports + saved views, role dashboards, audit viewer, validated bulk import, outbound webhooks, tenant branding). Cross-references the owning cycle narratives; no new RCM control. |
| 0.2 DRAFT | 2026-06-24 | Platform | Added capability #10 — the **notification inbox** (per-user read state over the existing `notifications` table; new `notification_reads`, migration `0087`; bell + `/notifications` page). Unifies the notifications produced by #3/#4 and workflow escalations; no new RCM control. |
| 0.3 DRAFT | 2026-06-24 | Platform | Added capability #11 — the **public REST API (v1)** (`/api/v1` items/inventory/orders/invoices, API-key-only, scope-gated, per-key rate-limited, OpenAPI 3.1 doc). No schema change; scope + rate limiting are preventive access controls reinforcing ITGC-AC-07; no new RCM control. |
| 0.4 DRAFT | 2026-06-24 | Platform | Added **Platform Phase 10 — document templates**: no-code, presentation-only customization of customer-facing documents (receipt live; other doc types authorable, rendered as wiring lands). Template carries no amounts, never blanks the core / omits mandatory fields, posts nothing to the GL; RLS-scoped (migration `0088`). New §7.12, RACI + control-matrix rows, error codes; `ext` harness +11 checks. No new RCM control (operational). |
| 0.5 DRAFT | 2026-06-24 | Platform | Added **Platform Phase 11 — custom objects**: tenant-defined record types reusing the Phase 1 custom-fields typed store (entity = object_key); records get a registry with a display name. No GL, RLS-scoped (migration `0089`). New §7.13, RACI + control-matrix rows, error codes; `ext` harness +13 checks. No new RCM control (operational). |
| 0.6 DRAFT | 2026-06-24 | Platform | Added **Platform Phase 12 — object layouts**: no-code form/layout designer for custom objects (sections/columns/order/hide, per role) resolved against live field defs so new fields auto-surface. No GL, RLS-scoped (migration `0090`). New §7.14, RACI + control-matrix rows, error codes; `ext` harness +9 checks. No new RCM control (operational). |
