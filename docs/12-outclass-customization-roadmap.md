# 12 — Outclass-the-Market Customization Roadmap (Platform Phase 10+)

> **Date:** 2026-06-24 · **Status:** DRAFT v0.1 · **Owner:** Platform / Product
> **Scope:** Define the customization & differentiation roadmap that takes Invisible ERP V2 from
> *feature-complete* to *market-winning*, building on the delivered world-class foundations
> (`09-worldclass-roadmap.md`, `11-next-upgrade-realworld-roadmap.md`) and the shipped Platform
> Customization track (`process-narratives/27-platform-customization.md`, Phases 1–9).

---

## 0. Read this first — where we actually are

The hard parts are **done**. Per `11-next-upgrade-realworld-roadmap.md` (verified 2026-06-23): DB-enforced
RLS, double-entry GL with maker-checker, real payments, Thai fiscal compliance, a 66-control SOX RCM, and
the agentic-write differentiator are all built and CI-gated. The **Platform Customization** track (Phases
1–9) already lets a tenant adapt the ERP without code: custom fields, approval workflows, alert rules,
scheduled reports + saved views, role dashboards, audit viewer, validated bulk import, outbound webhooks,
and org branding.

**So "outclass the market" is not a feature-count problem.** This app is already broader than most
commercial ERP/POS suites. The gap between *feature-complete* and *market-winning* is five things — depth
of self-service customization, an AI-native UX, SEA localization, an ecosystem, and onboarding/trust — none
of which is "another module."

> **The bet (one line):** Win as **the ERP a customer (or partner) can reshape themselves** — a no-code
> Studio + an AI that configures it for you + SEA-wide localization + an open ecosystem — on top of the
> trustworthy, audited books we already have. Incumbents (Odoo/NetSuite) have the Studio but thin AI;
> the local Thai players (FlowAccount/PEAK, Loyverse/StoreHub) have neither the depth nor the controls.

---

## 1. The five pillars

Each initiative maps to a **Platform Phase** (continuing the 1–9 cadence) and the strategic tier (T1–T3)
from `09-worldclass-roadmap.md`.

### Pillar A — No-Code Customization Studio *(the ERP moat)*
Turn Phases 1–9 into a true Studio a customer can reshape without code.

| ID | Initiative | Builds on | Why it wins |
|----|-----------|-----------|-------------|
| **A3** | **Document template designer** — customize receipts/invoices/POs/quotes/payslips | Phase 9 branding | #1 recurring ERP request; bounded; visible. **(Phase 10 — delivered, §4)** |
| **A1** | **Custom objects/entities** — tenant-defined records (not just fields) | Phase 1 custom fields | Lets a tenant model what we never shipped — Odoo's core stickiness |
| **A2** | **Form & layout designer** — drag-drop fields/sections per entity per role | A1 | The "Studio" experience buyers expect; kills service requests |
| **A4** | **Rules & automation engine** — computed/validation fields + "when X then Y" | Phases 2/3 | One automation fabric over the alert + workflow engines |
| **A5** | **Self-service report/pivot builder** over a governed semantic layer | Phases 4/5 | Ad-hoc BI without exporting to Excel |

### Pillar B — AI-Native ERP *(the 2026 differentiator)*
| ID | Initiative | Why it wins |
|----|-----------|-------------|
| **B1** | **Embedded copilot on every screen** (explain variance, draft this PO) | AI as the interface, not a destination |
| **B2** | **Document AI intake** — OCR vendor invoices → AP, receipts → expenses | The demo that closes deals; incumbents are weak here |
| **B3** | **NL → analytics** over the A5 semantic layer (cite-the-numbers) | "Top 5 loss-making SKUs in Bangkok last quarter?" |
| **B4** | **AI configuration assistant** — describe a workflow → it builds the Studio config | Makes the A-pillar moat 10× more accessible |
| **B5** | **Continuous controls monitoring** — duplicate invoices, split-PO dodging, ghost vendors | Differentiator *and* strengthens the SOX/ICFR story |

### Pillar C — Localization & Compliance Packs *(the SEA expansion engine)*
| ID | Initiative | Why it wins |
|----|-----------|-------------|
| **C1** | **Real i18n framework** (ICU/next-intl), per-tenant/user locale | Strings are TH/EN-hardcoded today — prerequisite for every other market |
| **C2** | **Country localization packs** (Odoo l10n model): CoA, tax, statutory reports, e-invoicing — TH ✓ → MY/SG/VN/ID/PH | Sell one product across SEA instead of forking |
| **C3** | **Pluggable tax + e-invoicing engine** behind a provider interface | Deal-maker for cross-border SMBs (pulls T2 forward) |

### Pillar D — Ecosystem & Extensibility *(network-effect moat)*
| ID | Initiative | Why it wins |
|----|-----------|-------------|
| **D1** | **Public API + OpenAPI + versioning + developer portal** (sandbox, rate tiers) | We have keys+webhooks; this makes us integrable + marketplace-ready |
| **D2** | **Connector framework + marquee connectors**: LINE, Shopee/Lazada, Shopify/Woo, QuickBooks/Xero, bank import | Meets SEA SMBs where they operate |
| **D3** | **App marketplace** with partner revenue share | The long-game moat (Odoo/Salesforce) — needs A1–A5 + D1 |

### Pillar E — Experience, Onboarding & Trust *(win & keep SMBs)*
| ID | Initiative | Why it wins |
|----|-----------|-------------|
| **E1** | **Guided onboarding + industry template packs** (restaurant/retail/distribution/services) | #1 driver of SMB activation; local rivals do this poorly |
| **E2** | **Data-migration toolkit** (productize Phase 7 import: Excel/FlowAccount/Loyverse/QuickBooks) | Removes the biggest switching barrier |
| **E3** | **Mobile-first companion (PWA)** — approvals, dashboards, warehouse scan | Unifies offline-POS + mobile-scan into one story |
| **E4** | **White-label / full theming** (colors, fonts, domains, login, emails) | Enables a reseller/partner channel — strong SEA GTM |
| **E5/E6** | **Scale/reliability** (Redis, replicas, partitioning, SLOs) + **certs** (SOC 2 / ISO 27001) | Required upmarket; sequence per the lean-then-scale plan |

---

## 2. Sequencing (respects the lean-then-scale, Bangkok/Alibaba budget)

- **Wave 1 — "Adaptable & sticky" (next 1–2 quarters):** `A3` → `A1+A2` → `E1` → `D2 (LINE + 1 e-commerce + 1 accounting)` → `B2`.
- **Wave 2 — "Intelligent & global":** `C1` → `C2 (first extra country)` → `A4 + A5` → `B1/B3/B4` → `D1`.
- **Wave 3 — "Scale & ecosystem" (yr 2+):** `C3` → `D3` → `E4` → `E5/E6` → `B5`.

---

## 3. Cross-cutting principle (non-negotiable)

Every phase ships as **code + docs + controls** in the same change (per `CLAUDE.md`): update the owning
process narrative, the user manual, the UAT cases + traceability, and the RCM/compliance harness where a
control is affected. Customization that touches financially-significant documents (tax invoices, POs) must
be **presentation-only** — never altering amounts, never omitting a legally-mandatory field — and must post
nothing to the GL. That discipline is itself part of "outclass."

---

## 4. Phase 10 — Document template designer (A3) · **DELIVERED 2026-06-24**

*Goal: a tenant customizes how customer-facing documents look, no code, without ever changing the numbers.*

- **What shipped:** a no-code, **presentation-only** template designer. The **receipt** (`ใบเสร็จรับเงิน`)
  is live end-to-end; abbreviated/full tax invoices, quotations, POs and payslips are authorable now and
  rendered as their wiring lands (catalog marks them `planned`).
- **Knobs (receipt):** show logo, extra header note, show/hide branch · address · tax-id, accent colour,
  body font scale, custom thank-you + up to 5 extra footer lines, paper width. One template per
  `(tenant, doc_type)` is the **default** consumed at render time.
- **Guarantees:** a template can **never change amounts** and **never blanks the core** (seller name +
  total always render; mandatory tax-document fields never omitted); it posts **nothing** to the GL; every
  row is **RLS-scoped**; mutations ride the **audit log**.
- **API:** `GET /api/document-templates` (+ `/doc-types`, `/active?doc_type=`), `POST`, `PUT /:id`,
  `POST /:id/default`, `DELETE /:id`, `POST /preview` (live sample render). Perm `users`/`exec`.
- **Architecture:** the receipt renderer was extracted to a pure module `printing/receipt-render.ts`
  shared by the **live render** (`ReceiptService`) and the **designer preview** (`DocumentTemplatesService`)
  — one source of truth, no DI cycle. Default config reproduces the prior output exactly.
- **Files:** schema `database/schema/document-templates.ts`; migration `drizzle/0088_document_templates.sql`
  (new tenant table + RLS loop); module `modules/document-templates/*`; render `modules/printing/receipt-render.ts`;
  web `app/(internal)/document-templates/page.tsx` + nav.
- **Verification:** `ext` harness +11 checks (catalog, create→default, active, preview, **core-integrity with
  an empty template**, hide-tax-id, permission gate, RLS isolation, **no-GL delta**) — **115/115 green**.
  Existing branding/receipt checks still pass through the refactored path.
- **Docs:** `process-narratives/27-platform-customization.md` §7.10 (+RACI, control matrix, error codes,
  revision 0.2); user manual `12-platform-customization.md`; UAT `08-admin-sod-uat.md` UAT-ADM-040/041 +
  traceability. No new RCM control (operational/presentation; reinforces REST-10 receipt tie-out — unaffected).
- **Deferred (next increment of Phase 10):** template-driven rendering for abbreviated/full tax invoices
  (presentation-only, mandatory fields preserved), quotations, POs, payslips; logo file upload to object
  storage (today a pasted https URL / data-URI, per Phase 9).

---

## 5. Phase 11 — Custom objects (A1) · **DELIVERED 2026-06-24**

*Goal: let a tenant model records we never shipped — the real Studio moat.*

- **What shipped:** tenant-defined record types with no code. A tenant defines an **object**
  (`custom_objects`), gives it fields, and captures **records** (`custom_object_records`). An object's
  fields + typed values **reuse the Phase 1 custom-fields store** (entity = `object_key`), so the same
  type/required/select-option validation applies for free; records carry a registry id + display name so
  they list cleanly. RLS-scoped, audited, **no GL**.
- **API:** `GET/POST /api/custom-objects`, `GET/DELETE /api/custom-objects/:key`,
  `GET/POST /api/custom-objects/:key/records`, `GET/PUT/DELETE /api/custom-objects/:key/records/:id`;
  field defs via the existing `/api/custom-fields`. Perm `masterdata`/`users`/`exec`.
- **Files:** [custom-objects.ts](apps/api/src/database/schema/custom-objects.ts) · migration
  [0089_custom_objects.sql](apps/api/drizzle/0089_custom_objects.sql) · [custom-objects module](apps/api/src/modules/custom-objects/custom-objects.service.ts)
  (reuses `CustomFieldsService`) · web [custom-objects/page.tsx](apps/web/src/app/(internal)/custom-objects/page.tsx) + nav.
- **Verification:** `ext` harness +13 checks (define, dup, fields-via-reuse, record create/list/get/update/
  delete, reused `BAD_OPTION` + `REQUIRED_FIELD`, RLS isolation, no-GL) — **128/128 green**.
- **Docs:** narrative 27 §7.11 (+RACI/control-matrix/codes, revision 0.3); user manual ch.12; UAT ADM-042/043 + traceability.

## 5b. Phase 12 — Form & layout designer (A2) · **DELIVERED 2026-06-24**

*Goal: lay out a custom object's form — sections, order, columns, hide — per role.*

- **What shipped:** a no-code form/layout designer for custom objects (Phase 11). Arrange fields into
  **sections**, set 1/2-**column** layout, **reorder**, **hide** fields, and optionally target a **role**.
  The config is presentation-only and **resolved against the object's live field defs** at render time — so a
  newly-added field always surfaces (appended) and stale references drop. The custom-object data-entry form
  now **renders by the resolved layout** (for the viewer's role). RLS-scoped, audited, **no GL**.
- **API:** `GET /api/object-layouts` (+ `/resolve?object_key=&role=`), `POST`, `PUT /:id`,
  `POST /:id/default`, `DELETE /:id`, `POST /preview`. Perm `masterdata`/`users`/`exec`.
- **Files:** [object-layouts.ts](apps/api/src/database/schema/object-layouts.ts) · migration
  [0090_object_layouts.sql](apps/api/drizzle/0090_object_layouts.sql) · [object-layouts module](apps/api/src/modules/object-layouts/object-layouts.service.ts) ·
  web [object-layouts/page.tsx](apps/web/src/app/(internal)/object-layouts/page.tsx) (designer + live preview) +
  the [custom-objects form](apps/web/src/app/(internal)/custom-objects/page.tsx) now renders by layout + nav.
- **Verification:** `ext` harness +9 checks (built-in fallback, create→default, resolve applies sections +
  hides a field, **a newly-added field auto-surfaces**, preview-without-save, RLS isolation, no-GL) — **137/137 green**.
- **Docs:** narrative 27 §7.12 (+RACI/control-matrix/codes, revision 0.4); user manual ch.12; UAT ADM-044/045 + traceability.

## 5c. Phases 13–19 — Pillar A finish (A4/A5) + Pillar B (AI-native) · **DELIVERED 2026-06-24**

*Goal: complete the no-code Studio and make the ERP AI-native — without weakening the audited books.*

**Pillar A — completed:**
- **Phase 13 · A4 — Automation rules engine.** No-code "when EVENT [and CONDITION] then ACTION" over the events the app emits (`po.approved/rejected`, `alert.fired`); actions = notification / message / log (non-GL), via a guarded webhook-dispatcher hook + `/api/automation/run-event`. Tables `automation_rules` + `automation_executions` (migration `0091`).
- **Phase 14 · A5 — Semantic layer + report builder.** Governed measures × dimensions over POS sales; safe RLS-scoped aggregate (keys map to fixed SQL — only filter values parameterized); saved reports reuse saved-views. `/api/query/model` + `/api/query/run`.

**Pillar B — AI-native** *(all read-only / suggestion-only / human-in-the-loop; each degrades deterministically with no `ANTHROPIC_API_KEY`, so CI is offline-safe):*
- **Phase 15 · B1 — Embedded copilot** (`/api/copilot/ask`) — KB-grounded, cite-or-refuse; reuses the RAG `KnowledgeService` + agent.
- **Phase 16 · B2 — Document-AI intake** (`/api/doc-ai/extract`) — pasted invoice → structured AP draft (Claude or regex); **extract-only**, never posts.
- **Phase 17 · B3 — NL analytics** (`/api/nl-analytics/ask`) — plain language → the A5 governed query (no raw SQL).
- **Phase 18 · B4 — AI configuration assistant** (`/api/ai-config/suggest`) — describe → proposed Studio config JSON; **suggestion-only**.
- **Phase 19 · B5 — Continuous controls monitoring** (`/api/controls/*`) — detective scans (duplicate invoice/amount, ghost vendor) → findings for review; RLS-scoped, no GL. Table `control_findings` (migration `0092`).

- **Verification:** `ext` harness **208/208 green** (+15 for B1–B5); `pnpm -r typecheck` + `@ierp/api` / `@ierp/web` builds clean; the full suite (e2e / worldclass / compliance / restaurant / taxdocs) stays green. All RLS-scoped, audited, **no GL**.
- **Docs:** narrative 27 §7.16–7.22 (twenty-two capabilities; +RACI / control-matrix / error-codes, revisions 0.8–1.0); user manual ch.12; UAT ADM-062…070 + traceability. B5 is noted as a detective-control aid (formal RCM control-ID assignment is a planned follow-up).

**Pillars A–E software is complete** (see the revision history): A1–A5 (Studio), B1–B5 (AI-native), C1–C3 (localization), D1–D2 (ecosystem), E1–E5 (experience) — 24 platform phases. **Deferred by design** (per §8 defaults): **D3** app marketplace + **E6** SOC 2 / ISO 27001 certification, plus the *external* follow-ups each 🟡 phase names (certified per-country content, live 3rd-party + tax-authority credentials, managed Redis/replicas) — none of which are code deliverables.

> **Detailed C–E architecture & specs:** [`13-pillars-cde-architecture-spec.md`](./13-pillars-cde-architecture-spec.md) — per-initiative interfaces, data models, API surfaces, controls, verification approach, and an honest 🟢/🟡/🔴 tag for what's fully buildable vs framework-+-stub vs external-only (SOC2/ISO audit, live 3rd-party creds, statutory sign-off). §8 there lists the open decisions needed before the build starts.

---

## 6. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-24 | Platform / Product | Initial outclass roadmap: 5 pillars (Studio / AI-native / localization / ecosystem / experience), 3 waves. Records **Phase 10 (A3 document templates) as delivered** and sketches **Phase 11–12 (A1/A2 custom objects + form designer)** as next. Builds on Platform Phases 1–9 and the T0–T3 world-class roadmap. |
| 0.2 DRAFT | 2026-06-24 | Platform / Product | **Phase 11 (A1 custom objects) delivered** — tenant-defined record types reusing the Phase 1 custom-fields typed store; 128/128 `ext` checks. **Phase 12 (A2 form/layout designer) is next.** |
| 0.3 DRAFT | 2026-06-24 | Platform / Product | **Phase 12 (A2 form/layout designer) delivered** — per-object/per-role layouts (sections, columns, order, hide) resolved against live field defs; the custom-object form renders by the layout; 137/137 `ext` checks. **Wave 1 (A3 → A1 → A2) complete.** |
| 0.4 DRAFT | 2026-06-24 | Platform / Product | **Phases 13–14 (A4 automation + A5 semantic-layer reports) delivered** — Pillar A complete (merged via PR #50); 193/193 `ext`. |
| 0.5 DRAFT | 2026-06-24 | Platform / Product | **Pillar B (AI-native) delivered** — Phases 15–19: embedded copilot, document-AI intake, NL analytics, AI configuration assistant, continuous controls monitoring; all read-only / suggestion-only / human-in-the-loop with deterministic no-key fallbacks. 208/208 `ext`; typecheck + builds clean. **Pillars A & B complete.** §5c added. |
| 0.6 DRAFT | 2026-06-24 | Platform / Product | Added the **Pillars C–E architecture & specification** (`13-pillars-cde-architecture-spec.md`, Phases 20–30) as a direction checkpoint before build: provider/adapter interfaces, data models, migrations `0093`–`0101`, controls, verification, 🟢/🟡/🔴 dependency tagging, recommended sequence, and the §8 decisions. No code yet — awaiting direction. |
| 0.7 DRAFT | 2026-06-24 | Platform / Product | **C–E build started (defaults accepted) — Phases 20 + 29 delivered:** **C1 i18n / locale framework** (per-locale catalog th/en/ms/vi/id, server-resolved user → tenant → th, `users.locale` migration `0093`; narrative `28-localization`) and **E4 white-label theming** (per-tenant brand hue → in-gamut oklch, radius/name/logo/tagline applied app-wide, `tenants.theme_prefs` migration `0094`; narrative `30-experience`). Read-only / presentation-only, RLS-scoped, no GL; `ext` 208 → **217**; UAT ADM-071/072. |
| 0.8 DRAFT | 2026-06-24 | Platform / Product | **C–E Wave 2 — Phases 26 + 23 delivered:** **E1 onboarding + industry packs** (setup checklist + one-click packs idempotently seeding custom objects; `onboarding_progress`/`pack_installs` migration `0095`; narrative `30`) and **D1 API maturity / developer portal** (portal over the shipped v1: keys + rate tiers, scopes, endpoints, OpenAPI; `api_keys.tier` migration `0096`; new narrative `29-ecosystem`). RLS-scoped, no GL; `ext` 217 → **228**; UAT ADM-073/074. |
| 0.9 DRAFT | 2026-06-24 | Platform / Product | **C–E Wave 3 — Phases 24 + 27 delivered:** **D2 connector framework** (register/sync LINE·Shopee·bank-CSV over a canonical model, stub transport, idempotent per-tenant `external_id_map`, never auto-posts; tables migration `0097`; narrative `29`) and **E2 data-migration toolkit** (source adapters → canonical → dry-run validation + job log, preview before the Phase-7 commit; `migration_jobs` migration `0098`; narrative `30`). RLS-scoped, no GL; `ext` 228 → **240**; UAT ADM-075/076. |
| 1.0 DRAFT | 2026-06-24 | Platform / Product | **C–E Wave 4 — Phases 21 + 22 delivered:** **C2 country localization packs** (Odoo l10n model — CoA/tax/statutory/e-invoice/locale per country; TH certified + MY draft; applying sets tax country + locale; `tenant_localization` migration `0099`) and **C3 pluggable e-invoicing engine** (provider interface + stub default + TH/MY/SG adapters; canonical-invoice submit, idempotent by doc_ref; `einvoice_config`+`einvoice_submissions` migration `0100`). Both narrative `28`; RLS-scoped, no GL; `ext` 240 → **248**; UAT ADM-077/078. Certified per-country content + live authority credentials are external follow-ups. |
| 1.1 DRAFT | 2026-06-24 | Platform / Product | **C–E Wave 5 (final) — Phases 28 + 30 delivered:** **E3 mobile PWA** (installable `manifest.webmanifest` + icon + app-shell SW registration; offline-capable, pairs with the offline-POS outbox) and **E5 scale interfaces** (`CacheService` in-memory default + Redis-swappable; ops metrics endpoint; health probes already shipped). No new migration; `ext` 248 → **250**; UAT ADM-079/080. **Pillars C, D, E software complete** — C1–C3, D1–D2, E1–E5 (10 phases, migrations `0093`–`0100`, `ext` 208 → 250). Deferred per the §8 defaults: **D3** app marketplace + **E6** SOC 2 / ISO 27001 certification (external). |
