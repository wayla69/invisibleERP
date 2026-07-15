# 49 — SME Single-User Edition: One Operator, Every Job — Design & Roadmap

> **Date:** 2026-07-15 · **Status:** v0.2 — **APPROVED, IN BUILD** (owner decisions recorded §6) · **Owner:** ERP / Product / Compliance
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

### 1.1 Data + config (updated per owner decisions 2026-07-15)
- **Migration (Phase S1):** add `tenants.control_profile text NOT NULL DEFAULT 'enterprise'`
  (`'enterprise' | 'sme'`), a tenant-scoped `self_approvals` evidence table (canonical 0232-form RLS loop +
  `idx_self_approvals_tenant`), and a **platform-level** `platform_sme_defaults` single-row config table
  (no `tenant_id`-named column — platform table pattern; GRANT block per 0234/0247). Journal all; next free
  migration number.
- **Edition is chosen at company CREATION** (provisioning param, default `enterprise`), from the platform
  console's provision form. **Upgrade `sme` → `enterprise` is allowed; downgrade `enterprise` → `sme` is
  FORBIDDEN** (`403 PROFILE_DOWNGRADE_FORBIDDEN`) — an entity that has operated under full SoD may not
  weaken its control environment later (owner decision; also keeps the audit narrative monotonic).
- **Platform SME-defaults config page (god):** a config surface where the platform owner sets the defaults
  every NEW SME company starts with — identical for all SMEs at creation (owner decision): hidden nav
  groups, SME-01 reviewer routing (external-accountant email; platform owner always included), and the
  default `SME_OWNER` role assignment for the company's first admin. Stored in `platform_sme_defaults`;
  applied by `tenant-provisioning.service.ts` at creation time; changing defaults later affects only
  future companies (existing tenants keep their stamped copy).
- **Who flips it:** the platform owner ("god") per company via a `@PlatformAdmin` route
  (`admin/tenants/:id/control-profile`, upgrade-only), so the transition is a conscious, audited fleet
  action — never a client-supplied header.
- **Visible mode indicator:** every user of an SME tenant sees a persistent **"โหมด SME (SME Mode)"** badge
  in the app shell (beside the scope banner), so nobody mistakes a relaxed-SoD environment for the
  enterprise control environment (owner requirement).

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

Decision rule inside `assertMakerChecker` (per owner decision 2026-07-15 — **no amount threshold**):

1. **`enterprise`** → today's behaviour verbatim: `maker === approver` ⇒ throw `SOD_SELF_APPROVAL`. Zero
   behaviour change (goldenmaster/writeflow parity holds).
2. **`sme`** → allow `maker === approver` at **any amount** (owner decision: ไม่มีจำกัด), **provided** a
   non-empty `reason` is supplied. Every allowed self-approval is recorded in the shared, tenant-scoped
   **`self_approvals`** table `{event, ref, username, amount?, reason, at}` + the append-only `audit_log`
   with a `self_approved: true` marker — this feed is what SME-01 (§4) reviews. A missing reason ⇒
   `400 SELF_APPROVAL_REASON_REQUIRED`. With no preventive ceiling, the **detective** SME-01 review is the
   load-bearing compensating control, routed to **both** the customer's external accountant **and** the
   platform owner (owner decision).

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
- Migration: `tenants.control_profile` + `self_approvals` evidence table + `platform_sme_defaults`.
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

- **Preventive gate:** a self-approval is never silent — it fails without an explicit justification
  (`SELF_APPROVAL_REASON_REQUIRED`), and the `enterprise` profile (plus every non-SME tenant) keeps the full
  hard block. (Owner decision: no amount ceiling in SME mode — the detective leg below carries the load.)
- **Detective review:** the scheduled *self-approval review* report (every `self_approved` transaction in the
  period, with maker=approver, amount, reason, ref) delivered to **both** independent reviewers — the SME's
  external accountant/bookkeeper **and** the platform owner. Sign-off is logged.
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

## 6. Owner decisions — RESOLVED 2026-07-15

1. **Threshold defaults** → **ไม่มีจำกัด (no ceiling).** SME self-approval is allowed at any amount; the
   mandatory logged reason + the SME-01 detective review are the compensating controls.
2. **Independent reviewer identity** → **both**: the customer's external accountant **and** the platform
   owner receive the SME-01 self-approval review.
3. **SME nav surface** → **configurable**: a god-only platform config page sets the SME defaults (hidden
   nav groups etc.); **every new SME starts identical** from those defaults.
4. **(added)** Persistent **SME Mode badge** for all users of an SME tenant; edition **chosen at company
   creation**; **upgrade-only** transition (`sme`→`enterprise` allowed, downgrade forbidden); complete,
   working screens for provisioning / config / badge / upgrade.

---

## Revision history
| Rev | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-07-15 | ERP/Product | Initial plan — edition-as-config decision, `control_profile` seam, SME-01 compensating control, 4-phase doc-synced roadmap. Not started. |
| 0.2 | 2026-07-15 | ERP/Product | Owner decisions recorded (§6): no self-approval ceiling; SME-01 → accountant + platform owner; god config page for platform-wide SME defaults; SME Mode badge; edition at creation, upgrade-only. Status → IN BUILD. |
| 1.1 | 2026-07-15 | ERP/Product | **FULL COVERAGE** — every maker-checker self-approval site is wired through the seam: **101 events** (was 12). Adds all of GL (JE reverse GL-17, CoA change, posting rules GL-24, period lock/reopen GL-16/16b, tie-out GL-14, FX reval, deferred tax, consolidation, IC recon, budget, disclosure GL-26, flux GL-25), AP payment runs EXP-13 (approve+execute+discount terms), AR (netting, allowance, cash application, credit hold/limit), treasury ×7, refunds, vendor bank change, tax ×4, master data (reject/import batch/scheduled/SoD-exception/tenant-profile G15), projects (BoQ/CO/close review/portfolio/gates/claims PROJ-16/subcon PROJ-17/PMR ×4), HCM ×7, quality ×7 (QC-01..04), revenue recognition ×4 + REV-24, service ×4, assets FA-10/11/13, landed/std cost, write-off INV-07, transfer INV-16, 3-way override EXP-01, leases, loyalty G13, RE-02, AI actions, campaigns, CRM merge — and the generic **workflow engine** (`workflow.act` + `selfApprovalAllowed` flag to the SoD engine; PERM_PAIR never relaxed). Two deliberate hard blocks stay: self-benefit SoD-exception approval; PERM_PAIR. Historical HTTP-400 sites keep 400 (httpStatus option / as400 remap). Baseline: projects.service/controller & payments +1 import line each (noted); assets/ap-payment-run/procurement SHRANK. PN-23 rev 0.6. |
| 1.0 | 2026-07-15 | ERP/Product | **DELIVERED (v1)** — migration `0413` (`tenants.control_profile`+`sme_prefs`, `self_approvals`, `platform_sme_defaults`); the `common/control-profile.ts` seam (`assertMakerChecker` + `SelfApprovalBody`); live profile on `JwtUser` via the guard's tenants join; **12 events wired v1**: `gl.je.approve` (GL-05), `ap.payment.approve`, `exp.pettycash.approve`, `md.change.approve` (MDM-01), `cpq.discount.approve`/`cpq.quote.accept`/`cpq.quote.reject` (CPQ-01/G12), `inv.stocktake.post` (INV-04), `giftcard.issue.approve` (G1), `hcm.timesheet.approve`/`hcm.leave.approve`, `price.rule.approve` (G6), `gl.recon.certify` — every other maker-checker site keeps the hard block (fail-closed; extend by one `assertMakerChecker` call each; sites in `service-size-baseline.json` files — INV-07 write-off, refunds, assets — deferred to a follow-up that offsets the ratchet). NO new role (per-company Admin already resolves all permissions). God screens: provision edition selector, edition column + one-way upgrade, ค่าเริ่มต้น SME tab; SME banner for all tenant users; web `api.ts` auto-prompts the reason on `SELF_APPROVAL_REASON_REQUIRED`. SME-01 = `sme_self_approval_review` in `governance-bi-reports.ts` (RCM 290). Docs: PN-23 rev 0.5 row 0b; manual 11 + FAQ; UAT-ADM-157..160 + matrix v7.24; ToE `cutover/sme.ts`. |
