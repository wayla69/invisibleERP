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

export type GatewayName = 'mock' | 'promptpay' | 'stripe';

// Resolve a gateway by name. Stripe only available when STRIPE_SECRET_KEY env is set.
export function resolveGateway(name?: string): { gateway: PaymentGateway; name: GatewayName } {
  const key = (name ?? 'mock').toLowerCase();
  if (key === 'promptpay') return { gateway: new PromptPayGateway(), name: 'promptpay' };
  if (key === 'stripe') {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (secret) return { gateway: new StripeGateway(secret), name: 'stripe' };
    // fall back to mock when Stripe isn't configured
    return { gateway: new MockGateway(), name: 'mock' };
  }
  return { gateway: new MockGateway(), name: 'mock' };
}
