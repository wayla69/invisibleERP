# Disaster Recovery & Business Continuity Plan (ITGC-OP-02)

> **Status:** v1.3 · **Date:** 2026-07-10 · **Owner:** CTO / Platform-SRE · **Review cadence:** annual + after any DR test
> Builds on the backup/restore procedure (`tools/ops/BACKUP-RUNBOOK.md`, ITGC-OP-01). This plan adds the
> scenario playbooks, roles, communications, business-continuity (degraded-mode) posture, and the **DR test
> schedule** — the items OP-02 was missing.

## 1. Objectives (RTO / RPO)

| Tier | What | RPO (max data loss) | RTO (max downtime) | Mechanism |
|---|---|---|---|---|
| Data (DB) | Postgres restore from backup | **1 hour** | **< 30 min** | hourly `pg-backup.sh` + `restore.sh` (OP-01) |
| Service (app) | API/web redeploy | n/a (stateless) | **< 15 min** | redeploy last-good image (`deploy.yml`) |
| Region/provider | full failover to alternate region | **1 hour** (last offsite dump) | **< 4 hours** | restore offsite dump into a new region + repoint DNS |

Offsite copies (S3/R2 or Alibaba OSS) are what make region loss recoverable — backups MUST replicate offsite,
not just to local disk.

## 2. Disaster scenarios & playbooks

1. **DB data loss / corruption** — restore the latest verified dump: `TARGET_DATABASE_URL=… tools/ops/restore.sh
   ierp-<stamp>.dump.gz`, run `db:migrate` (idempotent), repoint `DATABASE_URL`, confirm `/readyz` = ready.
2. **Accidental destructive change** (bad migration / mass delete) — restore to a scratch DB at the last
   good hourly dump, diff/extract the affected rows, or cut over wholesale if within RPO. The append-only
   audit/hash-chain (ITGC-AC-10/16) + field-change log (AC-14) scope the blast radius.
3. **Region / provider outage** — provision Postgres + app in the alternate region, restore the latest
   **offsite** dump, run migrations, deploy the app, repoint DNS/CDN. Track against the 4-hour RTO.
4. **Security incident / ransomware** — isolate; rotate `JWT_SECRET` + `APP_ENC_KEY` + DB creds + API keys
   (revoke via the AC-15/AC-20 paths); restore from a known-clean pre-incident dump; forensics from the
   immutable audit trail. Follow `docs/ops/observability-incident.md` SEV-1.
5. **Dependency outage** (Stripe / Anthropic / LINE) — degrade gracefully: payments fall back to the mock
   tender / cash; AI fails closed (`AI_DPA_REQUIRED` / `AI_UNAVAILABLE`) without blocking core ERP; queue
   webhooks for replay. No data loss.

6. **Store-hub box loss / failure** (LAN-first stores, `docs/41` / `docs/ops/store-hub-setup.md`) — the hub
   holds the store's operational state *and any sale not yet replayed to the cloud*. **RPO = the push
   interval** (cron every 5 min) for revenue, and the nightly verified dump (`hub-backup`) for the rest.
   Playbook: rebuild the box, `docker compose up -d --build`, restore the latest dump (`pg_restore`), then
   `hub-push` — the deterministic `client_uuid` makes the replay idempotent, so re-pushing a restored dump
   **cannot double-post** (BRANCH-04). If the dump predates un-replayed sales, that revenue exists only on
   the lost disk: quantify it from `GET /api/hub/fleet` (last reported backlog) and re-enter centrally.
   While a hub is down the store can point tills at the cloud (browser offline outbox, Phase 0) and sell
   quick sales; dine-in/diner-QR need the hub or the internet.

## 3. Business continuity (degraded-mode operations)

- **POS keeps selling offline** — the restaurant/register offline path buffers sales locally and syncs on
  reconnect (so a backend/region outage doesn't stop the till). Reconcile on recovery.
- **A LAN-first store keeps its whole front-of-house running** on its hub through an internet outage
  (diner QR, KDS, register, buffet, cash sessions); sales + Z-reports replay exactly-once on reconnect
  (BRANCH-04/BRANCH-05). Card/e-wallet capture and PromptPay confirmation still need the internet.
- **Read-mostly fallback** — if the primary DB is degraded, serve from the latest restore in read-mostly
  mode while the primary is rebuilt.
- **Manual control continuity** — maker-checker/SoD and the audit trail remain the controls of record; any
  manual workaround during an incident is logged and reconciled post-incident.

## 4. Roles & responsibilities

| Role | Owner | Responsibility |
|---|---|---|
| Incident Commander | on-call lead | Declares the DR event, runs the playbook, owns the timeline |
| DBA / restore operator | DevOps/DBA | Executes restore/failover, verifies data integrity |
| Comms lead | Product/Support | Status page + stakeholder/customer updates per SEV |
| Exec sponsor | CTO | Go/no-go on region failover; external/legal/regulatory comms |

## 5. Communications

Severity matrix + cadence in `docs/ops/observability-incident.md` (SEV-1: status page + stakeholders ≤ 30 min).
Maintain the status-page + paging routing; PDPA breach notification (controller within 72h) per the DPA.

## 6. DR test schedule (the OP-02 "annual test")

| Test | Frequency | Evidence |
|---|---|---|
| **Restore drill** (restore latest dump → scratch DB → `verify-restore.sh`) | **monthly** | drill log / `restore-drill-cron.sh` output (Alibaba Tier-0 automates it) |
| **Automated DR game-day** (backup → drop → restore → verify → app bring-up, **measured RTO/RPO**) | **monthly + on demand** (doubles as the monthly restore-drill evidence on GitHub-hosted deploys) | CI `DR Game-day` workflow report artifact (archive to `docs/ops/dr-test-reports/`) |
| **Full DR tabletop** (walk a region-loss scenario with roles) | **annually** | tabletop minutes + action items |
| **Live failover game-day** (restore offsite dump into an alternate region, repoint, measure RTO) | **annually** | game-day report with measured RTO/RPO vs targets |

> **First executed: 2026-06-30 — PASS.** Automated data-tier game-day measured **RTO 2.6 s** (target 30 min)
> and **RPO 0 loss** (key-table reconciliation), with the app booting + authenticating on the recovered
> database. Report: [`dr-test-reports/2026-06-30-gameday.md`](dr-test-reports/2026-06-30-gameday.md).
> (Region/DNS failover remains the annual tabletop + live game-day above.)

### DR-test checklist (per live test)
- [ ] Pick the scenario + announce the test window.
- [ ] Restore the latest **offsite** dump into a clean instance; run `db:migrate`.
- [ ] `verify-restore.sh` passes (core tables present, row counts sane).
- [ ] Bring up the app; `/readyz` = ready; smoke-test login + a GL read + a POS sale.
- [ ] **Measure actual RTO/RPO**; compare to §1 targets; file gaps as action items.
- [ ] Record in the DR evidence log; update this plan's revision history.

## 7. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-06-30 | CTO / Platform-SRE | Initial DR/BCP plan — RTO/RPO tiers, scenario playbooks, BCP degraded-mode, roles/comms, DR test schedule + checklist (OP-02 Gap → Implemented). |
| 1.1 | 2026-06-30 | Platform / SRE | Added the **automated DR game-day** (CI `DR Game-day` workflow + `cutover/dr-gameday`) and recorded the **first executed test (PASS: RTO 2.6 s, RPO 0)**. |
| 1.2 | 2026-07-08 | Platform / SRE | **Game-day cadence: annual → MONTHLY** (`dr-gameday.yml` cron) so the automated end-to-end restore test doubles as the monthly restore-drill evidence OP-01/OP-02 commit to on GitHub-hosted deploys (each run uploads its measured-RTO/RPO report, retention 90d; archive to `dr-test-reports/`). RCM OP-02 evidence refs updated. |
| 1.3 | 2026-07-10 | Platform | **Store-hub (LAN-first) DR** — new scenario 6 (hub box loss: RPO = the push interval; restore + idempotent re-push cannot double-post per BRANCH-04; quantify un-replayed revenue from the fleet backlog) and a BCP line for a hub keeping the whole front-of-house running through an internet outage. Runbook: `docs/ops/store-hub-setup.md` (verified nightly `hub-backup`, §8 update procedure). |
