# Pre-deletion checklist — destructive infrastructure changes (ITGC-OP)

**Scope:** deleting or replacing ANY production infrastructure resource — a database/Postgres service,
a Railway service, a volume, a domain, an environment, or a bulk set of service variables.
**Why this exists:** on 2026-07-09 an "orphan" Postgres service was deleted because a dashboard
suggestion said it was unused — without first verifying which service actually referenced it. The
deletion set off a chain (superuser `DATABASE_URL` swap → 3 failed deploys → hand-rebuild of the
service env) that silently dropped `AUTH_COOKIE_SAMESITE` and produced the July-10 login-bounce
outage (`docs/ops/incident-2026-07-10-login-bounce-cross-site-cookie.md`). The deletion itself turned
out to be harmless — but that was luck, established only *after the fact*. "The system suggested it"
is not verification.

## Before deleting a database (or any data-bearing resource)

1. **Identify what references it.** Match the resource's private domain / connection host against every
   service's variables. One dispatch per service of `Ops — Railway failed-deploy diagnostics` prints
   the variable names; the H-3 provisioning workflow shows the pattern for matching
   `DATABASE_URL` hosts against `RAILWAY_PRIVATE_DOMAIN`. **Nothing may reference the resource.**
2. **Prove it is not the live datastore.** Connect and inspect: the live ERP DB has
   `drizzle.__drizzle_migrations` with 100+ rows and populated `tenants` / `users` tables (this is the
   same sanity gate `ops-provision-app-role.yml` enforces before touching roles). An empty or
   never-migrated database plus zero recent connections (`pg_stat_activity`) is deletable; anything
   else stops here.
3. **Snapshot anyway.** Take a backup/dump (tools/BACKUP-RUNBOOK.md) of anything data-bearing before
   deletion — deletion must be a two-key operation: verify, snapshot, then delete.
4. **Record it.** Note what was deleted, the evidence from steps 1–2, and the snapshot location in an
   ops log entry (a dated note under `docs/ops/`). If the deletion is part of an incident, it goes in
   the incident timeline.

## Before/after touching service environment variables in bulk

- `docs/ops/railway-env-manifest.json` is the **config-of-record for variable names** per service.
  Any variable you add/remove on a service must be reflected there in the same change.
- After ANY hand-edit of service env (especially under incident pressure), dispatch
  `Ops — synthetic prod probe` and confirm the `env-manifest` job passes — it fails loudly on a lost
  name, which is exactly the mistake hand-rebuilds make. The probe also runs on a 30-min schedule,
  so a miss pages within half an hour instead of waiting for a user report.
- Never rebuild a service's variables from memory. Reconstruct from the manifest + the referenced
  secrets store, then verify.

## The two-question test (print this)

Before any destructive action, be able to answer — with evidence, not inference:

1. **What breaks if I'm wrong?** (blast radius — who references this resource?)
2. **How do I get back?** (snapshot/rollback path, verified to exist *before* acting)

If either answer is "I think…", stop and verify first. An AI assistant's or a dashboard's suggestion
to delete something is a *hypothesis to verify*, never an authorization.

## Revision history

| Date | Version | Change |
|---|---|---|
| 2026-07-10 | 1.0 | Initial runbook — incident 2026-07-10 follow-up (unverified orphan-DB deletion as trigger). |
