import { Controller, Post, Req, Body, Headers, Logger, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public, NoTx } from '../../common/decorators';
import { BillingService } from './billing.service';

// Stripe webhook — no JWT. Authenticity is the Stripe signature (HMAC over the RAW body) verified with
// STRIPE_WEBHOOK_SECRET. This is the source of truth for subscription activation/renewal/cancellation, so
// it must be authenticated. Mirrors the PSP-callback controller: @NoTx (system caller, not tenant-scoped;
// applyStripeEvent scopes every write by tenant_id), fail-closed in prod, parse-only in dev/test for local
// mock flows.
@Controller('api/billing/stripe')
export class StripeWebhookController {
  private readonly logger = new Logger('StripeWebhook');
  constructor(private readonly billing: BillingService) {}

  @Public()
  @NoTx()
  @Post('webhook')
  async webhook(
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Headers('stripe-signature') signature: string | undefined,
    @Body() body: any,
  ): Promise<{ received: true; handled: boolean; tenant_id?: number; status?: string }> {
    const event = await this.verifyAndParse(req.rawBody, signature, body);
    const res = await this.billing.applyStripeEvent(event);
    return { received: true, ...res };
  }

  // Verify the Stripe signature over the RAW body when STRIPE_WEBHOOK_SECRET is set (fail closed on a bad/
  // missing signature; prod runs with rawBody:true so the exact bytes are available). When no secret is
  // configured: reject in production (cannot authenticate the caller), but accept the already-parsed JSON
  // body in dev/test so local/mock webhooks work — mirroring the PSP webhook gate.
  private async verifyAndParse(rawBody: Buffer | undefined, signature: string | undefined, parsedBody: any): Promise<{ type?: string; data?: { object?: any } }> {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (secret) {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? 'sk_unused');
      try {
        return stripe.webhooks.constructEvent(rawBody ?? Buffer.from(''), signature ?? '', secret);
      } catch {
        throw new UnauthorizedException({ code: 'BAD_WEBHOOK_SIGNATURE', message: 'Invalid Stripe webhook signature', messageTh: 'ลายเซ็น webhook ไม่ถูกต้อง' });
      }
    }
    const env = process.env.NODE_ENV;
    if (env !== 'development' && env !== 'test') {
      throw new UnauthorizedException({ code: 'WEBHOOK_UNVERIFIED', message: 'Stripe webhook secret not configured', messageTh: 'ยังไม่ได้ตั้งค่ารหัสยืนยัน webhook' });
    }
    this.logger.warn('Stripe webhook accepted UNVERIFIED (no STRIPE_WEBHOOK_SECRET; dev/test only)');
    return parsedBody ?? {};
  }
}
