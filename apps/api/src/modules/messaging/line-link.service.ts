import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { eq, isNotNull } from 'drizzle-orm';
import { resolvePermissions, type Role, type Permission } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users, userPermissions, messageLog, lineChatStates } from '../../database/schema';
import { isUniqueViolation } from '../../common/db-error';
import type { JwtUser } from '../../common/decorators';
import { helpCard } from './line-cards';

// LINE staff-account linking + chat identity resolution, extracted from line-webhook.controller.ts
// (2026-07-09 decomposition; zero behaviour change). Owns the one-time link-code lifecycle (0227), the
// LC-3 admin link registry / force-unlink (ITGC-AC offboarding evidence), the linked-staff lookup +
// effective-permission expansion the chat command router authorizes with, and the shared chat audit row.
@Injectable()
export class LineLinkService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Best-effort chat audit row (message_log, campaign chat_link_audit) — shared by every chat handler.
  async audit(tenantId: number | null, recipient: string, body: string) {
    try {
      await this.db.insert(messageLog).values({ tenantId, memberId: null, channel: 'line', recipient, body, campaign: 'chat_link_audit', status: 'received', provider: 'line', createdBy: 'system:line-chat' });
    } catch { /* audit best-effort */ }
  }

  private static readonly CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L ambiguity
  genCode(): string {
    let out = '';
    // randomInt is CSPRNG-backed and rejection-sampled — no modulo bias over the 31-char alphabet
    for (let i = 0; i < 6; i++) out += LineLinkService.CODE_ALPHABET[randomInt(LineLinkService.CODE_ALPHABET.length)];
    return out;
  }

  // Bind the LINE account to the staff user holding this (unexpired) one-time code. The code was issued to
  // an authenticated pr_raise holder on /requisitions, so possession of it proves the ERP identity; the
  // user must belong to this OA's tenant (HQ users with no tenant may link on any of their shops' OAs).
  async linkStaff(tenantId: number, lineUserId: string, code: string): Promise<{ text: string; flex?: any }> {
    const db = this.db;
    const [u] = await db.select().from(users).where(eq(users.lineLinkCode, code)).limit(1);
    const expired = !u?.lineLinkExpiresAt || new Date(u.lineLinkExpiresAt).getTime() < Date.now();
    if (!u || u.isActive === false || expired || (u.tenantId != null && Number(u.tenantId) !== tenantId)) {
      return { text: 'รหัสเชื่อมไม่ถูกต้องหรือหมดอายุ — สร้างรหัสใหม่ได้ที่หน้า "คำขอซื้อ (PR)" ในระบบ ERP' };
    }
    try {
      await db.update(users).set({ lineUserId, lineLinkCode: null, lineLinkExpiresAt: null }).where(eq(users.id, u.id));
    } catch (e: any) {
      if (isUniqueViolation(e)) return { text: 'บัญชี LINE นี้ถูกเชื่อมกับผู้ใช้อื่นแล้ว — ยกเลิกการเชื่อมเดิมก่อนจากหน้า "คำขอซื้อ (PR)"' };
      throw e;
    }
    await this.audit(tenantId, lineUserId, `[chat:link] ${u.username}`);
    // altText MUST keep the phrase "เชื่อมบัญชีสำเร็จ" — notification previews + the line-crm assertion read it.
    return {
      text: `เชื่อมบัญชีสำเร็จ ✔ (${u.username}) — พิมพ์ "help" เพื่อดูคำสั่งทั้งหมด`,
      flex: helpCard(`🎉 เชื่อมบัญชีสำเร็จ`, `ยินดีต้อนรับคุณ ${u.username}`),
    };
  }

  // Resolve the STAFF user linked to this LINE account (active + same tenant; HQ users pass on any tenant).
  async staffByLine(tenantId: number, lineUserId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.lineUserId, lineUserId)).limit(1);
    if (!u || u.isActive === false) return null;
    if (u.tenantId != null && Number(u.tenantId) !== tenantId) return null;
    return u;
  }

  // Effective permissions = per-user override (if any) else role default, expanded — same precedence the
  // login flow uses (resolvePermissions), so chat honours exactly what the web session would.
  async effectivePerms(u: { id: number; role: string }): Promise<string[]> {
    const rows = await this.db.select({ perm: userPermissions.perm }).from(userPermissions).where(eq(userPermissions.userId, Number(u.id)));
    const overrides = rows.map((r: any) => r.perm as Permission);
    return resolvePermissions(u.role as Role, overrides.length ? overrides : null);
  }

  // ── LC-3 governance: admin link registry (ITGC-AC — offboarding evidence) ─────────────────────────
  async listLinks() {
    const rows = await this.db.select({ username: users.username, role: users.role, tenantId: users.tenantId, lineUserId: users.lineUserId, isActive: users.isActive })
      .from(users).where(isNotNull(users.lineUserId)).orderBy(users.username);
    return {
      links: rows.map((r: any) => ({
        username: r.username, role: r.role, tenant_id: r.tenantId != null ? Number(r.tenantId) : null,
        line_user_id_masked: `${String(r.lineUserId).slice(0, 5)}…`, active: r.isActive !== false,
      })),
      count: rows.length,
    };
  }

  // Force-unlink for offboarding: clears the binding + any pending chat state, audit-logged. The chat
  // channel dies immediately even if the account was left active by mistake.
  async adminUnlink(username: string, actor: JwtUser) {
    const [u] = await this.db.select({ id: users.id, lineUserId: users.lineUserId, tenantId: users.tenantId }).from(users).where(eq(users.username, username)).limit(1);
    if (!u?.lineUserId) throw new NotFoundException({ code: 'NOT_LINKED', message: 'User has no linked LINE account', messageTh: 'ผู้ใช้นี้ไม่ได้เชื่อม LINE' });
    await this.db.update(users).set({ lineUserId: null, lineLinkCode: null, lineLinkExpiresAt: null }).where(eq(users.id, u.id));
    await this.db.delete(lineChatStates).where(eq(lineChatStates.lineUserId, String(u.lineUserId)));
    await this.audit(u.tenantId != null ? Number(u.tenantId) : actor.tenantId ?? null, String(u.lineUserId), `[chat:admin-unlink] ${username} by ${actor.username}`);
    return { username, unlinked: true };
  }

  // ── Link-code lifecycle (authenticated web endpoints) ─────────────────────

  // Issue a fresh one-time link code for the calling staff user (10-minute TTL; re-issuing replaces the
  // previous code). The code is typed into the shop's LINE OA chat as `link <code>`.
  async issueLinkCode(user: JwtUser) {
    const db = this.db;
    const [row] = await db.select({ id: users.id, lineUserId: users.lineUserId }).from(users).where(eq(users.username, user.username)).limit(1);
    if (!row) throw new UnauthorizedException({ code: 'UNKNOWN_USER', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    for (let i = 0; ; i++) {
      const code = this.genCode();
      try {
        await db.update(users).set({ lineLinkCode: code, lineLinkExpiresAt: expiresAt }).where(eq(users.id, row.id));
        return { code, expires_at: expiresAt.toISOString(), linked: !!row.lineUserId };
      } catch (e: any) {
        if (!isUniqueViolation(e) || i >= 4) throw e; // code collision → regenerate (astronomically rare)
      }
    }
  }

  async linkStatus(user: JwtUser) {
    const [row] = await this.db.select({ lineUserId: users.lineUserId }).from(users).where(eq(users.username, user.username)).limit(1);
    return { linked: !!row?.lineUserId };
  }

  async unlink(user: JwtUser) {
    await this.db.update(users).set({ lineUserId: null, lineLinkCode: null, lineLinkExpiresAt: null }).where(eq(users.username, user.username));
    return { linked: false };
  }
}
