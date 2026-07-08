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
| `APP_ENC_KEY` | ✅ (boot-blocking) | Legacy/root AES-256-GCM key (key id `1`) for at-rest ciphertext: TOTP seeds, webhook/SSO/messaging secrets, encrypted PII columns | via the keyring + `key_rotation_sweep` (below) |
| `APP_ENC_KEYRING` | for rotation | JSON map of key id → secret (`{"2":"<random ≥32 chars>"}`); keys derived per id via **HKDF-SHA256** (salted, label-separated). Malformed JSON fails closed. | add a new kid to rotate |
| `APP_ENC_ACTIVE_KID` | for rotation | Which keyring id NEW writes encrypt under (unset ⇒ legacy `1`, byte-identical v1 format). An active kid missing from the ring fails closed. | flip after staging the new kid |
| `PSP_WEBHOOK_SECRET` (or `PSP_WEBHOOK_SECRET_<PROVIDER>`) | ✅ (boot-blocking) | HMAC-verify PSP callbacks | per PSP policy |
| `CORS_ORIGINS` | recommended (warns) | Explicit allowed web origins | on domain change |
| `AUTH_COOKIE_DOMAIN` | **required when web & api are on different hosts** (else login bounces) | Scopes the session cookies (`ierp_token`/`ierp_csrf`) to a shared parent domain (e.g. `.example.com`) so both origins share them. Unset ⇒ host-only (single-origin / same-origin proxy). Not a secret. | on domain change |
| `AUTH_COOKIE_SAMESITE` | only for **cross-registrable-domain** web/api | `Lax` (default) \| `None` \| `Strict`. `None` (true cross-site) auto-adds `Secure` (HTTPS required). Not a secret. | on topology change |
| `AUTH_COOKIE_MAX_AGE` | optional | Session cookie lifetime in seconds (default `43200` = 12h). Not a secret. | n/a |
| `SENTRY_DSN` | recommended | External error-aggregation (Sentry). Not boot-blocking — built-in signals (logs/audit/health/ops-metrics) are always on. | n/a |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | recommended | External distributed tracing (OTel/OTLP export). Not boot-blocking. | n/a |
| `REQUIRE_OBSERVABILITY_BACKENDS` | optional | `=1` **mandates** the two above as a fail-closed boot gate (audited envs); overridable with `ALLOW_NO_OBSERVABILITY=1`. Not a secret. | n/a |
| `TENANCY_MODE` | recommended (`multi-company` if outsiders can sign up) | `single-company` (default, HQ sees all branches) \| `multi-company` (Admin org-scoped — isolates independent companies). Set on **every** API service on the DB. Not a secret. See `tenancy-model.md`. | n/a |
| `PUBLIC_SIGNUP_ENABLED` | optional (prod default = **disabled**) | Gates the public `POST /api/auth/signup` in production (`SIGNUP_DISABLED` when off). Flip truthy to onboard a company, off after. Non-prod always allows signup. Not a secret. | n/a |
| `PLATFORM_ADMIN_USERNAMES` | recommended (to onboard without opening signup) | Comma list of usernames allowed to provision companies via `POST /api/admin/tenants` (`@PlatformAdmin`). Empty ⇒ nobody (secure default). Case-insensitive. Not a secret. See `tenancy-model.md`. | on operator change |
| `TABLE_TOKEN_SECRET` | optional (falls back to `APP_ENC_KEY`) | HMAC for QR table-session tokens | with APP_ENC_KEY |
| `STRIPE_SECRET_KEY` / acquirer keys | if that PSP is enabled | Payment gateway | per PSP policy |
| `ANTHROPIC_API_KEY` | optional | AI assistant/analytics (rule-based fallback if unset) | per provider |
| `LINE_CHANNEL_TOKEN` | if LINE push/marketing is used | Activates the real LINE Messaging API push gateway (else mock). Bearer token from the Official Account channel. | per provider |
| `SMS_API_KEY` + `SMS_API_URL` | if SMS delivery is used | Activate the provider-agnostic SMS gateway (Bearer key + REST endpoint; optional `SMS_SENDER` sender id). Unset ⇒ mock/no-op. | per provider |
| `SMTP_HOST` (+ `SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`/`SMTP_SECURE`) | if email delivery is used | Activate the SMTP email gateway (nodemailer). `SMTP_HOST` present ⇒ real send; unset ⇒ mock/no-op. Optional `SMTP_SUBJECT` default subject. | per provider |

| `OBJECT_STORE_URL` (+ `OBJECT_STORE_TOKEN`/`OBJECT_STORE_PUBLIC_URL`) | if offloading blobs (receipt photos) | Base URL of an S3-compatible object store (S3/MinIO/R2) written via authorized HTTP PUT; `OBJECT_STORE_TOKEN` is the Bearer/presigned auth, `OBJECT_STORE_PUBLIC_URL` an optional CDN read base. Unset ⇒ blobs stay inline in the DB. | per provider |
| `CDP_WEBHOOK_URL` (+ `CDP_WEBHOOK_TOKEN`) | if the scheduled `cdp_export_sync` job pushes to a CDP | Ingest endpoint the member-snapshot batches are POSTed to (`common/cdp-sync.ts`); `CDP_WEBHOOK_TOKEN` is the optional Bearer auth. Unset ⇒ the job reports a `mock` push (no-op). | per provider |

> **Per-tenant provider override.** The above LINE/SMS/SMTP env values are the **platform default**. A tenant
> may register its **own** provider credentials via `PUT /api/messaging/providers/:channel` — stored
> **AES-256-GCM encrypted at rest** in `tenant_messaging_config.config_enc` (guarded by `APP_ENC_KEY`,
> write-only). The gateway resolves **per-tenant creds → platform env → mock**. These are DB secrets, not env.

## 4. Rotation runbook (summary)
1. Generate the new secret in the store. 2. Stage it (new env value). 3. Roll the service (api is
stateless; `JWT_SECRET` rotation logs everyone out by design). 4. Verify `/readyz` + a login. 5. Revoke
the old value.

**Encryption-at-rest key rotation (`APP_ENC_KEY` → keyring, 4.3):** never swap `APP_ENC_KEY` in place —
that bricks stored ciphertext. Instead:
1. Add a new key to the ring: `APP_ENC_KEYRING='{"2":"<new random secret>"}'` (keep `APP_ENC_KEY` set —
   it remains key id `1` for existing ciphertext).
2. Set `APP_ENC_ACTIVE_KID=2` and roll the service — new writes are now `v2:2:…`; all old `v1:` data
   still decrypts (the ciphertext embeds its key id).
3. Run **`key_rotation_sweep`** (BI scheduler report type, or on demand) until it reports `re-encrypted 0`
   — it re-encrypts all 17 at-rest ciphertext columns (PII + TOTP + webhook/SSO/messaging secrets) in
   bounded, idempotent batches (500 rows/column/run).
4. Only then may `APP_ENC_KEY` be retired (after confirming no `v1:` ciphertext remains).
Verified by `apps/api/test/key-rotation.test.ts` + the `bi` cutover harness (inert/rotate/idempotent/rotate-back).

## 5. Known gap / follow-up
- **Key versioning + rotation: DONE (4.3)** — versioned keyring (`APP_ENC_KEYRING`/`APP_ENC_ACTIVE_KID`,
  HKDF-SHA256 with per-kid label separation) + the idempotent `key_rotation_sweep` re-encrypt job; see §4.
  **Remaining:** custody of the root secrets in an **external KMS** (AWS/GCP KMS or Vault) instead of env
  variables — an infrastructure dependency; the keyring already provides the versioning/re-encrypt
  machinery a KMS would drive. The (currently unused) blind-index helper still derives from the legacy
  root — give it its own HKDF label before first wiring a `*_bidx` column.
- **Web auth token hardening** (move from `localStorage` to httpOnly cookie + CSRF) is a cross-cutting
  web+api change deferred to its own tested workstream (ITGC-AC-07) — see the roadmap.

## 6. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-06-23 | Platform / Security | Initial secrets policy + matrix + rotation; documents boot-time fail-closed validation. |
| 1.1 | 2026-06-25 | Platform / Security | Added session-cookie scoping env to the matrix — `AUTH_COOKIE_DOMAIN` (required for separate web/api origins), `AUTH_COOKIE_SAMESITE`, `AUTH_COOKIE_MAX_AGE` (non-secret config, documented for completeness). Cross-references `railway-setup.md` §4. |
| 1.3 | 2026-07-08 | Platform / Security | **4.3 — versioned encryption keyring + rotation runbook.** `APP_ENC_KEYRING`/`APP_ENC_ACTIVE_KID` added to the matrix (HKDF-SHA256, label-separated, fail-closed); §4 gains the staged rotation procedure driven by the idempotent `key_rotation_sweep` job (17 at-rest ciphertext columns); §5 gap narrowed to external-KMS custody of root secrets. |
| 1.2 | 2026-07-01 | Platform | Documented the customer-messaging gateway credentials — `LINE_CHANNEL_TOKEN`, `SMS_API_KEY`/`SMS_API_URL`/`SMS_SENDER`, `SMTP_*` — that switch the SMS and email channels from dev-mock to real delivery (`messaging/gateways.ts`). |
