# Experience, Onboarding & White-Label — Process Narrative

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-30-EXP |
| Process owner | `<<Platform Admin / Product>>` |
| Approver | `<<CFO / Head of IT>>` |
| Version | **0.1 DRAFT · 2026-06-24** |
| Review cadence | Annual + on significant change |
| Related RCM controls | No new RCM control (presentation/operational features). Reinforces ITGC-AC-03 (RLS). |
| Related narratives | `27-platform-customization.md` (branding #9, doc templates #13), roadmap `13-pillars-cde-architecture-spec.md` §5 |

## 2. Purpose

The **experience, onboarding & trust** pillar (roadmap Pillar E) wins and keeps SMBs: **white-label theming**
+ **guided onboarding & industry packs** (this version), and — planned — a **data-migration toolkit** (E2),
a **mobile PWA** (E3), and **scale interfaces** (E5). Each is **presentation-only or staging-only**,
**RLS-scoped**, and posts **nothing to the GL**.

## 3. Scope

**In scope (delivered):** all of Pillar E's software — **white-label theming (E4)**, **onboarding & industry
packs (E1)**, **data-migration toolkit (E2)**, **mobile PWA (E3)** + **scale interfaces (E5)** (Phases 26–30).
**External (not a code deliverable):** E6 SOC 2 / ISO 27001 certification — an audit, deferred per the
deployment plan (roadmap `13` §5/§8).

## 4. Process narrative — capabilities

1. **White-label theming — Phase 29 (E4).** Extends Phase-9 branding to **full theming**: a tenant sets brand
   tokens — a **brand hue** (applied as an in-gamut **oklch** `--primary`, matching the app's Tailwind-v4 token
   format), a corner **radius**, a **brand name**, **logo**, and **tagline** — and the web shell applies them as
   **CSS variables** across the whole app (a `ThemeApplier` in the internal layout). `GET /api/tenant/theme`
   (universal — every user's shell needs the effective theme), `PUT /api/tenant/theme` (perm `users`/`exec`).
   Storage: additive `tenants.theme_prefs` jsonb (migration `0094`). Presentation-only — it carries no amounts
   and posts **nothing** to the GL; RLS self-scoped to the caller's tenant; the logo accepts only an
   `https`/`data:image` URI (reuses the Phase-9 hardening). Web: `/theme` editor with a live preview. *Verified
   by the `ext` harness (default oklch primary / set-tokens / bad-hue / bad-radius / RLS isolation). Email-template
   overrides + a public login-page theme by tenant code are noted follow-ups.*
2. **Guided onboarding + industry packs — Phase 26 (E1).** A curated **setup checklist** (per-tenant step
   completion + a % progress) and one-click **industry template packs** — one per curated business type
   (restaurant / retail / distribution / services / manufacturing / construction / ecommerce / hospitality /
   healthcare / professional / agriculture / automotive / logistics / education / nonprofit / realestate) —
   that **seed a working set of custom objects** (reusing the A1 store; e.g. BOM + work centre for
   manufacturing, BoQ + subcontractor for construction, room type + recipe for hospitality). Pack apply is
   **idempotent** (skips an object the tenant already has) and posts **nothing** to the GL. `GET /api/onboarding` (+ `/packs`),
   `POST /api/onboarding/apply-pack`, `POST /api/onboarding/steps/:key/complete|reset`. Perm
   `users`/`exec`/`dashboard` (reads + steps), `masterdata`/`users`/`exec` (apply). Tables `onboarding_progress`
   + `pack_installs` (migration `0095`); RLS-scoped. Web `/onboarding`. *Verified by the `ext` harness
   (checklist / complete-step / bad-step / pack-apply / idempotent-reapply / bad-pack / RLS).*
3. **Data-migration toolkit — Phase 27 (E2).** Productizes the Phase-7 import into a guided **migrate-from**
   flow: a **source adapter** (Loyverse / FlowAccount / generic CSV) maps a vendor export → **canonical** rows,
   then a **dry-run** validation (mirroring the Phase-7 per-row checks) reports errors **without writing**, and
   the job is recorded for preview before the tenant commits through the proven Phase-7 importer. `GET
   /api/migration/sources`, `POST /api/migration/dry-run`, `GET /api/migration/jobs` (perm
   `masterdata`/`users`/`exec`). Table `migration_jobs` (migration `0098`); RLS-scoped. Web `/migration`.
   *Verified by the `ext` harness (sources / field-map + invalid-row flagging / bad-source / bad-entity /
   job-recorded / RLS). Direct one-click commit (calling the Phase-7 importer) is a noted follow-up.*
4. **Mobile PWA — Phase 28 (E3).** Makes the app an **installable, offline-capable PWA**: a
   `manifest.webmanifest` (name / icons / `standalone` display / theme colour) + registration of the existing
   safe app-shell service worker (`sw.js` — same-origin, GET-only, API-skipping stale-while-revalidate), wired
   into the root layout. Pairs with the existing offline-POS outbox (idempotent replay). No backend model — a
   client capability over existing APIs. Installable from any screen. *Verified by the web build (manifest +
   icon + SW registration). Push over the existing notification inbox is a noted follow-up.*
5. **Scale interfaces — Phase 30 (E5).** The app-side of the upmarket scale story: a **`CacheService`**
   (in-memory TTL default; `CACHE_PROVIDER=redis` swaps a Redis adapter behind the same interface — the
   EmbedderService precedent) and an **ops endpoint** surfacing process metrics + cache/queue **provider
   posture** (the liveness `/healthz` + readiness `/readyz` probes already exist). `GET /api/ops/metrics`,
   `GET /api/ops/cache-selftest` (perm `exec`/`users`). No schema. Web `/ops`. *Verified by the `ext` harness
   (metrics posture + CacheService round-trip). Provisioning managed Redis + read replicas + table
   partitioning is an infra/ops task (lean-then-scale) — out of scope for the app layer.*

## 5. Control matrix

| Capability | Risk | Control | Type | RCM ID | Evidence |
|---|---|---|---|---|---|
| White-label theming | Cross-tenant theme bleed; unsafe asset/colour | RLS self-scoped tenant theme; brand hue bounded 0–360 → in-gamut oklch; radius from an allowlist; logo restricted to https/data-image; presentation-only, no GL | Preventive | (operational) | `ext` theme checks (set, bad-hue, bad-radius, RLS) |
| Onboarding / industry packs | Cross-tenant seed bleed; duplicate seeding | Pack apply is idempotent + RLS-scoped (seeds only the caller's tenant); seeds configuration/sample objects only, no GL | Preventive | (operational) | `ext` onboarding checks (idempotent re-apply, RLS) |
| Data migration | Bad master data loaded silently | Source adapter → canonical → dry-run validation (Phase-7 per-row checks) before any write; job recorded; RLS-scoped; no GL | Preventive | MDM-02 | `ext` migration checks (invalid-row flagging, RLS) |
| Mobile PWA | Offline data integrity | Offline writes replay through the existing idempotent outbox; the SW is GET-only + API-skipping + same-origin; no GL | Preventive | (operational) | web build (manifest + SW) |
| Scale interfaces | Stale / inconsistent cached reads | Cache is a TTL store behind one interface (in-memory default); ops endpoint read-only; no GL | Preventive | (operational) | `ext` ops checks (metrics, cache round-trip) |

## 6. Exception & error handling

All `400` unless noted: theming — `BAD_HUE` (hue not 0–360), `BAD_RADIUS` (not in the allowlist), `BAD_LOGO`
(not https/data-image), `NO_TENANT`; onboarding — `BAD_STEP` (unknown step), `BAD_PACK` (unknown pack);
migration — `BAD_SOURCE`, `BAD_ENTITY`, `BAD_ROWS`. Unauthorized → `403`/`401`; cross-tenant access is RLS-filtered.

## 7. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-24 | Platform | Initial experience narrative. Delivered **Platform Phase 29 — white-label theming (E4)**: per-tenant brand tokens (brand hue → in-gamut oklch `--primary`, radius, name, logo, tagline) applied as CSS variables app-wide; `tenants.theme_prefs` (migration `0094`). Presentation-only, no GL, RLS/self-scoped; `ext` +5 checks. E1/E2/E3/E5 planned — see roadmap `13` §5. |
| 0.2 DRAFT | 2026-06-24 | Platform | Added **Platform Phase 26 — guided onboarding + industry packs (E1)**: a setup checklist (per-tenant step completion + %) and one-click industry packs (restaurant/retail/distribution/services) that idempotently seed custom objects (reusing A1). Tables `onboarding_progress` + `pack_installs` (migration `0095`). No GL, RLS-scoped; new §4.2, control-matrix row, `BAD_STEP`/`BAD_PACK`; `ext` +7 checks. |
| 0.3 DRAFT | 2026-06-24 | Platform | Added **Platform Phase 27 — data-migration toolkit (E2)**: source adapters (Loyverse/FlowAccount/CSV) map a vendor export → canonical → dry-run validation (mirroring Phase-7) with a recorded job, previewed before the Phase-7 commit. Table `migration_jobs` (migration `0098`). RLS-scoped, validation-only, no GL; new §4.3, control-matrix row (MDM-02), `BAD_SOURCE`/`BAD_ENTITY`/`BAD_ROWS`; `ext` +6 checks. |
| 0.4 DRAFT | 2026-06-24 | Platform | Added **Platform Phase 28 — mobile PWA (E3)**: installable, offline-capable PWA (`manifest.webmanifest` + icon + registration of the existing app-shell `sw.js`) wired into the root layout; pairs with the offline-POS outbox. No backend model, no GL; new §4.4, control-matrix row. Verified by the web build. |
| 0.5 DRAFT | 2026-06-24 | Platform | Added **Platform Phase 30 — scale interfaces (E5)**: a `CacheService` (in-memory TTL default; Redis swap behind the interface) + an ops metrics endpoint (cache/queue posture; the health probes already exist). No schema, no GL; new §4.5, control-matrix row; `ext` +2 checks. Infra (Redis / read replicas / partitioning) is an ops follow-up. **Pillar E software complete (E1–E5); E6 SOC2 is external.** |
| 0.6 DRAFT | 2026-07-18 | Platform | **Sample-data + industry packs extended to all 17 business types (E1/B3 — no control/schema change).** The B3 starter pack (`StarterPackService`) now maps every industry to one of four seed kinds — POS **catalog** (restaurant/retail/ecommerce/hospitality/automotive/healthcare/education), **dining tables** (restaurant/hospitality), **warehouse** branch (distribution/manufacturing/agriculture/logistics), or **demo project** (services/construction/professional/realestate/nonprofit) — refactored config-driven (the four original industries seed byte-identically). The E1 onboarding **industry packs** gain a pack per new industry (custom objects only, idempotent, no GL). ToE: `onboarding` harness +5 (ecommerce catalog, manufacturing warehouse, construction project, manufacturing pack objects) → 157. |
