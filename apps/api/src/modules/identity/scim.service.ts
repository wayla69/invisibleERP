import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users, tenants, tenantIdentity } from '../../database/schema';
import { AdminUsersService } from '../admin-users/admin-users.service';
import type { JwtUser } from '../../common/decorators';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ROLE_EXT = 'urn:ietf:params:scim:schemas:extension:ierp:2.0:User';

// SCIM 2.0 user provisioning. Runs under the SCIM principal's tenant (RLS-scoped); create/reactivate go
// through AdminUsersService so the SAME SoD checks apply as the admin UI; deprovisioning DEACTIVATES
// (is_active=false) rather than deleting, preserving the audit trail.
@Injectable()
export class ScimService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly adminUsers: AdminUsersService) {}

  private toResource(u: any) {
    return {
      schemas: [USER_SCHEMA, ROLE_EXT],
      id: String(u.id),
      userName: u.username,
      active: u.isActive !== false,
      name: { formatted: u.username },
      externalId: u.ssoSubject ?? undefined,
      [ROLE_EXT]: { role: u.role },
      meta: { resourceType: 'User', location: `/scim/v2/Users/${u.id}` },
    };
  }

  private async tenantCode(tenantId: number): Promise<string> {
    const db = this.db as any;
    const [t] = await db.select({ code: tenants.code }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) throw new BadRequestException({ code: 'NO_TENANT', message: 'Tenant not found', messageTh: 'ไม่พบผู้เช่า' });
    return t.code;
  }

  private async defaultRole(tenantId: number): Promise<string> {
    const db = this.db as any;
    const [c] = await db.select({ r: tenantIdentity.defaultRole }).from(tenantIdentity).where(eq(tenantIdentity.tenantId, tenantId)).limit(1);
    return c?.r ?? 'Customer';
  }

  // GET /scim/v2/Users[?filter=userName eq "x"&startIndex=&count=]
  async list(user: JwtUser, q: { filter?: string; startIndex?: string; count?: string }) {
    const db = this.db as any;
    let unameEq: string | undefined;
    if (q.filter) {
      const m = /userName\s+eq\s+"([^"]+)"/i.exec(q.filter);
      if (m) unameEq = m[1];
    }
    const startIndex = Math.max(Number(q.startIndex) || 1, 1); // SCIM is 1-based
    const count = Math.min(Math.max(Number(q.count) || 100, 0), 200);
    const where = and(eq(users.tenantId, user.tenantId as number), unameEq ? eq(users.username, unameEq.toLowerCase()) : undefined);
    const all = await db.select().from(users).where(where).orderBy(users.username);
    const page = all.slice(startIndex - 1, startIndex - 1 + count);
    return {
      schemas: [LIST_SCHEMA],
      totalResults: all.length,
      startIndex,
      itemsPerPage: page.length,
      Resources: page.map((u: any) => this.toResource(u)),
    };
  }

  private async byId(tenantId: number, id: string) {
    const db = this.db as any;
    const numId = Number(id);
    if (!Number.isFinite(numId)) return null;
    const [u] = await db.select().from(users).where(and(eq(users.id, numId), eq(users.tenantId, tenantId))).limit(1);
    return u ?? null;
  }

  async get(user: JwtUser, id: string) {
    const u = await this.byId(user.tenantId as number, id);
    if (!u) throw this.notFound(id);
    return this.toResource(u);
  }

  // POST /scim/v2/Users — provision (SoD-checked via AdminUsersService).
  async create(user: JwtUser, body: any) {
    const db = this.db as any;
    const userName: string = String(body?.userName ?? '').trim();
    if (!userName) throw new BadRequestException({ code: 'INVALID_VALUE', message: 'userName is required', messageTh: 'ต้องระบุ userName', scimType: 'invalidValue' });
    const role = body?.[ROLE_EXT]?.role ?? (await this.defaultRole(user.tenantId as number));
    const code = await this.tenantCode(user.tenantId as number);
    // Reuse the SoD-safe admin create path (random unusable password; SSO/SCIM users never password-login).
    await this.adminUsers.create({ username: userName, password: 'scim_' + randomBytes(16).toString('hex'), role, customer_name: code });
    // Link the IdP subject + active state.
    const externalId = body?.externalId ? String(body.externalId) : null;
    const active = body?.active !== false;
    await db.update(users)
      .set({ ssoSubject: externalId, isActive: active })
      .where(and(eq(users.username, userName.trim().toLowerCase()), eq(users.tenantId, user.tenantId as number)));
    const created = await db.select().from(users).where(and(eq(users.username, userName.trim().toLowerCase()), eq(users.tenantId, user.tenantId as number))).limit(1);
    return this.toResource(created[0]);
  }

  // PUT /scim/v2/Users/:id — replace (role/active/externalId).
  async replace(user: JwtUser, id: string, body: any) {
    const db = this.db as any;
    const u = await this.byId(user.tenantId as number, id);
    if (!u) throw this.notFound(id);
    const set: any = {};
    if (body?.active !== undefined) set.isActive = body.active !== false;
    if (body?.externalId !== undefined) set.ssoSubject = body.externalId ? String(body.externalId) : null;
    const role = body?.[ROLE_EXT]?.role;
    if (role) {
      await this.adminUsers.update(u.username, { role }); // SoD-checked
    }
    if (Object.keys(set).length) await db.update(users).set(set).where(eq(users.id, u.id));
    return this.get(user, id);
  }

  // PATCH /scim/v2/Users/:id — minimal Microsoft/Okta dialect: replace `active` (deprovision/reactivate).
  async patch(user: JwtUser, id: string, body: any) {
    const db = this.db as any;
    const u = await this.byId(user.tenantId as number, id);
    if (!u) throw this.notFound(id);
    const ops: any[] = Array.isArray(body?.Operations) ? body.Operations : [];
    let nextActive = u.isActive;
    for (const op of ops) {
      const path = String(op?.path ?? '').toLowerCase();
      const val = op?.value;
      const isActiveOp = path === 'active' || (path === '' && val && typeof val === 'object' && 'active' in val);
      if ((String(op?.op ?? '').toLowerCase() === 'replace' || !op?.op) && isActiveOp) {
        const raw = path === 'active' ? val : val.active;
        nextActive = raw === true || raw === 'true' || raw === 'True';
      }
    }
    await db.update(users).set({ isActive: nextActive }).where(eq(users.id, u.id));
    return this.get(user, id);
  }

  // DELETE /scim/v2/Users/:id — deprovision = DEACTIVATE (soft), never destroy the row.
  async deactivate(user: JwtUser, id: string) {
    const db = this.db as any;
    const u = await this.byId(user.tenantId as number, id);
    if (!u) throw this.notFound(id);
    await db.update(users).set({ isActive: false }).where(eq(users.id, u.id));
    return { deactivated: true };
  }

  serviceProviderConfig() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: '/scim/v2',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer Token', description: 'Per-tenant SCIM bearer token (scim_…)' }],
    };
  }

  private notFound(id: string) {
    return new NotFoundException({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '404', detail: `User ${id} not found`, code: 'NOT_FOUND', message: `User ${id} not found` });
  }
}
