# 49 — SME Single-User Edition: One Operator, Every Job — Design & Roadmap

> **Date:** 2026-07-15 · **Status:** v0.1 — **PLAN / DRAFT** (not started) · **Owner:** ERP / Product / Compliance
> **Scope:** Deliver an **SME edition** in which **one person can legitimately perform every job** — without
> forking the codebase and without silently disabling the SOX/ICFR control fabric. The relaxation is a
> **per-tenant, configurable policy** layered on the *existing* maker-checker seams, backed by a documented
> **compensating detective control** so the audit trail stays honest for the NASDAQ/ISO narrative.
> **Decision recorded (this doc):** **Do NOT fork** into a separate repo or a separate web/API app.
> Ship it as an **edition-as-config** cross-cutting policy (sibling of `TENANCY_MODE`), same delivery
> discipline as `docs/19`/`23` — each phase an independently-shippable, doc-synced PR (migration *if any* +
> module + permissions/SoD + RCM control + narrative + user-manual + UAT + cutover-harness), merged only on
> a fully green CI matrix.

---

## 0. Read this first — why config, not a fork

The customer's ask ("อีก version สำหรับ SMEs ที่คนเดียวทำได้ทุกงาน") is real, but **"one operator does
everything" is not a new business domain** — it is a **policy over the controls that already exist**. Per the
Architecture Gatekeeper rules it therefore belongs at the **tenancy/policy layer**, exactly where
`TENANCY_MODE` already lives (`apps/api/src/common/env.validation.ts:63`), **not** in a new module and
**absolutely not** in a second repository.

**Why a fork is the wrong call.** The whole system's value and its NASDAQ/SOX/ISO story rest on one spine:
Segregation of Duties + maker-checker + multi-tenant RLS + a first-class documentation set (RCM, process
narratives, UAT, ~110 cutover harnesses). A fork means maintaining **two** of each; within a quarter the
editions diverge and the compliance deliverables rot. One codebase with a per-tenant switch keeps a single
source of truth and lets a company **upgrade SME → Enterprise by flipping a flag**, not by migrating apps.

**The real blocker is two layers, and only the second one needs new work.**

| Layer | What blocks a solo operator | Fix |
|---|---|---|
| **1. Permission grants** | Roles hand out *granular* duties; no single stock role holds them all. | Easy — a broad `SME_OWNER` role (all duties). Pure data in `permissions.ts`. |
| **2. Runtime maker-checker invariant** | Many services **hard-block** `approver === maker` regardless of permissions held. | The actual design work — route every such site through **one** policy helper that an SME profile can relax *within bounds*. |

Layer 2 is where a solo operator hits a wall **even with every permission**. Representative hard blocks
found in the code (non-exhaustive — Phase S1 enumerates all):

- `apps/api/src/modules/giftcards/gift-card.service.ts:63` → `SOD_VIOLATION` (issuer ≠ approver)
- `apps/api/src/modules/cpq/cpq.service.ts:238` / `:296` → `SOD_SELF_APPROVAL` (quote author ≠ discount approver)
- GL-05 in `apps/api/src/modules/ledger/ledger.service.ts` — a manual JE posts **Draft**, excluded from
  balances until a **different** user approves (`postEntry`)
- Project billing / subcon / RE contract / QC / MDM self-approval blocks (SoD rules **R17–R22**,
  `packages/shared/src/permissions.ts:243`–`:259`)

**What this plan does NOT touch (hard lines — keep fail-closed):**

- **Tenant isolation & RLS stay fully intact.** SME edition relaxes *maker ≠ checker*; it never relaxes
  *tenant_id* filtering, the tenancy boot checks (`common/tenancy-boot-check.ts`, H-3/H-4), or the
  non-superuser `ierp_app` role. A one-person company is still one tenant with hard data isolation.
- **No silent bypass.** A relaxed maker-checker step is **not** invisible — it is a **logged self-approval
  with a mandatory justification**, surfaced in a detective **compensating control** (§4). This is the
  difference between "an SME edition" and "a hole in the control fabric."

---

## 1. The mechanism — `control_profile` per tenant

A single per-tenant enum, resolved **live** (like role/orgId/tenantId in the guard), with an env-provided
default for newly-provisioned companies. Model it on `TENANCY_MODE`.

### 1.1 Data + config
- **Migration (Phase S1):** add `tenants.control_profile text NOT NULL DEFAULT 'enterprise'`
  (`'enterprise' | 'sme'`). No RLS change — it is a column on the existing `tenants` row. Journal it; bump
  the migration number to the next free id.
- **Env default:** `DEFAULT_CONTROL_PROFILE` (default `enterprise`) — the profile stamped on a company at
  provisioning (`modules/billing/tenant-provisioning.service.ts`). Add a **warn** in `env.validation.ts`
  mirroring the `TENANCY_MODE` block (invalid value ⇒ fall back to `enterprise`, the safe default).
- **Who flips it:** the platform owner ("god") per company via a `@PlatformAdmin` route on the billing
  admin controller (`admin/tenants/:id/control-profile`), so switching an existing customer to SME is a
  conscious, audited fleet action — never a client-supplied header.

### 1.2 The single policy seam — `common/control-profile.ts`
One helper that **every** maker-checker site calls, instead of the scattered inline
`maker === approver` checks. This is the loose-coupling / bounded-context win — the SME relaxation lives in
**one** file, not sprinkled across 20 services.

```ts
// common/control-profile.ts  (types only — illustrative)
export type ControlProfile = 'enterprise' | 'sme';

// A maker-checker EVENT with its risk tier + the amount (in THB) at stake.
export interface MakerCheckerCtx {
  profile: ControlProfile;
  event: string;          // e.g. 'gl.je.approve', 'cpq.discount.approve', 'giftcard.issue'
  maker: string;          // username
  approver: string;       // username
  amount?: number;        // THB, if the event is monetary
  reason?: string;        // mandatory when a self-approval is being allowed
}

// Returns { ok } or throws ForbiddenException(SOD_SELF_APPROVAL) — the ONE place the invariant lives.
export function assertMakerChecker(ctx: MakerCheckerCtx): void;
```

Decision rule inside `assertMakerChecker`:

1. **`enterprise`** → today's behaviour verbatim: `maker === approver` ⇒ throw `SOD_SELF_APPROVAL`. Zero
   behaviour change (goldenmaster/writeflow parity holds).
2. **`sme`** → allow `maker === approver` **only when both**:
   - the event's `amount` is **at or below** that event's **self-approval threshold** (a per-event, per-tenant
     table `control_profile_limits`, sensible SME defaults, editable by the owner), **and**
   - a non-empty `reason` is supplied (persisted on the approval row + emitted to `audit_log` with a
     `self_approved: true` marker).
   Above the threshold, `sme` behaves like `enterprise` — the solo owner must still bring in a second
   approver (or the transaction parks in the maker-checker queue). This keeps a genuine ceiling on
   unreviewed self-authorization.

> **Never** read `control_profile` from a client header or JWT claim — source it live from the DB in the
> interceptor/guard alongside `tenantId` (L-3 pattern), so a client can't self-upgrade to SME.

---

## 2. Architecture Gatekeeper pre-flight (recorded)

1. **Context Check:** ✅ Correct layer. This is a cross-cutting *policy*, placed beside `TENANCY_MODE` in the
   common/tenancy layer + `permissions.ts`. **No** new business module; **no** fork.
2. **Coupling Check:** ✅ Reduces coupling. Today each service re-implements `maker === approver`; this
   centralizes the invariant in `common/control-profile.ts` and every site *depends on that contract only*.
   No cross-domain DB joins introduced.
3. **Test Readiness:** New unit tests for `assertMakerChecker` (both profiles × below/above threshold ×
   reason-present/absent); a **cross-tenant boundary test** proving tenant A can't set/read tenant B's
   profile; and a new `sme` cutover harness (§5). Re-run `basics`, `golden`, `writeflow`, `compliance` —
   they MUST stay green under the default `enterprise` profile (proves zero regression).

---

## 3. Phased delivery (independent, doc-synced PRs, in order)

Each phase is one shippable PR. Phases S2+ depend on S1's seam existing.

### Phase S1 — the seam + the flag (no behaviour change yet) ⭐ first
- Migration: `tenants.control_profile` + `control_profile_limits` (per-event self-approval ceilings).
- `common/control-profile.ts` with `assertMakerChecker`; resolve profile live in
  `common/tenant-tx.interceptor.ts` (beside tenantId).
- `DEFAULT_CONTROL_PROFILE` env + `env.validation.ts` warn.
- **Refactor, don't relax:** replace the inline `maker === approver` checks at the enumerated sites (giftcards,
  cpq, ledger GL-05, project billing/subcon, RE, QC, MDM) with `assertMakerChecker`, **defaulting every
  tenant to `enterprise`** so behaviour is byte-identical. Golden/writeflow/basics MUST be unchanged.
- Unit tests for the helper. **No** SME relaxation is live yet — this PR only proves the seam is inert.

### Phase S2 — the SME owner role + relaxation + the compensating control
- `SME_OWNER` role in `packages/shared/src/permissions.ts` (all duties). Because it *intentionally* holds
  both sides of many `SOD_RULES`, add an explicit **carve-out note** in the SoD registry: under `sme` the
  design conflict is *accepted and compensated* by control **SME-01** (§4), not un-flagged silently.
- Turn on the `sme` branch of `assertMakerChecker` (threshold + mandatory reason + `self_approved` audit
  marker).
- **New detective control SME-01** — the compensating control (§4): a scheduled **self-approval review**
  BI report listing every self-approved transaction in the period, for an independent review (owner's
  accountant / external bookkeeper / platform owner). Rides the BI scheduler as an idempotent action job
  in the owning `*-bi-reports.ts` provider (docs/46 Phase 1 pattern — **not** a new branch in
  `bi-generate.service.ts`).
- RCM: `add(...)` SME-01 in `compliance/build_rcm.py`, regenerate the xlsx, bump the census spans
  (`check-rcm-census.mjs`).

### Phase S3 — SME UX (simplify, don't fork the web app)
- Behind the same `control_profile`, filter `apps/web/src/lib/nav.ts` to an SME-lean navigation (hide
  enterprise-only groups: multi-approver queues, platform/god surfaces already hidden, advanced
  manufacturing depth, etc.), driven by a serializable `edition` prop (RSC-safe — the AppShell selects nav
  internally, per the `use-client`/serialization gotcha).
- Streamlined onboarding for a one-person company (auto-assign `SME_OWNER`, sensible profile defaults).
- Keep the mobile card/table + bottom-sheet patterns; verify no horizontal overflow in every view mode.

### Phase S4 (optional) — upgrade path & packaging
- SME → Enterprise upgrade = flip `control_profile` to `enterprise`; document that above-threshold and all
  self-approved history remains intact and reviewable. Tie into `docs/36-monetization-packaging.md` as a
  plan tier.

---

## 4. The compensating control — SME-01 (makes it audit-honest)

Relaxing maker-checker for a solo operator is **acceptable under ICFR only if a compensating control
detects and reviews the self-authorizations**. SME-01 is that control:

- **Preventive ceiling:** the per-event self-approval threshold (§1.2) — high-risk / high-value actions
  still require a second person even in SME mode.
- **Detective review:** the scheduled *self-approval review* report (every `self_approved` transaction in the
  period, with maker=approver, amount, reason, ref) delivered to an **independent reviewer** — typically the
  SME's external accountant/bookkeeper, or the platform owner. Sign-off is logged.
- **Immutable trail:** every self-approval already writes to the append-only `audit_log`; the `self_approved`
  marker + mandatory `reason` make the exception queryable, not buried.

This is the standard ICFR treatment for small entities where full SoD is impractical: **document the
limitation, cap it, and detect + independently review the exceptions.** It preserves the honest-controls
posture the codebase already fights for (fail-closed defaults, no silent bypass).

---

## 5. Doc-sync & CI impact (per CLAUDE.md MANDATORY policy)

- **Process narratives / RCM:** new control **SME-01** in `build_rcm.py` (regenerate xlsx; bump
  `<!-- rcm-* -->` census spans across the four census docs; `node tools/ci/check-rcm-census.mjs`). Note the
  accepted-and-compensated SoD carve-out in the affected narrative(s) and revision history.
- **User manual:** an "SME / single-operator mode" section — what the profile changes, the self-approval
  threshold, the review report, and the new `SME_OWNER` role.
- **UAT:** positive (solo owner completes a below-threshold flow end-to-end) **and** negative/control
  (above-threshold self-approval is blocked; a self-approval with no reason is rejected; the review report
  lists the exception). Keep the traceability matrix in sync.
- **Cutover harness:** a new `tools/cutover/src/sme.ts` — asserts (a) `enterprise` behaviour unchanged, (b)
  below-threshold self-approval allowed **with** reason, (c) above-threshold blocked, (d) missing reason
  rejected, (e) the self-approval review report surfaces the exception, and (f) the **cross-tenant boundary
  test** (tenant A cannot set/read tenant B's profile or thresholds). Keep `basics`/`golden`/`writeflow`/
  `compliance` green under the default profile.

---

## 6. Open decisions for the owner (before S1 code)

1. **Threshold defaults** — per-event self-approval ceilings for SME mode (e.g. JE ≤ ฿X, discount ≤ Y%,
   gift-card face ≤ ฿Z). Suggest starting conservative and tunable per tenant.
2. **Independent reviewer identity** — is the SME-01 detective review sent to the customer's external
   accountant, the platform owner, or both? Drives who the report is scheduled to.
3. **Which enterprise surfaces to hide** in SME nav (Phase S3) — needs a product pass on `nav.ts` groups.

---

## Revision history
| Rev | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-07-15 | ERP/Product | Initial plan — edition-as-config decision, `control_profile` seam, SME-01 compensating control, 4-phase doc-synced roadmap. Not started. |
