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
(this version), and — planned — guided **onboarding + industry packs** (E1), a **data-migration toolkit** (E2),
a **mobile PWA** (E3), and **scale interfaces** (E5). Each is **presentation-only or staging-only**,
**RLS-scoped**, and posts **nothing to the GL**.

## 3. Scope

**In scope (delivered):** **white-label theming (E4, Platform Phase 29)**. **Planned (see roadmap `13` §5):**
E1 onboarding + industry packs (Phase 26), E2 migration toolkit (Phase 27), E3 PWA (Phase 28), E5 scale
interfaces (Phase 30).

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

## 5. Control matrix

| Capability | Risk | Control | Type | RCM ID | Evidence |
|---|---|---|---|---|---|
| White-label theming | Cross-tenant theme bleed; unsafe asset/colour | RLS self-scoped tenant theme; brand hue bounded 0–360 → in-gamut oklch; radius from an allowlist; logo restricted to https/data-image; presentation-only, no GL | Preventive | (operational) | `ext` theme checks (set, bad-hue, bad-radius, RLS) |

## 6. Exception & error handling

All `400` unless noted: theming — `BAD_HUE` (hue not 0–360), `BAD_RADIUS` (not in the allowlist), `BAD_LOGO`
(not https/data-image), `NO_TENANT`. Unauthorized → `403`/`401`; cross-tenant access is RLS-filtered.

## 7. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-24 | Platform | Initial experience narrative. Delivered **Platform Phase 29 — white-label theming (E4)**: per-tenant brand tokens (brand hue → in-gamut oklch `--primary`, radius, name, logo, tagline) applied as CSS variables app-wide; `tenants.theme_prefs` (migration `0094`). Presentation-only, no GL, RLS/self-scoped; `ext` +5 checks. E1/E2/E3/E5 planned — see roadmap `13` §5. |
