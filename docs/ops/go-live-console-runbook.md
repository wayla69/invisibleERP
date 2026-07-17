# Go-live console & people runbook — the non-code checklist

> **Date:** 2026-07-02 · **Status:** v1.5 — OPEN (every item here is blocked on a human or a console, not code) · **Owner:** CEO / CFO + Platform
> **Purpose:** docs/27 closed every repo-tractable audit finding; this runbook consolidates the remainder —
> each item names its owner, the exact console/legal action, the env var or command involved, and the
> verification that proves it done. Work through it top-down; strike items in the revision table as they land.

## 0. Code-side gate verification sweep — 2026-07-17 (main @ `67b6ca6`)

Every item below is blocked on a human/console by design, but each one leans on a **code gate** that must
keep holding until the human acts. This sweep re-verified every gate on current main; re-run it (grep the
named symbol) whenever main moves materially, and strike this table's row when the console side lands.

| # | Item | Code gate verified on main | Console/human side |
|---|---|---|---|
| 1 | Legal execution | `/legal/privacy` page present, still marked ฉบับร่าง (DRAFT) — correctly unpublished ✅ | ⏳ counsel executes + publishes |
| 2 | Anthropic DPA | Fail-closed `AI_DPA_REQUIRED` in `common/ai-models.ts`; boot warn in `common/env.validation.ts` ✅ | ⏳ sign DPA, set `AI_DPA_ACKNOWLEDGED` |
| 3 | SOC 2 evidence pack | `compliance` CI job writes the `EVIDENCE_OUT` artifact per run ✅ | ⏳ engage firm, archive quarterly |
| 4 | ELC operation | Registers + `governance` harness live; `CONTROL_STATUS_HONEST.md` keeps ELC-01/02/04 honestly **Partial** ✅ | ⏳ run the campaigns/cadence/hotline |
| 5 | PgBouncer + Redis | `tools/ops/pgbouncer/pgbouncer.ini` + `userlist.txt.example` present; `realtime-bus.ts` degrades local-only with the `realtime_redis_publish_failed` ops alert ✅ | ⏳ provision on Railway, set `REALTIME_REDIS_URL`, point `DATABASE_URL` at :6432 |
| 6 | PII backfill | `db:backfill:pii` script (`backfill-encrypt-pii.ts`, idempotent) present ✅ | ⏳ one-time prod run with `PII_ENCRYPTION_KEY` |
| 7 | Capacity baseline | `loadtest` manual-dispatch workflow with `pg_url` input present ✅; **§4 baseline table has no dated staging row yet** | ⏳ dispatch vs staging (after item 5), record numbers |
| 8 | Seed credentials | Seeder refuses prod admin without `SEED_ADMIN_PASSWORD` (+ `ALLOW_PROD_SEED`); `must_change_password` on first login ✅ | ⏳ vault the password at provisioning |
| 9 | Wave 6 business evidence | n/a (no code gate) | ⏳ CEO |
| 10–12 | Tenant reset / delete / purge | `@PlatformAdmin` endpoints with two-step suspend-first safety + confirm-code, audit chain preserved (migration 0393) ✅ | ⏳ operate when the pilot moves to real usage |
| 13 | SME launch gate | Deploy smoke warn-skips loudly without `SMOKE_USER`/`SMOKE_PASS` ✅; `sme_review` permission + nav-profile tests + industry stamping live ✅ | ⏳ SME defaults tab, provision edition+industry, accountant login |

**Sweep verdict:** all code gates hold on `67b6ca6`; zero regressions. Every remaining opener is
console/legal/people work — the launch-blocking engineering surface is **empty**.

## 1. Legal execution (counsel) — AUD-LGL-02

**Owner:** CEO + external counsel.
**Action:** complete the `<<…>>` placeholders and execute:
`docs/legal/terms-of-service.md` · `data-processing-agreement.md` · `privacy-policy.md` · `sla.md`.
Publish the executed privacy policy and update the served summary page (`apps/web/src/app/legal/privacy/page.tsx`) to match — that page is deliberately a plain server component; edits are text-only.
**Verify:** executed PDFs stored in the compliance evidence archive; `/legal/privacy` no longer says DRAFT.
**Evidence:** signed instruments + publication date (SOC 2 CC2.3).

## 2. Anthropic Data Processing Addendum → unblock AI — AUD-LGL-02

**Owner:** CEO (signature) + Platform (env).
**Action:** execute the Anthropic commercial DPA, then set **`AI_DPA_ACKNOWLEDGED=<date/reference>`** in the API environment (Railway). Until then the platform **fails closed**: any agent endpoint raises `AI_DPA_REQUIRED` even with `ANTHROPIC_API_KEY` set (see `common/ai-models.ts`; `env.validation.ts` warns at boot).
**Verify:** `POST /api/ai/agent/*` no longer returns 403 `AI_DPA_REQUIRED`; boot log warning gone.
**Evidence:** signed addendum + the env-change change-record (change-management.md).

## 3. SOC 2 Type I engagement + evidence window — AUD-CMP-03

**Owner:** CFO.
**Action:** engage the audit firm (Type I first, Type II after ≥1 quarter of operating evidence). The control-evidence pack is already automated: the `compliance` CI job writes the ICFR evidence artifact (`EVIDENCE_OUT`) per run — archive one pack per quarter, plus the RCM (`compliance/Oshinei_ERP_SOX_RCM_v1.xlsx`) and `COSO_ICFR_Audit_Readiness_Plan.md` as the auditor's PBC starting set.
**Verify:** signed engagement letter; first quarterly evidence archive folder exists.

## 4. Operate the entity-level controls — AUD-CMP-04 (R3-4)

**Owner:** CEO / board.
**Action:** the *system* side is built (registers + `governance` harness); the *people* side must run:
- **ELC-01** — hold the annual ethics acknowledgement campaign (HR); register captures sign-offs.
- **ELC-02** — convene the audit-committee cadence (board); minutes logged to the oversight register.
- **ELC-04** — operate the whistleblower channel (triage + case log).
**Verify:** each register shows ≥1 real cycle of entries; `CONTROL_STATUS_HONEST.md` ELC rows flip Partial → Implemented with the operating date.

## 5. Railway provisioning: PgBouncer + Redis — AUD-ARC-03 / AUD-ARC-06

**Owner:** Platform (console).
**Action (per `capacity-and-pooling.md` §2/§5 + `deployment.md` §4):**
1. Deploy PgBouncer (transaction mode; config at `tools/ops/pgbouncer/pgbouncer.ini`) and point the API **`DATABASE_URL`** at `:6432`, not Postgres directly.
2. Add the Redis add-on and set **`REALTIME_REDIS_URL`** — the SSE fan-out (`common/realtime-bus.ts`) is already multi-node-ready and degrades to local-only (with an ops alert) until this is set.
**Verify:** `SHOW POOLS` shows client multiplexing; two API replicas both deliver a live KDS/BI event (the `realtime_redis_publish_failed` ops alert stops appearing).

## 6. Production PII backfill — AUD-LGL-01 (R0-1)

**Owner:** Platform, one-time after deploy of the encryption release.
**Action:** with **`PII_ENCRYPTION_KEY`** set in prod, run `pnpm --filter @ierp/api db:backfill:pii`
(idempotent — re-encrypts legacy plaintext rows in place; see `pii-encryption-rollout.md`).
**Verify:** re-run prints 0 remaining plaintext rows; spot-check ciphertext at rest via SQL.
**Evidence:** run output captured to the change record.

## 7. Staging capacity baseline — AUD-ARC-06 (R1-5, repo half done)

**Owner:** Platform.
**Action:** dispatch the `loadtest` GitHub workflow against staging (real Postgres + PgBouncer via `pg_url` input, after item 5) and copy the numbers into the `capacity-and-pooling.md` **§4 baseline table** — that table is the audit evidence for capacity; repeat each release.
**Verify:** §4 table has a dated row with rps/p95 and the artifact link.

## 8. Production seed credentials — AUD-SEC-03

**Owner:** Platform.
**Action:** prod provisioning must set **`SEED_ADMIN_PASSWORD`** (≥8 chars) — the seeder refuses to create the admin without it and never prints credentials; the old well-known `admin/admin123` cannot reach prod.
**Verify:** first login uses the vaulted password and forces a change (`must_change_password`).

## 9. Wave 6 — business evidence — AUD-BIZ-01

**Owner:** CEO.
**Action:** outside engineering scope: land external tenants, record revenue evidence, and align the
NASDAQ narrative to it (docs/27 Wave 6: customers, pricing, PMO). Tracked here only so this runbook is the
single open-items list.

## 10. Pilot-company test-data factory reset (suspend → reset → reactivate) — ITGC-AC-18

**Owner:** Platform.
**Action:** when the pilot company (e.g. **Amber**) finishes UAT and is ready to start real usage, in
`/platform` → บริษัท: (a) **suspend** the company (its users are blocked from this moment — the reset
button only appears on a suspended company), (b) open the company drawer → danger zone **ล้างข้อมูลบริษัท
(Factory reset)** → type the company code → reset — test data is wiped (logins, plan, and the ITGC-AC-16
audit chain are preserved; fiscal year + CoA re-seeded), then (c) **reactivate** the company and hand it
back for real usage. No env var involved: the operation is permanent but only ever possible on a company
that was deliberately taken offline first, so an actively-used company cannot be wiped in one click.
**Verify:** after (b) the company's transaction lists are empty; after (c) its admin logs in and works
normally; the reset appears in the company's audit trail + the god notification inbox.
Model + gates: `docs/ops/tenancy-model.md` §2 (rev 1.19).

## 11. Deleting a pure-test company (suspend → delete) — ITGC-AC-18

**Owner:** Platform.
**Action:** for a company that was ONLY ever used for testing and should stop existing entirely (not just
have its data reset — e.g. a duplicate/mistaken provision), in `/platform` → บริษัท: (a) **suspend** the
company if not already, (b) open the company drawer → danger zone **ลบบริษัท (Delete company)** → type the
company code → delete. This is lighter than item 10's factory reset: it does **not** touch any business
data, it only flags the company row itself — the company disappears from the fleet list/switcher and its
users are **permanently** blocked (`TENANT_DELETED`), even if the company is later reactivated (reactivate
alone never re-opens a deleted company). Reversible via the drawer's **กู้คืน (Restore)** button (check
"แสดงบริษัทที่ถูกลบ" / show-deleted to find it in the list) — after restoring, the company stays suspended
until a separate reactivate.
**Verify:** after delete, the company is gone from the default `/platform` company list and its admin's
login is blocked with `TENANT_DELETED`; toggling "show deleted" surfaces it again with a Restore action.
Model + gates: `docs/ops/tenancy-model.md` §1bis/§2 (rev 1.24), migration 0393.

## 12. Actually reclaiming space — permanently purging an already-deleted company — ITGC-AC-18

**Owner:** Platform.
**Action:** deleting (item 11) only hides a company — it does not reclaim any space, so a fleet with many
disposable test companies still accumulates junk. Once a company has been deleted (item 11) and you're
certain it will never be needed again, in `/platform` → บริษัท → check "แสดงบริษัทที่ถูกลบ" (show deleted) →
open the company → danger zone **ล้างถาวร (Permanent purge)** → type the company code → purge. This
**IRREVERSIBLE** step wipes every remaining tenant-scoped table (business data, users, subscriptions,
AI/usage meters). **By explicit product decision it never erases `audit_log`** (the ITGC-AC-16 hash chain is
append-only) — so the company record itself also survives purge, kept solely as that audit trail's anchor;
it will always show under "show deleted" with a "ล้างถาวรแล้ว" (Purged) status, but has zero users and can
never log in or be restored again.
**Verify:** after purge, the drawer shows the purged banner (Restore button gone); the company's audit
history is still visible in the cross-company activity feed (§ god notification/audit inbox).
Model + gates: `docs/ops/tenancy-model.md` §2 (rev 1.24), migration 0393.

## 13. SME edition launch gate — docs/49 + docs/51 Track B (control_profile='sme')

**Owner:** Platform (console), before provisioning the first REAL SME company.
**Action:** the SME code paths are all live (docs/49 v1.0–1.6; docs/51 B1/B2/B3), but three launch inputs
are console-side and per-fleet/per-company:
1. **Platform SME defaults** — `/platform` → **ค่าเริ่มต้น SME** tab: set the **external accountant email**
   (this is load-bearing: every new SME company's auto-provisioned monthly **SME-01** self-approval-review
   subscription takes its recipients from this stamped copy — left empty, only the god-inbox leg operates)
   and any fleet-wide extra hidden nav groups (the per-industry hiding/folding is automatic — docs/51 B1).
2. **Provision with the RIGHT edition + industry** — `/platform` → บริษัท → provision form: edition **SME**
   and the company's true industry (restaurant/retail/distribution/services). Both are **birth attributes**:
   edition is upgrade-only afterwards, and the B1 nav profile + B3 starter kit are stamped from the industry
   at creation (a per-company hidden-list fix later is possible via the drawer's ตั้งค่า SME, but the
   default-open profile and starter kit are not re-derived).
3. **SME-02 accountant leg** — in the SME company, create the external accountant a **separate limited
   login** granting only the `sme_review` permission (per-user override in `/admin/users`) so the
   independent-review sign-off leg (`/sme-review`) is operable from day one; the platform owner signs the
   other leg via act-as.
**Verify:** provision a disposable SME test company per target industry → first login shows the folded
industry menu (โครงการ hidden for a restaurant; ~15 items) + the starter kit (sample menu/tables etc.);
`/platform` company drawer shows the SME badge + prefs; `report_subscriptions` has the active monthly
`sme_self_approval_review` row carrying the accountant email; the accountant login reaches `/sme-review`
and nothing else. Then delete+purge the test company (items 11–12).
Model: `docs/49` §6, `docs/51` Track B; code gates verified in `docs/51` Track C (rev 1.3).

## Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 1.5 | 2026-07-17 | Platform | Added §0 — **code-side gate verification sweep** (docs/51 Track C follow-through): every runbook item's underlying code gate re-verified on main `67b6ca6` (fail-closed AI DPA, evidence artifact, ELC honesty, pgbouncer config + realtime degrade alert, PII backfill script, loadtest workflow, seed guard, tenant reset/delete/purge, SME gates + smoke warn-skip). Verdict: all gates hold; the launch-blocking engineering surface is empty — every opener is console/legal/people work. Re-run the sweep when main moves materially. |
| 1.4 | 2026-07-16 | Platform | Added item 13 — **SME edition launch gate** (docs/51 Track C): the three console-side inputs the delivered SME edition needs before real SME provisioning — platform SME defaults (accountant email drives SME-01 recipients), edition+industry chosen correctly at creation (birth attributes: B1 nav profile + B3 starter kit stamp from industry; edition upgrade-only), and the accountant's separate `sme_review`-only login for the SME-02 leg — plus a full per-industry provisioning verification loop using items 11–12 for cleanup. |
| 1.0 | 2026-07-02 | Platform | Initial runbook consolidating every open human/console item from docs/27 (legal execution, Anthropic DPA → `AI_DPA_ACKNOWLEDGED`, SOC 2 engagement + quarterly evidence, ELC operation, Railway PgBouncer/Redis, prod `db:backfill:pii`, loadtest §4 baseline, `SEED_ADMIN_PASSWORD`, Wave 6) with owner + exact action + verification each. |
| 1.1 | 2026-07-09 | Platform | Added item 10 — pilot-company test-data factory reset from the Platform Console (**suspend → reset → reactivate**): wipes a pilot's UAT data before real usage while preserving logins/plan/audit-chain; only ever possible on a suspended company, so an active company cannot be wiped in one click. |
| 1.2 | 2026-07-13 | Platform | Added item 11 — tenant soft-delete (migration 0393, **suspend → delete**): for a pure-test company that should stop existing entirely, lighter than the factory reset (no data touched, only the company row is flagged) and reversible via Restore. Prompted by a request to fully remove a test tenant ("Amber") after the factory reset UI was confused with a full company deletion. |
| 1.3 | 2026-07-13 | Platform | Added item 12 — tenant purge (migration 0393, **delete → purge**): the actual space-reclaiming follow-up to item 11's soft-delete, since delete alone leaves junk accumulating forever. IRREVERSIBLE; wipes everything except `audit_log` (ITGC-AC-16 chain preserved by explicit product decision) and therefore the company record itself. Prompted by the same "Amber" cleanup — soft-delete alone wasn't enough to actually reduce junk. |
