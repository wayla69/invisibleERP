# Store Hub — setup runbook (LAN-first Phase 1)

> Plan: `docs/41-lan-first-store-hub-plan.md` · Narrative: PN-24 §7 step 6b · Package: `hub/`
>
> **Scope (updated for Phase 2a):** the hub runs the restaurant front-of-house **standalone** (register,
> menu, floor plan, staff password/PIN login), and **a-la-carte sales now replay to the cloud ledger
> exactly once** via `db:hub:push` → `POST /api/hub/ingest` (control **BRANCH-04**; see §6). Still
> Phase 2b: buffet-tier and loyalty-redeem sales (visibly `skipped_unsupported` in `hub_push_log`, to
> reconcile manually), till sessions/Z-reports, tip pools and stock movements. The register's own
> browser-level offline outbox (Phase 0) keeps covering short cloud outages in cloud-pointed stores.
> **Phase 2b/3 update:** buffet-tier sales now replay natively (cloud-master pricing), and the diner QR
> self-order journey is proven end-to-end on the hub (§7). Still Phase 2c: loyalty-redeem sales,
> till/Z-reports, hub-local stock ops, fiscal-chain verification.

## 1. What you need

- A small always-on box in the store (any mini-PC with 8GB RAM; the till PC works for a pilot) with
  Docker installed, wired into the store's router/switch.
- A per-store DNS name (see §4) and the repo checked out on the box (or the two images pre-built).
- On the **cloud**: `HUB_SYNC_SECRET` set on the API service (fail-closed — the snapshot endpoint
  403s until it exists).

## 2. Export the snapshot (cloud side)

As a `branch`/`exec` user of the store's tenant:

```
GET /api/hub/snapshot?include_credentials=1
X-Hub-Sync-Key: <HUB_SYNC_SECRET>
```

Save the JSON as `hub/snapshot/hub-snapshot.json` on the box. Notes:

- `include_credentials=1` + the header ships **front-of-house staff** (password + PIN hashes) so
  cashiers log in on the hub with the same PIN. Privileged/MFA accounts (Admin, finance) are **never
  exported** — administer on the cloud, re-export, re-seed.
- Without the flag you get a catalog-only snapshot (menu/tables, no staff) — useful for inspection.
- The payload is HMAC-signed; keep the file as-is (reformatting breaks the signature).

## 3. Boot + seed the hub

```bash
cd hub
cp .env.example .env        # fill every secret; HUB_SYNC_SECRET must MATCH the cloud's
docker compose up -d --build             # db → migrations → api → web
docker compose --profile seed run --rm hub-seed   # verifies the signature, then imports
```

Re-running `hub-seed` with a newer snapshot is safe (idempotent upsert; row ids are preserved
verbatim, so printed table-QR tokens keep working). Verify: open `http://<box-ip>/` on a till,
log in as a cashier (PIN works), the menu and floor plan are there.

## 4. TLS + DNS on the LAN (the part everyone underestimates)

PWA/service-worker (offline shell) and the phone camera (QR scan) require a **secure context**, so
plain `http://192.168.x.x` is not enough for full functionality:

1. Create a public DNS record per store — `store1.pos.<your-domain>` → the hub's **LAN IP**
   (e.g. `192.168.1.10`). A public name pointing at RFC1918 space is fine and is the standard trick.
2. Issue a real certificate for that name with a **DNS-01** challenge (the box doesn't need to be
   reachable from the internet). Easiest: run [Caddy](https://caddyserver.com) on the box in front of
   `web:80` with your DNS provider's plugin — it issues + renews automatically while the internet is
   up, and certs stay valid ~90 days through outages.
3. Outage-proof name resolution: either give the router a local DNS override for the store name → hub
   IP, or run dnsmasq on the box. (Devices that cached the record keep working regardless.)
4. Table QR codes: encode the store WiFi join (WPA string) + `https://store1.pos.<domain>/qr/<token>`
   so a diner lands on the hub without typing anything.

For a quick pilot without DNS: `http://<box-ip>` works for logged-in tills (no PWA install/camera
on diner phones — acceptable to smoke-test the loop).

## 5. Operations

- **Update the catalog:** edit on the cloud → re-export → re-run `hub-seed`. (Menu edits made
  directly on the hub survive but will be overwritten per-row by the next snapshot import.)
- **Local break-glass admin:** set `HUB_ADMIN_PASSWORD` in `.env` before seeding → user `hubadmin`
  (Admin, hub-only). No cloud credential is ever copied to the box.
- **Backups (Phase 4b):** `docker compose --profile backup run --rm hub-backup` dumps `ierp_hub`,
  **verifies the archive**, prunes past `BACKUP_KEEP_DAYS`, prints the **un-replayed sale count the dump
  protects**, and optionally copies offsite (`BACKUP_OFFSITE_TARGET`). Cron it nightly after close:
  `0 3 * * * cd /opt/ierp-hub && docker compose --profile backup run --rm hub-backup >> /var/log/hub-backup.log 2>&1`.
  Restore: `gunzip -c hub-<stamp>.dump.gz | pg_restore -d ierp_hub -c`. Full DR posture:
  `docs/ops/dr-bcp-plan.md` (scenario 6).
- **Losing the box = losing un-replayed revenue.** The `GET /api/hub/fleet` backlog (Phase 4a) and the
  backup log both show that number. Keep the push cron tight (5 min) so the exposure window is minutes.
- **Clock:** keep NTP on (router default) — `captured_at` drift skews the business-day bucketing.
- **Security:** the box holds staff credential hashes + sales data — full-disk encryption on, SSH
  key-only, and the same `APP_ENC_KEY` hygiene as any API node. Suspending a staff member on the
  cloud does NOT reach the hub until the next re-seed (Phase-2 sync closes this gap) — for immediate
  revocation, deactivate the user on the hub too (`hubadmin`).

## 6. Pushing sales to the cloud (Phase 2a — BRANCH-04)

When the internet is up, replay hub-captured sales into the cloud ledger:

```bash
docker compose --profile push run --rm hub-push     # or: pnpm --filter @ierp/api db:hub:push
```

- Env: `CLOUD_URL` (the cloud API origin) + the same `HUB_SYNC_SECRET`; batches are HMAC-signed and the
  cloud verifies before replaying. Safe on a cron (e.g. every 5 min): the `client_uuid` is derived from
  the hub sale number, so re-pushes — including after a crash or a restored hub DB — only ever produce
  `duplicate` results, never a second sale/GL.
- Outcomes land in the hub's `hub_push_log`. **Review `skipped_unsupported` rows** (buffet/loyalty/no
  order link) — those sales exist only on the hub ledger until Phase 2b or manual entry; the reason
  column says why. Failures (`failed`) are retried on the next run.
- Cloud-side review: `GET /api/hub/reconciliation?from&to` (perm `branch`/`exec`) ties every hub op to
  its cloud sale + value — the BRANCH-04 detective tie-out.

**Cash sessions (Z-reports) ride the same run (Phase 2c, BRANCH-05).** After the sales, `hub-push`
sends each **closed** till session with its physical count and the sale numbers it covers. The cloud
recomputes expected cash from its own ledger and posts the 5830 over/short (a variance above the
materiality threshold parks the session for a manager to approve — same rule as an online close).

> **A session is BLOCKED (`TILL_SALES_NOT_SYNCED`) while any of its sales is still un-replayed** —
> deliberately: a variance certified over a partial revenue population is worse than a late one. If a
> session stays blocked, look at the `skipped_unsupported` / `failed` rows in `hub_push_log` for the
> sales in that window, resolve them (e.g. enter a loyalty-redeem sale centrally), then re-run the push.

**Fleet visibility (Phase 4a).** Every push run also sends a signed heartbeat. `GET /api/hub/fleet`
(perm `branch`/`exec`) lists your hubs with `stale` (no heartbeat in the window), the un-replayed
backlog, failed/skipped counts and the measured clock skew — so a box that quietly stops replaying is
visible. Set `HUB_ID` in `.env` to name the box; keep the push on a cron (5 min) so the heartbeat is
fresh even on a quiet day.

## 7. Diner QR self-order on the hub (Phase 3)

Works out of the box once the hub is seeded — the printed table QRs from the cloud era keep working
because the import preserves each table's `qr_token` verbatim:

- Diner phone (on the store WiFi, hub origin per §4) scans the table QR → `/qr/start/:qrToken` opens a
  session on the hub → menu / buffet tiers / ordering / KDS all run hub-local. Settled sales replay to
  the cloud per §6 — **buffet-tier sales included** (the cloud re-prices the per-pax charge from its own
  package master).
- **Payments while offline — be honest with the till:** cash and a static PromptPay QR work; **card /
  e-wallet capture and PromptPay payment *confirmation* need the internet** (the PSP webhook can't reach
  the hub). Fallback: a payment terminal on mobile data, confirm manually.
- New tables created ON the hub get their own QR and work immediately; they'll appear on the cloud only
  as their sales replay (the table master itself re-seeds cloud→hub, not hub→cloud).

## 8. Updating a hub (Phase 4b)

The hub runs the **same images as the cloud**, so an update is a rebuild + restart. Do it **after close**,
never mid-service, and **push first** so no un-replayed sale rides the restart:

```bash
cd /opt/ierp-hub
docker compose --profile push run --rm hub-push      # drain the backlog (verify: pushed/duplicate only)
docker compose --profile backup run --rm hub-backup  # take a dump you can roll back to
git -C /opt/invisible-erp pull                       # or pull new images
docker compose up -d --build                         # api applies migrations on boot (RUN_MIGRATIONS=1)
docker compose --profile seed run --rm hub-seed      # only if the catalog changed on the cloud
```

Verify: a till logs in, the menu renders, `GET /api/hub/fleet` (from HQ) shows the box **fresh, backlog 0**.

> **The hub tells you when it is due.** Every `hub-push` run gets the cloud version back and prints an
> upgrade hint when the box is behind — or a loud warning when the box is **ahead of the cloud**, which is
> the unsafe direction. `GET /api/hub/fleet` shows `cloud_version` and each box’s `version_status`.
Roll back by checking out the previous commit/tag and `up -d --build`; restore the dump only if a
migration mangled data (migrations are forward-only — a restore is the rollback path).

> **Version skew is safe in one direction only:** a hub may run *behind* the cloud (its pushes still
> ingest — the ingest contract is additive), but a hub **ahead** of the cloud can send fields the cloud's
> validator rejects. Upgrade the cloud first, then the hubs.

## Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-07-10 | Platform | Initial runbook (docs/41 Phase 1: snapshot export/import + `hub/` compose + TLS/DNS recipe). |
| 0.2 | 2026-07-10 | Platform | Phase 2a: §6 push-to-cloud operations (`hub-push` one-shot, cron guidance, `skipped_unsupported` review, reconciliation endpoint); scope note updated. |
| 0.3 | 2026-07-10 | Platform | Phases 2b/3: buffet-tier replay noted in §6 scope; new §7 diner-QR-on-hub + offline-payments honesty. |
| 0.4 | 2026-07-10 | Platform | Phases 2c/4a: §6 gains cash-session (Z-report) up-sync incl. the deliberate `TILL_SALES_NOT_SYNCED` block, and fleet visibility via the signed heartbeat + `GET /api/hub/fleet` (`HUB_ID`). |
| 0.5 | 2026-07-10 | Platform | Phase 4b: verified nightly backup (`hub/backup.sh` + `hub-backup` compose profile, retention + optional offsite, reports the un-replayed backlog it protects) and new §8 hub-update procedure (drain → dump → rebuild; cloud-before-hub version-skew rule). |
