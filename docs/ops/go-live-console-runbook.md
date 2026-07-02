# Go-live console & people runbook — the non-code checklist

> **Date:** 2026-07-02 · **Status:** v1.0 — OPEN (every item here is blocked on a human or a console, not code) · **Owner:** CEO / CFO + Platform
> **Purpose:** docs/27 closed every repo-tractable audit finding; this runbook consolidates the remainder —
> each item names its owner, the exact console/legal action, the env var or command involved, and the
> verification that proves it done. Work through it top-down; strike items in the revision table as they land.

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

## Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 1.0 | 2026-07-02 | Platform | Initial runbook consolidating every open human/console item from docs/27 (legal execution, Anthropic DPA → `AI_DPA_ACKNOWLEDGED`, SOC 2 engagement + quarterly evidence, ELC operation, Railway PgBouncer/Redis, prod `db:backfill:pii`, loadtest §4 baseline, `SEED_ADMIN_PASSWORD`, Wave 6) with owner + exact action + verification each. |
