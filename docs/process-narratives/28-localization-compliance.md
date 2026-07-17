# Localization & Compliance Packs — Process Narrative

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-28-LOC |
| Process owner | `<<Platform Admin / Localization Lead>>` |
| Approver | `<<CFO / Head of IT>>` |
| Version | **0.7 DRAFT · 2026-07-17** |
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
21)**, **pluggable e-invoicing engine (C3, Phase 22)**, and **nav i18n wiring (roadmap C3, 2026-06-28)** — nav
labels and sidebar chrome now resolved through the `t()` framework, enabling full language switching.
**Planned (see roadmap `13` §3):** certified per-country pack content + live e-invoicing adapters (external —
legal sign-off + authority credentials).

## 4. Process narrative — capabilities

1. **i18n / locale framework — Phase 20 (C1).** Evolves the homegrown web i18n into a real framework: a
   per-locale **message catalog** (`apps/web/src/lib/messages.ts`) seeded for **th · en · ms · vi · id**, an
   `useLang()` provider with **`{var}` interpolation** + `Intl` number/date formatters, and a **server-resolved
   effective locale** — `user.locale` (override) → `tenants.default_language` (tenant default) → `'th'`. A user
   sets their own locale; an admin sets the tenant default. `GET /api/i18n/locales`, `GET/PUT /api/i18n/me`
   (universal — self-prefs, no permission gate), `PUT /api/i18n/tenant-default` (perm `users`/`exec`). Storage:
   additive `users.locale` column (migration `0093`); the tenant default reuses the existing
   `tenants.default_language`. No GL; per-user writes are self-scoped; tenant default is RLS self-scoped. Web:
   the header **language picker**. **Client persistence contract (2026-07-17):** the picker caches the choice
   in `localStorage` and persists it best-effort via `PUT /api/i18n/me`; when the persist cannot succeed
   (offline, or a read-only company view where mutations are rejected `403 READONLY_IMPERSONATION`) the choice
   is marked *pending* on-device and stays **authoritative across page loads** (with a persist retry on each
   mount) — the server-resolved locale must never revert an explicit user selection. Once a persist succeeds,
   the server value is authoritative again (cross-device sync). *Verified by the `ext` harness (catalog /
   set-self / bad-locale / per-user isolation) + the web e2e `apps/web/e2e/lang-persistence.spec.ts`
   (read-only-view persistence + server-authority restore); the foundation country packs (C2) + e-invoicing
   (C3) build on.*
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
   in behind it. `submit` validates a **canonical invoice**, **prepares** the country-appropriate document
   (MY → MyInvois UBL 2.1; SG → Peppol BIS3; others → JSON) and hashes it, **delivers** it via the provider's
   **transport**, and logs the result **idempotently by doc_ref**. `GET /api/einvoice/providers`,
   `GET/PUT /api/einvoice/config`, `POST /api/einvoice/submit`, `GET /api/einvoice/submissions`
   (perm `exec`/`creditors`/`ar`). Tables `einvoice_config` (creds AES-256-GCM-encrypted in prod) +
   `einvoice_submissions` (migration `0100`); RLS-scoped. Read-of-invoice → external send — posts **nothing**
   to the GL. Web `/einvoice`.
   - **Honesty contract (fail-closed transport).** A real tax-authority filing only happens when a provider's
     **transport is actually wired** (credentials + endpoint, which live outside the repo). Until then an
     **external** provider (RD / MyInvois / Peppol) records the submission as **`pending`** — the document is
     prepared and hashed but **NOT transmitted** — and **never** a false `accepted` with a fabricated QR. Only
     the sandbox **`stub`** provider acknowledges locally, and it is explicitly flagged **`sandbox:true`** so it
     can never be mistaken for a real filing. This replaced an earlier stub that unconditionally returned
     `accepted` with an `einvoice.example` QR for every provider. *Verified by the `ext` harness (stub submit /
     idempotent / bad-doc) and `basics` (MY & SG providers prepare → `pending`, no QR; stub → `accepted` +
     `sandbox:true`). Live authority credentials + conformance testing per country remain external follow-ups.*

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
| 0.5 DRAFT | 2026-07-10 | Platform | **E-invoicing submit made honest — fail-closed transport (data-integrity fix; no migration, no new control).** `EInvoiceService.submit` previously returned `status:'accepted'` with a fabricated `https://einvoice.example/…` QR for **every** provider, so a screen implied real filings were made when nothing was transmitted. Submit now **prepares + hashes** the country document (real work) then **delivers via a per-provider transport**: an **external** provider (RD/MyInvois/Peppol) with no live transport wired records **`pending`** (prepared, not transmitted, `qr:null`) — never a false `accepted`; only the sandbox **`stub`** returns `accepted` and is flagged **`sandbox:true`**. New pluggable `EInvoiceTransport` interface (real authority adapters swap in behind it). §4.3 gains the honesty-contract note; web `/einvoice` shows a status pill (pending/accepted-sandbox) + a "prepares, not transmitted" note. ToE: `basics` 326 (MY & SG → `pending` + no QR; stub → `accepted` + `sandbox`), `ext` 295 (stub submit/idempotent/bad-doc). Manual `07-tax.md` note. |
| 0.7 DRAFT | 2026-07-17 | Platform | **EN coverage extension — customer portal + shared client errors (translation coverage; no API/DB/permission change, no new control).** All 11 `/portal/**` screens (POS, dashboard, inventory/reorders, my-business, loyalty, variance, survey, BoM, my-users, track, shell brand) are wired through `t()` with a new `i18n-catalog/portal.ts` fragment (`pt.*`, ~190 new keys th+en) — previously hardcoded Thai, so an EN user saw Thai portal screens. New **`lib/i18n-static.ts`** (`ts()`/`currentLang()`, reads the persisted `ierp_lang`) lets non-React modules translate: fetch-layer errors (`lib/api.ts` timeout/network/session), receipt-print errors (`lib/terminal.ts`), JE form validation (`lib/journal-validation.ts`), toast fallback (`lib/notify.ts`), AI-chat errors, SME-reason prompt fallback. `lib/api.ts` now also picks the **server** error message by locale (`message` EN vs `messageTh`) instead of always Thai. Internal leftovers wired: `/capture` email-capture card (`iv.capmail_*`), password show/hide aria-labels. Auth/public diner pages (login, QR order, tracking, NPS) remain Thai/bilingual by design — no LanguageProvider there (product decision pending). Doc-sync: manual 00 §5 + FAQ; UAT unchanged (no behavioral contract change — translation coverage only, mirroring rev 0.4's nav-wiring precedent). |
| 0.6 DRAFT | 2026-07-17 | Platform | **Language choice no longer reverts on navigation (bug fix; no migration, no new control).** The web `LanguageProvider` re-resolved the locale from `GET /api/i18n/me` on every mount and let it clobber the on-device choice while the persisting `PUT /api/i18n/me` was fire-and-forget — so whenever the PUT couldn't succeed (a god in **read-only company view**, every mutation → `403 READONLY_IMPERSONATION`; or offline) each full page load snapped the UI back to TH. Fix: a failed persist marks the choice *pending* in `localStorage` (`ierp_lang_pending`); while pending, the local choice is authoritative (with a persist retry on mount) and the server read is skipped; a successful persist clears it and the server-resolved value is authoritative again (cross-device sync intact). §4.1 gains the client-persistence contract. No API/DB/permission changes; no GL. ToE: web e2e `apps/web/e2e/lang-persistence.spec.ts`; UAT-ADM-171. |
| 0.4 DRAFT | 2026-06-28 | Platform | **Roadmap C3 — nav i18n wiring**: all `INTERNAL_NAV` and `PORTAL_NAV` `title`/`label` strings replaced with `messages.ts` i18n keys (~170 new entries covering 18 group titles, 9 subgroup titles, and all nav item labels in th+en). `AppShell` and `CommandPalette` now call `t()` for all rendered nav text and sidebar chrome (favourites, recent, search, logout). `portal/layout.tsx` wrapped in `LanguageProvider`. No API, DB, or permission changes; no GL. The UI now switches language correctly when a user selects a non-Thai locale. |
