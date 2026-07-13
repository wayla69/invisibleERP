// docs/46 Phase 4c cut 1 — the Stripe adapter, moved VERBATIM out of billing.service.ts. Previously
// instantiated ad-hoc (`new StripeBilling()`) at three call sites; BillingService now holds ONE instance
// (ctor-body field) and hands it to the metering sub-service, so tests can stub a single seam.
/**
 * Stripe billing adapter. Without STRIPE_SECRET_KEY it returns a mock checkout URL so the SaaS flow is
 * fully testable offline. With a key set, it calls the real Stripe SDK (dynamic import — never hard-require
 * 'stripe' at module load, so a deploy without billing configured still boots).
 */
export class StripeBilling {
  private readonly secret = process.env.STRIPE_SECRET_KEY;
  get enabled(): boolean { return !!this.secret; }

  async createCheckoutSession(
    plan: { code: string; name: string; amount: number; currency: string; interval: 'monthly' | 'annual' },
    tenant: { id: number; code: string; existingCustomerId?: string | null },
  ): Promise<{ url: string; mock: boolean; customerId?: string; sessionId?: string }> {
    if (!this.secret) {
      return { url: `https://billing.example/checkout/${plan.code}`, mock: true };
    }
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(this.secret);
    const customerId =
      tenant.existingCustomerId ??
      (await stripe.customers.create({ name: tenant.code, metadata: { tenant_id: String(tenant.id), tenant_code: tenant.code } })).id;
    const appBase = process.env.APP_BASE_URL ?? 'http://localhost:3000';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: String(tenant.id),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: (plan.currency ?? 'THB').toLowerCase(),
            recurring: { interval: plan.interval === 'annual' ? 'year' : 'month' }, // 1.7 — annual billing
            unit_amount: Math.round(Number(plan.amount) * 100), // smallest currency unit
            product_data: { name: `Oshinei ERP — ${plan.name}` },
          },
        },
      ],
      metadata: { tenant_id: String(tenant.id), plan_code: plan.code, billing_interval: plan.interval },
      success_url: process.env.STRIPE_SUCCESS_URL ?? `${appBase}/settings/billing?status=success`,
      cancel_url: process.env.STRIPE_CANCEL_URL ?? `${appBase}/settings/billing?status=cancel`,
    });
    return { url: session.url ?? `${appBase}/settings/billing`, mock: false, customerId, sessionId: session.id };
  }

  // Append a one-off invoice ITEM for metered AI overage to the customer's next subscription invoice. Stripe
  // attaches a pending invoice item to the customer's upcoming invoice automatically. Without a key (or with
  // no customer) it's a no-op mock so the monthly job is fully testable offline. The idempotencyKey is a
  // second guard (alongside the DB UNIQUE(tenant, month)) so a retried run never double-charges.
  async createOverageInvoiceItem(
    customerId: string | null,
    amountTHB: number,
    description: string,
    idempotencyKey: string,
  ): Promise<{ id: string | null; mock: boolean }> {
    if (!this.secret || !customerId || amountTHB <= 0) return { id: null, mock: true };
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(this.secret);
    const item = await stripe.invoiceItems.create(
      { customer: customerId, amount: Math.round(amountTHB * 100), currency: 'thb', description },
      { idempotencyKey },
    );
    return { id: item.id, mock: false };
  }
}
