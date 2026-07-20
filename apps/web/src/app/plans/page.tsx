// Public plans & pricing page — the prospect-facing buying-experience surface (no session required,
// like /legal/privacy). Server shell only: all interactivity + t() live in the client island.
import { PricingClient } from './pricing-client';

export const metadata = { title: 'แพ็กเกจและราคา / Plans & Pricing — Invisible ERP' };

export default function PricingPage() {
  return <PricingClient />;
}
