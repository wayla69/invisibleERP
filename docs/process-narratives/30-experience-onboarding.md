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

**In scope (delivered):** **white-label theming (E4, Phase 29)**, **guided onboarding & industry packs (E1,
Phase 26)** + **data-migration toolkit (E2, Phase 27)**. **Planned (see roadmap `13` §5):** E3 PWA (Phase 28),
E5 scale interfaces (Phase 30).

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
   completion + a % progress) and one-click **industry template packs** (restaurant / retail / distribution /
   services) that **seed a working set of custom objects** (reusing the A1 store). Pack apply is **idempotent**
   (skips an object the tenant already has) and posts **nothing** to the GL. `GET /api/onboarding` (+ `/packs`),
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

## 5. Control matrix

| Capability | Risk | Control | Type | RCM ID | Evidence |
|---|---|---|---|---|---|
| White-label theming | Cross-tenant theme bleed; unsafe asset/colour | RLS self-scoped tenant theme; brand hue bounded 0–360 → in-gamut oklch; radius from an allowlist; logo restricted to https/data-image; presentation-only, no GL | Preventive | (operational) | `ext` theme checks (set, bad-hue, bad-radius, RLS) |
| Onboarding / industry packs | Cross-tenant seed bleed; duplicate seeding | Pack apply is idempotent + RLS-scoped (seeds only the caller's tenant); seeds configuration/sample objects only, no GL | Preventive | (operational) | `ext` onboarding checks (idempotent re-apply, RLS) |
| Data migration | Bad master data loaded silently | Source adapter → canonical → dry-run validation (Phase-7 per-row checks) before any write; job recorded; RLS-scoped; no GL | Preventive | MDM-02 | `ext` migration checks (invalid-row flagging, RLS) |

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
