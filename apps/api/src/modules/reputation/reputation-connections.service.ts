import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { reputationConnections } from '../../database/schema';
import { decrypt } from '../../common/crypto';
import type { JwtUser } from '../../common/decorators';
import { GoogleOAuthService, type ReputationPlatform } from './google-oauth.service';

const GBP_ACCOUNTS_URL = 'https://mybusiness.googleapis.com/v4/accounts';
const GA4_ACCOUNT_SUMMARIES_URL = 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries';

export interface ConnectionTarget { ref: string; label: string }

// docs/47 — connection CRUD + "list available targets" (Business Profile locations / GA4 properties) so
// the admin can pick which location(s)/property to track after granting OAuth consent. Tokens are never
// returned by any read here — only connection status/metadata.
@Injectable()
export class ReputationConnectionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly oauth: GoogleOAuthService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  // GET /api/reputation/connections — redacted (no tokens).
  async list(user: JwtUser) {
    const tenantId = this.tid(user);
    const rows = await this.db.select().from(reputationConnections).where(eq(reputationConnections.tenantId, tenantId));
    return {
      connections: rows.map((r) => ({
        id: r.id, platform: r.platform, status: r.status, google_account_email: r.googleAccountEmail,
        external_refs: r.externalRefs, last_synced_at: r.lastSyncedAt, last_error: r.lastError,
        has_refresh_token: !!r.refreshTokenEnc, created_at: r.createdAt,
      })),
    };
  }

  private async findOwn(user: JwtUser, id: number) {
    const tenantId = this.tid(user);
    const [row] = await this.db.select().from(reputationConnections)
      .where(and(eq(reputationConnections.id, id), eq(reputationConnections.tenantId, tenantId))).limit(1);
    if (!row) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND', message: 'Connection not found', messageTh: 'ไม่พบการเชื่อมต่อ' });
    return row;
  }

  // GET /api/reputation/connections/:id/targets — enumerate available locations/properties live from Google.
  async listTargets(user: JwtUser, id: number): Promise<{ targets: ConnectionTarget[] }> {
    const conn = await this.findOwn(user, id);
    const accessToken = await this.oauth.freshAccessToken(conn);
    if (conn.platform === 'google_maps') return { targets: await this.listGbpLocations(accessToken) };
    if (conn.platform === 'google_analytics') return { targets: await this.listGa4Properties(accessToken) };
    throw new BadRequestException({ code: 'BAD_PLATFORM', message: 'Unknown platform', messageTh: 'ไม่รู้จักแพลตฟอร์ม' });
  }

  private async listGbpLocations(accessToken: string): Promise<ConnectionTarget[]> {
    const authHeaders = { authorization: `Bearer ${accessToken}` };
    const accRes = await fetch(GBP_ACCOUNTS_URL, { headers: authHeaders });
    if (!accRes.ok) return [];
    const accJson: any = await accRes.json().catch(() => ({}));
    const targets: ConnectionTarget[] = [];
    for (const acc of accJson.accounts ?? []) {
      const locRes = await fetch(`https://mybusiness.googleapis.com/v4/${acc.name}/locations?pageSize=100`, { headers: authHeaders });
      if (!locRes.ok) continue;
      const locJson: any = await locRes.json().catch(() => ({}));
      for (const loc of locJson.locations ?? []) {
        targets.push({ ref: loc.name, label: loc.locationName ?? loc.name });
      }
    }
    return targets;
  }

  private async listGa4Properties(accessToken: string): Promise<ConnectionTarget[]> {
    const res = await fetch(GA4_ACCOUNT_SUMMARIES_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return [];
    const json: any = await res.json().catch(() => ({}));
    const targets: ConnectionTarget[] = [];
    for (const acc of json.accountSummaries ?? []) {
      for (const prop of acc.propertySummaries ?? []) {
        targets.push({ ref: prop.property, label: `${acc.displayName} — ${prop.displayName}` });
      }
    }
    return targets;
  }

  // PUT /api/reputation/connections/:id/targets — save which locations/properties to sync.
  async setTargets(user: JwtUser, id: number, targets: ConnectionTarget[]) {
    await this.findOwn(user, id);
    await this.db.update(reputationConnections)
      .set({ externalRefs: targets, updatedAt: new Date() })
      .where(eq(reputationConnections.id, id));
    return { ok: true, count: targets.length };
  }

  // DELETE /api/reputation/connections/:id — best-effort revoke at Google, then mark revoked locally
  // (kept as a row, not deleted, so synced reviews/analytics retain their connection_id lineage).
  async revoke(user: JwtUser, id: number) {
    const conn = await this.findOwn(user, id);
    if (conn.refreshTokenEnc) await this.oauth.revokeToken(decrypt(conn.refreshTokenEnc));
    await this.db.update(reputationConnections)
      .set({ status: 'revoked', accessTokenEnc: null, refreshTokenEnc: null, updatedAt: new Date() })
      .where(eq(reputationConnections.id, id));
    return { ok: true };
  }

  // Active connections for a tenant on one platform (used by the sync services).
  async activeFor(tenantId: number, platform: ReputationPlatform) {
    return this.db.select().from(reputationConnections)
      .where(and(eq(reputationConnections.tenantId, tenantId), eq(reputationConnections.platform, platform), eq(reputationConnections.status, 'active')));
  }
}
