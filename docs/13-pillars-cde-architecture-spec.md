# 13 — Pillars C–E: Architecture & Specification (Platform Phases 20+)

> **Date:** 2026-06-24 · **Status:** DRAFT v0.1 — *direction checkpoint, pre-build* · **Owner:** Platform / Product
> **Scope:** Define the **interfaces, data models, API surfaces, controls, and verification approach** for the
> outclass roadmap's remaining pillars — **C (Localization & Compliance)**, **D (Ecosystem & Extensibility)**,
> **E (Experience, Onboarding & Trust)** — *before* committing to the heavy build. Companion to
> [`12-outclass-customization-roadmap.md`](./12-outclass-customization-roadmap.md) (the what/why) and
> [`process-narratives/27-platform-customization.md`](./process-narratives/27-platform-customization.md)
> (the delivered Pillars A & B, twenty-two capabilities).

---

## 0. How to read this — and what "done" can mean

Pillars A & B shipped as **fully buildable software** (code + UI + harness + docs, all RLS-scoped, no-GL,
deterministic-offline). Pillars C–E are **not uniform** in that respect. Each initiative below is tagged:

- 🟢 **Buildable here** — a complete, harness-verified increment in the A/B mould.
- 🟡 **Framework + stub** — we build the *engine and the provider interface* with a deterministic default/stub;
  going live needs an external credential, dataset, or legal sign-off that can't be exercised in CI.
- 🔴 **External process** — fundamentally not a code deliverable (an audit, a legal certification, a payments
  contract). We can build *supporting* software and documentation, but cannot "complete" it here.

**This document itself is the deliverable for the chosen checkpoint** ("architecture + specs first"). Nothing
below is implemented yet. §8 lists the **decisions I need from you** before building each item.

---

## 1. Design principles carried over from A & B (non-negotiable)

Every C–E phase inherits the invariants that made A/B safe and CI-green:

1. **Provider/adapter pattern with a safe default.** The codebase already proves this: `EmbedderService` runs a
   deterministic local embedder by default and swaps to a real model via `EMBED_PROVIDER` *behind one
   interface*; the B1–B4 AI features degrade to deterministic logic with **no `ANTHROPIC_API_KEY`**. Every
   external dependency in C–E (tax authority, e-commerce API, bank feed) hides behind the **same shape**: a
   typed provider interface, a **stub/sandbox default that CI exercises**, and a real adapter chosen by config.
2. **RLS tenant isolation** on every new tenant-scoped table (`tenant_id` + the `0002` policy loop, re-run by
   each migration — the established pattern through `0092`).
3. **No GL impact** from configuration/integration/operational features (the books stay the system of record;
   integrations *propose drafts*, never auto-post).
4. **Least privilege** — every surface gated by an explicit permission; secrets **AES-256-GCM encrypted at
   rest** (the webhook/identity precedent), tokens stored only as hashes.
5. **Documentation-as-done** — each phase updates its owning narrative, the user manual, UAT + traceability,
   and the control/compliance harness where a control is affected (per `CLAUDE.md`).
6. **Verification-as-done** — each phase adds checks to a cutover harness (`ext` or a new suite) that boots the
   real app over PGlite; merge only on green.

> **The provider contract (the spine of C3, D2, and parts of C2/E5):**
> ```ts
> // A pluggable external integration: deterministic stub by default, real adapter by config.
> export interface ExternalProvider<Cfg, In, Out> {
>   readonly key: string;                       // 'einvoice.my.myinvois', 'connector.shopee', …
>   readonly mode: 'stub' | 'sandbox' | 'live'; // CI always runs 'stub'
>   configure(cfg: Cfg): Promise<void>;         // secrets arrive already-decrypted; never logged
>   healthcheck(): Promise<{ ok: boolean; detail?: string }>;
>   execute(input: In): Promise<Out>;           // idempotent where the remote allows it
> }
> ```
> A `ProviderRegistry` resolves `key → provider`; the **stub** is registered unconditionally so tests and
> no-credential tenants get a working, inert path. This is exactly how `EmbedderService` already behaves.

---

## 2. What each initiative builds on (grounding in shipped code)

| Initiative | Already in the codebase (reuse, don't rebuild) |
|---|---|
| **C1** i18n | `apps/web/src/lib/i18n.tsx` — a homegrown `LanguageProvider`/`useLang()` with an **inline** TH/EN `MESSAGES` map, localStorage-persisted, Thai-fallback, opt-in per screen, plus `components/language-toggle.tsx`. C1 *evolves* this; it is not greenfield. |
| **C2** country packs | Thai CoA/tax/statutory already implemented across `ledger`/`finance`/`tax-docs`; this is the **reference pack** to generalize. |
| **C3** tax/e-invoicing | `tax-docs` module + `pos-fiscal` (TH RD e-Tax Invoice/e-Receipt) — the first concrete e-invoicing implementation to put behind a provider interface. |
| **D1** API maturity | **Shipped** public REST API v1 (capability #11): `/api/v1/*`, `PublicApiGuard` (scope + rate-limit), API keys at `/api/platform/api-keys`, curated OpenAPI 3.1. D1 matures this (versioning, dev portal, tiers). |
| **D2** connectors | Outbound **webhooks** (HMAC-signed, retried) + the **AES-256-GCM secret-at-rest** pattern + the API-key machine-principal guard — the building blocks for inbound connectors. |
| **D3** marketplace | API keys + scopes + the `billing` module (packages) + Pillar A custom objects/layouts — an app install is "scoped key + config bundle + billing line". |
| **E1** onboarding/packs | `/setup`, Pillar A (custom objects, layouts, doc templates), alerts, dashboards — a "pack" is a transactional bundle of these. |
| **E2** migration | **Shipped** validated bulk import (Phase 7): dry-run → preview → commit over 8 entities. E2 adds source adapters + field-mapping on top. |
| **E3** PWA | `offline` schema + offline-POS + `mobile-scan`; `notifications` inbox (for push). E3 is a manifest + service worker + install + the existing offline queue. |
| **E4** white-label | Phase 9 **branding** (`tenants.branding_prefs`, logo/tagline on receipts) + Phase 10 **document templates**. E4 generalizes to full theming + login/email/domain. |
| **E5** scale | Stateless Nest app + Postgres; append-only `audit_log`; per-key rate-limit already exists (in-process). E5 externalizes cache/queue/limit and partitions hot tables. |
| **E6** certs | The existing **SOX RCM + ITGC controls** + `compliance/` harness — E6 *maps* these to SOC 2 TSC / ISO 27001 Annex A and builds evidence tooling; the audit is external. |

**Numbering plan.** Schema migrations continue from **`0092`** → next free is **`0093`**. Platform Phases
continue from **19** → C–E occupy **Phases 20–30** (mapping in each section). One migration per phase that
needs a table; phases that are pure surface/provider/UI add **no** schema.

---

## 3. Pillar C — Localization & Compliance Packs *(the SEA expansion engine)*

### C1 · Real i18n framework — Phase 20 · 🟢 Buildable
**Goal:** turn the homegrown `i18n.tsx` into a real framework: externalized message catalogs, ICU
plural/number/date formatting, and a **per-user + per-tenant default locale** persisted server-side, so the
app is ready to add SEA locales without touching component code.

- **Architecture.** Keep the `useLang()/t()` *call sites* (incremental migration, no big-bang rewrite) but back
  them with **per-locale JSON catalogs** (`apps/web/messages/{th,en,ms,vi,id}.json`) loaded by locale, and an
  **ICU formatter** (`Intl.*` + a tiny message interpolator, or adopt `next-intl` — see §8 decision). Add
  number/currency/date helpers keyed off the active locale (Buddhist-era vs Gregorian already matters for TH).
- **Server side.** Add `locale` to **user prefs** and a **tenant default locale**; `GET/PUT /api/i18n/locale`
  (self) resolves *user → tenant → 'th'*. Expose the supported-locale list from the API so it's one source of truth.
- **Data model.** Additive columns only: `users.locale text`, `tenants.default_locale text`. Migration `0093`.
- **Controls.** No GL; self-scoped writes; RLS unchanged. **Verification:** harness asserts locale resolution
  order + catalog completeness (no missing keys for shipped locales) + that `t()` falls back safely.
- **External deps:** none (translation *content* for new locales is data we can seed/stub; professional
  translation is a later content task). **Effort:** **M.**

### C2 · Country localization packs — Phase 21 · 🟡 Framework + stub
**Goal:** the Odoo *l10n* model — a country **pack** = Chart of Accounts seed + tax codes/rates + statutory
report templates + the e-invoicing adapter (C3) + locale (C1). Thailand is the **reference pack**; the
framework lets us add MY/SG/VN/ID/PH as data + an adapter, not a fork.

- **Architecture.** A `LocalizationPack` descriptor (declarative) + a `PackInstaller` service that applies it
  **transactionally** into a tenant (idempotent, re-runnable):
  ```ts
  export interface LocalizationPack {
    country: 'TH' | 'MY' | 'SG' | 'VN' | 'ID' | 'PH';
    version: string;
    chartOfAccounts: CoASeed[];        // account code/name/type/parent
    taxCodes: TaxCodeSeed[];           // rate, base, reporting box
    statutoryReports: ReportTemplateRef[];
    einvoiceProviderKey?: string;      // → C3 ProviderRegistry, e.g. 'einvoice.my.myinvois'
    locale: string;                    // → C1
  }
  ```
- **Data model.** `localization_packs` (catalog: country, version, status `draft|certified`), `tenant_localization`
  (active pack per tenant + applied_at). Packs themselves ship as **versioned seed files**, not rows. Migration `0094`.
- **Controls.** Applying a pack **never posts to the GL** (it seeds *configuration* — accounts/tax codes — not
  balances); RLS-scoped; audited; CoA seed respects existing maker-checker before any posting happens later.
- **Verification:** harness installs the **TH reference pack** into a fresh tenant and asserts CoA/tax-code
  presence + idempotent re-install + isolation. A **second pack (MY skeleton)** proves the framework generalizes.
- **External deps / out of scope 🔴:** *certified* CoA/tax/statutory content + legal sign-off **per country** is
  accounting/legal work, not code. We ship the framework + TH (certified) + one **skeleton** pack marked
  `draft`. **Effort:** **L** (framework M; each certified country is an ongoing content engagement).

### C3 · Pluggable tax + e-invoicing engine — Phase 22 · 🟡 Framework + stub
**Goal:** put e-invoicing behind one provider interface so each market's regime is an adapter. Real regimes
(from public mandates): **TH** RD e-Tax Invoice/e-Receipt (shipped — becomes the first adapter), **MY** LHDN
MyInvois (UBL 2.1 + validation + QR), **SG** InvoiceNow (Peppol/IMDA), **VN** GDT verification-code invoices,
**ID** e-Faktur / CoreTax, **PH** BIR EIS.

- **Architecture.** `EInvoiceProvider extends ExternalProvider<Cfg, InvoiceDoc, SubmissionResult>` with
  `submit()/status()/cancel()`. A **stub provider** (registered always) validates the canonical `InvoiceDoc`
  shape and returns a deterministic `{ status: 'accepted', ref, qr }` so CI + no-credential tenants work. Real
  adapters map canonical→country format (UBL/Peppol/JSON), sign, submit, and persist the response.
- **Data model.** `einvoice_provider_config` (per tenant: provider key + **encrypted** credentials, like
  `tenant_identity`), `einvoice_submissions` (doc ref, provider, payload hash, status, response, RLS-scoped).
  Migration `0095`.
- **Controls.** Submission is **read-of-the-invoice → external send**, never a GL mutation; credentials encrypted
  at rest; every submission logged (IPE/audit); idempotent by doc ref. Reinforces existing tax controls.
- **Verification:** harness submits via the **stub** and asserts canonical validation, accepted/rejected paths,
  idempotency, isolation, no-GL. **External deps 🔴:** live submission needs each authority's credentials +
  conformance testing. **Effort:** **L** (engine + stub + TH adapter M; each live adapter is its own effort).

---

## 4. Pillar D — Ecosystem & Extensibility *(network-effect moat)*

### D1 · API maturity + developer portal — Phase 23 · 🟢 Buildable (mostly)
**Goal:** take the shipped v1 API from "exists" to "integrator-ready": self-serve key management UI, live
OpenAPI/Swagger docs, usage analytics, and **rate tiers**.

- **Architecture.** Reuse `/api/v1` + `PublicApiGuard`. Add a **developer portal** web surface (`/developer`):
  list/create/revoke keys (exists at `/api/platform/api-keys`), per-scope explanation, a rendered Swagger UI
  over the existing `openapi.json`, and a **usage panel**. Promote the in-process rate-limit to **named tiers**
  (`free|standard|partner`) on the key.
- **Data model.** `api_request_log` (key prefix, route, status, ts — for analytics/quotas; partition-friendly) +
  `api_keys.tier`. Migration `0096`. (Sandbox = a per-tenant flag/dataset, not new infra.)
- **Controls.** Same scope-gating + isolation as v1; the request log is tenant-scoped; no GL. **Verification:**
  harness asserts tier limits, usage logging, and that revoked keys 401. **External deps:** none for the portal;
  a *public* sandbox host is a deployment concern. **Effort:** **M.**

### D2 · Connector framework + reference connectors — Phase 24 · 🟡 Framework + stub
**Goal:** a first-class **inbound** integration framework (we have outbound webhooks): connect LINE, Shopee,
Lazada, Shopify, WooCommerce, QuickBooks/Xero, and bank statement import — each a `Connector` adapter over a
canonical model with encrypted creds, scheduled sync, idempotent upserts, and an event log.

- **Architecture.** `Connector extends ExternalProvider` with `pull(since)/push(entity)/handleWebhook(payload)`.
  A **canonical model** (Order, Product, Customer, Payment, StatementLine) + an **external-id map** so syncs are
  idempotent and bidirectional without duplicates. Each connector ships a **stub transport** (fixture in/out)
  that CI exercises; real transport is OAuth + REST. Bank import reuses the **Phase-7 dry-run validate→commit**
  pipeline with format parsers (ISO 20022 camt.053 / OFX / bank CSV).
  ```ts
  export interface Connector extends ExternalProvider<ConnectorCfg, SyncRequest, SyncResult> {
    readonly capabilities: ('orders'|'catalog'|'customers'|'payments'|'statements')[];
    pull(since: string): Promise<CanonicalBatch>;     // remote → canonical (stub: fixtures)
    push(batch: CanonicalBatch): Promise<PushResult>; // canonical → remote (optional)
    handleWebhook(sig: string, body: unknown): Promise<CanonicalBatch>;
  }
  ```
- **Data model.** `connectors` (type, status, **encrypted** creds), `connector_syncs` (run log), `external_id_map`
  (`(connector, canonical_type, local_id, external_id)` unique). Migration `0097`.
- **Controls.** Imported data lands as **drafts/staging** for human review before it affects AR/AP/GL (never
  auto-posts); creds encrypted; inbound webhooks **HMAC/signature-verified** (reuse the webhook scheme); RLS-scoped;
  idempotent. **Verification:** harness runs a **stub Shopee + a bank-CSV import** end-to-end (pull→canonical→staged),
  asserts idempotent re-pull, signature rejection, isolation, no-GL. **External deps 🔴:** live OAuth apps +
  partner API credentials per platform. **Effort:** **L** (framework M; each live connector M).

### D3 · App marketplace — Phase 25 · 🟡 Framework + stub (depends on D1, D2, A1–A5)
**Goal:** third parties publish apps (a scoped integration + a config bundle); tenants install them; partners
share revenue.

- **Architecture.** An **app** = listing metadata + requested scopes (→ API keys/scopes) + an optional **config
  pack** (reuse the E1 pack installer) + a billing plan (reuse `billing`). Install = issue a scoped key + apply
  the pack + add a billing line. Review/listing workflow reuses approval workflows (Phase 2).
- **Data model.** `marketplace_apps` (publisher, listing, scopes, status), `app_installs` (tenant, app, key ref,
  installed_at), revenue via existing billing. Migration `0098`.
- **Controls.** Installs are **scope-gated** (the user consents to scopes, like OAuth); partner payouts run
  through billing (no direct GL poke); RLS + audit. **Verification:** harness publishes a stub app, installs it
  (key issued + pack applied + billing line), uninstalls (key revoked). **External deps 🔴:** real partner
  onboarding, payout contracts, and a public storefront. **Effort:** **L** — *recommend deferring until D1+D2
  ship and there's partner demand* (matches the roadmap's "yr 2+").

---

## 5. Pillar E — Experience, Onboarding & Trust *(win & keep SMBs)*

### E1 · Guided onboarding + industry template packs — Phase 26 · 🟢 Buildable
**Goal:** an in-app guided setup + one-click **industry packs** (restaurant / retail / distribution / services)
that seed a working configuration — the #1 SMB activation driver.

- **Architecture.** A `TemplatePack` (declarative bundle: custom objects + layouts (A1/A2), doc templates (A3),
  alert rules (#3), dashboards (#5), saved views, sample master data) applied by a transactional, **idempotent**
  `PackInstaller` (shared with C2). An **onboarding checklist** tracks per-tenant progress (connect branding,
  add first product, run first sale, invite a user…). `GET /api/onboarding`, `POST /api/onboarding/apply-pack`,
  `POST /api/onboarding/steps/:key/complete`.
- **Data model.** `onboarding_progress` (tenant, step, done_at), `template_packs` (catalog), `pack_installs`
  (tenant, pack, version). Migration `0099`.
- **Controls.** Packs seed **configuration + sample data only** (no GL); idempotent; RLS; audited; sample data is
  clearly tagged and removable. **Verification:** harness applies the restaurant pack to a fresh tenant and
  asserts the objects/dashboards/alerts exist + idempotent re-apply + isolation. **Effort:** **M.**

### E2 · Data-migration toolkit — Phase 27 · 🟢 Buildable (🟡 for vendor-specific exports)
**Goal:** productize Phase-7 import into a guided **migrate-from** flow with source adapters
(Excel/CSV, FlowAccount, Loyverse, QuickBooks) + field mapping — removing the biggest switching barrier.

- **Architecture.** A `MigrationSource` adapter normalizes a vendor export → canonical rows → the existing
  **dry-run validate → preview → commit** pipeline; a **field-mapping** step (saved per source) handles schema
  drift. Adapters for the common CSV/Excel shapes are deterministic; vendor formats are parsed from sample
  exports.
- **Data model.** `migration_jobs` (source, entity, mapping json, status, counts), reuse import internals.
  Migration `0100`.
- **Controls.** Dry-run first (no writes until commit); per-row validation (reuse Phase-7 codes); idempotent;
  RLS; no GL. **Verification:** harness migrates a sample Loyverse/Excel product+customer export through
  validate→commit and asserts counts + error accumulation + isolation. **External deps 🟡:** exact vendor export
  formats need real sample files to harden. **Effort:** **M.**

### E3 · Mobile-first companion (PWA) — Phase 28 · 🟢 Buildable
**Goal:** an installable PWA for approvals, dashboards, and warehouse scan — unifying offline-POS + mobile-scan
into one mobile story.

- **Architecture.** A `manifest.webmanifest` + a **service worker** (app-shell + offline cache; reuse the
  existing `offline` queue for writes), install prompt, and **push** via the notification inbox. No new backend
  model — it's a client capability over existing APIs. Scope v1 to approvals + KPIs + scan (the high-value mobile
  flows).
- **Controls.** Offline writes use the existing idempotent offline-sync queue (no double-post); auth unchanged.
  **Verification:** build asserts manifest + SW register; a harness/e2e checks the offline queue replays. **Effort:** **M.**

### E4 · White-label / full theming — Phase 29 · 🟢 Buildable
**Goal:** extend Phase-9 branding + Phase-10 doc templates to **full theming**: color tokens, fonts, logo,
**login page**, **email templates**, and (optionally) a **custom domain** — enabling a reseller/partner channel.

- **Architecture.** A per-tenant **theme token set** (resolved into CSS variables at load, like `next-themes`
  already wires dark mode) + themable login + email-template overrides (reuse the doc-template renderer pattern).
  `GET/PUT /api/tenant/theme`. Custom domain is a config record + a deployment/DNS step (the record is buildable;
  the cert/DNS is ops).
- **Data model.** `tenant_theme` (tokens json) or extend `tenants.branding_prefs`; `email_templates` (per
  doc_type, like document_templates). Migration `0101`.
- **Controls.** Presentation-only (no GL); RLS self-scoped; logo/asset URLs validated + output-encoded (reuse the
  Phase-9 hardening). **Verification:** harness asserts theme resolution + email-template render + that a tenant
  can't read another's theme. **External deps 🟡:** custom-domain TLS/DNS is ops. **Effort:** **M.**

### E5 · Scale & reliability — Phase 30 · 🟡 Framework + ops
**Goal:** the upmarket scale story — cache/queue/limit externalized, hot tables partitioned, SLOs observable.

- **Architecture (app-side, buildable).** A **cache interface** (in-memory default → Redis adapter, the provider
  pattern again), a **job-queue interface** (in-process default → Redis/BullMQ adapter) for sweeps
  (alerts/reports/webhooks/connector syncs), promote the per-key rate-limit to the shared store, add
  `/health` + `/metrics` (readiness/liveness + Prometheus). **Partitioning** DDL for `audit_log` + sales by
  month. **Ops-side (not code 🔴):** provisioning Redis + read replicas on Alibaba (Bangkok), SLO targets/alerting.
- **Controls.** No behavior change to the books; partitioning preserves the append-only audit guarantee.
  **Verification:** harness asserts the cache/queue interfaces work with the in-memory default (CI) + a unit test
  for the Redis adapter shape. **External deps 🔴:** managed Redis/replicas (deployment + cost — fits the
  lean-then-scale Alibaba plan in memory). **Effort:** **L** (interfaces M; infra is ops).

### E6 · Certifications (SOC 2 / ISO 27001) — workstream, not a phase · 🔴 External
**Goal:** audit-readiness. **This is not a code deliverable** (your deployment memo already defers SOC2). What we
*can* build: a **control-mapping** from the existing SOX RCM + ITGC controls to **SOC 2 Trust Services Criteria**
and **ISO 27001 Annex A**, plus **evidence-collection tooling** (export access reviews, audit-log samples,
change-management records the app already produces). The audit, the auditor, and the certificate are external,
multi-month, and out of scope here. **Effort:** documentation/tooling **M**; certification **external**.

---

## 6. Recommended build sequence & dependency graph

```
C1 i18n ──┬── C2 country packs ──── C3 e-invoicing engine
          │        │                      (adapters per country: external)
          │        └──────────────┐
E1 onboarding packs ◄── (shared PackInstaller) ──┘
E4 white-label   (independent; reuses branding/doc-templates)
E2 migration     (independent; reuses Phase-7 import)
E3 PWA           (independent; reuses offline/notifications)
D1 API maturity ──── D2 connector framework ──── D3 marketplace
E5 scale         (independent; mostly interfaces + ops)
E6 certs         (external; depends on nothing code-wise)
```

**Suggested order (each its own PR, A/B cadence):**
1. **C1** (unblocks all SEA work) → **E4** (high-visibility, self-contained) → **E1** (activation; shared installer).
2. **D1** (matures the shipped API) → **D2 framework + 1 stub connector + bank-CSV** → **E2** (migration).
3. **C2 framework + TH pack + 1 skeleton** → **C3 engine + stub + TH adapter** → **E3 PWA**.
4. **E5 interfaces** (Redis/queue/health) when scale demands it; **D3** and **live C3/D2 adapters** + **E6** as
   demand/contracts/audit windows arrive (roadmap "yr 2+").

**Net new migrations:** `0093`–`0101` (nine), each additive + RLS-looped. **Net new Platform Phases:** 20–30.

---

## 7. Cross-cutting verification & docs plan (per phase, per CLAUDE.md)

Each phase, on delivery: a cutover-harness block (likely a new `ecosystem`/`localization` suite alongside `ext`
to keep `ext` focused); narrative updates (a **new** process-narrative `28-localization` and `29-ecosystem`
rather than overloading `27`); user-manual chapter(s); UAT cases + traceability; and a compliance-harness/RCM
touch **only** where a real control changes (C3 submission integrity; D2 import-staging; E6 mapping).

---

## 8. Decisions I need from you before building

These genuinely change the build — I'd like your call (defaults I'd otherwise take in **bold**):

1. **i18n engine (C1):** adopt **`next-intl`** (ICU, SSR-friendly, standard) *or* keep the homegrown provider
   backed by catalog files (smaller, zero-dep)? — **default: extend homegrown** (lower risk, keeps `t()` sites).
2. **First non-TH market (C2/C3):** which country pack to build as the first real adapter — **MY (MyInvois)**,
   SG (InvoiceNow/Peppol), or VN? — **default: MY** (largest near-term mandate pressure).
3. **First connectors (D2):** which 2–3 to prioritize — **LINE + Shopee + bank-CSV**, or Shopify/Woo, or
   QuickBooks/Xero? — **default: LINE + Shopee + bank-CSV** (SEA SMB reality).
4. **Marketplace (D3):** build the framework now, or **defer to yr-2** per the roadmap? — **default: defer.**
5. **Scale (E5):** provision **managed Redis on Alibaba (Bangkok)** now, or build the interfaces and stay
   in-process until load demands it? — **default: interfaces now, infra when needed** (lean-then-scale).
6. **E6:** do you want the **control-mapping + evidence tooling** built now (audit-prep), or parked until a
   certification window is funded? — **default: park; note as follow-up.**

---

## 9. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-24 | Platform / Product | Initial architecture + specification for Pillars C–E (Phases 20–30): per-initiative goal, interfaces, data model, API, controls, verification, external-dependency tagging (🟢/🟡/🔴), sequencing, and the open decisions in §8. Direction checkpoint before build, per the chosen "architecture + specs first" scope. Grounded in the shipped A/B code (i18n.tsx, public API v1, webhooks, branding, Phase-7 import, tax-docs, offline). |
