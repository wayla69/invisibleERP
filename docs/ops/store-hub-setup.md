# Store Hub — setup runbook (LAN-first Phase 1)

> Plan: `docs/41-lan-first-store-hub-plan.md` · Narrative: PN-24 §7 step 6b · Package: `hub/`
>
> **Phase-1 scope honesty:** the hub runs the restaurant front-of-house **standalone** (register,
> menu, floor plan, staff password/PIN login). The **hub→cloud financial replay is Phase 2** — until
> it ships, sales rung on the hub stay in the hub's ledger (fine for a pilot store / lab; not yet a
> substitute for the cloud POS in an audited store). The register's own browser-level offline outbox
> (Phase 0) keeps covering short cloud outages in cloud-pointed stores.

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
- **Backups:** the hub DB is the store's operational state; snapshot the `hub_pgdata` volume nightly
  (`docker compose exec db pg_dump …`). Full DR posture: `docs/ops/dr-bcp-plan.md`.
- **Clock:** keep NTP on (router default) — `captured_at` drift skews the business-day bucketing.
- **Security:** the box holds staff credential hashes + sales data — full-disk encryption on, SSH
  key-only, and the same `APP_ENC_KEY` hygiene as any API node. Suspending a staff member on the
  cloud does NOT reach the hub until the next re-seed (Phase-2 sync closes this gap) — for immediate
  revocation, deactivate the user on the hub too (`hubadmin`).

## Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-07-10 | Platform | Initial runbook (docs/41 Phase 1: snapshot export/import + `hub/` compose + TLS/DNS recipe). |
