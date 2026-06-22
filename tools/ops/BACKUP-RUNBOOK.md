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
# optional offsite: also set BACKUP_S3='s3://my-bucket/ierp' (awscli or rclone configured)
```
Produces `ierp-YYYYMMDD-HHMMSS.dump.gz`, **verifies it is restorable** (`pg_restore --list`), uploads if
`BACKUP_S3` set, prunes older than `RETAIN_DAYS`.

### Schedule (pick one)
- **Railway cron service**: a tiny service running `pg-backup.sh` on `0 * * * *` with `DATABASE_URL` + `BACKUP_S3` env.
- **GitHub Actions**: scheduled workflow (`on: schedule: - cron: '0 * * * *'`) with the DB URL + cloud creds in repo secrets, `apt-get install postgresql-client`, run the script, no artifact retention of the dump itself (push to object storage).

## Restore (disaster recovery)
1. Provision a fresh empty Postgres (new Railway DB) and get its `DATABASE_URL`.
2. Fetch the newest good dump (`aws s3 cp …` or local), `gunzip ierp-*.dump.gz`.
3. Restore:
   ```bash
   pg_restore --no-owner --no-privileges --clean --if-exists -d "$NEW_DATABASE_URL" ierp-*.dump
   ```
4. **Re-apply the RLS role + policies** if restoring into a brand-new cluster: migrations 0002/0003/0043
   create the `app_user` role and `tenant_isolation` policies. If the role is missing, run
   `pnpm --filter @ierp/api db:migrate` against the restored DB (idempotent) before pointing the app at it.
5. Point the API's `DATABASE_URL` at the restored DB and redeploy.

## Verify a restore (monthly drill — do NOT skip)
Restore the latest dump into a throwaway DB and sanity-check, then drop it:
```bash
pg_restore --no-owner --no-privileges -d "$SCRATCH_URL" ierp-*.dump
psql "$SCRATCH_URL" -c "select count(*) from tenants;"            # tenants present
psql "$SCRATCH_URL" -c "select code,status from fiscal_periods limit 5;"  # per-tenant periods intact
psql "$SCRATCH_URL" -c "select source,count(*) from journal_entries group by 1;"  # GL intact
```
A backup you have never restored is not a backup.

## Notes / gotchas
- The dump is logical (`pg_dump -Fc`), portable across Postgres minor versions and Railway moves.
- Secrets (`JWT_SECRET`, `APP_ENC_KEY`) are NOT in the DB — keep them in the deploy env / a secret manager.
  Restoring the DB without the same `APP_ENC_KEY` makes encrypted-at-rest fields (TOTP seeds, webhook
  secrets) undecryptable. Back up those keys separately and securely.
- `pg-backup.sh` is offline/standalone — it needs only `pg_dump`/`pg_restore` (postgresql-client) + `DATABASE_URL`.
