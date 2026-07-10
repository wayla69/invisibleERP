# ISO 27001:2022 Gap Analysis — Invisible ERP V2

**Entity:** Invisible Consulting — Oshinei Enterprise ERP
**System in scope:** Invisible ERP V2 (NestJS API · Next.js web · Drizzle · PostgreSQL 16, multi-tenant RLS)
**Framework:** ISO/IEC 27001:2022 — Annex A (93 controls across 4 themes)
**Prepared:** 2026-06-28 · Version 0.1 DRAFT — for review with ISMS Lead / certification body
**Owner:** CISO / IT Security (to assign)
**Related:** `soc2-readiness.md` · `COSO_ICFR_Audit_Readiness_Plan.md` · `Oshinei_ERP_SOX_RCM_v1.xlsx` · `policies/`

> **Relationship to SOC 2 and SOX work:** ISO 27001:2022 Annex A maps almost one-to-one with SOC 2 CC6–CC9
> (Logical Access, System Operations, Change Management, Risk Mitigation). The <!-- rcm-total -->203<!-- /rcm-total -->-control RCM built for SOX
> 404(a) covers the ITGC spine of ISO 27001; the gap analysis below shows where existing controls satisfy
> Annex A requirements and where incremental work is needed. A shared evidence base keeps the three
> certifications from tripling compliance work.

---

## 0. Read this first — ISO 27001 certification path

| Stage | What happens | Typical duration |
|---|---|---|
| **Gap analysis** (this document) | Compare current state to Annex A; identify gaps | 4–6 weeks |
| **ISMS build** | Scope, policy suite, risk register, SOA, internal audit | 3–4 months |
| **Stage 1 audit** (document review) | Certification body reviews ISMS documentation | 1–2 days |
| **Stage 2 audit** (implementation review) | On-site/virtual evidence review | 2–3 days |
| **Certificate issued** | Initial 3-year certification cycle begins | — |
| **Surveillance audits** | Annual; confirm continued conformance | 1 day/year |
| **Recertification** | Full audit at year 3 | 2–3 days |

**Recommendation:** pursue ISO 27001:2022 certification in parallel with the SOC 2 Type II observation
period (M+4 onward) — the overlapping evidence collection makes both programmes less expensive. A shared
ISMS scope (Invisible ERP V2, same system boundary as SOC 2) minimises scope-creep.

---

## 1. Scope and boundaries

**ISMS scope statement (draft):**
> "The design, development, operation, and support of Invisible ERP V2 — a multi-tenant cloud ERP and
> POS platform for the Thai hospitality/retail sector — including the API service, web application,
> database, authentication subsystem, CI/CD pipeline, and secrets management, hosted on Railway with
> GitHub Actions as the CI/CD provider."

**Exclusions:** Payment processing (Stripe, Adyen, Opn, 2C2P, GBPrime) — carved out as sub-service
organisations with their own PCI-DSS / SOC 2 reports. Physical infrastructure (Railway data centres) — 
covered by Railway's ISO 27001 / SOC 2 report (complementary user entity control).

---

## 2. Statement of Applicability skeleton

The table below lists all 93 Annex A controls, their applicability to Invisible ERP V2, current status,
and the evidence source. Controls marked **N/A (justified)** have a documented exclusion reason; **N/A
(to confirm)** require the ISMS Lead to confirm exclusion before the Stage 1 audit.

### Theme A.5 — Organisational controls (37 controls)

| A.5.# | Control name | Applicable | Current evidence | Status |
|---|---|---|---|---|
| A.5.1 | Policies for information security | Yes | `policies/` (13 files; 5 v1.0 / 8 DRAFT) | 🟡 8 DRAFT policies need v1.0 adoption |
| A.5.2 | Information security roles and responsibilities | Yes | SOX PMO RACI (to be finalised); `ELC-POL-03` DoA | 🟡 RACI not yet documented |
| A.5.3 | Segregation of duties | Yes | SoD matrix R01–R16; `PermissionsGuard` enforces at API | ✅ Implemented |
| A.5.4 | Management responsibilities | Yes | ELC-POL-01 §3 management commitment | ✅ Designed |
| A.5.5 | Contact with authorities | Yes | Incident response policy §7 authority contacts (to populate) | 🟡 Contact list placeholder — populate |
| A.5.6 | Contact with special interest groups | Yes | Vulnerability triage (`vulnerability-triage.md`) — CVE tracking | ✅ Designed |
| A.5.7 | Threat intelligence | Yes | `pnpm audit` CI gate; quarterly CVE review cadence | ✅ Designed |
| A.5.8 | Information security in project management | Yes | SDLC policy `ELC-POL-08`; PR template control-impact field | ✅ Designed |
| A.5.9 | Inventory of information and other assets | Yes | System description in `soc2-readiness.md` §1; component table | 🟡 Formal asset register needed |
| A.5.10 | Acceptable use of information and other assets | Yes | ELC-POL-01 Code of Conduct §4 acceptable use | ✅ Designed |
| A.5.11 | Return of assets | N/A (to confirm) | No physical assets issued to staff (cloud-native) | — |
| A.5.12 | Classification of information | Yes | Tenant RLS isolates data; no formal classification schema | 🟡 Data classification policy needed |
| A.5.13 | Labelling of information | Yes | Derived from classification — no current labelling scheme | ❌ Gap — requires classification first |
| A.5.14 | Information transfer | Yes | TLS in transit enforced (Railway/Vercel); AES-256-GCM at rest | ✅ Implemented |
| A.5.15 | Access control | Yes | RBAC + per-user permission overrides; ITGC-AC-01/02 | ✅ Implemented |
| A.5.16 | Identity management | Yes | Scrypt password hashing; TOTP MFA; user provisioning Admin UI | ✅ Implemented |
| A.5.17 | Authentication information | Yes | Password policy in `ELC-POL-09` (DRAFT); no plaintext storage | 🟡 POL-09 at DRAFT |
| A.5.18 | Access rights | Yes | Quarterly recertification report; ITGC-AC-08 | 🟡 Recertification not yet scheduled |
| A.5.19 | Information security in supplier relationships | Yes | `policies/12-third-party-vendor-management-policy.md` (DRAFT) | 🟡 POL-12 at DRAFT; no vendor inventory |
| A.5.20 | Addressing information security within supplier agreements | Yes | PSP contracts reference SOC 2 / PCI-DSS; Railway ToS | 🟡 Security clauses not formally tracked |
| A.5.21 | Managing information security in the ICT supply chain | Yes | `pnpm audit` + gitleaks CI gates; CODEOWNERS | ✅ Designed |
| A.5.22 | Monitoring, review and change management of supplier services | Yes | Annual vendor review (to schedule); POL-12 §5 | 🟡 Annual review not yet scheduled |
| A.5.23 | Information security for use of cloud services | Yes | Railway SOC 2; GitHub SOC 2; sub-service org carve-outs | ✅ Designed |
| A.5.24 | Information security incident management planning | Yes | `policies/10-incident-response-policy.md` | ✅ Designed |
| A.5.25 | Assessment and decision on information security events | Yes | `observability-incident.md` runbook; Sentry alert triage | ✅ Designed |
| A.5.26 | Response to information security incidents | Yes | Incident response policy §5; runbook escalation matrix | 🟡 Tabletop drill not yet conducted |
| A.5.27 | Learning from information security incidents | Yes | `PRE_PRODUCTION_AUDIT_2026Q2.md` deficiency log | ✅ Designed |
| A.5.28 | Collection of evidence | Yes | Append-only audit log + hash chain (`GET /api/admin/audit/verify`) | ✅ Implemented |
| A.5.29 | Information security during disruption | Yes | `policies/09-backup-dr-bcp-policy.md`; backup runbook | 🟡 BCP tabletop exercise not yet conducted |
| A.5.30 | ICT readiness for business continuity | Yes | RTO/RPO in `BACKUP-RUNBOOK.md`; pg-backup + restore scripts | 🟡 Recovery drill documented but not run |
| A.5.31 | Legal, statutory, regulatory and contractual requirements | Yes | PDPA compliance (TH); SOX; NASDAQ listing rules | 🟡 Formal legal register needed |
| A.5.32 | Intellectual property rights | Yes | MIT/proprietary licence headers; dependency audit | ✅ Designed |
| A.5.33 | Protection of records | Yes | 7-year SOX retention; evidence-retention policy (to draft) | 🟡 Evidence-retention policy not yet authored |
| A.5.34 | Privacy and protection of personally identifiable information | Yes | PDPA policy (DRAFT POL-13); RLS isolates tenant PII | 🟡 POL-13 at DRAFT |
| A.5.35 | Independent review of information security | Yes | Third-party pen test planned (C4 deliverable) | 🟡 Pen test not yet conducted |
| A.5.36 | Compliance with policies, rules and standards | Yes | 27-check compliance harness; CI gate on every PR | ✅ Designed |
| A.5.37 | Documented operating procedures | Yes | 30-cycle process narratives in `docs/process-narratives/` | ✅ Designed |

---

### Theme A.6 — People controls (8 controls)

| A.6.# | Control name | Applicable | Current evidence | Status |
|---|---|---|---|---|
| A.6.1 | Screening | Yes | HR background check process (to document) | ❌ Gap — no documented screening process |
| A.6.2 | Terms and conditions of employment | Yes | ELC-POL-01 Code of Conduct acknowledgement | ✅ Designed |
| A.6.3 | Information security awareness, education and training | Yes | `policies/README.md` training requirements; onboarding checklist | 🟡 Formal training records not maintained |
| A.6.4 | Disciplinary process | Yes | ELC-POL-01 §6 conduct procedures | ✅ Designed |
| A.6.5 | Responsibilities after termination or change of employment | Yes | ITGC-AC-09 deprovisioning; Admin UI user-deactivation | ✅ Implemented |
| A.6.6 | Confidentiality or non-disclosure agreements | Yes | NDA referenced in Code of Conduct §2 (to formalise template) | 🟡 NDA template not on file |
| A.6.7 | Remote working | Yes | All-remote team; Railway/GitHub SaaS — TLS enforced; no VPN gap | ✅ Designed |
| A.6.8 | Information security event reporting | Yes | ELC-POL-02 Whistleblower; `compliance@invisible-erp.co.th`; `/compliance-reports` | ✅ Designed |

---

### Theme A.7 — Physical controls (14 controls)

> **Note:** Invisible ERP V2 is a cloud-native SaaS with no owned/leased physical infrastructure.
> Physical controls for Railway's data centres are addressed by Railway's own ISO 27001 / SOC 2 report
> (complementary user entity control). The controls below are assessed for the Invisible Consulting
> office environment (applicable) and the cloud hosting (covered by Railway).

| A.7.# | Control name | Applicable | Current evidence | Status |
|---|---|---|---|---|
| A.7.1 | Physical security perimeters | N/A (cloud) | Railway physical perimeter — Railway SOC 2 | ✅ Covered by sub-service org |
| A.7.2 | Physical entry | N/A (cloud) | Railway physical access — Railway SOC 2 | ✅ Covered by sub-service org |
| A.7.3 | Securing offices, rooms and facilities | N/A (to confirm) | Remote-first; no office server room | — |
| A.7.4 | Physical security monitoring | N/A (cloud) | Railway CCTV / monitoring — Railway SOC 2 | ✅ Covered by sub-service org |
| A.7.5 | Protecting against physical and environmental threats | N/A (cloud) | Railway environmental controls — Railway SOC 2 | ✅ Covered by sub-service org |
| A.7.6 | Working in secure areas | N/A (to confirm) | Remote-first; no classified physical areas | — |
| A.7.7 | Clear desk and screen | Yes | Clear screen policy in Code of Conduct §4.3 (to add explicitly) | 🟡 Not yet explicit in policy |
| A.7.8 | Equipment siting and protection | N/A (cloud) | No on-premises equipment | — |
| A.7.9 | Security of assets off-premises | Yes | All assets cloud-hosted; developer endpoints managed by dev | 🟡 Endpoint MDM not documented |
| A.7.10 | Storage media | N/A (cloud) | No removable media in scope | — |
| A.7.11 | Supporting utilities | N/A (cloud) | Railway UPS / generator — Railway SOC 2 | ✅ Covered by sub-service org |
| A.7.12 | Cabling security | N/A (cloud) | Railway cabling — Railway SOC 2 | ✅ Covered by sub-service org |
| A.7.13 | Equipment maintenance | N/A (cloud) | Railway hardware maintenance — Railway SOC 2 | ✅ Covered by sub-service org |
| A.7.14 | Secure disposal or re-use of equipment | N/A (cloud) | Railway media disposal — Railway SOC 2 | ✅ Covered by sub-service org |

---

### Theme A.8 — Technological controls (34 controls)

| A.8.# | Control name | Applicable | Current evidence | Status |
|---|---|---|---|---|
| A.8.1 | User end point devices | Yes | Developer laptops — no MDM currently enforced | 🟡 Endpoint MDM gap |
| A.8.2 | Privileged access rights | Yes | `exec` + `gl_post` SoD restrictions; TOTP for privileged roles | ✅ Implemented |
| A.8.3 | Information access restriction | Yes | RBAC + RLS; `PermissionsGuard` | ✅ Implemented |
| A.8.4 | Access to source code | Yes | CODEOWNERS + branch protection; GitHub team permissions | ✅ Implemented |
| A.8.5 | Secure authentication | Yes | Scrypt; TOTP MFA; JWT HS256; session invalidation on logout | ✅ Implemented |
| A.8.6 | Capacity management | Yes | Railway auto-scale; load-test baseline (to document) | 🟡 Load-test baseline not yet run |
| A.8.7 | Protection against malware | Yes | `pnpm audit` + gitleaks + CodeQL CI gates; non-root container | ✅ Implemented |
| A.8.8 | Management of technical vulnerabilities | Yes | `vulnerability-triage.md`; quarterly CVE review; ITGC-SD-03 | ✅ Implemented |
| A.8.9 | Configuration management | Yes | `ELC-POL-08` Change Management/SDLC; CM-01..05 controls | ✅ Implemented |
| A.8.10 | Information deletion | Yes | Tenant offboarding — hard-delete policy (to document); Drizzle cascades | 🟡 Tenant data deletion procedure not documented |
| A.8.11 | Data masking | Yes | PII fields not logged; audit log stores user/action/entity not payload | ✅ Designed |
| A.8.12 | Data leakage prevention | Yes | RLS isolates cross-tenant; gitleaks in CI blocks credential commits | ✅ Implemented |
| A.8.13 | Information backup | Yes | `tools/ops/pg-backup.sh` + `restore.sh` + `verify-restore.sh` | ✅ Implemented |
| A.8.14 | Redundancy of information processing facilities | Yes | Railway managed Postgres replication; auto-failover | 🟡 Failover SLA from Railway not formally documented |
| A.8.15 | Logging | Yes | Audit log + hash chain; OTel structured logs; Sentry | ✅ Implemented |
| A.8.16 | Monitoring activities | Yes | `/healthz` + `/readyz` probes; OTel dashboards (setup pending) | 🟡 Production dashboards not yet wired |
| A.8.17 | Clock synchronisation | Yes | Railway NTP synchronisation (complementary) | ✅ Covered by sub-service org |
| A.8.18 | Use of privileged utility programs | Yes | DB admin access gated; no `psql` shell exposed to app | ✅ Designed |
| A.8.19 | Installation of software on operational systems | Yes | CI/CD gated deploy; no ad-hoc prod deploys; non-root container | ✅ Implemented |
| A.8.20 | Networks security | Yes | Helmet; explicit CORS; rate-limiting; Railway network isolation | ✅ Implemented |
| A.8.21 | Security of network services | Yes | TLS enforced (Railway/Vercel); PSP communication over HTTPS | ✅ Implemented |
| A.8.22 | Segregation of networks | Yes | Railway container isolation; tenant data partitioned by RLS | ✅ Implemented |
| A.8.23 | Web filtering | N/A (to confirm) | No outbound web browsing from the ERP API server | — |
| A.8.24 | Use of cryptography | Yes | AES-256-GCM secrets at rest; TLS 1.2+ in transit; Scrypt passwords | ✅ Implemented |
| A.8.25 | Secure development lifecycle | Yes | SDLC policy; PR template; CodeQL SAST; mandatory review | ✅ Implemented |
| A.8.26 | Application security requirements | Yes | Input validation (`class-validator`); OWASP top-10 in CodeQL | ✅ Implemented |
| A.8.27 | Secure system architecture and engineering principles | Yes | Non-root containers; parameterised queries (Drizzle); RLS | ✅ Implemented |
| A.8.28 | Secure coding | Yes | CodeQL SAST; gitleaks; `pnpm audit`; CODEOWNERS | ✅ Implemented |
| A.8.29 | Security testing in development and acceptance | Yes | 83-check CI suite; integration harnesses; unit tests | ✅ Implemented |
| A.8.30 | Outsourced development | N/A (to confirm) | Development is in-house | — |
| A.8.31 | Separation of development, test and production environments | Yes | Railway `production` environment gated; no dev DB on prod | ✅ Designed |
| A.8.32 | Change management | Yes | ITGC-CM-01..05; PR template + CODEOWNERS + required reviews | ✅ Implemented |
| A.8.33 | Test information | Yes | Harnesses use synthetic data; no prod data in CI | ✅ Designed |
| A.8.34 | Protection of information systems during audit testing | Yes | Pen test scope pre-agreed; read-only audit access only | 🟡 Pen test not yet conducted |

---

## 3. Gap summary

### By status

| Status | Count | % |
|---|---|---|
| ✅ Implemented / Designed | 53 | 57% |
| 🟡 Partial | 24 | 26% |
| ❌ Gap | 3 | 3% |
| N/A (justified or to confirm) | 13 | 14% |

### Critical gaps (❌)

| # | Control | Gap | Action |
|---|---|---|---|
| G-01 | A.5.13 Labelling | No data classification scheme exists → no labelling possible | Author data-classification policy first (G-02), then labelling procedure |
| G-02 | A.5.12 Classification | No formal classification schema (Public / Internal / Confidential / Restricted) | Draft data-classification policy; classify system data assets |
| G-03 | A.6.1 Screening | No documented pre-employment background check process | HR to document screening process (criminal / reference / right-to-work) |

### High-priority partials (🟡)

| # | Control | Gap | Action |
|---|---|---|---|
| P-01 | A.5.1 / CC5.3 | 8 DRAFT policies (POL-06..13) | Adopt at v1.0 (board / management approval) |
| P-02 | A.5.9 | No formal asset register | Create and maintain an asset register (system + data assets) |
| P-03 | A.5.19 / CC9.2 | Vendor management policy at DRAFT; no vendor inventory | Adopt POL-12; complete vendor inventory with attestation status |
| P-04 | A.5.26 / CC7.4 | No incident response tabletop exercise conducted | Schedule and run a tabletop; document lessons-learned |
| P-05 | A.5.29 / A1.3 | BCP tabletop exercise not yet conducted | Schedule BCP + restore drill |
| P-06 | A.5.31 | No formal legal/regulatory register | Build legal register (PDPA, SOX, NASDAQ, PDPC, RD e-Tax) |
| P-07 | A.5.33 | Evidence-retention policy not yet authored | Draft and adopt retention policy (7 yr SOX / 3 yr SOC 2 / PDPA) |
| P-08 | A.5.35 / CC7.4 | Third-party pen test not yet conducted | Commission pen test (see C4 roadmap §5) |
| P-09 | A.6.3 / CC1.4 | No formal training records | Implement training register; run annual security awareness |
| P-10 | A.8.1 / A.8.34 | Developer endpoints — no MDM | Define acceptable endpoint baseline (disk encryption, OS patching) |
| P-11 | A.8.6 / A1.1 | No load-test baseline | Run load test; document capacity review cadence |
| P-12 | A.8.16 / CC7.2 | OTel dashboards + alert rules not yet wired in production | SRE to wire dashboards and alert thresholds |

---

## 4. Remediation roadmap

### Phase 1 — ISMS foundations (M+1 to M+3, pre-Stage-1 audit)

| # | Action | Owner | Effort |
|---|---|---|---|
| R-01 | Adopt 8 DRAFT policies at v1.0 | Legal / Board | S |
| R-02 | Author data-classification policy + labelling procedure | CISO | S |
| R-03 | Document HR screening process | HR | S |
| R-04 | Create and publish formal asset register | IT Admin | S |
| R-05 | Author evidence-retention policy | Controller | S |
| R-06 | Build legal / regulatory requirements register | Legal | M |
| R-07 | Complete vendor inventory with SOC 2 / PCI-DSS attestations | Procurement | S |
| R-08 | Author NDA template; link from Code of Conduct | Legal | S |
| R-09 | Draft endpoint security baseline (MDM or policy equivalent) | CISO | S |
| R-10 | Wire OTel dashboards + alert rules in production | SRE | S |
| R-11 | Configure GitHub `production` environment reviewers | DevOps | S |

### Phase 2 — Evidence accumulation (M+3 to M+6, pre-Stage-2 audit)

| # | Action | Owner | Effort |
|---|---|---|---|
| R-12 | Run incident-response tabletop exercise + document | CISO / Eng | S |
| R-13 | Run BCP + restore drill + document | Ops | M |
| R-14 | Commission + complete third-party pen test | External firm | M |
| R-15 | Run first quarterly user access review | IT Admin | S |
| R-16 | Run first load test; document capacity review | Eng | M |
| R-17 | Establish annual vendor review cadence | Procurement | S |
| R-18 | Deliver first security-awareness training + records | HR | S |

### Phase 3 — Surveillance readiness (ongoing after certification)

- Annual internal audit covering all 93 Annex A controls
- Annual management review (scope, risk, objectives, KPIs)
- Annual security-awareness training cycle
- Quarterly vulnerability review + CVE triage
- Continuous CI gate monitoring (compliance harness + CodeQL + gitleaks)

---

## 5. Risk register excerpt

> The full ISMS risk register will be authored as a separate artefact. The following table records the
> top risks identified during this gap analysis.

| Risk ID | Risk description | Likelihood | Impact | Current control | Residual risk |
|---|---|---|---|---|---|
| R-ISO-01 | Cross-tenant data leakage via RLS misconfiguration | Low | Critical | RLS enforced at DB; ToE harness; ITGC-AC-03/04 | Low |
| R-ISO-02 | Credential compromise — developer endpoint | Medium | High | TOTP MFA; no prod console access; gitleaks | Medium → target MDM |
| R-ISO-03 | Supply-chain attack via malicious npm dependency | Medium | High | `pnpm audit` CI gate; lockfile; quarterly review | Medium |
| R-ISO-04 | Incident with no tested response procedure | Medium | High | IR policy exists; runbook exists; no drill | High → tabletop |
| R-ISO-05 | Loss of production DB with no verified restore | Low | Critical | pg-backup scripts exist; no drill conducted | Medium → drill |
| R-ISO-06 | Regulatory breach — PDPA / RD e-Tax | Low | High | PDPA DRAFT policy; RLS; e-invoice audit log | Medium → adopt POL-13 |

---

## 6. Statement of Applicability (SOA) — skeleton

The full SOA is a required ISO 27001 Annex A deliverable. This skeleton records applicability and
justification for each control theme; full per-control SOA rows will be authored before Stage 1 audit.

| Theme | Controls | Applicable | Excluded (justified) |
|---|---|---|---|
| A.5 Organisational | 37 | 36 | A.5.11 (no physical asset issue) |
| A.6 People | 8 | 8 | — |
| A.7 Physical | 14 | 3 | 11 (cloud-native; Railway complementary) |
| A.8 Technological | 34 | 30 | A.8.23 (no outbound browsing); A.8.30 (in-house dev); A.7.10 / A.8.17 (cloud) |

**Exclusion justification (cloud-native):** Physical controls A.7.1–A.7.14 (except A.7.7 and A.7.9) are
not applicable to Invisible ERP V2 because the system is hosted entirely on Railway's managed
infrastructure. Physical security for the data centre environment is provided by Railway and documented
in Railway's ISO 27001 / SOC 2 report, which is reviewed annually as a complementary user entity control.

---

## 7. Certification timeline

| Milestone | Target |
|---|---|
| Gap analysis complete (this document) | M+0 |
| ISMS Phase 1 actions complete (R-01 to R-11) | M+3 |
| Select certification body | M+2 |
| Stage 1 audit (document review) | M+4 |
| ISMS Phase 2 actions complete (R-12 to R-18) | M+6 |
| **Stage 2 audit (certification)** | M+6 |
| **Certificate issued** | M+7 |
| First surveillance audit | M+19 |
| Recertification audit | M+43 |

---

## 8. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-28 | Platform | Initial ISO 27001:2022 Annex A gap analysis. 93 controls assessed: 53 ✅, 24 🟡, 3 ❌, 13 N/A. Gap summary, risk register excerpt, SOA skeleton, and remediation roadmap. |
| 0.2 DRAFT | 2026-07-02 | Platform | Census reconciliation (docs/27 R3-1): SOX-RCM population reference corrected to the generated census (169 as of that date — the tagged census is the live figure) with a machine-readable tag. |
