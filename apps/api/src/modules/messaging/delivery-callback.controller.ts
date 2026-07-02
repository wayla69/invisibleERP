import { Controller, Post, Param, Body, Headers, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants } from '../../database/schema';
import { safeEqualStr } from '../../common/crypto';
import { Public, NoTx } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MessagingService } from './messaging.service';
import { TenantMessagingService } from './tenant-messaging.service';

// Inbound delivery-status callback (Phase E2). A messaging provider (SMS/LINE/email) POSTs the final state of
// a message it previously accepted, identified by the provider_ref we stored on send. Public + no JWT: the
// URL carries the shop code and the caller proves itself with the tenant's per-channel Callback token
// (`X-Callback-Token` compared constant-time to the `callbackToken` in that channel's creds). @NoTx —
// every write is scoped by the resolved tenant_id explicitly.
const CallbackBody = z.object({ channel: z.enum(['line', 'sms', 'email']), ref: z.string().min(1), status: z.string().min(1), error: z.string().optional() });

@Injectable()
export class DeliveryCallbackService {
  private readonly logger = new Logger('DeliveryCallback');
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly messaging: MessagingService,
    private readonly tenantMsg: TenantMessagingService,
  ) {}

  async handle(tenantCode: string, token: string | undefined, dto: z.infer<typeof CallbackBody>) {
    const db = this.db as any;
    const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, tenantCode)).limit(1);
    if (!t) throw new UnauthorizedException({ code: 'UNKNOWN_TENANT', message: 'Unknown shop code', messageTh: 'ไม่พบรหัสร้าน' });
    const tenantId = Number(t.id);

    const creds = await this.tenantMsg.resolveCreds(tenantId, dto.channel);
    const expected = creds?.callbackToken as string | undefined;
    if (expected) {
      if (!token || !safeEqualStr(expected, token)) throw new UnauthorizedException({ code: 'BAD_CALLBACK_TOKEN', message: 'Invalid callback token', messageTh: 'โทเคน callback ไม่ถูกต้อง' });
    } else {
      const env = process.env.NODE_ENV;
      if (env !== 'development' && env !== 'test') throw new UnauthorizedException({ code: 'CALLBACK_UNVERIFIED', message: 'No callback token configured for this channel', messageTh: 'ยังไม่ได้ตั้งค่าโทเคน callback' });
      this.logger.warn(`delivery callback accepted UNVERIFIED for tenant ${tenantId}/${dto.channel} (no callbackToken; dev/test only)`);
    }
    return this.messaging.applyDeliveryStatus(tenantId, dto.channel, dto.ref, dto.status, dto.error);
  }
}

@Controller('api/messaging')
export class DeliveryCallbackController {
  constructor(private readonly svc: DeliveryCallbackService) {}

  @Public()
  @NoTx()
  @Post('delivery-callback/:tenantCode')
  callback(
    @Param('tenantCode') tenantCode: string,
    @Headers('x-callback-token') token: string | undefined,
    @Body(new ZodValidationPipe(CallbackBody)) b: z.infer<typeof CallbackBody>,
  ) {
    return this.svc.handle(tenantCode, token, b);
  }
}
