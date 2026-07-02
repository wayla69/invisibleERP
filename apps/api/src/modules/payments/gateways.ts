// Payment gateway abstraction — select by `gateway` field (default 'mock').
// Each gateway proves money moved: authorizeAndCapture returns a ref + final status.

import { BadRequestException } from '@nestjs/common';
import { buildPromptPayPayload } from './promptpay-qr';
import { OmiseProvider } from '../pos/terminal/providers';

export interface GatewayResult {
  ref: string;
  status: 'Captured' | 'Authorized' | 'Pending' | 'Failed';
}

export interface PaymentGateway {
  authorizeAndCapture(
    amount: number,
    currency: string,
    method: string,
    meta?: Record<string, unknown>,
  ): Promise<GatewayResult>;
}

const rnd = () => Math.random().toString(36).slice(2, 12);

// Always captures — used for dev/tests and as the default tender path.
export class MockGateway implements PaymentGateway {
  async authorizeAndCapture(): Promise<GatewayResult> {
    return { ref: 'mock_' + rnd(), status: 'Captured' };
  }
}

// PromptPay (TH QR) — QR is settled asynchronously by the payer. Return the QR payload as the
// ref and mark the tender 'Pending' until a settlement webhook flips it to Captured. Reporting
// Captured up-front would book funds that have not actually moved.
export class PromptPayGateway implements PaymentGateway {
  async authorizeAndCapture(amount: number, _currency: string, _method: string, meta?: Record<string, unknown>): Promise<GatewayResult> {
    // When the merchant's PromptPay ID is supplied (from tenant config), emit a REAL scannable EMVCo QR
    // as the ref. Otherwise fall back to the placeholder so existing flows keep working.
    const ppId = (meta?.promptpay_id ?? meta?.promptPayId) as string | undefined;
    const ref = ppId ? buildPromptPayPayload(ppId, amount) : 'promptpay_' + amount;
    return { ref, status: 'Pending' };
  }
}

// Stripe — real PaymentIntents create+confirm. A card needs a payment-method token from the client
// (threaded via meta.token); without one we cannot charge, so we report Pending (NOT a fake capture).
export class StripeGateway implements PaymentGateway {
  constructor(private readonly secretKey: string) {}

  async authorizeAndCapture(amount: number, currency: string, _method: string, meta?: Record<string, unknown>): Promise<GatewayResult> {
    if (!this.secretKey) return { ref: 'stripe_unconfigured', status: 'Failed' };
    const token = (meta?.token ?? meta?.payment_method) as string | undefined;
    if (!token) return { ref: `stripe_pending_${meta?.sale_no ?? amount}`, status: 'Pending' };
    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: String(minorUnits(amount, currency)), currency: (currency || 'THB').toLowerCase(), payment_method: token, confirm: 'true', 'automatic_payment_methods[enabled]': 'true', 'automatic_payment_methods[allow_redirects]': 'never' }),
    });
    const pi: any = await res.json().catch(() => ({}));
    if (!res.ok || pi.error) throw new BadRequestException({ code: 'PSP_ERROR', message: pi.error?.message ?? `Stripe error ${res.status}`, messageTh: 'การชำระเงินผิดพลาด' });
    return { ref: pi.id, status: mapStripe(pi.status) };
  }
}

// Opn Payments (formerly Omise) — Thailand's most common PSP aggregator. ONE integration unlocks cards
// (chip/contactless), Thai e-wallets (TrueMoney / Rabbit LINE Pay / ShopeePay) and cross-border tourist
// wallets (Alipay+ / WeChat Pay) through a single charge API. Constructed only when OPN_SECRET_KEY is set;
// otherwise resolveGateway falls back to mock.
//
// A card tender carries a token/source from the terminal SDK (meta.token) and is charged for real via the
// shared OmiseProvider — capturing synchronously (→ Captured) per the PSP's authoritative response. A
// tender with no token cannot be charged here, so it stays Pending (settled out-of-band) — we NEVER
// report Captured for money that has not actually moved.
export class OpnGateway implements PaymentGateway {
  private readonly omise: OmiseProvider;
  constructor(secretKey: string) { this.omise = new OmiseProvider(secretKey); }

  async authorizeAndCapture(amount: number, currency: string, method: string, meta?: Record<string, unknown>): Promise<GatewayResult> {
    const token = (meta?.token ?? meta?.source) as string | undefined;
    if (!token) {
      // No token to charge against → await an out-of-band settlement; do not fabricate a capture.
      return { ref: `opn_pending_${meta?.sale_no ?? amount}`, status: 'Pending' };
    }
    // Real charge through the proven Omise client (handles satang, basic-auth, status mapping). Card
    // tenders capture immediately; the PSP itself returns Pending for an async wallet/QR source.
    const { ref, status } = await this.omise.charge({ amount, currency: currency || 'THB', type: 'sale', token, intentNo: String(meta?.sale_no ?? '') });
    return { ref, status };
  }
}

// Minor-currency units. Most currencies are 2-decimal (satang/cents ×100); JPY/KRW are zero-decimal.
function minorUnits(amount: number, currency: string): number {
  const zeroDecimal = /^(JPY|KRW|VND|CLP|ISK)$/i.test(currency || '');
  return Math.round(amount * (zeroDecimal ? 1 : 100));
}
function mapStripe(status: string): GatewayResult['status'] {
  if (status === 'succeeded') return 'Captured';
  if (status === 'requires_capture') return 'Authorized';
  if (status === 'processing' || status === 'requires_action' || status === 'requires_confirmation') return 'Pending';
  return 'Failed';
}

export type GatewayName = 'mock' | 'promptpay' | 'stripe' | 'opn';

// Resolve a gateway by name. Stripe/Opn are only available when their secret-key env is set; absent that,
// they fall back to the mock so the tender path keeps working in dev/test.
export function resolveGateway(name?: string): { gateway: PaymentGateway; name: GatewayName } {
  const key = (name ?? 'mock').toLowerCase();
  if (key === 'promptpay') return { gateway: new PromptPayGateway(), name: 'promptpay' };
  if (key === 'stripe') {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (secret) return { gateway: new StripeGateway(secret), name: 'stripe' };
    return { gateway: new MockGateway(), name: 'mock' };
  }
  if (key === 'opn') {
    const secret = process.env.OPN_SECRET_KEY;
    if (secret) return { gateway: new OpnGateway(secret), name: 'opn' };
    return { gateway: new MockGateway(), name: 'mock' };
  }
  return { gateway: new MockGateway(), name: 'mock' };
}
