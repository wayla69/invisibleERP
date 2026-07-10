# 41 — LAN-first Store Hub: full offline restaurant operation (POS + diner self-order) until the internet returns

**Status: Phase 0 DELIVERED · 2026-07-10** — Phases 1–4 PLANNED.

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

## Phase 1 — Store Hub MVP (PLANNED)

Package the existing stack as an in-store appliance; all in-store devices use it as their origin.

- **Packaging:** Docker compose (Postgres + API + Next standalone) for durable installs; a single-process
  PGlite mode for tiny/pilot installs (mirrors how the cutover harnesses boot `AppModule` today). Target:
  any mini-PC; the till PC itself can host for a pilot.
- **Scope:** one tenant, one branch per hub. Seeded from the cloud with a signed snapshot (menu +
  modifiers + tables/zones + buffet tiers + users/PINs + tax config) — extend the BRANCH-02 master-bundle.
- **The secure-context problem (the part everyone underestimates):** PWA/service worker + phone camera
  (QR scan) require HTTPS. Plan: per-store public DNS name (`storeN.pos.<domain>`) resolving to the hub's
  LAN IP, real certificate via DNS-01 issuance, renewed while the internet is up; hub runs a local DNS
  responder so names keep resolving during an outage. Table QR encodes WiFi-join + the hub URL.
- **Auth on the hub:** same JWT/cookie model; user/PIN store synced down so cashier PIN quick-login
  (ITGC-AC-17) works with no cloud round-trip.

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
| 0 | 1 PR (this one) | — |
| 1 | ~2–3 PRs (packaging, snapshot seed, TLS/DNS recipe) | — |
| 2 | ~3–4 PRs (sync engine, controls, harness) | 1 |
| 3 | ~1–2 PRs (origin plumbing, token minting, payment UX) | 1, 2 |
| 4 | ~2 PRs (console, update channel, ITGC docs) | 1 |

## Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-07-10 | Platform | Initial plan; Phase 0 delivered in the same PR (PN-24 rev 0.3, UAT-O2C-284..285, e2e `register-offline.spec.ts`). |
