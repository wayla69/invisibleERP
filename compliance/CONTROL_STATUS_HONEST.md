# Internal-control status — honest baseline & ID crosswalk

> **Purpose.** A plain, defensible statement of where ICFR actually stands, written in response to the PwC
> Capital Markets Advisory review. It (a) corrects the "audit-ready" overclaim, (b) gives the real
> Implemented/Partial/Gap counts, (c) reconciles the panel's control IDs to the RCM (several didn't match,
> which is why built controls read as "missing"), and (d) states a realistic ICFR-attestable timeline.
>
> Source of truth: `compliance/build_rcm.py` → `Oshinei_ERP_SOX_RCM_v1.xlsx` (regenerate, never hand-edit).
> Last reconciled: 2026-06-30.

## 1. We are NOT "audit-ready" — and we should stop saying it

> **Enforced (3.6):** a CI guard `tools/ci/check-overclaims.mjs` now fails the build if a bare "audit-ready"
> / "NASDAQ-ready" / "SOC 2 certified" / "100% compliant" (etc.) reappears in `compliance/**` or `docs/**`
> without an honest qualifier (a negation, the ≥1-quarter-operating-evidence definition, or a dated target).
> This file is exempt (it discusses the retraction). So the retraction below cannot silently regress in a
> future doc edit.

"Audit-ready" implies controls are designed, operating, evidenced over time, and externally testable today.
That is not true and should not be claimed. The accurate statement is:

> The control **environment is real and largely built** — most key controls exist in code with an automated
> Test-of-Effectiveness (ToE) harness re-performing them on every CI run. What remains is (a) a small set of
> partial/gap controls, (b) **time** — an external auditor needs each key control *operating for ≥1 quarter*
> before they can sample it, and (c) the entity-level governance scaffolding (audit committee, ethics policy,
> fraud-risk assessment) that is organizational, not software.

### "Implemented" in the RCM ≠ "attestable"
`Implemented` means: the control exists in the system today and an automated ToE harness proves it *prevents
the risk* (not merely that the code compiles). It does **not** mean operating-effectiveness has been
evidenced over an audit period or tested by an independent firm. Those are separate, later gates.

## 2. Real status (current RCM)

| Status | Count | Share | Meaning |
|--------|-------|-------|---------|
| Implemented | **<!-- rcm-implemented -->209<!-- /rcm-implemented -->** | 98% | Exists + automated ToE harness re-performs it |
| Partial | **<!-- rcm-partial -->3<!-- /rcm-partial -->** | 2% | Capability present; must be formalized/extended |
| Gap | **<!-- rcm-gap -->0<!-- /rcm-gap -->** | 0% | — every control now has at least system scaffolding |
| **Total** | **<!-- rcm-total -->212<!-- /rcm-total -->** | | |

> The counts above carry machine-readable census tags: `python3 compliance/build_rcm.py --counts` is the
> **only source of truth**, and `tools/ci/check-rcm-census.mjs` (CI) fails when any tagged claim drifts
> from it — the 2026-07 investment audit found FIVE different populations quoted across the compliance
> docs (66, 57, 68, 153, 154 vs the then-current 169; the census has since grown as new controls landed), which fails an auditor's first PBC reconciliation.
>
> Note on the panel's "49/77": that snapshot is **stale**. The control set has more than doubled (77 → the tagged total above)
> and implemented coverage has risen as the deepening programs landed. The figures above are generated from
> `build_rcm.py`, not asserted.
>
> **As of 2026-06-30 there are no Gap controls.** The entity-level governance controls were closed two ways
> that reinforce each other: adopted **policy documents** (`compliance/policies/03–05`) + existing system
> **enforcement** (RBAC + maker-checker), and a live **governance-evidence module** (ethics-ack register,
> whistleblower case log, DoA matrix, fraud-risk register, audit-committee oversight log; ToE
> `cutover/governance.ts`). ELC-03 (DoA) and ELC-05 (fraud-risk) are **Implemented** (enforced + documented +
> registered); ELC-01/02/04 remain **Partial** — the *system* captures the evidence, but the *human*
> governance (running the ethics campaign, holding audit-committee meetings, operating the hotline) is the
> org/PMO process that earns the rest. **"No gaps" ≠ "done":** the remaining Partials (the tagged count above — ELC-01/02/04) still need
> operating evidence, and Implemented ≠ externally-attested (see §5).

## 3. Panel ID crosswalk — why "gaps" were actually built

The panel's three headline findings used control IDs that **do not match this RCM's numbering**. Each named
control is in fact built, enforced as a hard gate, and ToE-tested. The mismatch itself is the root cause of
the "missing control" reading.

| Panel said | Panel's claim | Actual RCM control(s) | Real status | Enforcement / evidence |
|------------|---------------|------------------------|-------------|------------------------|
| **EXP-03** — 3-way match "optional, not a hard gate" | Optional | **EXP-01** (3-way match gates AP pay) + **EXP-09** (AP-pay consults match) | Implemented | `assertPayable()` throws `MATCH_BLOCKED` *before* any payment row is created; override is maker-checked (overrider ≠ matcher). ToE in `cutover/match.ts` **and now** `cutover/compliance.ts`. *(RCM's actual EXP-03 = "PR/PO raised without authorization", a different control.)* |
| **GL-06** — period-close "isn't enforced" | Not enforced | **GL-02** (no posting to closed period) + **GL-15** (hard close) + **GL-16** (close/lock SoD) + **GL-19** (pre-lock validation) | Implemented | `postEntry()` rejects a posting into a `Locked` period (`PERIOD_LOCKED`) / `Closed` period (`PERIOD_CLOSED`); locker ≠ starter. ToE in `cutover/compliance.ts`. *(RCM's actual GL-06 = "operator mis-posts to another tenant's books", a tenancy control.)* |
| **PAY-02** — payroll pre-disbursement review "doesn't exist" | Missing | **PAY-03** (payroll run maker-checker) | Implemented | Payroll run posts a **Draft** JE excluded from balances; a different user must approve (reuses GL-05 SoD). ToE in `cutover/compliance.ts`. *(RCM's actual PAY-02 = "statutory withholdings mis-stated", a different control.)* |

**Action taken:** the formal ICFR ToE harness (`cutover/compliance.ts`) now carries an explicitly-labeled
EXP-01/EXP-09 three-way-match test (previously the gate was proven only in `cutover/match.ts`). GL period
gating (GL-02/15/16) and payroll maker-checker (PAY-03) were already in the compliance harness.

## 4. The real remaining work (Partial + Gap)

> This section is a 2026-06-30 snapshot; the **live RCM** (`build_rcm.py` → xlsx) is the source of truth for
> current counts as controls are closed. Since the snapshot, **`ITGC-OP-04` (scheduled-job failure alerting)
> moved to Implemented** — `#264` added job-queue dead-letter alerting + reaper + ops-metrics, and the
> scheduler-swallow gap (a failed BI report/action subscription was recorded but never alerted) was then
> closed with an ops alert + operator notification at `executeSubscription`, ToE in `cutover/bi.ts`.

### Partial (3) — all entity-level governance; **system shipped, human process pending**
`ELC-01` ethics-acknowledgement register (annual campaign = HR process) · `ELC-02` audit-committee oversight
log (holding the meetings = board process) · `ELC-04` whistleblower case log (operating the hotline =
governance process).

> The financial Partials are now closed: `PROJ-03` (WIP/2390 close-review sign-off, maker-checker), `REC-03`
> (per-period intercompany reconciliation sign-off gating consolidation), and `TAX-03` (WHT at AP payment +
> ภ.ง.ด. reporting) all reached **Implemented**. **Every remaining Partial is human-governance, not code** —
> the systems capture the evidence; the company running the ethics campaign, holding the audit-committee
> meetings, and operating the hotline is what earns Implemented.

### Gap — none
There are **no Gap controls**. Each entity-level governance control has an in-app evidence-capture register/log
(the `governance` module — ethics acknowledgement, whistleblower case log, DoA matrix, fraud-risk register,
audit-committee oversight) with permission gating + RLS tenant isolation and a ToE in `cutover/governance.ts`,
**plus** adopted policy documents (`compliance/policies/03–05`). ELC-03 (DoA — enforced by RBAC + maker-checker
and documented) and ELC-05 (fraud-risk register mapped to controls) reached **Implemented**; ELC-01/02/04 sit
at **Partial** — the *system* captures the evidence, but the *human* governance (the ethics campaign, holding
the audit-committee meetings, operating the hotline) is the org/PMO process that earns Implemented.
**"No gaps" is not "done"**, and Implemented ≠ externally-attested (see §5).

## 5. Realistic ICFR-attestable timeline

- **EGC posture (JOBS Act).** SOX **404(b)** external-auditor attestation on ICFR is **deferred** (up to 5
  fiscal years post-IPO, or until EGC status is lost). SOX **302** certifications and **404(a)** management
  ICFR assessment still apply from the first/second annual report.
- **What gates "attestable".** An external auditor samples a key control only after it has **operated for
  ≥1 quarter** with retained evidence. So even a fully-built control cannot be attested the day it ships.
- **Honest earliest date.** Management ICFR assertion (404(a)) is realistically **Q1 2027 at the earliest**,
  and only if a dedicated SOX PMO runs the remediation without slipping: close the 6 entity-level gaps,
  formalize the 9 partials, then accumulate ≥1 (preferably 2–3) quarters of operating evidence. Six-month
  plans rarely land; plan for the controls *and* the evidence period.

## 6. Revision history

| Date | Change |
|------|--------|
| 2026-06-30 | Initial — honest baseline (138/9/6 of 153), panel↔RCM ID crosswalk, "audit-ready" correction, EGC/404(b) timeline. PwC Capital Markets follow-up. |
| 2026-07-02 | **Census reconciliation (docs/27 R3-1 / AUD-CMP-01).** All counts re-generated from `build_rcm.py --counts` (169: 166 Implemented / 3 Partial / 0 Gap) and tagged machine-readable; the new CI guard `check-rcm-census.mjs` blocks future drift. Prior figures in this doc (151/3/0 of 154) were a stale hand-copy. |
| 2026-07-02 | **Operating-evidence clock started (docs/27 R3-3).** CI now retains every `compliance` ToE run as a structured evidence artifact (see soc2-readiness.md §revision 0.3 for the quarterly-archive runbook). The "≥1 quarter of retained operating evidence" precondition for auditor sampling accrues from this date — every earlier day had ToE runs but no retained artifacts. |
