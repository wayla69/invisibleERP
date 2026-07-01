# Integration providers — status & go-live guide

**Status: v1.0 · 2026-06-25**

Several outbound integrations ship with a **deterministic mock/stub provider as the
default** and switch to the real provider **only when its credentials are
configured** (an env var or a per-tenant config row). This is intentional and
working-as-designed — it lets CI, demos and no-credential tenants run the full flow
without external accounts, mirroring the same pattern across every integration.

> **This is not a list of gaps.** Each integration's *business logic* is implemented
> and tested; only the **transport to a third party** falls back to a mock until you
> supply credentials. To go live, set the variable(s) below — no code change.

The abstraction + a persisted delivery/submission log mean a mock run is
indistinguishable in shape from a real one (status, refs, audit row), so switching to
real credentials needs no downstream change.

## Provider matrix

| Integration | Code | Mock default | Real provider trigger | Notes |
|---|---|---|---|---|
| **Subscription billing (Stripe)** | `modules/billing/billing.service.ts` (`StripeBillingAdapter`) | mock checkout URL (`mock: true`) | `STRIPE_SECRET_KEY` | Returns a sandbox checkout URL until the key is set; the real SDK call is stubbed in at the marked spot. |
| **Payment gateways (sale/refund)** | `modules/payments/gateways.ts` | `MockGateway` (`name: 'mock'`) | `STRIPE_SECRET_KEY` (Stripe) · `OPN_SECRET_KEY` (Opn/Omise) · PromptPay | Factory returns the real gateway when its secret is present, else mock. |
| **Card-present terminals / PSP** | `modules/pos-terminal/providers.ts` | `MockProvider` | `OMISE_SECRET_KEY` (Opn/Omise wired) · 2C2P / GBPrime follow the same shape | Charge/capture/refund + webhook verification over HTTPS once a secret exists. |
| **e-Invoicing (per country)** | `modules/einvoice/einvoice.service.ts` | provider `stub` (sandbox) | per-tenant `einvoice_config.provider_key` (set in the e-Invoicing screen) | One interface, per-country providers; `stub` validates + logs without submitting. |
| **e-Tax Invoice / e-Receipt (RD/ETDA)** | `modules/pos-fiscal/etax.service.ts` | provider `mock` (acks immediately) | `provider = http` + `ETAX_PROVIDER_URL` / `ETAX_TOKEN`; signing via `ETAX_SIGNING_*` | `http` POSTs the (optionally signed) UBL XML to a generic SP endpoint — drop-in for INET / Frank / Leceipt. |
| **LINE Login (member auth)** | `modules/loyalty/line-auth.ts` | dev `mock:<userId>` token accepted | `LINE_LOGIN_CHANNEL_ID` | With the channel id set, verifies the token against LINE's endpoint. |
| **Customer messaging (LINE / SMS / email)** | `modules/messaging/gateways.ts` (+ `tenant-messaging.service.ts`) | mock records as `sent` | **per-tenant** `PUT /api/messaging/providers/:channel` → else env `LINE_CHANNEL_TOKEN` · `SMS_API_KEY`+`SMS_API_URL` · `SMTP_HOST` | All channels implemented: LINE push + **OA broadcast** + **flex/rich messages** (`pushLineFlex`/`broadcastLineFlex` — cards/carousels), SMS (provider-agnostic HTTP REST + `SMS_SENDER`), email (SMTP/nodemailer). **Resolution order: per-tenant creds (encrypted at rest) → platform env → mock**, so a tenant can use its own LINE OA / SMS sender / SMTP mailbox. **Inbound:** `POST /api/line/webhook/:tenantCode` receives follow/unfollow (auto-enrol on follow), authenticated by the tenant's LINE Channel Secret (HMAC over the raw body). |
| **Connectors (ingest framework)** | `modules/connectors/connectors.service.ts` | stub transport (canonical fixtures) | real transport per connector type (D2 framework) | `bank_csv` parses posted statement text; other types return deterministic fixtures until wired. |
| **Channel adapters (delivery aggregators)** | `modules/channel-adapter/providers.ts` | `MockPlatformProvider` | `CHANNEL_API_URL_<PLATFORM>` + `CHANNEL_API_TOKEN_<PLATFORM>` | Per-platform (e.g. `..._GRAB`, `..._LINEMAN`); real `HttpPlatformProvider` when the URL is set. |
| **Object storage (receipt photos / blobs)** | `common/object-storage.ts` | inline base64 blob kept in the DB | `OBJECT_STORE_URL` (+ `OBJECT_STORE_TOKEN`, `OBJECT_STORE_PUBLIC_URL`) | S3-compatible (S3/MinIO/R2) via authorized HTTP PUT/DELETE; when set, receipt submissions store an `objstore:<key>` reference instead of the megabyte data URL. Unset ⇒ inline (unchanged). PDPA erasure deletes the object. |

## Go-live checklist (per integration)

1. Obtain credentials from the provider (or, for e-Invoicing, pick the per-country provider in the **e-Invoicing** settings screen).
2. Set the env var(s) in the table above on the API service (or the per-tenant config row where noted).
3. Redeploy/restart the API so the factory re-resolves the provider.
4. Run one transaction and confirm the persisted log row shows the **real** provider name (not `mock`) and a real provider ref.
5. For e-Tax, also configure `ETAX_SIGNING_*` if the SP requires a signed document.

## Related

- **SSO/OIDC is *not* in this list** — it is a fully-implemented feature, configured
  **per tenant** (not by env) in **Settings → Identity**: `modules/identity/sso.service.ts`
  validates the `id_token` (issuer / audience / expiry / subject), JIT-provisions the
  user and mints the session JWT; the auth-code → token exchange runs over the network
  in production. (RS256/JWKS signature verification is a documented follow-on to the
  current HS256 `client_secret` path.) The earlier unused `platform/oidc.service.ts`
  scaffold — which duplicated this and threw `NOT_CONFIGURED` — was **removed** as dead
  code so it can't be mistaken for the live path.
- Security posture of these seams: `compliance/vulnerability-triage.md`.
