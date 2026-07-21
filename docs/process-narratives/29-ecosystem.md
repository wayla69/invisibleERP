# Ecosystem & Extensibility — Process Narrative

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-29-ECO |
| Process owner | `<<Platform Admin / Partnerships>>` |
| Approver | `<<CFO / Head of IT>>` |
| Version | **0.4 DRAFT · 2026-07-21** |
| Review cadence | Annual + on significant change |
| Related RCM controls | Reinforces ITGC-AC-07 (API-key issuance/auth). No new RCM control. |
| Related narratives | `27-platform-customization.md` (public API #11, webhooks #8), roadmap `13-pillars-cde-architecture-spec.md` §4 |

## 2. Purpose

The **ecosystem & extensibility** pillar (roadmap Pillar D) makes the ERP integrable and marketplace-ready: a
mature **public API + developer portal** and an inbound **connector framework** (this version), and — planned
— an **app marketplace** (D3, deferred per the roadmap). Built on the shipped public API v1, API keys,
and outbound webhooks. **RLS-scoped**; posts **nothing to the GL**.

## 3. Scope

**In scope (delivered):** **API maturity / developer portal (D1, Phase 23)** + **connector framework (D2,
Phase 24)**. **Planned (see roadmap `13` §4):** D3 marketplace **deferred** to year 2.

## 4. Process narrative — capabilities

1. **API maturity / developer portal — Phase 23 (D1).** Matures the shipped public API v1 into an
   integrator-ready surface: a self-serve **developer portal** that lists the tenant's API keys with a settable
   **rate tier** (free / standard / partner), the **scope** catalog, the **endpoint** catalog, and a link to the
   **OpenAPI 3.1** document. Reuses the existing API-key auth + `PublicApiGuard` (scope-gate + per-key rate
   limit); adds a `tier` column to `api_keys` (migration `0096`). `GET /api/developer/portal`,
   `PUT /api/developer/keys/:id/tier` (perm `users`). Keys are **RLS-scoped** to the tenant. Web `/developer`.
   *Verified by the `ext` harness (portal catalog / set-tier / bad-tier / RLS). Per-request usage-analytics
   logging + a public sandbox host are noted follow-ups.*
2. **Connector framework — Phase 24 (D2).** A first-class **inbound** integration framework (the app already
   has outbound webhooks): register a **connector** (LINE / Shopee / bank-statement CSV) and **sync** it. A
   **stub transport** produces a deterministic canonical batch — CI-safe; real adapters swap in OAuth + REST
   behind the same provider shape — deduped **idempotently** via an `external_id_map`, with every run logged.
   Pulled records are surfaced **for review**; the framework **never auto-posts** to AR/AP/GL. Bank-CSV parses
   statement lines (idempotent by content hash). `GET /api/connectors/catalog`, `GET/POST /api/connectors`,
   `POST /api/connectors/:id/sync`, `GET /api/connectors/:id/syncs` (perm `users`/`exec`). Tables `connectors` +
   `connector_syncs` + `external_id_map` (migration `0097`); RLS-scoped — idempotency is **per tenant**. Web
   `/connectors`. *Verified by the `ext` harness (catalog / register / sync / idempotent-resync / bank-CSV /
   per-tenant-RLS). Live OAuth per platform is a noted follow-up.*
3. **Analytics read feeds — public API v1 (Marketing Intelligence integration).** Two new API-key,
   scope-gated read endpoints on the public surface (`@Controller('api/v1')`) that let an external analytics
   client pull the ERP's own sales + customer data by API (never a shared DB). New scope **`analytics:read`**
   (added to the developer-portal scope catalog + OpenAPI). **`GET /api/v1/sales/daily?from=&to=&group_by=`** —
   per-business-day revenue aggregated from POS sales (Voided excluded; `group_by=product` breaks it down; the
   MMM target variable; there is **no** native marketing-channel dimension on ERP sales — channel attribution
   is the integrator's own). **`GET /api/v1/customers/transactions?from=&to=`** — per-customer purchase facts
   (`customer_no`, `order_count`, `total_spend`, `first/last_order_date`) at the loyalty-profile grain
   (`customer_profiles ⋈ pos_members`), the Recency/Frequency/Monetary base. Both are **RLS tenant-scoped** to
   the calling key and **per-key rate-limited**, reusing the existing `PublicApiGuard`. This serves the
   separate **Marketing Intelligence Platform** (a Python data-science app — advanced MMM / sentiment-weighted
   RFM / TOWS — that reads ERP data over this API into its own warehouse; ERP posts **nothing** and stores
   nothing new). *Verified by the `ext` harness (+8: scope-required `403 INSUFFICIENT_SCOPE`, per-day revenue
   with Voided excluded, RFM base facts, and HQ↔cf2 tenant isolation on both feeds). Read-only pull; the
   result **push-back** is §4.4.*
4. **Analytics push-back + `/marketing-intel` (Marketing Intelligence results in the ERP).** The reverse
   direction of §4.3: the Marketing Intelligence Platform computes advanced MMM / sentiment-weighted RFM /
   TOWS in its own warehouse and **pushes the results back into the ERP** so the ERP **owns** what it
   displays (no cross-database join; the page works even when the external app is offline). New scope
   **`analytics:write`** + one endpoint **`POST /api/v1/analytics/snapshots`** (`@Scopes('analytics:write')`,
   body `{ snapshots: [{ kind: mmm\|rfm\|tows, payload, model_run_ref?, members? }] }`) — an **append** into the
   tenant-scoped `mi_analytics_snapshots` (migration `0460`, canonical org-RLS loop + leading
   `(tenant_id, kind, pushed_at)` index). The store is **append-only**: the read takes the latest per kind and
   a **run-history / period-comparison** view is exposed (`GET /api/marketing-intel/mmm-history`). A new
   bounded-context module `modules/marketing-intel` owns the table (the public-API controller delegates the
   write; the internal reads `GET /api/marketing-intel/{summary,mmm-history,segments}` are JWT +
   `marketing`/`exec`-gated). The **`/marketing-intel`** web page (a marketing/exec nav entry) renders the
   stored MMM channel-ROI + the MMM run trend, RFM segments and TOWS from the ERP's own store, with a
   "not yet pushed" empty state.
   **RFM → campaign action loop:** an `rfm` push MAY carry per-customer assignments
   (`members: [{ customer_no, segment }]`) which land on **`customer_profiles.mi_rfm_segment`** — a column
   **separate** from the ERP's own `rfm_segment` (owned by `CrmService.refreshProfile`) so the two RFM engines
   never clobber each other. A new campaign audience **`mi_segment`** resolves against that column, so the
   platform's sentiment-weighted segmentation drives the **existing consent-gated campaign delivery**;
   `POST /api/marketing-intel/segments/activate` turns a segment into a **draft** campaign (a human edits +
   sends — never an auto-blast; `EMPTY_SEGMENT` if no members). Read model only — **no GL posting**. The
   `analytics:write` scope is also selectable in the Settings → API-keys minting UI. *Verified by the `ext`
   harness (+12: `analytics:write` required — a catalog **and** an `analytics:read` key are both `403`;
   MMM/RFM/TOWS push `200`; tenant-scoped storage; append-only history + the trend read; `mi_rfm_segment`
   set without clobbering `rfm_segment`; per-segment counts; activate → a draft `mi_segment` campaign;
   empty-segment `400`).*

## 5. Control matrix

| Capability | Risk | Control | Type | RCM ID | Evidence |
|---|---|---|---|---|---|
| API maturity / portal | Over-broad or mis-tiered machine access | Keys + tiers RLS-scoped to the tenant; tier from an allowlist; reuses the v1 scope-gate + per-key rate limit | Preventive | ITGC-AC-07 | `ext` developer checks (portal, set-tier, bad-tier, RLS) |
| Connector framework | Cross-tenant data bleed; duplicate imports; premature posting | Stub-default transport (CI-safe); idempotent dedupe via `external_id_map` (per-tenant RLS); imported records staged for review, never auto-posted; live creds would be encrypted at rest | Preventive | (operational) | `ext` connector checks (idempotent resync, per-tenant RLS) |
| Analytics read feeds (`/api/v1/sales/daily`, `/customers/transactions`) | Over-broad machine access to sales/customer data; cross-tenant leak | Dedicated `analytics:read` scope (least privilege — not covered by catalog/orders/invoices scopes); RLS tenant-scoped to the calling key; per-key rate-limited; read-only (no write-back this phase); within-tenant egress only (a tenant's own key reads its own data) | Preventive | ITGC-AC-07 | `ext` analytics checks (scope-required 403, per-day revenue, RFM base facts, HQ↔cf2 isolation on both feeds) |
| Analytics push-back (`POST /api/v1/analytics/snapshots`, `/marketing-intel`) | A machine key with only read access mutating ERP state; cross-tenant write/leak of pushed results; a runaway push ballooning a row; the platform's RFM clobbering the ERP's own segmentation; an accidental mass send | Dedicated `analytics:write` scope — the `read` alias does **not** satisfy `:write`, so a read key is `403`; the write carries the key's own `tenant_id` (RLS `WITH CHECK`); bounded snapshot + members set; a read model only (no GL); the platform's RFM lands on a **separate** `mi_rfm_segment` column (the ERP's `rfm_segment` is untouched); activating a segment creates a **draft** campaign only (reuses the existing consent-gated delivery — a human sends) | Preventive | ITGC-AC-07 | `ext` push-back checks (write-scope-required 403 for catalog **and** read keys; 3-kind push; tenant-scoped storage; append-only history + trend; `mi_rfm_segment` set without clobbering `rfm_segment`; segment counts; activate → draft `mi_segment` campaign; empty-segment 400) |

## 6. Exception & error handling

All `400` unless noted: developer — `BAD_TIER` (not in the allowlist), `KEY_NOT_FOUND` (404); connectors —
`BAD_CONNECTOR` (unknown type), `CONNECTOR_NOT_FOUND` (404). Unauthorized → `403`/`401`; cross-tenant access is
RLS-filtered.

## 7. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-24 | Platform | Initial ecosystem narrative. Delivered **Platform Phase 23 — API maturity / developer portal (D1)**: a portal over the shipped public API v1 (keys + rate tiers, scopes, endpoints, OpenAPI); `api_keys.tier` (migration `0096`). RLS-scoped, no GL; `ext` +4 checks. D2 connector framework planned; D3 marketplace deferred — see roadmap `13` §4. |
| 0.2 DRAFT | 2026-06-24 | Platform | Added **Platform Phase 24 — connector framework (D2)**: register + sync inbound connectors (LINE / Shopee / bank-CSV) over a canonical model with a stub-default transport, idempotent `external_id_map` dedupe (per-tenant), and a per-run log; imported records staged for review, never auto-posted. Tables `connectors`/`connector_syncs`/`external_id_map` (migration `0097`). RLS-scoped, no GL; new §4.2, control-matrix row, `BAD_CONNECTOR`/`CONNECTOR_NOT_FOUND`; `ext` +6 checks. D3 marketplace deferred. |
| 0.3 DRAFT | 2026-07-14 | Platform | Added **analytics read feeds** to the public API v1 for the separate **Marketing Intelligence Platform** (a Python data-science app: advanced MMM / sentiment-weighted RFM / TOWS that reads ERP data by API into its own warehouse — no shared DB, ERP posts nothing). New scope **`analytics:read`** + two endpoints: `GET /api/v1/sales/daily` (per-day POS revenue, Voided excluded, `group_by=day\|product` — the MMM target) and `GET /api/v1/customers/transactions` (per-customer RFM base facts from `customer_profiles ⋈ pos_members`). Both RLS tenant-scoped + per-key rate-limited via the existing `PublicApiGuard`; wired into `developer.service.ts` scope/endpoint catalog + `openapi.ts` (HTML reference auto-derives). Read-only this phase (a future `analytics:write` push-back deferred). New §4.3, control-matrix row. `ext` +8 checks (scope-required 403, per-day revenue, RFM facts, HQ↔cf2 isolation). No new migration/RCM control (reuses ITGC-AC-07). |
| 0.4 DRAFT | 2026-07-21 | Platform | Added the **analytics push-back + action loop** (the reverse of 0.3, docs/48 phase 3): the Marketing Intelligence Platform now **pushes its computed MMM / RFM / TOWS results back into the ERP** so the ERP owns what it renders. New scope **`analytics:write`** + endpoint **`POST /api/v1/analytics/snapshots`** (**append-only** into `mi_analytics_snapshots`, migration **`0460`**, canonical org-RLS loop + leading `(tenant_id, kind, pushed_at)` index — so a **run-history / period comparison** is possible, `GET …/mmm-history`); new bounded-context module **`modules/marketing-intel`** (owns the table + the JWT `marketing`/`exec` reads `…/summary`, `…/mmm-history`, `…/segments`, and the `…/segments/activate` action); the **`/marketing-intel`** web page (marketing/exec nav) renders MMM+trend / RFM / TOWS with a not-yet-pushed empty state and a **per-segment "create campaign"** button. **RFM → campaign action loop:** an rfm push may carry per-customer `members` which land on a **separate** `customer_profiles.mi_rfm_segment` column (the ERP's own `rfm_segment` is never clobbered), and a new **`mi_segment`** campaign audience targets it — so the platform's segmentation drives the existing consent-gated delivery; activation creates a **draft** campaign only. `analytics:write` added to the developer catalog + OpenAPI + the Settings API-key minting chips. Read model only, no GL. New §4.4, control-matrix row. `ext` +12 checks. No new RCM control (reuses ITGC-AC-07). |
