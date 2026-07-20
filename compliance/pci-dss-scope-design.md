# PCI-DSS Scope Design — Invisible ERP

**Entity:** Invisible Consulting — Invisible Enterprise ERP
**System in scope:** Invisible ERP (NestJS API · Next.js web · Drizzle · PostgreSQL 16, multi-tenant RLS)
**Framework:** PCI-DSS v4.0 — SAQ-A (merchants who have outsourced all cardholder data functions)
**Prepared:** 2026-06-28 · Version 0.1 DRAFT — for review with QSA / acquiring bank
**Owner:** CISO / Head of Engineering (to assign)
**Related:** `soc2-readiness.md` · `iso27001-gap-analysis.md` · `policies/`

> **Key design decision:** Invisible ERP is architected as a **tokenization-only** payment system.
> No Primary Account Number (PAN), CVV, track data, or cardholder name flows through or is stored by
> the ERP API, database, or web application. All cardholder data functions are outsourced entirely to
> PCI-DSS-certified payment service providers. This qualifies the system for SAQ-A — the lightest
> PCI-DSS attestation path — and is the design constraint that MUST be maintained as the system evolves.

---

## 1. Scope boundary

### What is IN scope for PCI-DSS

| Component | Role | Cardholder data? |
|---|---|---|
| Next.js web (checkout page) | Renders PSP-hosted iframe / redirect | **No** — PSP's script runs in its own iframe; no PAN touches Invisible ERP's DOM |
| NestJS API | Receives tokenized `payment_method` string from PSP webhook | **No** — token only, not PAN |
| PostgreSQL | Stores `payment_method` (PSP token string) in `orders` table | **No** — token is not cardholder data |
| Railway (hosting) | Hosts API + DB containers | **No** — no CDE components |

**PCI-DSS scope for Invisible ERP = SAQ-A** (merchants who outsource all cardholder data functions to PCI-DSS-compliant third parties and whose e-commerce website does not directly receive cardholder data).

### What is OUT of PCI-DSS scope

| Component | Why out of scope |
|---|---|
| Stripe | PCI-DSS Level 1 service provider; Stripe.js / Stripe Elements handles all PAN entry in their iframe |
| Adyen | PCI-DSS Level 1 service provider; Adyen Drop-In / Components handles PAN in their iframe |
| Opn (Omise) | PCI-DSS Level 1 service provider; OmiseJS handles PAN in their iframe |
| 2C2P | PCI-DSS Level 1 service provider; 2C2P's payment page handles PAN |
| GBPrime | PCI-DSS Level 1 service provider; GBPrime's hosted page handles PAN |
| PromptPay EMVCo | QR code payment — no cardholder data (bank-initiated, account-to-account) |

### Scope boundary diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Customer browser                                               │
│  ┌───────────────────────────────────┐  ┌────────────────────┐ │
│  │  Invisible ERP Next.js page       │  │  PSP iframe/page   │ │
│  │  (No PAN; renders PSP component)  │  │  (PAN entered here)│ │
│  │                                   │  │  PCI-DSS scope:PSP │ │
│  └──────────────┬────────────────────┘  └────────┬───────────┘ │
│                 │ token / redirect                │             │
└─────────────────┼─────────────────────────────────┼─────────────┘
                  │                                 │
     ┌────────────▼────────────┐        ┌───────────▼──────────┐
     │  Invisible ERP API      │        │  PSP servers          │
     │  (NestJS / Railway)     │◄───────│  (Stripe/Adyen/etc.) │
     │  Stores: token string   │webhook │  Stores: PAN (vault)  │
     │  NO PAN — SAQ-A scope   │        │  PCI-DSS Level 1      │
     └────────────┬────────────┘        └──────────────────────┘
                  │
     ┌────────────▼────────────┐
     │  PostgreSQL 16          │
     │  orders.payment_method  │
     │  = "pm_xxx" (token)     │
     │  NO PAN                 │
     └─────────────────────────┘

  ◄─── NOT in CDE ───►                  ◄──── CDE (PSP) ────►
```

---

## 2. SAQ-A eligibility requirements

PCI-DSS v4.0 SAQ-A applies when **all** of the following are true:

| Requirement | Invisible ERP status |
|---|---|
| Merchant accepts card payments only through fully outsourced payment channels | ✅ All PSPs are Level 1; Invisible ERP never touches PAN |
| All payment processing is handled by PCI-DSS-validated third-party service providers | ✅ Stripe, Adyen, Opn, 2C2P, GBPrime each maintain PCI-DSS reports |
| The merchant's website does not receive cardholder data | ✅ PSP iframe/redirect — no PAN in Invisible ERP's DOM |
| All elements of the payment page(s) delivered to the consumer's browser originate from the third party or the merchant | ✅ PSP-hosted elements only; no inline JS reading PAN |
| The merchant does not electronically store, process, or transmit any cardholder data on merchant systems | ✅ Only `payment_method` token stored — confirmed by DB schema review |

**Conclusion:** Invisible ERP qualifies for SAQ-A. Completing SAQ-A produces a self-attestation (AoC) acceptable to most acquiring banks for merchant-level card acceptance.

---

## 3. SAQ-A control requirements and current status

SAQ-A v4.0 contains 13 requirements (not all apply to SAQ-A merchants). The applicable requirements and their current status:

### Requirement 1 — Network security controls

| Sub-req | Requirement | Status | Evidence |
|---|---|---|---|
| 1.1 | Network security controls defined and documented | 🟡 Partial | Railway network isolation (complementary); explicit CORS + Helmet in API |
| 1.2 | Network access controls configured and maintained | ✅ | Railway private networking; no public DB endpoint |
| 1.3 | Network access between trusted and untrusted networks restricted | ✅ | API behind Railway's load balancer; DB not internet-exposed |

### Requirement 2 — Secure configurations

| Sub-req | Requirement | Status | Evidence |
|---|---|---|---|
| 2.1 | Processes for managing all system components via secure configurations | ✅ | Non-root containers; Railway managed Postgres; SDLC policy |
| 2.2 | System components configured and managed securely | ✅ | CI/CD gated deploy; no ad-hoc prod config changes |
| 2.3 | Wireless access points are secured | N/A | No wireless infrastructure |

### Requirement 3 — Protect stored account data

| Sub-req | Requirement | Status | Evidence |
|---|---|---|---|
| 3.1 | Processes for data retention and disposal | 🟡 Partial | 7-year SOX retention; token-only storage; data-deletion procedure to document |
| 3.2 | Storage of sensitive authentication data minimised | ✅ | **No SAD (PAN/CVV/track data) stored** — tokens only |
| 3.3 | SAD not retained after authorisation | ✅ | Never received; PSP handles authorisation |

### Requirement 4 — Protect cardholder data in transit

| Sub-req | Requirement | Status | Evidence |
|---|---|---|---|
| 4.1 | Processes for protecting cardholder data in transit | ✅ | No CHD in transit through Invisible ERP — tokens only |
| 4.2 | PAN not sent over unprotected communications | ✅ | No PAN in Invisible ERP systems; TLS enforced on all API calls |

### Requirement 5 — Protect all systems from malware

| Sub-req | Requirement | Status | Evidence |
|---|---|---|---|
| 5.1 | Anti-malware processes defined | ✅ | `pnpm audit`; gitleaks; CodeQL CI gates |
| 5.2 | All system components protected from malware | ✅ | Non-root containers; readonly FS where possible; Railway patching |
| 5.3 | Anti-malware solutions maintained | ✅ | CI gates run on every PR; quarterly dependency review |

### Requirement 6 — Develop and maintain secure systems

| Sub-req | Requirement | Status | Evidence |
|---|---|---|---|
| 6.1 | Security vulnerabilities identified and managed | ✅ | `vulnerability-triage.md`; ITGC-SD-03 quarterly CVE review |
| 6.2 | Bespoke and custom software developed securely | ✅ | CodeQL SAST; SDLC policy; PR mandatory review; `class-validator` |
| 6.3 | Security vulnerabilities in bespoke software addressed | ✅ | CI gate; `PRE_PRODUCTION_AUDIT_2026Q2.md` deficiency tracking |
| 6.4 | Web-facing application protected against attacks | ✅ | Helmet headers; explicit CORS; rate-limiting; OWASP scan in CodeQL |
| 6.5 | Changes to all system components managed securely | ✅ | ITGC-CM-01..05; PR template; CODEOWNERS; gated deploy |

### Requirement 7 — Restrict access to system components

| Sub-req | Requirement | Status | Evidence |
|---|---|---|---|
| 7.1 | Access defined and authorised | ✅ | RBAC + per-user overrides; ITGC-AC-01/02 |
| 7.2 | Access to system components restricted | ✅ | `PermissionsGuard`; no guest access to admin endpoints |
| 7.3 | Access to system components and data reviewed | 🟡 Partial | Quarterly recertification report exists; not yet scheduled |

### Requirement 8 — Identify users and authenticate access

| Sub-req | Requirement | Status | Evidence |
|---|---|---|---|
| 8.1 | Processes defined for user identification and authentication | ✅ | Auth service (`auth.service.ts`); ITGC-AC-06 |
| 8.2 | All users assigned a unique ID | ✅ | UUID `users.id`; no shared accounts |
| 8.3 | Authentication factors appropriate | ✅ | Scrypt; TOTP MFA for privileged roles; JWT session |
| 8.4 | MFA implemented | ✅ | TOTP enforced for `exec`/`gl_post`/`gl_close` roles |
| 8.5 | System/application accounts managed | ✅ | Service accounts scoped by API key; no hardcoded credentials |
| 8.6 | Application and system accounts authenticated | ✅ | API keys stored AES-256-GCM-encrypted; rotatable |

### Requirement 9 — Restrict physical access

| Sub-req | Requirement | Status | Evidence |
|---|---|---|---|
| 9.1 | Physical access controls defined | N/A (SAQ-A) | No CDE physical infrastructure; Railway complementary |
| 9.4 | Media with cardholder data secured | N/A | No CHD media |
| 9.5 | POI devices protected | N/A (SAQ-A) | No POS hardware terminals in CDE scope |

### Requirement 10 — Log and monitor all access

| Sub-req | Requirement | Status | Evidence |
|---|---|---|---|
| 10.1 | Logging and monitoring processes defined | ✅ | Audit log + hash chain; OTel + Sentry |
| 10.2 | Audit logs enabled for all system components | ✅ | Append-only audit log; ITGC-AC-10/16 |
| 10.3 | Audit log protection | ✅ | Hash chain (`GET /api/admin/audit/verify`); append-only DB trigger |
| 10.4 | Audit logs reviewed | 🟡 Partial | Log review process to formalise; no current scheduled review |
| 10.5 | Audit log history retained | 🟡 Partial | Retention policy not yet authored |
| 10.7 | Failures of critical controls detected | 🟡 Partial | OTel alert rules to wire |

### Requirement 11 — Test security of systems

| Sub-req | Requirement | Status | Evidence |
|---|---|---|---|
| 11.1 | Processes for testing defined | ✅ | 83-check CI suite; compliance harness; integration harnesses |
| 11.2 | Wireless access points tested | N/A | No wireless |
| 11.3 | External + internal penetration testing | 🟡 Partial | Pen test planned (C4 deliverable); not yet conducted |
| 11.4 | Intrusion detection / prevention | 🟡 Partial | Sentry anomaly; rate-limiting; no dedicated IDPS |
| 11.5 | Network change detection | ✅ | CI/CD gated; infrastructure changes reviewed |
| 11.6 | Unexpected changes to payment pages detected | ✅ | No CHD page in Invisible ERP; PSP iframe origin-checked |

### Requirement 12 — Support information security policies

| Sub-req | Requirement | Status | Evidence |
|---|---|---|---|
| 12.1 | Information security policy exists | 🟡 Partial | 8 DRAFT policies; 5 at v1.0 |
| 12.2 | Acceptable use policy | ✅ | ELC-POL-01 Code of Conduct §4 |
| 12.3 | Risk management process | ✅ | ELC-POL-05 Fraud Risk Assessment; RCM risk column |
| 12.4 | PCI-DSS compliance management | 🟡 Partial | This document; SAQ-A AoC not yet submitted to acquirer |
| 12.5 | PCI-DSS scope confirmed | ✅ | This document defines and confirms SAQ-A scope |
| 12.6 | Security awareness education | 🟡 Partial | Onboarding checklist; no formal training records |
| 12.7 | Personnel screened | 🟡 Partial | No documented screening process (see ISO 27001 G-03) |
| 12.8 | Third-party service provider management | ✅ | PSP carve-out; SOC 2 / PCI-DSS reports reviewed annually |
| 12.9 | TPSP responsibility acknowledgements | 🟡 Partial | Contracts reference PCI-DSS; responsibility matrix to formalise |
| 12.10 | Incident response plan | ✅ | `policies/10-incident-response-policy.md`; runbook |

---

## 4. Gap summary

### SAQ-A specific gaps

| # | Gap | Priority | Action |
|---|---|---|---|
| PCI-01 | SAQ-A self-assessment not yet completed and submitted to acquirer | High | Complete SAQ-A questionnaire; submit AoC to each acquiring bank |
| PCI-02 | Audit log review not formalised (Req 10.4) | Medium | Schedule weekly/monthly log review; document sign-off |
| PCI-03 | Log retention policy not authored (Req 10.5) | Medium | Draft evidence/log retention policy (min 12 months online / 3 years total) |
| PCI-04 | Penetration test not conducted (Req 11.3) | Medium | Commission annual third-party pen test (see §5) |
| PCI-05 | OTel alert rules not wired in production (Req 10.7) | Medium | SRE to wire alert thresholds |
| PCI-06 | Vendor responsibility matrix not formalised (Req 12.9) | Low | Document PSP responsibility split in vendor register |
| PCI-07 | Quarterly user access review not scheduled (Req 7.3) | Low | Schedule quarterly recertification |

### Invariants to protect (architecture constraints)

> These are the design rules that MUST NOT be violated. Any feature touching the payment flow MUST be
> reviewed against them. Breaking any invariant widens the PCI-DSS scope to SAQ-D or Level 1 — a
> significantly larger and more expensive compliance programme.

| # | Invariant | Monitoring |
|---|---|---|
| INV-01 | **No PAN ever touches Invisible ERP code or DB.** `orders.payment_method` stores PSP token strings only. | DB schema review on every migration; gitleaks blocks PAN-like patterns in code |
| INV-02 | **Payment pages use PSP-hosted iframe or redirect.** No inline payment form with `<input name="card_number">` or similar. | PR review; CodeQL scans for card-number-shaped patterns |
| INV-03 | **No CVV, track data, or full card expiry stored.** PSP tokens contain no sensitive authentication data. | DB schema review; CI harness |
| INV-04 | **PSP webhooks are verified before processing.** Stripe webhook signature, Adyen HMAC, etc. | Code review in `payments/` module |
| INV-05 | **PSP credentials stored encrypted.** API keys in Railway secret store or AES-256-GCM-encrypted DB field. | gitleaks CI gate; `env.ts` validation at boot |

---

## 5. Penetration test scope

When the annual third-party pen test is commissioned (C4 roadmap, M+5), the PCI-DSS portion of the
scope should include:

1. **External network penetration test** — Railway public endpoints (`api.invisible-erp.co.th`, web)
2. **Web application test** — OWASP Top 10; authentication bypass; session management; injection
3. **Payment page review** — Verify PSP iframe is correctly sandboxed; no CHD leakage via JS
4. **Internal scope** (if Railway grants network access) — DB network exposure; lateral movement
5. **Social engineering exclusion** — out of scope unless specifically requested

Deliverables: written report with severity-rated findings; retest after remediation; clean retest
report retained as PCI-DSS Req 11.3 evidence.

---

## 6. Annual SAQ-A submission checklist

The SAQ-A attestation must be submitted to each acquiring bank annually. Before submission:

- [ ] Review and update this scope design document
- [ ] Confirm all five PSPs have current PCI-DSS Attestation of Compliance (AoC) on file
- [ ] Verify no new payment flows were added that take CHD through Invisible ERP systems
- [ ] Complete SAQ-A questionnaire (12 sections × ~40 questions)
- [ ] CISO / Head of Engineering sign the AoC
- [ ] Submit to each acquiring bank's compliance portal
- [ ] File signed AoC in compliance evidence store (7-year retention)

---

## 7. Emerging scope considerations

> Actions that WOULD widen PCI-DSS scope beyond SAQ-A — avoid unless a QSA assessment confirms
> the expanded scope can be managed.

| Scenario | Scope impact | Guidance |
|---|---|---|
| Building an in-house card-capture form (no PSP iframe) | Widens to SAQ-D or Level 1 — full 250+ control assessment | Do **not** do this; maintain PSP-hosted capture |
| Storing full PAN for recurring billing | Requires tokenization vault (Level 1 or SAQ-D) | Use PSP-managed subscriptions/recurring tokens |
| Logging full card details in debug/error output | Widens scope immediately; criminal liability | gitleaks + CodeQL mandatory; log masking required |
| Adding a hardcoded-terminal / POS hardware integration | SAQ-B or SAQ-C depending on implementation | Engage QSA before building; use P2PE terminal |
| Transmitting PAN between internal services | Widens all services in the data flow to CDE | Architecture review + QSA required |

---

## 8. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-28 | Platform | Initial PCI-DSS scope design. SAQ-A qualification confirmed: tokenization-only architecture, no CHD in Invisible ERP systems. SAQ-A control gap assessment, architecture invariants, pen test scope, and annual submission checklist. |
