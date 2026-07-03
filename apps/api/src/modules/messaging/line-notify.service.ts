import { Inject, Injectable, Logger, BadRequestException } from '@nestjs/common';
import { eq, and, isNotNull, or, isNull } from 'drizzle-orm';
import { resolvePermissions, type Role, type Permission } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users, userPermissions, messageLog } from '../../database/schema';
import { TenantMessagingService } from './tenant-messaging.service';
import { resolveMessageGateway, pushLineFlex } from './gateways';

// LC-1 (docs/30) — the approver queue-entry card: a flex bubble with one-tap [อนุมัติ]/[ปฏิเสธ] postback
// buttons. The postback routes into the SAME chatDecision → approvePr → workflow-engine path as the typed
// command (with a confirm step), so the buttons change UX, not controls. Kept beside LineNotifyService so
// the workflow engine never needs to know LINE flex JSON.
export function buildApproveCard(docType: string, docNo: string, createdBy: string | null): any {
  const pb = (x: 'approve' | 'reject') => JSON.stringify({ a: 'decide', x, d: docNo });
  return {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'text', text: `🔔 รออนุมัติ: ${docType}`, weight: 'bold', size: 'sm', color: '#8a6d1d' },
        { type: 'text', text: docNo, weight: 'bold', size: 'lg' },
        { type: 'text', text: `โดย ${createdBy ?? '-'}`, size: 'sm', color: '#888888' },
      ],
    },
    footer: {
      type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', height: 'sm', action: { type: 'postback', label: 'อนุมัติ', data: pb('approve'), displayText: `อนุมัติ ${docNo}` } },
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: 'ปฏิเสธ', data: pb('reject'), displayText: `ปฏิเสธ ${docNo}` } },
      ],
    },
  };
}

// STAFF LINE notifications (0228 — LINE chat → PR phase 2). Pushes a message to the LINE account a staff
// user linked for the chat-PR flow (users.line_user_id). Transactional workflow signal, not marketing —
// so it does NOT go through MessagingService's member-consent/quiet-hours pipeline (those govern customer
// campaigns); it is audit-logged in message_log (campaign 'wf_notify'). Every entry point is best-effort:
// a notification must never break the business action that triggered it.
@Injectable()
export class LineNotifyService {
  private readonly logger = new Logger('LineNotify');
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly tenantMsg: TenantMessagingService,
  ) {}

  private async token(tenantId: number | null | undefined): Promise<string | undefined> {
    const creds = await this.tenantMsg.resolveCreds(tenantId ?? null, 'line').catch(() => null);
    return (creds?.token as string | undefined) ?? process.env.LINE_CHANNEL_TOKEN;
  }

  // Push to one linked staff user (no-op when the user has no linked LINE account). With `flex`, sends a
  // rich card (text becomes the altText); without, a plain text push.
  async notifyUser(username: string, tenantId: number | null | undefined, text: string, flex?: any): Promise<void> {
    try {
      const [u] = await this.db.select({ lineUserId: users.lineUserId, isActive: users.isActive, tenantId: users.tenantId })
        .from(users).where(eq(users.username, username)).limit(1);
      if (!u?.lineUserId || u.isActive === false) return;
      await this.push(tenantId ?? (u.tenantId != null ? Number(u.tenantId) : null), String(u.lineUserId), text, flex);
    } catch (e: any) {
      this.logger.warn(`notifyUser(${username}) failed: ${e?.message ?? e}`);
    }
  }

  // Push to every linked, active staff user holding a role (approver-queue fan-out). Tenant-scoped: users of
  // the doc's tenant plus HQ users (tenant NULL). Capped to keep a misconfigured role from blasting.
  async notifyRole(role: string, tenantId: number | null | undefined, text: string, cap = 20, flex?: any): Promise<void> {
    try {
      const conds = [eq(users.role, role as typeof users.$inferSelect.role), eq(users.isActive, true), isNotNull(users.lineUserId)];
      if (tenantId != null) conds.push(or(eq(users.tenantId, tenantId), isNull(users.tenantId))!);
      const rows = await this.db.select({ lineUserId: users.lineUserId, tenantId: users.tenantId })
        .from(users).where(and(...conds)).limit(cap);
      for (const r of rows) await this.push(tenantId ?? (r.tenantId != null ? Number(r.tenantId) : null), String(r.lineUserId), text, flex);
    } catch (e: any) {
      this.logger.warn(`notifyRole(${role}) failed: ${e?.message ?? e}`);
    }
  }

  // Push to every linked, active staff user holding ANY of the required permissions (effective set —
  // per-user override else role default, expanded; same precedence as login). Used where the approver
  // population is defined by permission rather than a single role (e.g. petty-cash EXP-08:
  // creditors/exec). The maker is excluded so a requester is never "notified" of their own request.
  async notifyPermissionHolders(required: string[], tenantId: number | null | undefined, text: string, excludeUsername?: string | null, cap = 20): Promise<void> {
    try {
      const conds = [eq(users.isActive, true), isNotNull(users.lineUserId)];
      if (tenantId != null) conds.push(or(eq(users.tenantId, tenantId), isNull(users.tenantId))!);
      const rows = await this.db.select().from(users).where(and(...conds)).limit(50);
      let sent = 0;
      for (const u of rows) {
        if (sent >= cap) break;
        if (excludeUsername && u.username === excludeUsername) continue;
        const ov = await this.db.select({ perm: userPermissions.perm }).from(userPermissions).where(eq(userPermissions.userId, Number(u.id)));
        const eff = resolvePermissions(u.role as Role, ov.length ? ov.map((r: any) => r.perm as Permission) : null);
        if (!required.some((p) => eff.includes(p as Permission))) continue;
        await this.push(tenantId ?? (u.tenantId != null ? Number(u.tenantId) : null), String(u.lineUserId), text);
        sent++;
      }
    } catch (e: any) {
      this.logger.warn(`notifyPermissionHolders(${required.join(',')}) failed: ${e?.message ?? e}`);
    }
  }

  // LP-3 (docs/31) — effective permission set of a staff user (per-user override else role default,
  // same precedence as login). Used by the digest delivery loop to filter KPIs per recipient AT SEND TIME.
  async effectivePermsOf(username: string): Promise<string[]> {
    const [u] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!u) return [];
    const ov = await this.db.select({ perm: userPermissions.perm }).from(userPermissions).where(eq(userPermissions.userId, Number(u.id)));
    return resolvePermissions(u.role as Role, ov.length ? ov.map((r: any) => r.perm as Permission) : null) as string[];
  }

  // LP-1 (docs/31) — the settings console's [ส่งข้อความทดสอบถึงฉัน] button: an explicit-feedback variant
  // of notifyUser for go-live verification. Unlike the best-effort notify paths, this ERRORS when the
  // caller has no linked LINE account (the admin needs to know why nothing arrived).
  async testSelf(user: { username?: string | null; tenantId?: number | null }): Promise<{ status: string; provider: string; to: string }> {
    const [u] = await this.db.select({ lineUserId: users.lineUserId })
      .from(users).where(eq(users.username, String(user.username ?? ''))).limit(1);
    if (!u?.lineUserId) {
      throw new BadRequestException({ code: 'NOT_LINKED', message: 'Your ERP account has no linked LINE — link it first (requisitions page → เชื่อมต่อ LINE)', messageTh: 'บัญชีของคุณยังไม่ได้เชื่อม LINE — เชื่อมต่อได้ที่หน้า "คำขอซื้อ (PR)"' });
    }
    const to = String(u.lineUserId);
    const result = await this.push(user.tenantId ?? null, to, 'ทดสอบการแจ้งเตือน LINE ✅ — ช่องทางของร้านพร้อมใช้งาน', undefined, 'line_test');
    return { status: result.status, provider: result.provider, to: `${to.slice(0, 6)}…` };
  }

  private async push(tenantId: number | null, lineUserId: string, text: string, flex?: any, campaign = 'wf_notify'): Promise<{ status: string; provider: string }> {
    const token = await this.token(tenantId);
    const result = flex && token
      ? await pushLineFlex(token, lineUserId, text, flex)
      : await resolveMessageGateway('line', token ? { token } : undefined).send(lineUserId, text);
    try {
      await this.db.insert(messageLog).values({
        tenantId, memberId: null, channel: 'line', recipient: lineUserId, body: text, campaign,
        status: result.status, provider: result.provider, providerRef: result.ref ?? null, error: result.error ?? null,
        createdBy: 'system:line-notify',
      });
    } catch { /* audit best-effort */ }
    return { status: result.status, provider: result.provider };
  }
}
