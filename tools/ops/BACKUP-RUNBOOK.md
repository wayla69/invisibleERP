# Backup & Restore Runbook — Invisible ERP V2 (Postgres)

The whole system's state is in one Postgres database (Railway). A lost/corrupted DB = total data loss
for every tenant. This is the minimum disaster-recovery procedure.

## Targets
- **RPO** (max data loss): **1 hour** — run `pg-backup.sh` hourly via cron.
- **RTO** (max downtime to restore): **< 30 min** — restore a dump + redeploy.
- **Retention**: 14 daily/hourly dumps locally + offsite copies (S3/R2). Tune `RETAIN_DAYS`.

## Take a backup
```bash
DATABASE_URL='postgres://…' tools/ops/pg-backup.sh /var/backups/ierp
# optional offsite (AWS S3): also set BACKUP_S3='s3://my-bucket/ierp' (awscli or rclone configured)
# optional offsite (Alibaba OSS): also set BACKUP_OSS='oss:ierp-backups/prod' (rclone remote configured)
```
Produces `ierp-YYYYMMDD-HHMMSS.dump.gz`, **verifies it is restorable** (`pg_restore --list`), uploads if
`BACKUP_S3` and/or `BACKUP_OSS` set, prunes older than `RETAIN_DAYS`.

### Schedule (pick one)
- **Railway cron service**: a tiny service running `pg-backup.sh` on `0 * * * *` with `DATABASE_URL` + `BACKUP_S3` env.
- **GitHub Actions**: scheduled workflow (`on: schedule: - cron: '0 * * * *'`) with the DB URL + cloud creds in repo secrets, `apt-get install postgresql-client`, run the script, no artifact retention of the dump itself (push to object storage).
- **Alibaba Cloud ECS (Tier 0)**: `tools/ops/alibaba/ecs-tier0-setup.sh` installs the hourly backup
  (`backup-cron.sh` → local disk + OSS) and the monthly restore drill (`restore-drill-cron.sh`) as host
  cron jobs. See [`alibaba/README.md`](alibaba/README.md).

## Restore (disaster recovery)
Scripted: [`tools/ops/restore.sh`](restore.sh) handles gunzip + `pg_restore --clean --if-exists`.
```bash
TARGET_DATABASE_URL="$NEW_DATABASE_URL" tools/ops/restore.sh ierp-<stamp>.dump.gz
```
Then:
1. **Re-apply the RLS role + policies** if restoring into a brand-new cluster: migrations 0002/0003/0043
   create the `app_user` role and `tenant_isolation` policies. If the role is missing, run
   `pnpm --filter @ierp/api db:migrate` against the restored DB (idempotent) before pointing the app at it.
   (Prod login-role/least-privilege setup is separate: `tools/ops/sql/prod-db-roles.sql`.)
2. Point the API's `DATABASE_URL` at the restored DB and redeploy; confirm `/readyz` is `ready`.

Manual fallback (equivalent): `gunzip ierp-*.dump.gz && pg_restore --no-owner --no-privileges --clean --if-exists -d "$NEW_DATABASE_URL" ierp-*.dump`.

## Verify a restore (quarterly drill — do NOT skip)
Scripted: [`tools/ops/verify-restore.sh`](verify-restore.sh) restores the latest dump into a throwaway
scratch DB, sanity-checks core tables (`tenants`, `users`, `accounts`, `journal_entries`), prints
row counts, then drops the scratch DB — a repeatable, evidence-producing command.
```bash
SCRATCH_ADMIN_URL=postgresql://…/postgres tools/ops/verify-restore.sh
```
A backup you have never restored is not a backup. **Capture the output as ITGC-OP-01 evidence:**

| Drill date | Dump tested | Result | Row counts | Operator | Evidence link |
|---|---|---|---|---|---|
| _pending first drill_ | | | | | |

## Notes / gotchas
- The dump is logical (`pg_dump -Fc`), portable across Postgres minor versions and Railway moves.
- Secrets (`JWT_SECRET`, `APP_ENC_KEY`) are NOT in the DB — keep them in the deploy env / a secret manager.
  Restoring the DB without the same `APP_ENC_KEY` makes encrypted-at-rest fields (TOTP seeds, webhook
  secrets) undecryptable. Back up those keys separately and securely.
- `pg-backup.sh` is offline/standalone — it needs only `pg_dump`/`pg_restore` (postgresql-client) + `DATABASE_URL`.
