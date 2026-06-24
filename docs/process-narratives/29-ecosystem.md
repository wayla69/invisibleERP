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
mature **public API + developer portal** (this version), and — planned — an inbound **connector framework**
(D2) and an **app marketplace** (D3, deferred per the roadmap). Built on the shipped public API v1, API keys,
and outbound webhooks. **RLS-scoped**; posts **nothing to the GL**.

## 3. Scope

**In scope (delivered):** **API maturity / developer portal (D1, Platform Phase 23)**. **Planned (see roadmap
`13` §4):** D2 connector framework (Phase 24); D3 marketplace **deferred** to year 2.

## 4. Process narrative — capabilities

1. **API maturity / developer portal — Phase 23 (D1).** Matures the shipped public API v1 into an
   integrator-ready surface: a self-serve **developer portal** that lists the tenant's API keys with a settable
   **rate tier** (free / standard / partner), the **scope** catalog, the **endpoint** catalog, and a link to the
   **OpenAPI 3.1** document. Reuses the existing API-key auth + `PublicApiGuard` (scope-gate + per-key rate
   limit); adds a `tier` column to `api_keys` (migration `0096`). `GET /api/developer/portal`,
   `PUT /api/developer/keys/:id/tier` (perm `users`). Keys are **RLS-scoped** to the tenant. Web `/developer`.
   *Verified by the `ext` harness (portal catalog / set-tier / bad-tier / RLS). Per-request usage-analytics
   logging + a public sandbox host are noted follow-ups.*

## 5. Control matrix

| Capability | Risk | Control | Type | RCM ID | Evidence |
|---|---|---|---|---|---|
| API maturity / portal | Over-broad or mis-tiered machine access | Keys + tiers RLS-scoped to the tenant; tier from an allowlist; reuses the v1 scope-gate + per-key rate limit | Preventive | ITGC-AC-07 | `ext` developer checks (portal, set-tier, bad-tier, RLS) |

## 6. Exception & error handling

All `400` unless noted: developer — `BAD_TIER` (not in the allowlist), `KEY_NOT_FOUND` (404). Unauthorized →
`403`/`401`; cross-tenant access is RLS-filtered.

## 7. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-24 | Platform | Initial ecosystem narrative. Delivered **Platform Phase 23 — API maturity / developer portal (D1)**: a portal over the shipped public API v1 (keys + rate tiers, scopes, endpoints, OpenAPI); `api_keys.tier` (migration `0096`). RLS-scoped, no GL; `ext` +4 checks. D2 connector framework planned; D3 marketplace deferred — see roadmap `13` §4. |
