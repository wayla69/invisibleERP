# Entity-Level Controls — Operating Manual (ELC-01 / ELC-02 / ELC-04)

> **Status:** v1.0 · **Date:** 2026-06-30 · **Owner:** Compliance / Company Secretary
> **Scope:** how to *operate* the three entity-level controls whose **systems are already built** but whose
> effectiveness depends on management running them on a cadence. This manual is the operating procedure the
> auditor samples alongside the in-app evidence.

The policies are adopted (v1.0, effective **2026-07-01**): code of conduct (`compliance/policies/01`),
whistleblower (`02`), delegation of authority (`03`), audit-committee charter (`04`), fraud-risk
assessment (`05`). The **systems** that capture the evidence live in `modules/governance`
(`/api/governance/*`). What remained was the **operating cadence** — that is what this manual defines.

## At a glance

| Control | Process | Cadence | Owner | In-app evidence | Readiness signal |
|---|---|---|---|---|---|
| **ELC-01** | Code-of-conduct acknowledgement | At hire + **annually** | CEO / HR | `ethics_acknowledgements` register | coverage % of active staff |
| **ELC-02** | Audit-committee ICFR oversight | **Quarterly** (≤ 92 days) | Board / Audit Committee | `governance_oversight` log | last meeting / next due / overdue |
| **ELC-04** | Whistleblower hotline | **Continuous** intake; review each AC meeting | Audit Committee / Compliance | `whistleblower_cases` log | open cases / ageing vs 30-day SLA |

**Monitor everything from one place:** `GET /api/governance/readiness` returns coverage %, oversight
cadence and case ageing with a `ready` flag + `alerts[]`. Schedule the **`governance_readiness`** BI report
(weekly) to push the same snapshot to compliance and raise a reminder whenever a signal breaches — the
scheduler logs each run (`report_runs`) and notifies, so the reminders are themselves audit evidence.

---

## ELC-01 — Annual code-of-conduct acknowledgement campaign

**Objective.** Every active staff member acknowledges the current code-of-conduct version; the dated
register is retained as tone-at-the-top evidence.

**Cadence.** New joiners within 5 business days of hire; **all staff annually** (run the campaign over a
2-week window, target ≥ 95% coverage before close).

**Procedure.**
1. **Publish** the current code-of-conduct version string (e.g. `2026-1.0`). Keep it stable for the year.
2. **Open the campaign** — notify all staff to acknowledge. Each staff member calls (or clicks in the app):
   `POST /api/governance/ethics/acknowledge { "policy_version": "2026-1.0" }`. Re-acknowledging is idempotent
   (one row per staff per version), so reminders are safe to repeat.
3. **Monitor coverage** — Compliance watches `GET /api/governance/readiness` (`ethics.coverage_pct` +
   `ethics.outstanding[]`) or the register `GET /api/governance/ethics/register?policy_version=2026-1.0`.
4. **Chase the outstanding** — the weekly `governance_readiness` job raises an `ELC-01` alert listing the
   outstanding count until coverage reaches target. Follow up the named `outstanding[]` staff.
5. **Close + retain** — when coverage hits target, snapshot the register (export) into the evidence
   repository. Retain **7 years**.

**Evidence.** The `ethics_acknowledgements` register (sample-able, dated, per version) + the campaign close
memo. **Acknowledgement statement** template in Appendix A.

---

## ELC-02 — Quarterly audit-committee ICFR oversight

**Objective.** The Audit Committee meets at least quarterly, reviews ICFR status / audit findings, and
minutes the review with sign-off.

**Cadence.** **Quarterly** — the readiness monitor flags *overdue* when the last meeting is older than
**92 days** (`oversight.next_due`).

**Procedure (per meeting).**
1. **Convene** — Chair calls the meeting per the charter (`compliance/policies/04`); circulate the agenda
   (Appendix B) ≥ 5 business days ahead with the ICFR pack: RCM exceptions, the maker-checker backlog
   (`GET /api/finance/approvals/pending`, GOV-01), open whistleblower cases, prior-meeting follow-ups.
2. **Review ICFR** — minute the control environment, significant deficiencies, management's remediation,
   and the whistleblower-case summary.
3. **Record it** — Secretary logs the meeting:
   `POST /api/governance/oversight { "meeting_date": "YYYY-MM-DD", "kind": "audit_committee",
   "topics": "...", "icfr_reviewed": true, "findings_reviewed": "...", "attendees": "...",
   "minutes_ref": "...", "signed_off_by": "<AC Chair>" }`.
4. **Approve minutes** — the next meeting approves the prior minutes; file the signed PDF within 10 business
   days and reference it in `minutes_ref`.

**Evidence.** The `governance_oversight` log (with `icfr_reviewed=true` + `signed_off_by`) + the signed
minutes. **Agenda + minutes** templates in Appendix B.

---

## ELC-04 — Whistleblower hotline (intake + investigation)

**Objective.** A safe, anonymous-capable reporting channel with a tracked case lifecycle and
non-retaliation, overseen by the Audit Committee.

**Cadence.** **Continuous** intake; the Audit Committee reviews open cases **every meeting**; investigate to
resolution within the **30-day SLA** (the readiness monitor flags cases open beyond it).

**Procedure.**
1. **Intake** — a reporter files via `POST /api/governance/hotline/cases { "allegation": "...",
   "category": "...", "anonymous": true }` (the policy's email channel feeds the same log). Anonymous by
   default — the reporter is recorded only if they opt out. A `case_ref` (`WB-XXXXXXXX`) is returned.
2. **Triage** — Compliance assigns a handler and advances the case:
   `PATCH /api/governance/hotline/cases/{ref} { "status": "investigating", "resolution_note": "..." }`.
   (Recuse anyone named in the allegation — never self-handle.)
3. **Investigate** — gather facts; the immutable audit trail (ITGC-AC-10) scopes any data review.
4. **Resolve / dismiss** — `PATCH .../{ref} { "status": "resolved"|"dismissed", "resolution_note": "..." }`.
5. **Oversee** — every Audit Committee meeting reviews the case log
   (`GET /api/governance/hotline/cases`); the weekly `governance_readiness` job raises an `ELC-04` alert for
   any case past the SLA. Non-retaliation per `compliance/policies/02`.

**Evidence.** The `whistleblower_cases` log (case_ref, status lifecycle, handler, resolution) + investigation
working papers. **Case intake + triage SOP** in Appendix C.

---

## Operating calendar

| When | Action |
|---|---|
| On hire | New joiner acknowledges the code of conduct (ELC-01) |
| Weekly | `governance_readiness` job → coverage / cadence / ageing snapshot + alerts |
| Quarterly | Audit-committee meeting → ICFR review + minutes (ELC-02); review open hotline cases (ELC-04) |
| Annually | Code-of-conduct acknowledgement campaign (ELC-01); refresh the fraud-risk register (ELC-05) |
| Continuous | Whistleblower intake + investigation within the 30-day SLA (ELC-04) |

## Appendix A — Code-of-conduct acknowledgement statement

> *I confirm that I have received, read and understood the Company's Code of Conduct (version `<version>`),
> including the conflict-of-interest and anti-corruption provisions. I agree to comply with it and to report
> any suspected breach through the channels described in the Whistleblower Policy. I understand that good-faith
> reporting is protected from retaliation.*
>
> Name · Role · Date · Version (captured as the `ethics_acknowledgements` row).

## Appendix B — Audit-committee agenda + minutes

**Agenda:** 1) Approve prior minutes · 2) ICFR status — RCM exceptions, maker-checker backlog (GOV-01),
control changes · 3) Internal/external audit findings + remediation · 4) Whistleblower case summary ·
5) Fraud-risk register review · 6) Other business · 7) Confirm next meeting (≤ 92 days).

**Minutes (capture in `findings_reviewed` / `minutes_ref`):** date, attendees/quorum, materials reviewed,
ICFR conclusions, decisions + owners + due dates, whistleblower cases reviewed, sign-off by the Chair.

## Appendix C — Whistleblower case intake + triage SOP

1. Receive → auto `case_ref`; preserve anonymity unless the reporter opts out.
2. Acknowledge (if contactable) within 3 business days; assign an independent handler (recuse the named).
3. `investigating` within 5 business days; categorise (fraud / controls / conduct / safety / retaliation).
4. Investigate; document working papers; target resolution within **30 days** (SLA).
5. `resolved` / `dismissed` with a resolution note; report disposition to the Audit Committee.
6. Apply non-retaliation protection throughout (`compliance/policies/02`).

## Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-06-30 | Compliance | Initial ELC operating manual — runbooks + cadence + templates for ELC-01/02/04, the `governance_readiness` monitor + weekly reminder job, and the operating calendar. Pairs with the in-app governance module (`modules/governance`) that captures the evidence. |
