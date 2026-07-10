// Store-hub snapshot export (LAN-first Phase 1, docs/41 — extends the BRANCH-02 master-bundle contract).
//
// A store hub is the SAME API+web running on an in-store box; this service exports everything it needs
// to boot and run the restaurant front-of-house: tenant identity + tax config, the full menu catalog
// (categories / items / modifiers / buffet tiers), floor plan (stations / zones / tables incl. their
// stable qr_token so printed table QRs keep working), and the tenant's PIN-eligible front-of-house
// users. All row ids are exported VERBATIM and the importer inserts them verbatim — id-stable so the
// Phase-2 hub→cloud sync can reference the same rows on both sides.
//
// Security posture:
// - The whole feature is FAIL-CLOSED behind `HUB_SYNC_SECRET`: unset ⇒ 403 HUB_SYNC_DISABLED.
// - The snapshot is HMAC-SHA256-signed with that secret; the importer refuses an unsigned/tampered file.
// - Credentials (password/PIN hashes) are exported ONLY when the caller both asks
//   (`?include_credentials=1`) and proves possession of the secret (`X-Hub-Sync-Key` header).
// - Privileged / MFA-required accounts are NEVER exported (same `requiresMfa` line as PIN login,
//   ITGC-AC-17): the hub is front-of-house; administration happens on the cloud and re-syncs.
//   TOTP secrets, SSO subjects and staff LINE/e-mail capture identities never leave the cloud.
import { Inject, Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, and, like, gte, lte, inArray, sql } from 'drizzle-orm';
import { requiresMfa, type Role, type Permission } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  tenants, users, userPermissions,
  menuCategories, menuItems, modifierGroups, modifierOptions, menuItemModifierGroups,
  buffetPackages, buffetPackageItems,
  kitchenStations, floorZones, diningTables,
  posOfflineSync, custPosSales, tillSessions, hubHeartbeats,
} from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { RestaurantOfflineSyncService, type RegisterOfflineSaleOp } from '../restaurant/offline-sync.service';
import { LedgerService } from '../ledger/ledger.service';
import { CASH_VARIANCE_THRESHOLD } from '../payments/payments.service';
import { roundCurrency } from '../tax/money';
// single source of the signature projection — the hub pusher signs with the same functions
import { signHubBatch, signHubDoc, type HubTillDoc, type HubHeartbeatDoc } from '../../database/hub-push';

export const HUB_SNAPSHOT_FORMAT = 'ierp-hub-snapshot';
export const HUB_SNAPSHOT_VERSION = 1;

/** HMAC-SHA256 signature over the serialized snapshot payload. Shared by exporter and importer. */
export function signHubPayload(payloadJson: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadJson).digest('hex');
}

@Injectable()
export class HubSyncService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly offlineSync: RestaurantOfflineSyncService,
    private readonly ledger: LedgerService,
  ) {}

  /** timing-safe HMAC compare — every hub-originated request authenticates this way. */
  private assertSignature(given: string | undefined, want: string) {
    const a = Buffer.from(String(given ?? ''), 'utf8');
    const b = Buffer.from(want, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException({ code: 'HUB_SYNC_BAD_SIGNATURE', message: 'Batch signature does not verify', messageTh: 'ลายเซ็นชุดข้อมูลไม่ถูกต้อง — ตรวจสอบ HUB_SYNC_SECRET' });
    }
  }

  private async assertTenant(tenantId: number) {
    const [tenant] = await this.db.select().from(tenants).where(eq(tenants.id, Number(tenantId)));
    if (!tenant) throw new BadRequestException({ code: 'NO_TENANT', message: 'Unknown tenant' });
  }

  private tenantId(user: JwtUser): number {
    if (user.tenantId == null) {
      throw new BadRequestException({ code: 'NO_TENANT', message: 'User is not bound to a tenant', messageTh: 'ผู้ใช้ไม่ได้ผูกกับร้าน/บริษัท' });
    }
    return Number(user.tenantId);
  }

  private secret(): string {
    const s = process.env.HUB_SYNC_SECRET ?? '';
    if (!s) {
      throw new ForbiddenException({ code: 'HUB_SYNC_DISABLED', message: 'HUB_SYNC_SECRET is not configured on this server', messageTh: 'ระบบซิงค์ Store Hub ยังไม่ถูกเปิดใช้งาน (ไม่ได้ตั้งค่า HUB_SYNC_SECRET)' });
    }
    return s;
  }

  async exportSnapshot(user: JwtUser, opts: { includeCredentials: boolean; syncKey: string | null }) {
    const secret = this.secret();
    const t = this.tenantId(user);
    const db = this.db;

    // Credential export needs proof of possession of the hub secret, not just an exec session.
    let withCreds = false;
    if (opts.includeCredentials) {
      const given = Buffer.from(opts.syncKey ?? '');
      const want = Buffer.from(secret);
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        throw new ForbiddenException({ code: 'HUB_SYNC_KEY_REQUIRED', message: 'Credential export requires the X-Hub-Sync-Key header matching HUB_SYNC_SECRET', messageTh: 'การส่งออกข้อมูลรหัสผ่าน/PIN ต้องแนบ X-Hub-Sync-Key ให้ตรงกับ HUB_SYNC_SECRET' });
      }
      withCreds = true;
    }

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, t));
    if (!tenant) throw new BadRequestException({ code: 'NO_TENANT', message: 'Tenant not found' });

    const [cats, items, groups, options, links, tiers, tierItems, stations, zones, tables] = await Promise.all([
      db.select().from(menuCategories).where(eq(menuCategories.tenantId, t)),
      db.select().from(menuItems).where(eq(menuItems.tenantId, t)),
      db.select().from(modifierGroups).where(eq(modifierGroups.tenantId, t)),
      db.select().from(modifierOptions).where(eq(modifierOptions.tenantId, t)),
      db.select().from(menuItemModifierGroups).where(eq(menuItemModifierGroups.tenantId, t)),
      db.select().from(buffetPackages).where(eq(buffetPackages.tenantId, t)),
      db.select().from(buffetPackageItems).where(eq(buffetPackageItems.tenantId, t)),
      db.select().from(kitchenStations).where(eq(kitchenStations.tenantId, t)),
      db.select().from(floorZones).where(eq(floorZones.tenantId, t)),
      db.select().from(diningTables).where(eq(diningTables.tenantId, t)),
    ]);

    // Front-of-house users only: active, tenant-bound, and NOT MFA-required for their role+overrides
    // (the exact PIN-eligibility line). Others administer on the cloud.
    const tenantUsers = await db.select().from(users).where(eq(users.tenantId, t));
    const foh: any[] = [];
    for (const u of tenantUsers) {
      if (!u.isActive) continue;
      const overrides = await db.select().from(userPermissions).where(eq(userPermissions.userId, u.id));
      const overridePerms = overrides.map((o: any) => o.perm as Permission);
      if (requiresMfa(u.role as Role, overridePerms.length ? overridePerms : null)) continue;
      foh.push({
        id: u.id, username: u.username, role: u.role, tenant_id: u.tenantId, org_id: u.orgId,
        locale: u.locale, is_active: u.isActive,
        user_permissions: overridePerms,
        ...(withCreds ? {
          password_hash: u.passwordHash, must_change_password: u.mustChangePassword,
          pin_hash: u.pinHash, pin_set_at: u.pinSetAt,
        } : {}),
      });
    }

    const data = {
      tenant: {
        id: tenant.id, code: tenant.code, name: tenant.name, org_id: tenant.orgId,
        tax_id: tenant.taxId, legal_name: tenant.legalName, branch_code: tenant.branchCode,
        vat_registered: tenant.vatRegistered, vat_rate: tenant.vatRate, tax_country: tenant.taxCountry,
        promptpay_id: tenant.promptpayId, default_language: tenant.defaultLanguage,
        functional_currency: tenant.functionalCurrency,
      },
      menu_categories: cats,
      menu_items: items,
      modifier_groups: groups,
      modifier_options: options,
      menu_item_modifier_groups: links,
      buffet_packages: tiers,
      buffet_package_items: tierItems,
      kitchen_stations: stations,
      floor_zones: zones,
      dining_tables: tables,
      users: foh,
    };

    const payload = {
      format: HUB_SNAPSHOT_FORMAT,
      version: HUB_SNAPSHOT_VERSION,
      generated_at: new Date().toISOString(),
      tenant_id: t,
      includes_credentials: withCreds,
      data,
    };
    const signature = signHubPayload(JSON.stringify(payload), secret);
    return {
      ...payload,
      counts: {
        menu_categories: cats.length, menu_items: items.length, modifier_groups: groups.length,
        modifier_options: options.length, menu_item_modifier_groups: links.length,
        buffet_packages: tiers.length, buffet_package_items: tierItems.length,
        kitchen_stations: stations.length, floor_zones: zones.length, dining_tables: tables.length,
        users: foh.length,
      },
      signature,
    };
  }

  // ── Phase 2a: hub → cloud sales ingest (machine-to-machine, HMAC-authenticated) ────────────────
  // @Public route (no JWT — the hub never stores a cloud user credential): authenticity comes from the
  // HMAC over (tenant_id, sent_at, sales) with the shared HUB_SYNC_SECRET, verified timing-safe. The
  // batch then replays through the SAME idempotent register offline-sync path (dedup on
  // (tenant, client_uuid) in pos_offline_sync; server re-prices; GL posts on THIS ledger — the cloud
  // ledger stays the book of record). A replayed/stolen batch can therefore only ever produce
  // 'duplicate' results — it cannot double-post or alter data. Control BRANCH-04.
  async ingest(body: { tenant_id: number; sent_at: string; sales: RegisterOfflineSaleOp[]; signature: string }) {
    const secret = this.secret();
    this.assertSignature(body.signature, signHubBatch(Number(body.tenant_id), String(body.sent_at), body.sales ?? [], secret));
    await this.assertTenant(Number(body.tenant_id));
    // Pre-auth request ⇒ RLS bypass is already on (same as login/signup); every service in the replay
    // path threads THIS explicit tenant, so rows land tenant-scoped exactly like a JWT request's would.
    const hubUser = { username: 'hub-sync', role: 'Sales', tenantId: Number(body.tenant_id), permissions: [] } as unknown as JwtUser;
    return this.offlineSync.syncBatch({ sales: body.sales ?? [] }, hubUser);
  }

  // ── Phase 2c: hub → cloud TILL (cash session / Z-report) ingest ────────────────────────────────
  // Control BRANCH-05. The hub sends the session envelope + the hub sale numbers rung during it; the
  // ONLY figure the cloud cannot derive is the physical `closing_count`.
  //
  //   expected = opening_float + Σ(CLOUD total of the cash sales in the session) + paid_in − paid_out
  //              − drops − cash_refunds
  //
  // The cloud therefore never trusts the hub's own expected-cash number, and — because it resolves each
  // hub sale through the BRANCH-04 dedup ledger — a session whose sales have NOT all replayed is
  // REFUSED (`TILL_SALES_NOT_SYNCED`, listing the missing ones) instead of certifying a variance
  // computed over an incomplete revenue population. Idempotent on `session_no` (re-push ⇒ duplicate).
  // Over/short posts to 5830 on the same materiality line as a native close (REV-13); a material
  // variance posts a DRAFT JE and parks the session `PendingApproval` for a different user to approve.
  //
  // NB (documented in PN-24 §7 6d): restaurant checkout does not write `payments` tenders, so the
  // NATIVE `aggregateTill` (which sums tenders) misses restaurant cash. Hub sessions are reconciled
  // against the SALE ledger instead — the authoritative revenue population for a hub.
  async ingestTill(body: { tenant_id: number; sent_at: string; till: HubTillDoc; signature: string }) {
    const secret = this.secret();
    this.assertSignature(body.signature, signHubDoc({ tenant_id: Number(body.tenant_id), sent_at: String(body.sent_at), till: body.till }, secret));
    const t = Number(body.tenant_id);
    await this.assertTenant(t);
    const doc = body.till;
    const db = this.db;

    const [existing] = await db.select().from(tillSessions).where(eq(tillSessions.sessionNo, doc.session_no)).limit(1);
    if (existing) {
      return { session_no: doc.session_no, status: 'duplicate' as const, variance: Number(existing.variance ?? 0), variance_status: existing.varianceStatus ?? null, variance_journal_no: existing.varianceJournalNo ?? null };
    }

    // resolve each hub sale_no → the cloud sale it replayed into (BRANCH-04 dedup ledger)
    const saleNos = doc.sale_nos ?? [];
    const uuids = saleNos.map((s) => `hub:${t}:${s}`);
    const mapped = uuids.length
      ? await db.select({ clientUuid: posOfflineSync.clientUuid, saleNo: posOfflineSync.saleNo })
          .from(posOfflineSync)
          .where(and(eq(posOfflineSync.tenantId, t), inArray(posOfflineSync.clientUuid, uuids), sql`${posOfflineSync.saleNo} is not null`))
      : [];
    const foundHubNos = new Set(mapped.map((m: any) => String(m.clientUuid).split(':')[2]));
    const missing = saleNos.filter((s) => !foundHubNos.has(s));
    if (missing.length) {
      throw new BadRequestException({
        code: 'TILL_SALES_NOT_SYNCED',
        message: `Push the session's sales first — ${missing.length} not replayed`,
        messageTh: `ยังซิงค์บิลในรอบนี้ไม่ครบ (${missing.length} รายการ) — ต้องส่งบิลให้ครบก่อนปิดรอบ`,
        missing,
      });
    }

    // Drawer takings, valued from the CLOUD's own sale rows (never the hub's numbers).
    // NB the restaurant settlement path debits 1000 Cash for the FULL settled amount of every tender
    // (`cust_pos_sales.payment_method` stores 'Dine-in', not the tender type — see PN-24 §7 6d), and the
    // tip rides into the drawer on top of `total` (credited to 2300). So the drawer expectation is
    // Σ(total + tip) over the session's sales — exactly what the GL says entered account 1000.
    const cloudSaleNos = mapped.map((m: any) => String(m.saleNo));
    const saleRows = cloudSaleNos.length
      ? await db.select({ total: custPosSales.total, tip: custPosSales.tip })
          .from(custPosSales)
          .where(and(eq(custPosSales.tenantId, t), inArray(custPosSales.saleNo, cloudSaleNos)))
      : [];
    const cashSales = roundCurrency(saleRows.reduce((s: number, r: any) => s + Number(r.total ?? 0) + Number(r.tip ?? 0), 0), 'THB');

    const num = (v: unknown) => Number(v ?? 0);
    const expectedCash = roundCurrency(
      num(doc.opening_float) + cashSales + num(doc.paid_in) - num(doc.paid_out) - num(doc.drops) - num(doc.cash_refunds), 'THB',
    );
    const variance = roundCurrency(num(doc.closing_count) - expectedCash, 'THB');

    let varianceJournalNo: string | null = null;
    let varianceStatus: 'NotRequired' | 'PendingApproval' = 'NotRequired';
    if (Math.abs(variance) >= 0.005 && !(await this.ledger.alreadyPosted('TILL_CLOSE', doc.session_no, t))) {
      const material = Math.abs(variance) > CASH_VARIANCE_THRESHOLD;
      const v = Math.abs(variance);
      const lines = variance < 0
        ? [{ account_code: '5830', debit: v }, { account_code: '1000', credit: v }]
        : [{ account_code: '1000', debit: v }, { account_code: '5830', credit: v }];
      const je: any = await this.ledger.postEntry({
        source: 'TILL_CLOSE', sourceRef: doc.session_no, tenantId: t,
        memo: `Hub till close variance ${doc.session_no} (${variance < 0 ? 'short' : 'over'} ${v})`,
        createdBy: 'hub-sync', pendingApproval: material, lines,
      });
      varianceJournalNo = je?.entry_no ?? null;
      varianceStatus = material ? 'PendingApproval' : 'NotRequired';
    }

    await db.insert(tillSessions).values({
      sessionNo: doc.session_no, tenantId: t,
      openedBy: doc.opened_by ?? 'hub', openedAt: new Date(doc.opened_at),
      openingFloat: String(num(doc.opening_float)),
      closedBy: doc.closed_by ?? 'hub', closedAt: new Date(doc.closed_at),
      closingCount: String(num(doc.closing_count)), expectedCash: String(expectedCash), variance: String(variance),
      denominations: doc.denominations ?? null, status: 'Closed',
      varianceJournalNo, varianceStatus,
    });

    return {
      session_no: doc.session_no, status: 'ingested' as const,
      cash_sales: cashSales, expected_cash: expectedCash, closing_count: num(doc.closing_count),
      variance, variance_status: varianceStatus, variance_journal_no: varianceJournalNo, sales_matched: cloudSaleNos.length,
    };
  }

  // ── Phase 4a: hub heartbeat (liveness + backlog) ───────────────────────────────────────────────
  // Signed like every hub call. The CLOUD stamps `last_seen_at` and derives `clock_skew_sec` from the
  // hub's own `sent_at` — a drifting hub clock mis-buckets the business day, so it is measured, not
  // assumed. Upsert per (tenant, hub_id).
  async heartbeat(body: { tenant_id: number; sent_at: string; hub: HubHeartbeatDoc; signature: string }) {
    const secret = this.secret();
    this.assertSignature(body.signature, signHubDoc({ tenant_id: Number(body.tenant_id), sent_at: String(body.sent_at), hub: body.hub }, secret));
    const t = Number(body.tenant_id);
    await this.assertTenant(t);
    const now = new Date();
    const skew = Math.round((new Date(body.sent_at).getTime() - now.getTime()) / 1000);
    const row = {
      tenantId: t, hubId: body.hub.hub_id, appVersion: body.hub.app_version ?? null,
      lastSeenAt: now, lastPushAt: body.hub.last_push_at ? new Date(body.hub.last_push_at) : null,
      pendingSales: Number(body.hub.pending_sales ?? 0), pendingTills: Number(body.hub.pending_tills ?? 0),
      failedDocs: Number(body.hub.failed_docs ?? 0), skippedDocs: Number(body.hub.skipped_docs ?? 0),
      clockSkewSec: Number.isFinite(skew) ? skew : null,
    };
    await this.db.insert(hubHeartbeats).values(row)
      .onConflictDoUpdate({ target: [hubHeartbeats.tenantId, hubHeartbeats.hubId], set: row });
    return { ok: true as const, hub_id: body.hub.hub_id, clock_skew_sec: row.clockSkewSec };
  }

  // Fleet view: the tenant's hubs with a derived `stale` flag (no heartbeat within the window) and the
  // backlog that a silent hub is sitting on. `attention` = stale, or failed/skipped docs, or big skew.
  async fleet(user: JwtUser, staleMinutes = 15) {
    const t = this.tenantId(user);
    const rows = await this.db.select().from(hubHeartbeats).where(eq(hubHeartbeats.tenantId, t));
    const now = Date.now();
    const hubs = rows.map((h: any) => {
      const seenMinAgo = Math.round((now - new Date(h.lastSeenAt).getTime()) / 60000);
      const stale = seenMinAgo > staleMinutes;
      return {
        hub_id: h.hubId, app_version: h.appVersion, last_seen_at: h.lastSeenAt, seen_minutes_ago: seenMinAgo,
        last_push_at: h.lastPushAt, pending_sales: h.pendingSales, pending_tills: h.pendingTills,
        failed_docs: h.failedDocs, skipped_docs: h.skippedDocs, clock_skew_sec: h.clockSkewSec,
        stale, needs_attention: stale || h.failedDocs > 0 || h.skippedDocs > 0 || Math.abs(h.clockSkewSec ?? 0) > 120,
      };
    });
    return {
      stale_minutes: staleMinutes,
      hubs,
      summary: {
        hubs: hubs.length,
        stale: hubs.filter((h) => h.stale).length,
        needs_attention: hubs.filter((h) => h.needs_attention).length,
        pending_docs: hubs.reduce((s, h) => s + h.pending_sales + h.pending_tills, 0),
      },
    };
  }

  // ── Phase 2a: reconciliation report (BRANCH-04 detective tie-out) ───────────────────────────────
  // Every hub-ingested op for the caller's tenant (client_uuid prefix 'hub:'), joined to the cloud sale
  // it minted — so the reviewer ties hub-captured count/value to the central ledger and chases failures.
  async reconciliation(user: JwtUser, from?: string, to?: string) {
    const t = this.tenantId(user);
    const conds = [eq(posOfflineSync.tenantId, t), like(posOfflineSync.clientUuid, 'hub:%')];
    if (from) conds.push(gte(posOfflineSync.capturedAt, new Date(`${from}T00:00:00+07:00`)));
    if (to) conds.push(lte(posOfflineSync.capturedAt, new Date(`${to}T23:59:59.999+07:00`)));
    // typed LEFT JOIN (not a raw scalar subquery — drizzle renders an embedded column ref inside a
    // sql`(SELECT …)` fragment UNQUALIFIED, so it binds to the inner table and matches every row: 21000)
    const rows = await this.db
      .select({
        client_uuid: posOfflineSync.clientUuid, status: posOfflineSync.status, device_id: posOfflineSync.deviceId,
        cloud_sale_no: posOfflineSync.saleNo, captured_at: posOfflineSync.capturedAt, synced_at: posOfflineSync.syncedAt,
        error_code: posOfflineSync.errorCode, attempts: posOfflineSync.attempts,
        cloud_total: custPosSales.total,
      })
      .from(posOfflineSync)
      .leftJoin(custPosSales, eq(custPosSales.saleNo, posOfflineSync.saleNo))
      .where(and(...conds));
    const out = rows.map((r: any) => ({
      ...r,
      hub_sale_no: String(r.client_uuid).split(':')[2] ?? null, // hub:{tenant}:{hub_sale_no}
      cloud_total: r.cloud_total != null ? Number(r.cloud_total) : null,
    }));
    const summary = {
      ops: out.length,
      synced: out.filter((r) => r.status === 'synced').length,
      failed: out.filter((r) => r.status === 'failed').length,
      cloud_total: Math.round(out.reduce((s, r) => s + (r.cloud_total ?? 0), 0) * 100) / 100,
    };
    return { from: from ?? null, to: to ?? null, rows: out, summary };
  }
}
