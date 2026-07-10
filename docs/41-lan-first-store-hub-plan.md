# 41 — LAN-first Store Hub: full offline restaurant operation (POS + diner self-order) until the internet returns

**Status: Phases 0–3 DELIVERED (0 register-hardening · 1 hub MVP · 2a sales replay/BRANCH-04 · 2b buffet replay · 3 diner QR on hub) · 2026-07-10** — Phase 2c (loyalty/till-Z/fiscal chain) + Phase 4 (fleet ops) PLANNED.

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

## Phase 2 — hub ⇄ cloud sync (2a DELIVERED 2026-07-10 · 2b PLANNED)

Extend the proven idempotency contract from "quick-sale replay" to the full financial document set.

**Phase 2a — SALES replay (DELIVERED; PN-24 rev 0.5 §7 step 6c, control BRANCH-04, UAT-O2C-290..291):**

- **Pusher (hub):** `db:hub:push` (`database/hub-push.ts`; compose one-shot `hub-push`) reconstructs each
  hub-captured restaurant sale from its originating order — lines + modifiers, discount (exact amount),
  tip, service-charge pct — with a **deterministic** `client_uuid` (`hub:{tenant}:{hub_sale_no}`), so any
  re-push (crash, double cron, even a **lost push-log**) lands `duplicate`: exactly-once by construction.
  Unsupported shapes (buffet tier, loyalty redemption, no order link) are logged **`skipped_unsupported`
  with a reason** in `hub_push_log` (migration `0293`) — a visible exception queue, never a silent drop.
- **Ingest (cloud):** `POST /api/hub/ingest` — `@Public` machine-to-machine, HMAC-SHA256 over
  `{tenant_id, sent_at, sales}` with `HUB_SYNC_SECRET`, verified timing-safe, fail-closed when unset.
  Replays through the SAME idempotent register offline-sync path (`RegisterOfflineSaleOp` extended with
  additive `discount`/`tip`/`service_charge_pct`): the cloud re-prices authoritatively and **GL posts on
  the cloud ledger** (book of record; the hub's own ledger is operational only).
- **Reconciliation:** `GET /api/hub/reconciliation` (`branch`/`exec`) ties hub ops ↔ cloud sale values
  per device/period. RCM 204→205 (BRANCH-04 Implemented).
- **ToE:** `hub-snapshot` harness extended to **27 checks** — ring-on-hub → push → cloud sale + GL + TB
  balanced → push-log loss re-push all-duplicate → tamper `403` → skip visibility.

**Phase 2b — buffet replay (DELIVERED 2026-07-10; PN-24 rev 0.6, UAT-O2C-292):**

- A buffet-tier hub sale replays via `op.buffet {package_code, pax, overtime_pax}`; the cloud re-creates
  the per-pax charge (`BuffetService.applyReplayCharge`) **priced from its own package master** — the
  hub's number is never trusted; ฿0 buffet food lines are not replayed (no revenue). Batch signature
  hardened to canonical (key-sorted) JSON — Zod's schema-ordered re-serialization broke the naive form
  (caught by the harness, never shipped).
- **Versioned master pull — dropped as superseded:** its control goal (detect a stale-price sale) is
  already met more strongly by the ingest design — the cloud **re-prices every op from its own master**
  and the BRANCH-04 reconciliation surfaces any hub↔cloud value drift. A version registry would add a
  table + sync state for evidence the re-price already provides.

**Phase 2c — remaining up-sync (PLANNED):**

- Loyalty-redeem sales (cross-system points state — today a visible `skipped_unsupported` queue), till
  sessions/Z-reports + cash over/short (maker-checker interplay), tip pool distributions (policy today:
  distribute on the CLOUD after sync — per-sale tips already accrue to 2300 at ingest), hub-local stock
  ops (waste/receives; sale-driven BOM deductions already post at cloud ingest), fiscal hash-chain
  verification at ingest (PN-20). DR/BCP + user-manual updates as surfaces widen.

## Phase 3 — diner self-order + KDS on the hub (DELIVERED 2026-07-10)

Proven rather than built — the P1 architecture already carried it, and the harness now locks it in
(UAT-O2C-293; runbook §7):

- **Diner QR works on the hub as-is:** the web app serves `/qr/[token]` relative to the hub origin
  (single-origin build), the **imported table `qr_token`s** (id-stable from P1) resolve on the hub, and
  the hub mints + verifies its own session tokens — no cloud round-trip anywhere in scan → session →
  menu → tiers → order → KDS → settle. The settled sale then replays via Phase 2a/2b. Harness drives the
  whole diner journey against the hub app, including a 2-pax buffet session.
- KDS, floor board, customer display: SSE off the same API bus — came along free, as predicted.
- **Payments honesty (runbook §7):** cash + static PromptPay work offline; card/e-wallet capture and
  PromptPay *confirmation* require the internet (fallback: payment terminal on mobile data). One gotcha
  found: Fastify's default `maxParamLength` (100) rejects the long diner session tokens — the hub runs
  the same `main.ts` (which already sets 500), so only harness-local boots need care.

## Phase 4 — fleet operations (PLANNED)

Hub heartbeat + version into the `/platform` console (god view), staged auto-update channel, on-hub DB
backup, NTP discipline for `captured_at`, disk encryption + edge-device ITGC controls.

## Sequencing & effort

| Phase | Size | Depends on |
|---|---|---|
| 0 | 1 PR — DELIVERED | — |
| 1 | 1 PR (snapshot export/import + `hub/` appliance + runbook) — DELIVERED | — |
| 2a | 1 PR (sales replay + ingest + BRANCH-04 + reconciliation) — DELIVERED | 1 |
| 2b + 3 | 1 PR (buffet replay + diner-QR-on-hub proof + payments honesty) — DELIVERED | 2a |
| 2c | ~2 PRs (loyalty/till-Z/stock up-sync; fiscal chain) | 2a |
| 3 | ~1–2 PRs (origin plumbing, token minting, payment UX) | 1, 2 |
| 4 | ~2 PRs (console, update channel, ITGC docs) | 1 |

## Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-07-10 | Platform | Initial plan; Phase 0 delivered in the same PR (PN-24 rev 0.3, UAT-O2C-284..285, e2e `register-offline.spec.ts`). |
| 0.2 | 2026-07-10 | Platform | Phase 1 (Store Hub MVP) delivered: `modules/hub` signed snapshot export, `db:hub:import` id-stable importer, `hub/` compose appliance + `docs/ops/store-hub-setup.md` runbook, CI harness `hub-snapshot` (20 checks). PN-24 rev 0.4; UAT-O2C-288..289. |
| 0.3 | 2026-07-10 | Platform | Phase 2a (hub→cloud sales replay) delivered: `db:hub:push` + `hub_push_log` (0291), cloud `POST /api/hub/ingest` (HMAC) + `GET /api/hub/reconciliation`, op pass-through (discount/tip/SC), **new control BRANCH-04** (RCM 205), harness → 27 checks. PN-24 rev 0.5; UAT-O2C-290..291. |
| 0.4 | 2026-07-10 | Platform | Phases 2b + 3 delivered: buffet-tier replay (`op.buffet`, cloud-master pricing, canonical-JSON signature) + diner QR self-order proven end-to-end ON the hub (harness → **40 checks**); versioned master pull dropped as superseded (re-price + BRANCH-04 drift); Phase 2c scoped (loyalty/till-Z/fiscal). PN-24 rev 0.6; UAT-O2C-292..293. |
