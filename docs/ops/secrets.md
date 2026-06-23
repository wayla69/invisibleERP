# Ops — Secrets Management (ITGC-AC-12)

> **Status:** v1.0 · **Date:** 2026-06-23 · **Owner:** Platform / Security
> Phase A deliverable of `docs/11-next-upgrade-realworld-roadmap.md`.

## 1. Principle
No plaintext secrets in the repo, images, or logs. Secrets live in a **managed secret store** and are
injected as environment variables at runtime. The API **fails closed**: it refuses to boot in
production when a required secret is missing (`apps/api/src/common/env.validation.ts`), and individual
modules also guard their own secret (JWT in `auth.module.ts`, encryption key in `crypto.ts`, PSP
webhook in the webhook handler).

## 2. Secret store
- **Railway:** project/service Variables (encrypted at rest), scoped per environment. Use a shared
  group for common values; never commit `.env`.
- **Containers/k8s:** a real store — AWS Secrets Manager / GCP Secret Manager / HashiCorp Vault — surfaced
  as env (e.g. External Secrets Operator). Do **not** bake secrets into images (`.dockerignore` excludes `.env`).

## 3. Secret matrix

| Variable | Required in prod | Purpose | Rotation |
|---|---|---|---|
| `DATABASE_URL` | ✅ (boot-blocking) | Postgres connection (use the `ierp_app` least-priv role) | on role/password change |
| `JWT_SECRET` | ✅ (boot-blocking) | Signs session JWTs | quarterly / on suspicion (invalidates sessions) |
| `APP_ENC_KEY` | ✅ (boot-blocking) | AES-256-GCM key for TOTP seeds + webhook secrets at rest | planned workstream — re-encrypt on rotate |
| `PSP_WEBHOOK_SECRET` (or `PSP_WEBHOOK_SECRET_<PROVIDER>`) | ✅ (boot-blocking) | HMAC-verify PSP callbacks | per PSP policy |
| `CORS_ORIGINS` | recommended (warns) | Explicit allowed web origins | on domain change |
| `SENTRY_DSN` | recommended (warns) | Error reporting | n/a |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | recommended (warns) | Trace export | n/a |
| `TABLE_TOKEN_SECRET` | optional (falls back to `APP_ENC_KEY`) | HMAC for QR table-session tokens | with APP_ENC_KEY |
| `STRIPE_SECRET_KEY` / acquirer keys | if that PSP is enabled | Payment gateway | per PSP policy |
| `ANTHROPIC_API_KEY` | optional | AI assistant/analytics (rule-based fallback if unset) | per provider |

## 4. Rotation runbook (summary)
1. Generate the new secret in the store. 2. Stage it (new env value). 3. Roll the service (api is
stateless; `JWT_SECRET` rotation logs everyone out by design). 4. Verify `/readyz` + a login. 5. Revoke
the old value. `APP_ENC_KEY` rotation requires re-encrypting stored ciphertext — tracked as its own
workstream (do **not** rotate it casually; it invalidates stored TOTP/webhook secrets).

## 5. Known gap / follow-up
- **KMS-backed envelope encryption + automated rotation** for `APP_ENC_KEY` is not yet implemented
  (currently a single env-supplied key). Tracked under ITGC-AC-12 as a follow-up.
- **Web auth token hardening** (move from `localStorage` to httpOnly cookie + CSRF) is a cross-cutting
  web+api change deferred to its own tested workstream (ITGC-AC-07) — see the roadmap.

## 6. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-06-23 | Platform / Security | Initial secrets policy + matrix + rotation; documents boot-time fail-closed validation. |
