# Ecosystem & Extensibility — Process Narrative

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-29-ECO |
| Process owner | `<<Platform Admin / Partnerships>>` |
| Approver | `<<CFO / Head of IT>>` |
| Version | **0.1 DRAFT · 2026-06-24** |
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

## 5. Control matrix

| Capability | Risk | Control | Type | RCM ID | Evidence |
|---|---|---|---|---|---|
| API maturity / portal | Over-broad or mis-tiered machine access | Keys + tiers RLS-scoped to the tenant; tier from an allowlist; reuses the v1 scope-gate + per-key rate limit | Preventive | ITGC-AC-07 | `ext` developer checks (portal, set-tier, bad-tier, RLS) |
| Connector framework | Cross-tenant data bleed; duplicate imports; premature posting | Stub-default transport (CI-safe); idempotent dedupe via `external_id_map` (per-tenant RLS); imported records staged for review, never auto-posted; live creds would be encrypted at rest | Preventive | (operational) | `ext` connector checks (idempotent resync, per-tenant RLS) |

## 6. Exception & error handling

All `400` unless noted: developer — `BAD_TIER` (not in the allowlist), `KEY_NOT_FOUND` (404); connectors —
`BAD_CONNECTOR` (unknown type), `CONNECTOR_NOT_FOUND` (404). Unauthorized → `403`/`401`; cross-tenant access is
RLS-filtered.

## 7. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-24 | Platform | Initial ecosystem narrative. Delivered **Platform Phase 23 — API maturity / developer portal (D1)**: a portal over the shipped public API v1 (keys + rate tiers, scopes, endpoints, OpenAPI); `api_keys.tier` (migration `0096`). RLS-scoped, no GL; `ext` +4 checks. D2 connector framework planned; D3 marketplace deferred — see roadmap `13` §4. |
| 0.2 DRAFT | 2026-06-24 | Platform | Added **Platform Phase 24 — connector framework (D2)**: register + sync inbound connectors (LINE / Shopee / bank-CSV) over a canonical model with a stub-default transport, idempotent `external_id_map` dedupe (per-tenant), and a per-run log; imported records staged for review, never auto-posted. Tables `connectors`/`connector_syncs`/`external_id_map` (migration `0097`). RLS-scoped, no GL; new §4.2, control-matrix row, `BAD_CONNECTOR`/`CONNECTOR_NOT_FOUND`; `ext` +6 checks. D3 marketplace deferred. |
