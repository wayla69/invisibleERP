# Localization & Compliance Packs — Process Narrative

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-28-LOC |
| Process owner | `<<Platform Admin / Localization Lead>>` |
| Approver | `<<CFO / Head of IT>>` |
| Version | **0.1 DRAFT · 2026-06-24** |
| Review cadence | Annual + on significant change |
| Related RCM controls | No new RCM control (UI-locale + pack config are operational). C3 e-invoicing reinforces tax-submission integrity (operational; live adapters are external). |
| Related narratives | `27-platform-customization.md` (Studio), tax-docs / `pos-fiscal` (TH e-Tax), roadmap `13-pillars-cde-architecture-spec.md` §3 |

## 2. Purpose

The **localization & compliance** pillar (roadmap Pillar C) lets one product serve all of SEA instead of a
fork per market: a real **i18n framework** (this version), and — planned — **country localization packs**
(CoA / tax / statutory reports, the Odoo *l10n* model) and a **pluggable e-invoicing engine** behind a
provider interface (MY MyInvois, SG InvoiceNow, VN, ID, PH; TH already shipped). Each piece is **tenant-isolated
by RLS** and posts **nothing to the GL**.

## 3. Scope

**In scope (delivered):** **i18n / locale framework (C1, Phase 20)**, **country localization packs (C2, Phase
21)** + **pluggable e-invoicing engine (C3, Phase 22)**. **Planned (see roadmap `13` §3):** certified
per-country pack content + live e-invoicing adapters (external — legal sign-off + authority credentials).

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
2. **Country localization packs — Phase 21 (C2).** The **Odoo *l10n*** model: a pack (declared in code) bundles
   a **CoA preview + tax codes + statutory reports + e-invoicing provider + locale** for a country. **TH** is
   the **certified** reference; **MY** ships as a **draft** skeleton — proving the framework generalizes.
   Applying a pack sets the tenant's **tax country** + **default locale** and records the active pack; the
   CoA/tax content is exposed for review (seeding it into the live ledger, with maker-checker, is a guarded
   follow-up). `GET /api/localization/packs`, `GET /api/localization`, `POST /api/localization/apply` (perm
   `exec`/`users`/`masterdata`). Table `tenant_localization` (migration `0099`); RLS-scoped; no GL. Web
   `/localization`. *Verified by the `ext` harness (packs / apply / bad-country / per-tenant RLS). Certified
   CoA/tax/statutory content + legal sign-off per country is external (out of scope here).*
3. **Pluggable e-invoicing engine — Phase 22 (C3).** Puts e-invoicing behind one **provider interface** (the
   same pattern as `tax-providers.ts`): a deterministic **stub** is the default (CI-safe; no-credential tenants
   work), real adapters — **TH** RD e-Tax Invoice, **MY** MyInvois (UBL 2.1), **SG** InvoiceNow (Peppol) — swap
   in behind it. `submit` validates a **canonical invoice**, submits via the configured provider, and logs the
   result **idempotently by doc_ref**. `GET /api/einvoice/providers`, `GET/PUT /api/einvoice/config`,
   `POST /api/einvoice/submit`, `GET /api/einvoice/submissions` (perm `exec`/`creditors`/`ar`). Tables
   `einvoice_config` (creds AES-256-GCM-encrypted in prod) + `einvoice_submissions` (migration `0100`);
   RLS-scoped. Read-of-invoice → external send — posts **nothing** to the GL. Web `/einvoice`. *Verified by the
   `ext` harness (providers / submit-accepted / idempotent / bad-doc). Live authority credentials + conformance
   testing per country are external follow-ups.*

## 5. Control matrix

| Capability | Risk | Control | Type | RCM ID | Evidence |
|---|---|---|---|---|---|
| i18n / locale | Cross-tenant or cross-user setting bleed | `user.locale` is self-scoped; tenant default is RLS self-scoped; unsupported locales rejected; read-only resolution, no GL | Preventive | (operational) | `ext` i18n checks (set-self, bad-locale, per-user isolation) |
| Country localization packs | Cross-tenant config bleed; wrong-country setup | Pack apply is RLS self-scoped (sets only the caller's tenant); unsupported country rejected; CoA seeding into the ledger deferred behind maker-checker; no GL | Preventive | (operational) | `ext` localization checks (apply, bad-country, RLS) |
| E-invoicing engine | Cross-tenant / duplicate / forged submissions; credential disclosure | Per-provider interface + stub default; submissions RLS-scoped + idempotent by doc_ref; canonical doc validated; live creds encrypted at rest; read-of-invoice → external send, no GL | Preventive | (operational; reinforces tax-submission integrity) | `ext` e-invoice checks (submit, idempotent, bad-doc) |

## 6. Exception & error handling

All `400` unless noted: i18n — `BAD_LOCALE` (unsupported code), `NO_TENANT` (no tenant in context for a
tenant-default write); localization — `BAD_COUNTRY` (unsupported country); e-invoicing — `BAD_DOC` (invalid
invoice), `BAD_PROVIDER` (unknown provider). Unauthorized → `403`/`401`; cross-tenant access is RLS-filtered.

## 7. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-24 | Platform | Initial localization narrative. Delivered **Platform Phase 20 — i18n / locale framework (C1)**: per-locale catalog (th/en/ms/vi/id), interpolation + `Intl` formatters, server-resolved effective locale (user → tenant → th), `users.locale` (migration `0093`). No GL, RLS/self-scoped; `ext` +4 checks. C2 (country packs) + C3 (e-invoicing engine) planned — see roadmap `13` §3. |
| 0.2 DRAFT | 2026-06-24 | Platform | Added **Platform Phase 21 — country localization packs (C2)**: the Odoo l10n model — a pack (CoA preview / tax codes / statutory reports / e-invoice provider / locale) per country; TH certified + MY draft skeleton. Applying sets tenant tax country + locale + records the active pack (live CoA seeding is a guarded follow-up). Table `tenant_localization` (migration `0099`). RLS-scoped, no GL; new §4.2, control-matrix row, `BAD_COUNTRY`; `ext` +4 checks. |
| 0.3 DRAFT | 2026-06-24 | Platform | Added **Platform Phase 22 — pluggable e-invoicing engine (C3)**: a provider interface (stub default; TH/MY/SG adapters) submitting a canonical invoice, logged idempotently by doc_ref. Tables `einvoice_config` + `einvoice_submissions` (migration `0100`). RLS-scoped, no GL; new §4.3, control-matrix row, `BAD_DOC`/`BAD_PROVIDER`; `ext` +4 checks. Live authority credentials per country are external. |
