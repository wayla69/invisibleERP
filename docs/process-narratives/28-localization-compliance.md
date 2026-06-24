# Localization & Compliance Packs — Process Narrative

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-28-LOC |
| Process owner | `<<Platform Admin / Localization Lead>>` |
| Approver | `<<CFO / Head of IT>>` |
| Version | **0.1 DRAFT · 2026-06-24** |
| Review cadence | Annual + on significant change |
| Related RCM controls | No new RCM control yet (UI-locale is operational). C3 e-invoicing (planned) will reinforce tax-submission integrity. |
| Related narratives | `27-platform-customization.md` (Studio), tax-docs / `pos-fiscal` (TH e-Tax), roadmap `13-pillars-cde-architecture-spec.md` §3 |

## 2. Purpose

The **localization & compliance** pillar (roadmap Pillar C) lets one product serve all of SEA instead of a
fork per market: a real **i18n framework** (this version), and — planned — **country localization packs**
(CoA / tax / statutory reports, the Odoo *l10n* model) and a **pluggable e-invoicing engine** behind a
provider interface (MY MyInvois, SG InvoiceNow, VN, ID, PH; TH already shipped). Each piece is **tenant-isolated
by RLS** and posts **nothing to the GL**.

## 3. Scope

**In scope (delivered):** the **i18n / locale framework (C1, Platform Phase 20)**. **Planned (see roadmap
`13` §3):** C2 country packs (Phase 21), C3 tax/e-invoicing engine (Phase 22).

## 4. Process narrative — capabilities

1. **i18n / locale framework — Phase 20 (C1).** Evolves the homegrown web i18n into a real framework: a
   per-locale **message catalog** (`apps/web/src/lib/messages.ts`) seeded for **th · en · ms · vi · id**, an
   `useLang()` provider with **`{var}` interpolation** + `Intl` number/date formatters, and a **server-resolved
   effective locale** — `user.locale` (override) → `tenants.default_language` (tenant default) → `'th'`. A user
   sets their own locale; an admin sets the tenant default. `GET /api/i18n/locales`, `GET/PUT /api/i18n/me`
   (universal — self-prefs, no permission gate), `PUT /api/i18n/tenant-default` (perm `users`/`exec`). Storage:
   additive `users.locale` column (migration `0093`); the tenant default reuses the existing
   `tenants.default_language`. No GL; per-user writes are self-scoped; tenant default is RLS self-scoped. Web:
   the header **language picker**. *Verified by the `ext` harness (catalog / set-self / bad-locale / per-user
   isolation); the foundation country packs (C2) + e-invoicing (C3) build on.*

## 5. Control matrix

| Capability | Risk | Control | Type | RCM ID | Evidence |
|---|---|---|---|---|---|
| i18n / locale | Cross-tenant or cross-user setting bleed | `user.locale` is self-scoped; tenant default is RLS self-scoped; unsupported locales rejected; read-only resolution, no GL | Preventive | (operational) | `ext` i18n checks (set-self, bad-locale, per-user isolation) |

## 6. Exception & error handling

All `400` unless noted: i18n — `BAD_LOCALE` (unsupported code), `NO_TENANT` (no tenant in context for a
tenant-default write). Unauthorized → `403`/`401`; cross-tenant access is RLS-filtered (no leak).

## 7. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-24 | Platform | Initial localization narrative. Delivered **Platform Phase 20 — i18n / locale framework (C1)**: per-locale catalog (th/en/ms/vi/id), interpolation + `Intl` formatters, server-resolved effective locale (user → tenant → th), `users.locale` (migration `0093`). No GL, RLS/self-scoped; `ext` +4 checks. C2 (country packs) + C3 (e-invoicing engine) planned — see roadmap `13` §3. |
