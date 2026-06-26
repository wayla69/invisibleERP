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
| XAdES signature scaffold (RSA-SHA256 + SignedProperties + SigningCertificate digest) | ✅ EXISTS (scaffold) | `tax-docs/etax-sign.ts` (`signEtaxXml`); env `ETAX_SIGNING_KEY_PEM(_B64)` + `ETAX_SIGNING_CERT_PEM(_B64)` |
| No-gap running number per seller/month (TIV/ATV) | ✅ EXISTS | `common/doc-number.service.ts` (`nextMonthlyTenant`), `doc_counters_tenant` |
| Hash-chained tamper journal (RD POS requirement) | ✅ EXISTS | `pos-fiscal/journal.service.ts`, `pos_journal` (REST-02) |
| ETDA *e-Tax by Email* path (≤30M THB/yr; CC the ETDA timestamp mailbox) | ✅ EXISTS | `tax-docs/etax-email.service.ts`; env `ETAX_TIMESTAMP_EMAIL` + SMTP |
| SP submission framework (mock + generic `http` POST) | 🟡 PARTIAL | `pos-fiscal/etax.service.ts` (`submitToProvider`); env `ETAX_PROVIDER`/`_URL`/`_TOKEN` |
| HTML→PDF render (A4 full + 80mm slip) | 🟡 PARTIAL | `tax-docs/tax-docs-pdf.service.ts` (no PDF/A-3) |
| VAT → GL 2100 + ภ.พ.30 reconciliation | ✅ EXISTS | `tax-reports.service.pp30` (TAX-04) |

## 4. The five remaining gaps (what the spike must close or cost)

1. **Certified canonicalization (Exclusive XML C14N).** `etax-sign.ts` itself flags that deterministic
   string canonicalization is *self-consistent but not guaranteed to interop with the RD validator* — RD
   needs DOM-based Exclusive XML C14N (`xml-exc-c14n`). **Risk: HIGH** (a signature the RD rejects is a hard
   stop). Spike PoC #1 closes this.
2. **A real signing certificate (CA / NRCA-chain) + safe key storage.** The scaffold reads a PEM from env;
   production needs a **CA-issued cert** and the private key in a **KMS/HSM**, not an env var. Lead-time +
   procurement is the long pole.
3. **A real transmission channel.** Either (a) a **Service Provider** contract (INET / Frank / Leceipt …) —
   the generic `http` adapter is a drop-in but each SP needs its own auth + payload mapping + status mapping;
   or (b) commit to the **e-Tax-by-Email** route (only valid ≤30M THB/yr revenue) and **sign** the emailed XML
   (today it emails the *unsigned* XML).
4. **PDF/A-3 archival (embedded signed XML).** Current output is HTML→PDF (not PDF/A-3 with XMP + the XML as
   an embedded attachment). Needed if we deliver a human-readable PDF that also carries the legal XML.
5. **Submission durability.** `tax-invoice.service.issueFull` calls `etax.submit` **best-effort (swallows
   errors)** — fine for sandbox, **unacceptable for production** (a silent failure = an undelivered legal
   document). Needs a status field + retry queue + an operator surface (extend the BI scheduler / a register).

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
3. **PoC #1 — signature interop:** sign one real invoice with a *test* cert through **Exclusive XML C14N** and
   pass it through the **ETDA / SP validator**. This is the make-or-break check on gap #1.
4. **PoC #2 — sandbox round-trip:** submit one document to the chosen **SP or RD sandbox** and capture the
   acknowledgement (and an induced failure, to design the retry path).
5. **PDF/A-3 decision:** confirm whether the RD/SP requires the embedded-XML PDF/A-3 at all (many SP flows do
   not) — if not, it drops out of scope.
6. **Costed workstream + risk register + go/no-go** (effort below).

## 7. Effort (to confirm after the spike)

Rough order, **after the cert is in hand** (the cert lead-time itself is the schedule risk, not the code):

| Item | Rough effort |
|---|---|
| Exclusive XML C14N + sign-path hardening (gap #1) | M (2–4 d) |
| KMS/HSM key storage + cert wiring (gap #2 code side) | M (2–3 d) |
| Chosen SP adapter (auth + payload + status map) **or** sign-the-email (gap #3) | M (2–4 d) |
| Submission status + retry queue + operator surface (gap #5) | M (2–3 d) |
| PDF/A-3 (only **if** required by gap #4) | M–L (3–6 d) |

≈ **2–3 developer-weeks of code** once unblocked — the headline ~200–300 h earlier estimate collapses
because XAdES signing + XML + numbering + journal + email + VAT-GL are **already built**. The real schedule
driver is **external** (cert + SP contract + RD sandbox access).

## 8. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| CA-cert lead-time | blocks both paths | start procurement **day 1** of the spike |
| Signature fails RD validator (C14N) | hard stop | PoC #1 *first*; budget the C14N upgrade |
| Vendor lock to one SP | cost / fragility | keep the generic `http` adapter seam; abstract per-SP mapping |
| Silent submission failure | undelivered legal doc | replace best-effort with a status + retry queue before go-live |
| Revenue >30M kills Path B | re-plan | confirm the pilot tenant's band up front |

## 9. Go / No-go criteria

**Go** if: PoC #1 produces a signature the validator accepts **and** PoC #2 gets a sandbox ack **and** the
cert lead-time fits the target date. **No-go / defer** if the validator rejects the C14N output or the cert
cannot be provisioned in time — in which case ship the **mock/sandbox** pipeline (`ETAX_PROVIDER=mock`,
already deployable) for internal UAT and re-spike when the external blockers clear.

## 10. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-06-26 | Platform | Initial spike charter. Current-state verified against the codebase (XAdES signing scaffold now exists; SP submission still mock/http-skeleton; PDF/A-3 absent). Cross-refs: `06-tax-compliance.md` (TAX-01..04), `pos-fiscal/`, `tax-docs/`. |
