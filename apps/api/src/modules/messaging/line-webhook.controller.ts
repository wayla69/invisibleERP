import { Controller, Post, Param, Req, Headers, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { createHmac } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants, posMembers, messageLog } from '../../database/schema';
import { safeEqualStr } from '../../common/crypto';
import { isUniqueViolation } from '../../common/db-error';
import { Public, NoTx } from '../../common/decorators';
import { TenantMessagingService } from './tenant-messaging.service';

// LINE Messaging API webhook (follow / unfollow / …). Public + no JWT: authenticity is the LINE signature
// (`X-Line-Signature` = base64 HMAC-SHA256 of the RAW body under the tenant's Channel Secret). One OA = one
// tenant, so the URL carries the shop code: each tenant points its LINE webhook at /api/line/webhook/<code>.
// @NoTx (system caller) — every write is scoped by the resolved tenant_id explicitly (RLS is bypassed here).
@Injectable()
export class LineWebhookService {
  private readonly logger = new Logger('LineWebhook');
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly tenantMsg: TenantMessagingService,
  ) {}

  async handle(tenantCode: string, rawBody: Buffer | undefined, signature: string | undefined, parsed: any) {
    const db = this.db;
    const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, tenantCode)).limit(1);
    if (!t) throw new UnauthorizedException({ code: 'UNKNOWN_TENANT', message: 'Unknown shop code', messageTh: 'ไม่พบรหัสร้าน' });
    const tenantId = Number(t.id);

    const creds = await this.tenantMsg.resolveCreds(tenantId, 'line');
    const secret = creds?.secret as string | undefined;
    const body = this.verify(secret, rawBody, signature, parsed);

    let followed = 0, unfollowed = 0;
    for (const ev of body?.events ?? []) {
      const userId = ev?.source?.userId;
      if (!userId) continue;
      if (ev.type === 'follow') { await this.onFollow(tenantId, userId); followed++; }
      else if (ev.type === 'unfollow') { await this.onUnfollow(tenantId, userId); unfollowed++; }
    }
    return { received: true, followed, unfollowed };
  }

  // Verify the LINE signature over the RAW body when a Channel Secret is configured (fail closed on a bad/
  // missing signature). No secret: reject in prod (cannot authenticate), accept the parsed body in dev/test.
  private verify(secret: string | undefined, rawBody: Buffer | undefined, signature: string | undefined, parsed: any) {
    if (secret) {
      const expected = createHmac('sha256', secret).update(rawBody ?? Buffer.from('')).digest('base64');
      if (!signature || !safeEqualStr(expected, signature)) {
        throw new UnauthorizedException({ code: 'BAD_WEBHOOK_SIGNATURE', message: 'Invalid LINE signature', messageTh: 'ลายเซ็น webhook ไม่ถูกต้อง' });
      }
      try { return JSON.parse((rawBody ?? Buffer.from('{}')).toString('utf8')); } catch { return parsed ?? {}; }
    }
    const env = process.env.NODE_ENV;
    if (env !== 'development' && env !== 'test') {
      throw new UnauthorizedException({ code: 'WEBHOOK_UNVERIFIED', message: 'LINE channel secret not configured', messageTh: 'ยังไม่ได้ตั้งค่ารหัสยืนยัน webhook' });
    }
    this.logger.warn(`LINE webhook accepted UNVERIFIED for tenant (no channel secret; dev/test only)`);
    return parsed ?? {};
  }

  // Following the OA auto-enrols (or re-activates) a member keyed by the LINE userId — so a walk-in who adds
  // the OA becomes a reachable member. Idempotent + tenant-scoped; logs a follow event for auditing.
  private async onFollow(tenantId: number, lineUserId: string) {
    const db = this.db;
    const [existing] = await db.select().from(posMembers).where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.lineUserId, lineUserId))).limit(1);
    if (existing) {
      if (existing.active === false) await db.update(posMembers).set({ active: true, lastUpdated: new Date() }).where(eq(posMembers.id, existing.id));
    } else {
      try {
        const [row] = await db.insert(posMembers).values({
          tenantId, memberCode: 'M-TMP', lineUserId, marketingOptIn: true, active: true,
          balance: '0', lifetime: '0', createdBy: 'system:line-follow',
        }).returning();
        await db.update(posMembers).set({ memberCode: `M-${String(row!.id).padStart(6, '0')}` }).where(eq(posMembers.id, row!.id));
      } catch (e: any) { if (!isUniqueViolation(e)) throw e; /* raced another follow → fine */ }
    }
    await this.log(tenantId, lineUserId, 'follow');
  }

  // Unfollowing is recorded (for follower analytics) but does NOT deactivate the member or touch their points
  // — membership and points outlive the OA relationship; they simply become unreachable over LINE.
  private async onUnfollow(tenantId: number, lineUserId: string) {
    await this.log(tenantId, lineUserId, 'unfollow');
  }

  private async log(tenantId: number, recipient: string, kind: 'follow' | 'unfollow') {
    const db = this.db;
    try {
      await db.insert(messageLog).values({ tenantId, memberId: null, channel: 'line', recipient, body: `[oa:${kind}]`, campaign: `oa_${kind}`, status: 'received', provider: 'line', createdBy: 'system:line-webhook' });
    } catch { /* audit best-effort */ }
  }
}

@Controller('api/line')
export class LineWebhookController {
  constructor(private readonly svc: LineWebhookService) {}

  @Public()
  @NoTx()
  @Post('webhook/:tenantCode')
  webhook(
    @Param('tenantCode') tenantCode: string,
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Headers('x-line-signature') signature: string | undefined,
  ) {
    return this.svc.handle(tenantCode, req.rawBody, signature, (req as any).body);
  }
}
