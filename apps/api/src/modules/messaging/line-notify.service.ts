import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and, isNotNull, or, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users, messageLog } from '../../database/schema';
import { TenantMessagingService } from './tenant-messaging.service';
import { resolveMessageGateway } from './gateways';

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

  // Push to one linked staff user (no-op when the user has no linked LINE account).
  async notifyUser(username: string, tenantId: number | null | undefined, text: string): Promise<void> {
    try {
      const [u] = await this.db.select({ lineUserId: users.lineUserId, isActive: users.isActive, tenantId: users.tenantId })
        .from(users).where(eq(users.username, username)).limit(1);
      if (!u?.lineUserId || u.isActive === false) return;
      await this.push(tenantId ?? (u.tenantId != null ? Number(u.tenantId) : null), String(u.lineUserId), text);
    } catch (e: any) {
      this.logger.warn(`notifyUser(${username}) failed: ${e?.message ?? e}`);
    }
  }

  // Push to every linked, active staff user holding a role (approver-queue fan-out). Tenant-scoped: users of
  // the doc's tenant plus HQ users (tenant NULL). Capped to keep a misconfigured role from blasting.
  async notifyRole(role: string, tenantId: number | null | undefined, text: string, cap = 20): Promise<void> {
    try {
      const conds = [eq(users.role, role as typeof users.$inferSelect.role), eq(users.isActive, true), isNotNull(users.lineUserId)];
      if (tenantId != null) conds.push(or(eq(users.tenantId, tenantId), isNull(users.tenantId))!);
      const rows = await this.db.select({ lineUserId: users.lineUserId, tenantId: users.tenantId })
        .from(users).where(and(...conds)).limit(cap);
      for (const r of rows) await this.push(tenantId ?? (r.tenantId != null ? Number(r.tenantId) : null), String(r.lineUserId), text);
    } catch (e: any) {
      this.logger.warn(`notifyRole(${role}) failed: ${e?.message ?? e}`);
    }
  }

  private async push(tenantId: number | null, lineUserId: string, text: string): Promise<void> {
    const token = await this.token(tenantId);
    const result = await resolveMessageGateway('line', token ? { token } : undefined).send(lineUserId, text);
    try {
      await this.db.insert(messageLog).values({
        tenantId, memberId: null, channel: 'line', recipient: lineUserId, body: text, campaign: 'wf_notify',
        status: result.status, provider: result.provider, providerRef: result.ref ?? null, error: result.error ?? null,
        createdBy: 'system:line-notify',
      });
    } catch { /* audit best-effort */ }
  }
}
