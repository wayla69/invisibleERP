# SOC 2 Type II Readiness — Invisible ERP V2

**Entity:** Invisible Consulting — Oshinei Enterprise ERP
**System in scope:** Invisible ERP V2 (NestJS API · Next.js web · Drizzle · PostgreSQL 16, multi-tenant RLS)
**Framework:** AICPA Trust Services Criteria (TSC) 2017 — Security (CC1–CC9); Availability (A1) noted
**Prepared:** 2026-06-28 · Version 0.1 DRAFT — for review with SOC 2 auditor / CPA firm
**Owner:** SOX PMO / Controller (to assign)
**Related:** `COSO_ICFR_Audit_Readiness_Plan.md` · `Oshinei_ERP_SOX_RCM_v1.xlsx` · `policies/`

> **Relationship to SOX work:** SOC 2 and SOX share most of their ITGC DNA. The <!-- rcm-total -->260<!-- /rcm-total -->-control RCM
> (<!-- rcm-implemented -->257<!-- /rcm-implemented --> Implemented; census: `build_rcm.py --counts`) built for SOX 404(a) is the primary evidence base for SOC 2. The gap between
> **Relationship to SOX work:** SOC 2 and SOX share most of their ITGC DNA. The <!-- rcm-total -->260<!-- /rcm-total -->-control RCM
> (<!-- rcm-implemented -->257<!-- /rcm-implemented --> Implemented; census: `build_rcm.py --counts`) built for SOX 404(a) is the primary evidence base for SOC 2. The gap between
> **Relationship to SOX work:** SOC 2 and SOX share most of their ITGC DNA. The <!-- rcm-total -->260<!-- /rcm-total -->-control RCM
> (<!-- rcm-implemented -->257<!-- /rcm-implemented --> Implemented; census: `build_rcm.py --counts`) built for SOX 404(a) is the primary evidence base for SOC 2. The gap between
> **Relationship to SOX work:** SOC 2 and SOX share most of their ITGC DNA. The <!-- rcm-total -->260<!-- /rcm-total -->-control RCM
> (<!-- rcm-implemented -->257<!-- /rcm-implemented --> Implemented; census: `build_rcm.py --counts`) built for SOX 404(a) is the primary evidence base for SOC 2. The gap between
> the two frameworks is narrower than it appears — SOC 2 adds service-organization-specific
> requirements (customer commitments, system description, availability) not in SOX. This document
> maps the existing controls to SOC 2 TSC, identifies the incremental evidence needed, and defines
> the path to a Type I report.

---

## 0. Read this first — SOC 2 Type I vs. Type II

| Report | What it covers | When you need it |
|---|---|---|
| **Type I** | Controls are **suitably designed** as of a point-in-time | First deliverable; needed for enterprise sales / investor due-diligence |
| **Type II** | Controls **operated effectively** over a ≥6-month period | Needed for enterprise contracts, regulated-industry customers, IPO readiness |

**Recommendation:** target a **Type I** report first (3–4 months engagement) covering the Security
category (CC1–CC9). Use the period that follows (observation window) to accumulate Type II evidence.
Extend scope to Availability (A1) in the Type II engagement.

---

## 1. System description (draft)

> The auditor will require a formal system description. This is the engineering input draft.

**Services provided:** multi-tenant cloud ERP and POS for Thai hospitality/retail SMEs. Customers
access via browser (Next.js web) and mobile; staff use the same web app. Data is partitioned by
tenant at the Row Level Security layer of PostgreSQL 16.

**Principal service commitments (from contracts / terms of service):**
- Financial data is isolated per tenant and inaccessible to other tenants
- The system is available during agreed business hours (uptime SLA to be formalised)
- Financial data is not disclosed to unauthorised parties
- Processing is complete, accurate, and timely (financial-close controls)

**System components in scope:**

| Component | Technology | Hosting |
|---|---|---|
| API | NestJS 10 (Fastify) · Node.js 22 | Railway (containerised, non-root) |
| Web | Next.js 14 (App Router) | Railway / Vercel |
| Database | PostgreSQL 16 · Drizzle ORM | Railway managed Postgres |
| Auth | JWT (HS256) + TOTP MFA | In-service (`auth.service.ts`) |
| Secrets | AES-256-GCM at rest; env-validated at boot | Railway secret store |
| PSP gateways | Stripe, Adyen, PromptPay EMVCo, Opn, 2C2P, GBPrime | External — not in SOC 2 scope |
| CI/CD | GitHub Actions — gated deploy pipeline | GitHub (SaaS) |

**Sub-service organisations (carved out):** Railway (hosting/infra), GitHub (source control / CI),
Stripe/Adyen/Opn/2C2P/GBPrime (payment processing). Complementary user entity controls (CUECs)
apply; each PSP carries its own SOC 2 / PCI-DSS report.

---

## 2. TSC control mapping — Security category (CC1–CC9)

### CC1 — Control Environment

| TSC point | Existing evidence | Evidence status |
|---|---|---|
| CC1.1 Commitment to integrity and values | ELC-POL-01 Code of Conduct v1.0 (effective 2026-07-01); acknowledgement-register template | ✅ Designed |
| CC1.2 Board oversight of ICFR / controls | ELC-POL-04 Audit Committee Charter (NASDAQ 5605(c)(2) + SEC 10A-3); audit committee established | ✅ Designed |
| CC1.3 Management's authority/responsibility | ELC-POL-03 Delegation of Authority (PO >50k / AP >100k / credit >500k) | ✅ Designed |
| CC1.4 Commitment to competence | `policies/README.md` training requirements; onboarding checklist in `docs/` | 🟡 Partial — formal training records needed |
| CC1.5 Accountability through performance | ELC-POL-01 §6 conduct procedures; SOX PMO to assign RACI | 🟡 Partial — RACI ownership assignment needed |

**Incremental actions:** (a) establish and document training records for finance + IT staff; (b) finalise SOX PMO RACI and document in a charter.

---

### CC2 — Communication and Information

| TSC point | Existing evidence | Evidence status |
|---|---|---|
| CC2.1 Information to support internal control | 30-cycle ISO process narratives in `docs/process-narratives/`; RCM in `Oshinei_ERP_SOX_RCM_v1.xlsx` | ✅ Designed |
| CC2.2 Communicates internally | ELC-POL-02 Whistleblower Policy; `compliance@invisible-erp.co.th` + `/compliance-reports` route | ✅ Designed |
| CC2.3 Communicates externally (to customers) | ToS (DRAFT v0.1), DPA (DRAFT v0.2), **privacy policy (DRAFT v0.1, `docs/legal/privacy-policy.md`)** + public `/legal/privacy` page linked from signup (docs/27 R0-2) | 🟡 Drafted — counsel review + publication pending |

**Incremental actions:** author Terms of Service and Privacy Policy (legal); publish a brief security whitepaper (link in the customer portal) describing the multi-tenant isolation model.

---

### CC3 — Risk Assessment

| TSC point | Existing evidence | Evidence status |
|---|---|---|
| CC3.1 Specifies suitable objectives | SOX 404(a) scope in `COSO_ICFR_Audit_Readiness_Plan.md` §1 | ✅ Designed |
| CC3.2 Identifies and analyses risks | ELC-POL-05 Fraud Risk Assessment (8 scenarios, residual ratings); RCM risk column | ✅ Designed |
| CC3.3 Assesses fraud risk | ELC-POL-05; SoD matrix R01–R16 | ✅ Designed |
| CC3.4 Identifies and analyses significant change | ELC-POL-08 Change Management/SDLC Policy; CM-01..05 controls | ✅ Designed |

---

### CC4 — Monitoring Activities

| TSC point | Existing evidence | Evidence status |
|---|---|---|
| CC4.1 Conducts ongoing and/or separate evaluations | 27-check automated compliance harness (`pnpm --filter @ierp/cutover compliance`); CI gate on every PR | ✅ Designed |
| CC4.2 Evaluates and communicates deficiencies | `PRE_PRODUCTION_AUDIT_2026Q2.md` (deficiency log + remediation tracking); risk register in RCM | ✅ Designed |

**Incremental actions:** formalise a quarterly control self-assessment (CSA) process; document evidence-retention policy (7 years for SOX; 3 years minimum for SOC 2).

---

### CC5 — Control Activities

| TSC point | Existing evidence | Evidence status |
|---|---|---|
| CC5.1 Selects and develops control activities | <!-- rcm-total -->260<!-- /rcm-total -->-control RCM with preventive + detective + automated split; per-cycle control matrices in narratives | ✅ Designed |
| CC5.1 Selects and develops control activities | <!-- rcm-total -->260<!-- /rcm-total -->-control RCM with preventive + detective + automated split; per-cycle control matrices in narratives | ✅ Designed |
| CC5.1 Selects and develops control activities | <!-- rcm-total -->260<!-- /rcm-total -->-control RCM with preventive + detective + automated split; per-cycle control matrices in narratives | ✅ Designed |
| CC5.1 Selects and develops control activities | <!-- rcm-total -->260<!-- /rcm-total -->-control RCM with preventive + detective + automated split; per-cycle control matrices in narratives | ✅ Designed |
| CC5.2 Selects general technology controls | ITGC-AC-01..16, ITGC-CM-01..05, ITGC-SD-01..03, ITGC-OP-01..04 | ✅ Designed |
| CC5.3 Deploys through policies and procedures | `policies/` (13 files, 5 v1.0 / 8 DRAFT); `docs/process-narratives/` (30 cycles) | 🟡 Partial — 8 DRAFT policies need v1.0 adoption |

**Incremental actions:** adopt the 8 DRAFT policies (POL-06..13) at v1.0; link each policy to the relevant RCM control ID.

---

### CC6 — Logical and Physical Access Controls

> This is the deepest criterion for a cloud SaaS. The existing ITGC-AC controls are the primary evidence base.

| TSC point | Existing evidence | RCM control | Evidence status |
|---|---|---|---|
| CC6.1 Logical access security | JWT auth + `JwtAuthGuard`; `PermissionsGuard`; 37+13 permissions | ITGC-AC-01/02 | ✅ Implemented + ToE harness |
| CC6.2 Authenticates with credentials | Scrypt password hashing; TOTP MFA for privileged roles | ITGC-AC-06 | ✅ Implemented + ToE harness |
| CC6.3 Authorises based on role | RBAC + per-user permission overrides | ITGC-AC-02 | ✅ Implemented |
| CC6.4 Considers network controls | Helmet, explicit CORS, rate-limiting; Railway network isolation | ITGC-AC-01 | ✅ Designed |
| CC6.5 Managed logical access control changes | User provisioning/deprovisioning via Admin UI; SoD preventive block | ITGC-AC-09/15 | ✅ Implemented + ToE harness |
| CC6.6 Considers access by external parties | Vendor portal gated by `vendor_portal` permission; PSPs are separate sub-service orgs | ITGC-AC-02 | ✅ Designed |
| CC6.7 Restricts transmission/movement of information | AES-256-GCM at rest (secrets); TLS in transit (Railway/Vercel enforce); RLS isolates tenant data | ITGC-AC-03/04 | ✅ Implemented |
| CC6.8 Prevents/detects unauthorised software | CI gate (CodeQL, gitleaks, `pnpm audit`); CODEOWNERS + branch protection | ITGC-CM-01/03 | ✅ Implemented |

**Incremental actions:** (a) formalise a user access review cadence (ITGC-AC-08 — quarterly recertification report exists; schedule it); (b) document physical access controls for Railway data-centre (rely on Railway's SOC 2 report as complementary).

---

### CC7 — System Operations

| TSC point | Existing evidence | RCM control | Evidence status |
|---|---|---|---|
| CC7.1 Detects and monitors new vulnerabilities | `pnpm audit` CI gate; `vulnerability-triage.md` (16 tracked); quarterly cadence | ITGC-SD-03 | ✅ Implemented |
| CC7.2 Monitors system components | OTel + Sentry wired; `/healthz` + `/readyz` probes; `observability-incident.md` alert runbook | ITGC-OP-03 | ✅ Designed — **[setup]** wire dashboards |
| CC7.3 Evaluates security events | Audit log + hash chain (`GET /api/admin/audit/verify`); append-only DB trigger | ITGC-AC-10/16 | ✅ Implemented + ToE harness |
| CC7.4 Responds to security incidents | `policies/10-incident-response-policy.md`; `observability-incident.md` runbook | ITGC-OP-03 | 🟡 Designed — incident response untested; needs tabletop drill |
| CC7.5 Identifies and rectifies software deficiencies | CI gates (83 checks); `PRE_PRODUCTION_AUDIT_2026Q2.md` deficiency log | ITGC-SD-03 | ✅ Implemented |

**Incremental actions:** (a) conduct and document an incident-response tabletop exercise; (b) formalise a penetration-test programme (third-party pen test is a C4 deliverable — see §4).

---

### CC8 — Change Management

| TSC point | Existing evidence | RCM control | Evidence status |
|---|---|---|---|
| CC8.1 Authorises and documents infrastructure/software changes | `.github/CODEOWNERS` + PR template (ticket + control-impact + docs-sync) + required reviews | ITGC-CM-01/03/04 | ✅ Implemented |
| CC8.1 Tests changes before deployment | 83-check CI suite; mandatory passing gate before merge | ITGC-CM-01/SD-03 | ✅ Implemented |
| CC8.1 Approves deployment | `deploy.yml` gated on GitHub `production` environment (deployer ≠ author) + an automated deploy-time `deployer≠author` assertion (`tools/ci/check-deploy-sod.mjs`, `--selftest`) as re-performable evidence | ITGC-CM-03 | ✅ Implemented (automated evidence) — **[setup]** configure environment reviewers for the hard-approval gate |
| CC8.1 Emergency change procedure | `change-management.md` emergency procedure + break-glass log | ITGC-CM-05 | ✅ Designed |
| CC8.1 Migration controls | Drizzle migrations hand-journaled; `migrations-journaled` CI gate catches duplicates | ITGC-CM-02 | ✅ Implemented |

---

### CC9 — Risk Mitigation

| TSC point | Existing evidence | Evidence status |
|---|---|---|
| CC9.1 Identifies and assesses risks with business objectives | RCM risk column; Fraud Risk Assessment; `COSO_ICFR_Audit_Readiness_Plan.md` | ✅ Designed |
| CC9.2 Assesses and manages vendor/business partner risk | `policies/12-third-party-vendor-management-policy.md` (DRAFT); PSP sub-service org carve-out | 🟡 Partial — vendor policy at DRAFT; formal vendor inventory needed |

**Incremental actions:** (a) adopt POL-12 at v1.0; (b) complete a vendor inventory with SOC 2 / PCI-DSS attestation status for each PSP and Railway/GitHub; (c) formalise annual vendor review process.

---

## 3. Availability criterion (A1) — scoping note

The **Availability** category adds three criteria (A1.1 performance capacity; A1.2 environmental threats; A1.3 recovery). When adding Availability to the scope:

| A1 point | Evidence needed |
|---|---|
| A1.1 Capacity / performance | Railway auto-scale config; load-test results; documented capacity review cadence |
| A1.2 Environmental / infrastructure threats | Railway SOC 2 / ISO 27001 report (complementary); BCP in `policies/09-backup-dr-bcp-policy.md` |
| A1.3 Recovery | `tools/ops/pg-backup.sh` + `restore.sh` + `verify-restore.sh`; quarterly drill; RTO/RPO documented in `BACKUP-RUNBOOK.md` |

**Recommendation:** add A1 in the Type II engagement once the Type I observation period is complete.

---

## 4. Gap summary and remediation roadmap

### Priority 1 — Type I blockers (needed before auditor engagement)

| # | Gap | Owner | Effort |
|---|---|---|---|
| 1 | 8 DRAFT policies (POL-06..13) need v1.0 board adoption | Legal/Board | S |
| 2 | Formal Terms of Service + Privacy Policy (CC2.3) | Legal | M |
| 3 | Evidence-retention policy (7-year SOX / 3-year SOC 2) | Controller | S |
| 4 | Production OTel dashboards + alert-rule wiring (CC7.2) | SRE | S |
| 5 | GitHub `production` environment reviewers configured (CC8.1) | DevOps | S |
| 6 | RACI chart and SOX PMO staffed (CC1.5) | Management | S |

### Priority 2 — Type II evidence accumulation (observation period)

| # | Gap | Owner | Effort |
|---|---|---|---|
| 7 | Quarterly user access review — run and document (CC6.5) | IT Admin | S |
| 8 | Monthly management variance review sign-off — run and document (ELC-06) | Controller | S |
| 9 | Incident response tabletop exercise (CC7.4) | CISO / Eng | S |
| 10 | Vendor inventory with attestation status (CC9.2) | Procurement | S |
| 11 | Third-party penetration test (CC7.4 / CC6.8 complement) | External firm | M |
| 12 | Training records for finance + IT staff (CC1.4) | HR | S |

### Priority 3 — Availability scope extension

| # | Gap | Owner | Effort |
|---|---|---|---|
| 13 | Load/performance test baseline + documented capacity review | Eng | M |
| 14 | BCP plan exercise (tabletop + restore drill documentation) | Ops | M |

---

## 5. Recommended engagement timeline

| Milestone | Target |
|---|---|
| Adopt DRAFT policies v1.0; author ToS/Privacy Policy | M+1 |
| Select SOC 2 auditor (CPA firm / licensed practitioner) | M+1 |
| Auditor readiness pre-assessment | M+2 |
| Type I observation date | M+3 |
| **Type I report issued** | M+4 |
| Type II observation window begins | M+4 |
| Third-party pen test | M+5 |
| **Type II report issued (6-month window)** | M+10 |

---

## 6. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-28 | Platform | Initial SOC 2 TSC mapping (CC1–CC9) leveraging existing 66-control RCM. Gap analysis and Type I/II roadmap. |
| 0.2 DRAFT | 2026-07-02 | Platform | Census reconciliation (docs/27 R3-1): RCM population corrected to the generated census (169/166 as of that date — the tagged census in CONTROL_STATUS_HONEST.md is the live figure) with machine-readable tags; CI guard `check-rcm-census.mjs` blocks drift. |
| 0.3 DRAFT | 2026-07-02 | Platform | **Operating-evidence clock STARTED (docs/27 R3-3 / AUD-CMP-03).** Every CI run of the `compliance` ToE harness now writes `compliance-evidence.json` (harness, commit, timestamp, all control checks pass/fail) and uploads it as build artifact `compliance-evidence-<sha>` (90-day GitHub retention). **Quarterly archive runbook:** each quarter-end, download the quarter's evidence artifacts and archive to durable storage (retention ≥ 15 months) so the ICFR/SOC-2 sampling window holds beyond GitHub's cap; record the archive location in the evidence register. The window of retained operating evidence accrues from 2026-07-02. |
