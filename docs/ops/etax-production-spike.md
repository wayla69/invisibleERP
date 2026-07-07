# e-Tax Invoice / e-Receipt — Production go-live spike (charter)

> **Status:** Spike charter (decision doc — not an implementation). **Owner:** Tax/Compliance + Platform.
> **Date:** 2026-06-26. **Timebox:** 3–5 working days. **Outcome:** a go/no-go + a costed workstream.

## 1. Why a spike (not a sprint)

The e-Tax pipeline is **~85% built** (see §3) — but the remaining 15% depends on **things we do not control**:
a CA-issued signing certificate, a Service-Provider (SP) contract or an RD sandbox, and RD-validator
interop rules. Estimating those blind is how you miss by months. This spike **timeboxes the unknowns** so
we can commit a real number and a real date.

This is a **regulatory** capability (สรรพากร / ETDA e-Tax Invoice & e-Receipt), so the deliverable of the
spike is a **decision** (which path, which provider, what cert, what effort) backed by two small PoCs.

## 2. Scope

In scope: issuing a **signed** e-Tax Invoice (full ม.86/4 + abbreviated ม.86/6) and transmitting it so it is
**legally delivered** — either via a Service Provider or the ETDA *e-Tax by Email* route — plus the archival
(PDF/A-3) and reconciliation expectations. **Out of scope:** VAT computation and the ภ.พ.30 return + GL-2100
reconciliation (already done — control **TAX-04**); WHT/ภ.ง.ด. (**TAX-03**); the tamper-evident POS journal
(already done — **REST-02**).

## 3. Current state (verified 2026-06-26) — what already exists

| Capability | State | Where |
|---|---|---|
| UBL 2.1 XML (ETDA-eTaxInvoice-2.0 shape) | ✅ EXISTS | `tax-docs/etax-xml.ts` (`buildEtaxInvoiceXml`) |
| XAdES signature, real Exclusive XML C14N (RSA-SHA256 + SignedProperties + SigningCertificate digest) | ✅ EXISTS | `tax-docs/etax-sign.ts` (`signEtaxXml`, via `xml-crypto`'s `ExclusiveCanonicalization`); env `ETAX_SIGNING_KEY_PEM(_B64)` + `ETAX_SIGNING_CERT_PEM(_B64)` — still needs a real CA-issued cert (gap #2) |
| No-gap running number per seller/month (TIV/ATV) | ✅ EXISTS | `common/doc-number.service.ts` (`nextMonthlyTenant`), `doc_counters_tenant` |
| Hash-chained tamper journal (RD POS requirement) | ✅ EXISTS | `pos-fiscal/journal.service.ts`, `pos_journal` (REST-02) |
| ETDA *e-Tax by Email* path (≤30M THB/yr; CC the ETDA timestamp mailbox) | ✅ EXISTS | `tax-docs/etax-email.service.ts`; env `ETAX_TIMESTAMP_EMAIL` + SMTP |
| SP submission framework (mock + generic `http` POST) | 🟡 PARTIAL | `pos-fiscal/etax.service.ts` (`submitToProvider`); env `ETAX_PROVIDER`/`_URL`/`_TOKEN` |
| HTML→PDF render (A4 full + 80mm slip) | 🟡 PARTIAL | `tax-docs/tax-docs-pdf.service.ts` (no PDF/A-3) |
| VAT → GL 2100 + ภ.พ.30 reconciliation | ✅ EXISTS | `tax-reports.service.pp30` (TAX-04) |

## 4. The five remaining gaps (what the spike must close or cost)

1. **~~Certified canonicalization (Exclusive XML C14N).~~ ✅ CLOSED (code-level) 2026-07-07.** `etax-sign.ts`
   now canonicalizes every digested fragment (the enveloped document reference, the XAdES `SignedProperties`
   reference, and the `SignedInfo` that gets RSA-signed) via `xml-crypto`'s `ExclusiveCanonicalization` over a
   parsed `@xmldom/xmldom` DOM — real W3C `xml-exc-c14n`, not a string-hash approximation. Verified against an
   **independent** XML-DSig library (`xml-crypto`'s own `SignedXml.checkSignature()`, not just this repo's own
   `verifyEtaxSignature`) in the `etax-sign` cutover harness — that cross-check is what caught and fixed a real
   whitespace/enveloped-transform bug during this work (see harness comments). **Residual risk: LOW-MEDIUM** —
   an independent open-source verifier accepting the signature is strong evidence, but it is not the same as
   running it through the actual RD/ETDA validator, which still requires PoC #1 below (blocked on gap #2).
2. **A real signing certificate (CA / NRCA-chain) + safe key storage.** `getSigningMaterial()` reads a PEM from env;
   production needs a **CA-issued cert** and the private key in a **KMS/HSM**, not an env var. Lead-time +
   procurement is the long pole.
3. **A real transmission channel.** Either (a) a **Service Provider** contract (INET / Frank / Leceipt …) —
   the generic `http` adapter is a drop-in but each SP needs its own auth + payload mapping + status mapping;
   or (b) commit to the **e-Tax-by-Email** route (only valid ≤30M THB/yr revenue) and **sign** the emailed XML
   (today it emails the *unsigned* XML).
4. **PDF/A-3 archival (embedded signed XML).** Current output is HTML→PDF (not PDF/A-3 with XMP + the XML as
   an embedded attachment). Needed if we deliver a human-readable PDF that also carries the legal XML.
5. **~~Submission durability.~~ ✅ CLOSED (code-level) 2026-07-07.** `EtaxService.submit` now records EVERY
   attempt — Accepted, an explicit SP rejection, or a thrown error (SP unreachable, `ETAX_PROVIDER_URL` not
   configured, etc.) — as a row in `etax_submissions` before rethrowing, and raises an ops alert
   (`etax_submit_failed`). The failure-audit write itself runs on the **AUTOCOMMIT raw pg client**
   (`PG_CLIENT`, same pattern as `login_attempts`/`ai_token_usage`), not the per-request tenant transaction —
   every non-SSE request runs inside ONE transaction (`TenantTxInterceptor`) that rolls back on any thrown
   exception, so a row written on the request's own transaction would itself be discarded the moment `submit`
   rethrows (the direct `POST /api/tax/etax/submit/:docNo` path hit exactly this during development — see the
   `etax` cutover harness). A distinct alert (`etax_submit_failure_not_recorded`) fires if even that autocommit
   write fails, without masking the original error. `EtaxService.retryFailed` is a new idempotent sweep (latest
   attempt per `doc_no`, retries every non-Accepted one) wired into the BI scheduler as `etax_submission_retry`
   (`TaxJobsService.runEtaxSubmissionRetry`) and exposed as an on-demand operator action
   (`POST /api/tax/etax/retry-failed`, `exec`-only) plus a "retry all failed" button + per-row error/retry in
   the e-Tax operator screen (`/pos-fiscal`, e-Tax tab). `tax-invoice.service.issueFull` still catches locally
   around its `etax.submit` call (issuance itself must not fail because the SP is down) — but that catch is no
   longer silent, since the failure is now durably tracked and retried by the sweep. **Residual: none at the
   code level** — this gap closes independently of gaps #2/#3 (it works with `mock`/`http` today and will keep
   working once a real SP is wired in).

## 5. Two delivery paths — decide in the spike

| | Path A — Service Provider | Path B — e-Tax by Email (pilot) |
|---|---|---|
| Legal basis | SP transmits to RD on our behalf | ETDA e-Tax by Email (revenue **≤ 30M THB/yr** only) |
| Cert | SP may provide / manage signing | We sign; need our own CA cert |
| Code to write | wire the chosen SP adapter onto the `http` shape; status/retry | sign the emailed XML (today unsigned); retry/status |
| Cost | per-document SP fee + integration | SMTP only; near-zero per-doc |
| Speed to live | medium (contract + creds) | fast (no contract) but capped at ≤30M and per-doc-manual-ish |
| Best for | multi-branch / >30M / high volume | a single small tenant pilot to prove the loop |

**Recommendation to validate in the spike:** start the **CA-cert procurement on day 1 regardless** (it
gates both paths if we ever self-sign), run **both** PoCs, and pick the path per the pilot tenant's revenue
band and volume.

## 6. Spike deliverables (timebox 3–5 days)

1. **Decision:** Path A (which SP) vs Path B, with the reasoning and the pilot tenant.
2. **CA-cert plan:** issuer (NRCA chain / TDID), lead-time, cost, and the **key-storage** design (KMS/HSM —
   never an env PEM in prod).
3. **PoC #1 — signature interop:** sign one real invoice with a *test* cert (C14N is done — see gap #1) and
   pass it through the **ETDA / SP validator** to confirm real-world acceptance, not just an independent
   library cross-check.
4. **PoC #2 — sandbox round-trip:** submit one document to the chosen **SP or RD sandbox** and capture the
   acknowledgement (and an induced failure, to design the retry path).
5. **PDF/A-3 decision:** confirm whether the RD/SP requires the embedded-XML PDF/A-3 at all (many SP flows do
   not) — if not, it drops out of scope.
6. **Costed workstream + risk register + go/no-go** (effort below).

## 7. Effort (to confirm after the spike)

Rough order, **after the cert is in hand** (the cert lead-time itself is the schedule risk, not the code):

| Item | Rough effort |
|---|---|
| ~~Exclusive XML C14N + sign-path hardening (gap #1)~~ | done — see gap #1 |
| KMS/HSM key storage + cert wiring (gap #2 code side) | M (2–3 d) |
| Chosen SP adapter (auth + payload + status map) **or** sign-the-email (gap #3) | M (2–4 d) |
| ~~Submission status + retry queue + operator surface (gap #5)~~ | done — see gap #5 |
| PDF/A-3 (only **if** required by gap #4) | M–L (3–6 d) |

≈ **1.5–2.5 developer-weeks of code** once unblocked — the headline ~200–300 h earlier estimate collapses
because XAdES signing (with real C14N) + XML + numbering + journal + email + VAT-GL are **already built**.
The real schedule driver is **external** (cert + SP contract + RD sandbox access).

## 8. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| CA-cert lead-time | blocks both paths | start procurement **day 1** of the spike |
| Signature fails the REAL RD/ETDA validator | hard stop | C14N itself is done + independently cross-checked (gap #1); PoC #1 still confirms against the actual validator, not just a library |
| Vendor lock to one SP | cost / fragility | keep the generic `http` adapter seam; abstract per-SP mapping |
| ~~Silent submission failure~~ | undelivered legal doc | **CLOSED** — every attempt (success/reject/error) is persisted + retried by the `etax_submission_retry` sweep (gap #5) |
| Revenue >30M kills Path B | re-plan | confirm the pilot tenant's band up front |

## 9. Go / No-go criteria

**Go** if: PoC #1 produces a signature the validator accepts **and** PoC #2 gets a sandbox ack **and** the
cert lead-time fits the target date. **No-go / defer** if the validator rejects the signed output or the cert
cannot be provisioned in time — in which case ship the **mock/sandbox** pipeline (`ETAX_PROVIDER=mock`,
already deployable) for internal UAT and re-spike when the external blockers clear.

## 10. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-06-26 | Platform | Initial spike charter. Current-state verified against the codebase (XAdES signing scaffold now exists; SP submission still mock/http-skeleton; PDF/A-3 absent). Cross-refs: `06-tax-compliance.md` (TAX-01..04), `pos-fiscal/`, `tax-docs/`. |
| 0.2 | 2026-07-07 | Platform | Gap #1 (Exclusive XML C14N) closed at the code level — `etax-sign.ts` now canonicalizes via `xml-crypto`'s `ExclusiveCanonicalization`, verified against that library's own independent `SignedXml` verifier in the `etax-sign` cutover harness (12 checks, up from 9). Gap #2 (real CA cert + KMS/HSM) is unchanged/still open — no certificate was obtained or fabricated. |
| 0.3 | 2026-07-07 | Platform | Gap #5 (submission durability) closed at the code level — `EtaxService.submit` persists every attempt (Accepted/Rejected/thrown-error) via the autocommit `PG_CLIENT` so a failure survives the per-request transaction rollback, alerts ops, and is retried by a new idempotent `retryFailed` sweep wired into the BI scheduler (`etax_submission_retry`) plus an on-demand operator endpoint/UI (`POST /api/tax/etax/retry-failed`, `/pos-fiscal` e-Tax tab). `etax` cutover harness extended 9→15 checks. Gaps #2/#3/#4 unchanged/still open. |
