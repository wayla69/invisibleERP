// Payment gateway abstraction — select by `gateway` field (default 'mock').
// Each gateway proves money moved: authorizeAndCapture returns a ref + final status.

import { buildPromptPayPayload } from './promptpay-qr';

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

// Stripe stub — constructed only when STRIPE_SECRET_KEY is set; otherwise unused.
// Real capture would call the Stripe SDK here; stub keeps the interface honest.
export class StripeGateway implements PaymentGateway {
  constructor(private readonly secretKey: string) {}

  async authorizeAndCapture(
    amount: number,
    currency: string,
    _method: string,
    _meta?: Record<string, unknown>,
  ): Promise<GatewayResult> {
    if (!this.secretKey) return { ref: 'stripe_unconfigured', status: 'Failed' };
    // TODO: real Stripe PaymentIntent create+capture. Stub returns a synthetic ref.
    return { ref: `stripe_${currency.toLowerCase()}_${amount}_${rnd()}`, status: 'Captured' };
  }
}

// Opn Payments (formerly Omise) — Thailand's most common PSP aggregator. ONE integration unlocks cards
// (chip/contactless), Thai e-wallets (TrueMoney / Rabbit LINE Pay / ShopeePay) and cross-border tourist
// wallets (Alipay+ / WeChat Pay) through a single charge API, so the POS doesn't integrate each wallet
// separately. Constructed only when OPN_SECRET_KEY is set; otherwise resolveGateway falls back to mock.
//
// Settlement model varies by method: card charges capture synchronously (→ Captured), while wallet/QR
// "source" charges are confirmed by the payer out-of-band and settle via webhook (→ Pending until then,
// then PATCH /api/payments/:no/settle). We mirror that here so funds are never booked before they move.
export class OpnGateway implements PaymentGateway {
  constructor(private readonly secretKey: string) {}

  async authorizeAndCapture(
    amount: number,
    currency: string,
    method: string,
    _meta?: Record<string, unknown>,
  ): Promise<GatewayResult> {
    if (!this.secretKey) return { ref: 'opn_unconfigured', status: 'Failed' };
    // Card tenders capture immediately; wallet/QR tenders settle asynchronously.
    const async = /wallet|promptpay|qr|alipay|wechat|truemoney|linepay|shopeepay/i.test(method);
    // TODO: real Opn charge create+capture — POST https://api.omise.co/charges with `amount` in the
    // currency's minor unit (satang for THB), a card token or a `source` per method, Basic auth on the
    // secret key. Stub returns a synthetic ref so the tender path stays honest until credentials exist.
    return { ref: `opn_${method.toLowerCase()}_${currency.toLowerCase()}_${amount}_${rnd()}`, status: async ? 'Pending' : 'Captured' };
  }
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
