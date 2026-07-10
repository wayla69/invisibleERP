# 41 — LAN-first Store Hub: full offline restaurant operation (POS + diner self-order) until the internet returns

**Status: Phase 0 DELIVERED · Phase 1 DELIVERED (MVP) · 2026-07-10** — Phases 2–4 PLANNED.

## 0. Problem & goal

Today the cloud is the only source of truth. When the store's internet dies:

- the **touch register** keeps selling *quick cash sales* via the IndexedDB outbox
  (`lib/register-offline.ts` → idempotent `POST /api/restaurant/offline-sync`, control BRANCH-03) — proven
  by the `restaurant-offline`/`offline-sync`/`pos-p0` harnesses and the `register-offline.spec.ts` e2e;
- but **dine-in service stops** (kitchen fire + table state are server-side), **diner QR self-order stops**
  (`/qr/[token]` talks to the cloud API), and multi-terminal coordination (KDS, floor board, customer
  display routing) stops.

**Goal:** the whole front-of-house keeps running on the store LAN/WiFi — diners order from their phones,
the register sells (incl. dine-in), the KDS cooks — until the internet returns, then everything reconciles
to the cloud ledger **exactly once** (BRANCH-03 preserved).

**Architecture decision:** browsers cannot serve each other; shared in-store state needs a server on the
LAN. So the model is **LAN-first**: every in-store device always talks to a small **Store Hub** (the same
NestJS API + Next web, running on an in-store box), and the hub syncs with the cloud. We do NOT do
"cloud-normally, failover-to-hub" — split-brain between devices pointing at different origins is exactly
the failure mode that loses/duplicates sales.

Why this is cheap for *us*: the API already runs against embedded Postgres (PGlite) in every CI harness;
the idempotent replay contract (`pos_offline_sync` dedup ledger, server-side re-price, GL posted at
ingest) is built and harness-tested; the offline master-data bundle exists (`GET /api/branches/master-bundle`,
BRANCH-02, PN-24 §7 step 5); and the diner/KDS/display surfaces are all served by this same codebase.

## Phase 0 — browser-only hardening (DELIVERED, this PR)

No new hardware; makes the *single-till* offline story survive the two real-world failure shapes it
previously didn't. See PN-24 rev 0.3, user manual 01 §offline, UAT-O2C-284..285.

1. **Menu survives a reload/reboot mid-outage.** The app-shell service worker deliberately never caches
   `/api/*`, so a refresh used to brick the register (shell loads, menu doesn't). The register now
   snapshots the last good `/api/menu` payload to localStorage (`fetchMenuOfflineFirst`,
   `lib/register-offline.ts`) and serves it when the live fetch fails; the menu query runs under TanStack
   `networkMode: 'always'` so it isn't paused while the browser reports offline.
2. **"Router up, internet down" auto-queue.** `navigator.onLine` lies in the most common outage (WiFi up,
   ISP down). A quick-sale checkout whose **order-creation** call fails at the network level (thrown error
   carries no HTTP `status`; `lib/api.ts` now stamps `status` on the session-expired error so a 401 is
   never mistaken for a dead link) falls back to the same offline queue automatically. HTTP rejections
   (validation, 86'd item) still surface and are never queued. Only the FIRST (pre-persistence) call falls
   back — a mid-flight failure after the order exists surfaces as an error — so the worst case is an
   orphan *open* order, never a double-posted sale.
3. **Service-worker cache-poisoning guard.** Redirect-followed responses are no longer cached (an expired
   session bouncing `/pos/register` → `/login` could poison the cached shell); cache bumped to v3 to purge
   any previously poisoned entries.

ToE: `apps/web/e2e/register-offline.spec.ts` (3 scenarios — offline queue+auto-sync, offline reload from
snapshot, false-online fallback + manual flush).

## Phase 1 — Store Hub MVP (DELIVERED 2026-07-10)

Package the existing stack as an in-store appliance; all in-store devices use it as their origin.
Shipped (PN-24 rev 0.4 §7 step 6b, UAT-O2C-288..289, runbook `docs/ops/store-hub-setup.md`):

- **Signed snapshot export** — `GET /api/hub/snapshot` (`modules/hub`): tenant identity + tax config,
  full menu catalog (categories/items/modifiers/buffet tiers), floor plan (stations/zones/tables incl.
  stable `qr_token`), and PIN-eligible **front-of-house users only** (the `requiresMfa` line; TOTP/SSO
  secrets never leave the cloud). Fail-closed on `HUB_SYNC_SECRET`; HMAC-SHA256-signed; credential
  export additionally gated on `X-Hub-Sync-Key`. Extends BRANCH-02.
- **Hub importer** — `db:hub:import` (`database/hub-import.ts`): verifies the signature before any
  write (tamper ⇒ `BAD_SIGNATURE`), id-stable upsert (printed table QRs keep working; Phase-2 sync
  references the same rows), resets runtime table status, bumps serials past the imported range,
  idempotent re-import, optional local `hubadmin` (no cloud credential ever copied down).
- **Appliance packaging** — `hub/docker-compose.yml` (+`.env.example`): Postgres 16 + the SAME api/web
  images the cloud runs (migrate-on-boot), one-shot `hub-seed` service, single-origin web (relative
  `/api` + `API_PROXY_TARGET` rewrite — no per-store rebuild, first-party cookies).
- **Secure-context recipe** (runbook §4): per-store public DNS name → LAN IP, DNS-01 cert (Caddy),
  local DNS fallback for outages, WiFi-join + hub-URL table QR.
- **ToE** — CI harness `tools/cutover/src/hub-snapshot.ts` (20 checks): fail-closed / perm gate /
  tenant isolation / credential gating / tamper-reject / full round-trip onto a second freshly-migrated
  PGlite where cashier password + **PIN login**, `/api/menu`, the floor plan, and post-import id
  sequencing all work.

Deferred within Phase 1 (unblocked, not needed for the pilot): single-process PGlite mode for the
production server (harness-only today — `DatabaseModule` has no PGlite branch), auto-fetch of the
snapshot by URL, and hub heartbeat (Phase 4).

## Phase 2 — hub ⇄ cloud sync (PLANNED)

Extend the proven idempotency contract from "quick-sale replay" to the full financial document set.

- **Down (master data):** versioned snapshot pull (menu/prices/promotions/users/tax); BRANCH-02 extended —
  the hub records `bundle_version` so a stale-price sale is detectable at ingest.
- **Up (financial docs):** sales, till sessions/Z-reports, tip accruals, stock movements replay with
  `client_uuid` idempotency into the existing `pos_offline_sync` dedup ledger; **GL posts cloud-side at
  ingest** (unchanged principle — ICFR controls REV-13/TIP-01/REST-10 tie-outs keep operating on the
  cloud ledger). Table/KDS state is hub-local operational state and never syncs up.
- **Numbering:** hub issues branch-prefixed provisional numbers; the cloud mints canonical `sale_no` at
  ingest (already the offline-sync behavior). The fiscal hash-chained journal (PN-20) seals per-hub and
  the cloud verifies the chain at ingest.
- **Controls/docs:** PN-24 rewrite around the hub (it already anticipates the model), new RCM control for
  hub-sync reconciliation ToE (extend `build_rcm.py` + census markers), new `tools/cutover` harness
  simulating hub→cloud replay, UAT + user-manual + DR/BCP (`docs/ops/dr-bcp-plan.md`) updates.

## Phase 3 — diner self-order + KDS on the hub (PLANNED)

- `/qr/[token]` served by the hub; `publicApi` targets the hub origin. Table-session QR tokens must mint
  offline → the hub holds the signing key / token table (synced down).
- KDS, floor board, customer display: already SSE off the API's `RealtimeService` bus — they come along
  free once the hub is the origin.
- **Payments honesty:** cash + static PromptPay work offline; card/e-wallet capture and PromptPay
  *confirmation* require the internet — the UI must say so, not pretend (fallback: payment terminal on
  mobile data).

## Phase 4 — fleet operations (PLANNED)

Hub heartbeat + version into the `/platform` console (god view), staged auto-update channel, on-hub DB
backup, NTP discipline for `captured_at`, disk encryption + edge-device ITGC controls.

## Sequencing & effort

| Phase | Size | Depends on |
|---|---|---|
| 0 | 1 PR — DELIVERED | — |
| 1 | 1 PR (snapshot export/import + `hub/` appliance + runbook) — DELIVERED | — |
| 2 | ~3–4 PRs (sync engine, controls, harness) | 1 |
| 3 | ~1–2 PRs (origin plumbing, token minting, payment UX) | 1, 2 |
| 4 | ~2 PRs (console, update channel, ITGC docs) | 1 |

## Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-07-10 | Platform | Initial plan; Phase 0 delivered in the same PR (PN-24 rev 0.3, UAT-O2C-284..285, e2e `register-offline.spec.ts`). |
| 0.2 | 2026-07-10 | Platform | Phase 1 (Store Hub MVP) delivered: `modules/hub` signed snapshot export, `db:hub:import` id-stable importer, `hub/` compose appliance + `docs/ops/store-hub-setup.md` runbook, CI harness `hub-snapshot` (20 checks). PN-24 rev 0.4; UAT-O2C-288..289. |
