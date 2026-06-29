// Cart helpers shared by the register page, cart panel, and checkout panel.
import type { CartLine } from './types';
import { lineAmount } from './types';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Menu prices are VAT-exclusive (net) — VAT is added on top, matching the portal POS and the server's
// checkout/receipt (subtotal + 7% = total). The cart figures are an on-screen estimate; the settled
// amount returned by checkout is authoritative.
export const VAT_RATE = 0.07;

let seq = 0;
/** Generate a unique client-side cart-line key. */
export function newLineKey(): string { seq += 1; return `ln-${Date.now().toString(36)}-${seq}`; }

/** Net subtotal across cart lines (after each line's own discount). */
export function cartSubtotal(lines: CartLine[]): number {
  return round2(lines.reduce((a, l) => a + lineAmount(l), 0));
}

/**
 * Net / service-charge / VAT / gross totals for the cart, after an optional order-level percentage discount
 * and an optional service-charge percentage. Mirrors the server's buildSale order of operations: service
 * charge is applied to the discounted net and is itself VATable (VAT on net + service charge). The cart
 * figures are an on-screen estimate; the settled amount returned by checkout is authoritative.
 */
export function cartTotals(lines: CartLine[], discountPct = 0, serviceChargePct = 0): { sub: number; discount: number; net: number; serviceCharge: number; vat: number; total: number } {
  const sub = cartSubtotal(lines);
  const discount = round2(sub * (discountPct || 0) / 100);
  const net = round2(sub - discount);
  const serviceCharge = round2(net * (serviceChargePct || 0) / 100);
  const vat = round2((net + serviceCharge) * VAT_RATE);
  return { sub, discount, net, serviceCharge, vat, total: round2(net + serviceCharge + vat) };
}

/** Merge an added item into the cart: bump qty if the same sku+modifiers row exists, else append. */
export function addLine(lines: CartLine[], line: CartLine): CartLine[] {
  const sig = (l: CartLine) => `${l.sku}|${(l.modifier_option_ids ?? []).slice().sort((a, b) => a - b).join(',')}`;
  const idx = lines.findIndex((l) => sig(l) === sig(line));
  if (idx >= 0) return lines.map((l, j) => (j === idx ? { ...l, qty: l.qty + line.qty } : l));
  return [...lines, line];
}
