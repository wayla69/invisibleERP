# Ops — Multi-tenant "link-per-customer" runbook (subdomain onboarding)

> **Status:** v1.0 · **Date:** 2026-07-01 · **Owner:** Platform
> Companion to `deployment.md` and `railway-setup.md`. How to give each customer their **own link
> (subdomain) and isolated data** on **one shared deployment** — the recommended model for onboarding many
> Loyalty/CRM/POS customers without standing up a server per customer.

## 1. Two isolation models — pick one

| Model | Isolation | Link per customer | Infra cost | When |
|---|---|---|---|---|
| **A. Shared multi-tenant + subdomain** (this runbook) | **Row-level (RLS by `tenant_id`)** — every query is scoped to the caller's tenant in the DB | `customerA.app.co`, `customerB.app.co` → same deployment | **Shared** across all customers | **Default.** Many customers, fast onboarding, one codebase/one upgrade. |
| **B. Dedicated single-tenant** | Whole stack per customer (own web+api+DB) | own domain, own servers | Per-customer (see §7) | A customer contractually requires physical/DB isolation, a bespoke SLA, or data residency. |

The app is **multi-tenant with Postgres RLS from the ground up** (`apps/api/drizzle/0002_rls.sql`; the api
connects as the least-privilege `ierp_app` role). A customer's users only ever see their own tenant's rows —
so Model A gives each customer a private link + private data **without** a dedicated server. Prefer A;
reserve B for the rare contractual case.

## 2. How tenant isolation actually works (so you can reason about the link)

- **Every tenant has a unique `code`** (`tenants.code`, e.g. `HQ`, `ACME`). Data rows carry `tenant_id`.
- **Staff login → tenant is fixed by the user record.** A staff user belongs to one `tenant_id`
  (`users.tenantId`); on login the per-request RLS transaction scopes all reads/writes to that tenant. The
  subdomain does **not** choose the tenant for staff — the user's credentials do. (Admins/HQ can pass an
  explicit `tenant_id` on cross-tenant aggregations.)
- **Member self-service app (`/m`) → tenant by shop code.** The consumer loyalty app resolves the tenant by
  **shop code + phone** on the public OTP routes (`apps/web/src/app/m/page.tsx` → `tenant_code`), with an
  explicit tenant filter (RLS is bypassed on `@Public` routes, so the code path filters by `tenant_id`
  itself — no cross-tenant leak).
- **Takeaway:** a per-customer **subdomain is a routing/branding layer**, not the security boundary. The
  security boundary is RLS. This is why Model A is safe.

## 3. Provision a new customer (the tenant)

A customer = a **tenant** row + an **Admin** user. Two supported ways:

1. **Self-service signup (SaaS):** `BillingService.signup` (`apps/api/src/modules/billing/billing.service.ts`)
   creates the tenant (`code`, company/tax identity, industry), the first **Admin** user, a **Trialing**
   subscription, provisions the **current fiscal year's periods**, and materialises the chosen **industry
   Chart-of-Accounts** — the tenant can post immediately. Drive it from the public onboarding screen.
2. **Operator-provisioned:** insert the tenant + Admin as `seed.ts` does for `HQ`
   (`db.insert(schema.tenants).values({ code, name })`), then have the customer's Admin set their password on
   first login (forced change).

Either way, note the tenant **`code`** — it is what the customer's member app and subdomain map to.

## 4. Give the customer their link (subdomain)

On the shared deployment (Railway per `railway-setup.md`, or containers per `deployment.md` §2B):

1. **DNS — wildcard.** Point `*.app.example.com` at the **web** service (CNAME/ALIAS). One record covers
   every future customer; no DNS change per onboarding.
2. **TLS — wildcard cert.** Issue `*.app.example.com` (Let's Encrypt DNS-01, or the platform's managed
   wildcard). Every subdomain is HTTPS with no per-customer cert work.
3. **Origins / cookies.** web and api are separate origins:
   - Set the web `NEXT_PUBLIC_API_URL` to the api origin (or use the **same-origin proxy** — `deployment.md`
     §2C `API_PROXY_TARGET` — so the browser makes first-party `/api/*` calls and the session cookie sticks).
   - Set **`AUTH_COOKIE_DOMAIN=.app.example.com`** so the session cookie is shared across all customer
     subdomains under the parent (see `secrets.md`). Add the wildcard/base web origin to **`CORS_ORIGINS`**.
4. **Hand the customer** `https://customerA.app.example.com`. Staff log in with their credentials (tenant
   resolved from the user); the member app uses the customer's shop `code`.

### 4a. Optional enhancement — subdomain auto-selects the shop (member app)
Today the member `/m` app takes the **shop code as typed input**. To make each customer's subdomain
*pre-select* their shop (so members never type a code), read the tenant from the hostname
(`customerA` ← `customerA.app.example.com`) and default the `shop` field. This is a small, isolated web
change (parse `window.location.hostname`, map the left-most label to `tenant_code`, lock the field). **Not
required** for Model A to work — flagged here as a UX follow-up. *(No API/security change: the OTP route
still filters by the resolved `tenant_code`.)*

## 5. Per-customer branding (optional)
Per-tenant theme/logo is available via the **Theme** screen (`/theme`, perms `users`/`exec`) — set the
customer's colours/logo after provisioning so their subdomain looks like their brand. Per-tenant feature
visibility (Labs, module toggles) is covered by `feature_flags` (per-tenant) and `module_configs`
(system-wide) — see `permissions.ts` and `docs/process-narratives/27-platform-customization.md`.

## 6. Messaging providers per customer
Loyalty/CRM outbound (LINE / SMS / email) resolves **per-tenant credentials first, then the platform env
default, then a logged mock** (`messaging/gateways.ts` + `TenantMessagingService`). So on a shared
deployment a customer can use **their own LINE OA token / SMS sender / SMTP mailbox**: an admin sets them via
`PUT /api/messaging/providers/:channel` (`{creds, enabled}`, perms `users`/`exec`) — stored **AES-256-GCM
encrypted at rest** (`tenant_messaging_config.config_enc`, write-only, never returned; `GET
/api/messaging/providers` shows only which channels are configured/enabled). A tenant that sets nothing falls
back to the platform env creds (`LINE_CHANNEL_TOKEN`, `SMS_API_KEY`+`SMS_API_URL`, `SMTP_*` — see
`secrets.md`); unset there too ⇒ mock. This removes the main reason to pick Model B for a "my own OA" customer.

## 7. Cost model (per customer, indicative — THB/month)

Infra is **shared** under Model A; the numbers below are the *dedicated* (Model B) figures for comparison.

| Item | Model A (shared) | Model B (dedicated) |
|---|---|---|
| Compute (web+api) + Postgres | amortised across all customers | ฿1,000–8,000 (Railway/VPS → full cloud HA) |
| Wildcard DNS + TLS | one-time, shared | per-customer domain |
| **Infra subtotal** | **~฿1,500–3,000 total, all customers** | **~฿3,000–8,000 per customer** |
| LINE OA | per LINE plan (free tier → ฿1,200+/mo) | same |
| SMS | ~฿0.25–0.75/message (usage) — prefer LINE for blasts | same |
| Email (SES/SendGrid) | ~$0–20/mo small volume | same |
| Ops/support labour | the real recurring cost — **not** the server | same |

> ⚠️ **Receipt images scale note.** Receipt-upload photos are stored inline (base64) in Postgres today
> (`loyalty_receipt_submissions.receipt_image`, ≤~2 MB each). For a large loyalty base (tens of thousands of
> members submitting receipts), move image bytes to **object storage (S3-compatible)** and keep only a
> reference in the DB before high-volume go-live — otherwise the DB grows fast and backups bloat. Tracked as
> a pre-scale follow-up.

## 8. Per-customer go-live checklist
- [ ] Tenant provisioned (`code`, Admin user, industry CoA, fiscal year) — §3
- [ ] Subdomain resolves over HTTPS (wildcard DNS + TLS) — §4
- [ ] `AUTH_COOKIE_DOMAIN` set to the shared parent; login sticks; CORS allows the web origin — §4
- [ ] Member `/m` app reaches the tenant by shop code (OTP delivers) — §2 / §4a
- [ ] Branding applied (theme/logo) — §5
- [ ] Messaging provider(s) configured and a test send shows a real `provider` (not `mock`) — §6, `secrets.md`
- [ ] Backups/PITR on for the shared DB (`tools/ops/BACKUP-RUNBOOK.md`)
- [ ] Boot-blocking env present (`DATABASE_URL`, `JWT_SECRET`, `APP_ENC_KEY`, PSP webhook secret) — `secrets.md`

## 9. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-07-01 | Platform | Initial runbook — shared multi-tenant + subdomain onboarding (Model A) vs dedicated (Model B); tenant provisioning, wildcard DNS/TLS, cookie/CORS, member-app shop-code note + optional subdomain auto-select, per-tenant branding/messaging, cost model, and a per-customer go-live checklist. |
