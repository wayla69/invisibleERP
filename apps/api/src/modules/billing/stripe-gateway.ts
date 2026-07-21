// docs/46 Phase 4c cut 1 — the Stripe adapter, moved VERBATIM out of billing.service.ts. Previously
// instantiated ad-hoc (`new StripeBilling()`) at three call sites; BillingService now holds ONE instance
// (ctor-body field) and hands it to the metering sub-service, so tests can stub a single seam.
/**
 * Stripe billing adapter. Without STRIPE_SECRET_KEY it returns a mock checkout URL so the SaaS flow is
 * fully testable offline. With a key set, it calls the real Stripe SDK (dynamic import — never hard-require
 * 'stripe' at module load, so a deploy without billing configured still boots).
 */
// Type-only import — erased at compile time, so the runtime keeps its lazy dynamic import (a deploy
// without billing configured still boots without the stripe package loaded).
import type Stripe from 'stripe';

export class StripeBilling {
  private readonly secret = process.env.STRIPE_SECRET_KEY;
  get enabled(): boolean { return !!this.secret; }

  async createCheckoutSession(
    plan: { code: string; name: string; amount: number; currency: string; interval: 'monthly' | 'annual' },
    tenant: { id: number; code: string; existingCustomerId?: string | null },
    // A3 — à-la-carte add-ons ride the SAME subscription as extra recurring line items (amount already
    // interval-scaled by the caller); their keys travel in metadata so the webhook can stamp entitlement.
    addons: { key: string; name: string; amount: number }[] = [],
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
            product_data: { name: `Invisible ERP — ${plan.name}` },
          },
        },
        ...addons.map((a) => ({
          quantity: 1,
          price_data: {
            currency: (plan.currency ?? 'THB').toLowerCase(),
            recurring: { interval: plan.interval === 'annual' ? ('year' as const) : ('month' as const) },
            unit_amount: Math.round(Number(a.amount) * 100),
            product_data: { name: `Invisible ERP add-on — ${a.name}` },
          },
        })),
      ],
      metadata: { tenant_id: String(tenant.id), plan_code: plan.code, billing_interval: plan.interval, addons: addons.map((a) => a.key).join(',') },
      success_url: process.env.STRIPE_SUCCESS_URL ?? `${appBase}/settings/billing?status=success`,
      cancel_url: process.env.STRIPE_CANCEL_URL ?? `${appBase}/settings/billing?status=cancel`,
    });
    return { url: session.url ?? `${appBase}/settings/billing`, mock: false, customerId, sessionId: session.id };
  }

  // A3 — reconcile a LIVE subscription's add-on line items to the desired set (self-serve mid-cycle
  // add/remove). Add-on items are identified by their item metadata.addon_key; Stripe's default
  // proration_behavior (create_prorations) handles mid-cycle fairness in both directions. Without a key
  // or a subscription id it's a no-op mock (entitlement-only mode) so dev/harness stay offline.
  async syncAddonItems(
    subscriptionId: string | null,
    desired: { key: string; name: string; amount: number }[],
    interval: 'monthly' | 'annual',
    currency = 'THB',
  ): Promise<{ added: number; removed: number; mock: boolean }> {
    if (!this.secret || !subscriptionId) return { added: 0, removed: 0, mock: true };
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(this.secret);
    const items = await stripe.subscriptionItems.list({ subscription: subscriptionId, limit: 100 });
    const existing = new Map<string, string>(); // addon_key -> item id
    for (const it of items.data) {
      const key = (it.metadata as Record<string, string> | null)?.addon_key;
      if (key) existing.set(key, it.id);
    }
    let added = 0; let removed = 0;
    for (const a of desired) {
      if (existing.has(a.key)) continue;
      await stripe.subscriptionItems.create({
        subscription: subscriptionId,
        quantity: 1,
        metadata: { addon_key: a.key },
        price_data: {
          currency: currency.toLowerCase(),
          recurring: { interval: interval === 'annual' ? 'year' : 'month' },
          unit_amount: Math.round(Number(a.amount) * 100),
          product: await this.addonProductId(stripe, a.name),
        },
      });
      added += 1;
    }
    const want = new Set(desired.map((a) => a.key));
    for (const [key, itemId] of existing) {
      if (want.has(key)) continue;
      await stripe.subscriptionItems.del(itemId);
      removed += 1;
    }
    return { added, removed, mock: false };
  }

  // subscriptionItems.create's price_data requires a PRODUCT id (unlike checkout's product_data) — find or
  // create one per add-on name, cached per process.
  private readonly addonProducts = new Map<string, string>();
  private async addonProductId(stripe: Stripe, name: string): Promise<string> {
    const label = `Invisible ERP add-on — ${name}`;
    const cached = this.addonProducts.get(label);
    if (cached) return cached;
    const found = await stripe.products.search({ query: `name:'${label.replace(/'/g, "\\'")}' AND active:'true'`, limit: 1 });
    const product = found.data[0] ?? (await stripe.products.create({ name: label }));
    this.addonProducts.set(label, product.id);
    return product.id;
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
