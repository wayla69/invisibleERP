# 47 — Reputation & External Analytics Ingestion (Google Maps reviews · GA4)

> **Date:** 2026-07-13 · **Status:** v0.1 — scoping · **Owner:** ERP / Product
> **Question answered:** *"Can we do webhook via Google Maps review, Wongnai review, and Google
> Analytics?"* — Not via webhook (none of the three push events to a third party); this is a
> **scheduled-poll ingestion** feature instead, for two of the three platforms.
> **Discipline (same as docs/25/26/44/45):** one doc-synced PR (migration + module + permissions/SoD +
> RCM control + narrative + user-manual + UAT + cutover-harness), merged only on a fully-green CI matrix.

---

## 0. Scope decision

| Platform | Mechanism available | In scope |
| --- | --- | --- |
| **Google Maps reviews** (Google Business Profile) | No webhook. OAuth2 user-consent + `accounts.locations.reviews.list` poll (`mybusiness.googleapis.com/v4`, scope `business.manage`). Google gates Business Profile API access behind an approval request — the OAuth *code* works the moment access is granted, but the tenant's Google Cloud project must be approved first. | **Yes** |
| **Google Analytics (GA4)** | No webhook (GA is normally the target of outbound events, not a source). OAuth2 user-consent + GA4 Data API `properties.runReport` (`analyticsdata.googleapis.com/v1beta`, scope `analytics.readonly`). | **Yes** |
| **Wongnai reviews** | No documented public API for a third party to pull a business's own reviews (Wongnai's public API surface is data-licensing/POS-oriented, not a review-webhook/pull endpoint for arbitrary businesses). Scraping would violate ToS. | **Deferred** — revisit if/when a Wongnai partner API is confirmed; the schema below reserves `platform` as an open text column so adding it later needs no migration shape change, just a new sync service. |

Because Google requires a real Google Cloud OAuth client (`client_id`/`client_secret`) that only the
account owner can register, and Business Profile API access additionally requires an approval request to
Google, **this feature is code-complete but inert without operator setup**: set `GOOGLE_OAUTH_CLIENT_ID` /
`GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI`, and (for Maps reviews specifically) have the
Business Profile API access request approved for that Cloud project.

## 1. Bounded context

**New module: `modules/reputation`** — a distinct business responsibility (external reputation
monitoring + external analytics ingestion) from the existing `modules/marketing` (campaigns/segments),
`modules/nps` (first-party surveys), and `modules/connectors` (canonical order/product/statement-line
data import, finance-adjacent). Reuses existing **infrastructure patterns**, not existing **tables**:

- Encrypted-credential storage: the `encryptedText` custom column type (`database/encrypted-column.ts`),
  same technique as `tenant_identity.oidc_client_secret_enc`.
- Single-use OAuth state: mirrors `ssoLoginState` (`modules/identity/sso.service.ts`) — a server-persisted,
  single-consume, expiring `state` row; PKCE `code_verifier`/`code_challenge`.
- Scheduled polling: the BI report-scheduler pattern (`BiReportSource`, module-owned `*-bi-reports.ts`,
  discovered by `BiReportRegistrarService`) — same shape as `ar_collections_dunning`/`eam_pm_generate`. A
  tenant admin creates a `daily` scheduled-report subscription of type `reputation_review_sync` /
  `reputation_ga4_sync` on the existing `/scheduled-reports` screen — no new scheduler UI needed.
- Dashboard read: a `reputation_summary` report type + a thin `BiService.reputationSummaryLive()` wrapper
  (same shape as `marketing_roi` / `BiService.marketingRoiLive()`), backing a live dashboard tab.

## 2. Schema (migration `0400`)

- **`reputation_connections`** — one row per `(tenant_id, platform)`. `platform: 'google_maps' |
  'google_analytics'`. Encrypted `access_token_enc`/`refresh_token_enc`, `token_expires_at`, `scope`,
  `google_account_email` (which Google account is connected, for admin visibility),
  `external_refs: jsonb` (chosen Business-Profile location resource names / GA4 property ids, set via a
  follow-up "list available targets → pick" step after the OAuth grant), `status`
  (`active`/`error`/`revoked`), `last_synced_at`, `last_error`.
- **`reputation_oauth_state`** — single-use OAuth state (state, tenant_id, created_by, platform,
  code_verifier, expires_at, consumed_at), same shape as `sso_login_state`.
- **`external_reviews`** — `(tenant_id, platform, external_review_id)` unique. author name/photo, rating
  (1–5), comment, review/reply timestamps, reply text, `synced_at`. Indexed on `(tenant_id, rating)` for a
  "needs attention" (low rating, no reply) filter.
- **`analytics_daily_snapshots`** — `(tenant_id, property_ref, metric_date)` unique. sessions, active
  users, conversions, total revenue, engagement rate, top channel group, raw `jsonb` for extensibility.

All four get the canonical org-scoped `tenant_isolation` RLS policy (0232/0399 form) in the same migration.

## 3. Auth flow (real OAuth, per your explicit choice over the paste-based alternative)

1. Admin (marketing/exec) clicks **connect** on `/reputation` → `GET /api/reputation/oauth/start?platform=`
   → creates a `reputation_oauth_state` row, returns Google's consent URL (PKCE, correct scope per
   platform).
2. Google redirects the browser to `/reputation/callback?code=&state=` (our registered redirect URI).
3. The callback **page** (mirrors `/sso/callback/page.tsx`) forwards `window.location.search` **verbatim**
   to `POST /api/reputation/oauth/callback` in the body — never reads `code`/`state` by name client-side,
   avoiding the `js/sensitive-get-query` (CWE-598) sink exactly like the SSO callback already does.
4. The backend consumes the single-use state, exchanges `code` for tokens at Google's fixed token endpoint
   (not tenant-configurable, so no SSRF surface), fetches the connected account's email, encrypts +
   upserts the connection.
5. Admin picks which location(s)/property from `GET .../targets` (enumerated live from Google) and saves
   via `PUT .../targets` — sync only covers picked targets.

## 4. Control & risk impact

New RCM control **MKT-15** (external reputation & analytics ingestion): encrypted-at-rest OAuth credential
storage (never returned by any read endpoint), tenant-scoped ingestion (RLS + explicit `tenant_id` filter,
Multi-Tenant Test Protocol boundary test), and reviewer PII (name/photo) is genuinely public data the
reviewer already published to Google Maps — not first-party consent-gated PII, so no ROPA/consent gate
applies here (distinct from the G3 audience-export control, which pushes *our* members' hashed PII out).

## 5. Delivery

One PR: schema/migration, OAuth service, connections CRUD + target-listing, review-sync + GA4-sync
services, BI report registration, controller, `/reputation` web workspace (Connections / Reviews /
Analytics tabs) + callback page + nav entry, RCM control + narrative + user-manual + UAT + traceability +
`.env.example`, cutover harness (`reputation.ts`) including the cross-tenant boundary test.
