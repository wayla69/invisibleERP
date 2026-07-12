// Per-platform payload → internal normalized order. Each aggregator has its own JSON; we read the
// documented field with tolerant fallbacks so a real payload (or a sandbox sim) both work.
export interface NormalizedLine { name: string; qty: number; unit_price: number }
export interface NormalizedOrder {
  extOrderId?: string; extEventId?: string; storeRef?: string; customerName?: string;
  // G1 (MKT-13): the platform's STABLE buyer identifier (opaque customer/eater id, else phone) — hashed at
  // the ingest edge (channel-customer-refs.service) so repeat marketplace buyers accrue to one profile.
  extCustomerRef?: string;
  deliveryFee: number; lines: NormalizedLine[]; raw: any;
}

const num = (x: any) => Number(x) || 0;

export function normalizeAggregatorPayload(platform: string, p: any): NormalizedOrder {
  const base = { raw: p, deliveryFee: 0, lines: [] as NormalizedLine[] };
  switch (platform) {
    case 'grab': {
      const items = p.items ?? p.order?.items ?? [];
      return { ...base, extOrderId: str(p.orderID ?? p.order_id ?? p.id), extEventId: str(p.eventID ?? p.event_id), storeRef: str(p.merchantID ?? p.store_ref ?? p.merchant_id), customerName: str(p.eater?.name ?? p.customer_name), extCustomerRef: str(p.eater?.id ?? p.eaterID ?? p.eater_id ?? p.customer_id ?? p.eater?.phone), deliveryFee: num(p.deliveryFee ?? p.delivery_fee), lines: items.map((i: any) => ({ name: str(i.name ?? i.itemName), qty: num(i.quantity ?? i.qty ?? 1), unit_price: num(i.price ?? i.unit_price ?? i.fare) })) };
    }
    case 'lineman': {
      const items = p.items ?? p.order_items ?? [];
      return { ...base, extOrderId: str(p.order_id ?? p.orderId ?? p.id), extEventId: str(p.event_id ?? p.eventId), storeRef: str(p.branch_id ?? p.store_ref ?? p.shop_id), customerName: str(p.customer?.name ?? p.customer_name), extCustomerRef: str(p.customer?.id ?? p.customer_id ?? p.customer?.phone ?? p.customer_phone), deliveryFee: num(p.delivery_fee), lines: items.map((i: any) => ({ name: str(i.name ?? i.menu_name), qty: num(i.qty ?? i.quantity ?? 1), unit_price: num(i.unit_price ?? i.price) })) };
    }
    case 'foodpanda':
    case 'robinhood':
    default: {
      const items = p.items ?? p.products ?? [];
      return { ...base, extOrderId: str(p.order_id ?? p.token ?? p.id), extEventId: str(p.event_id ?? p.notification_id), storeRef: str(p.vendor_id ?? p.store_ref ?? p.outlet_id), customerName: str(p.customer?.name ?? p.customer_name), extCustomerRef: str(p.customer?.id ?? p.customer_id ?? p.buyer_id ?? p.customer?.phone ?? p.customer_phone), deliveryFee: num(p.delivery_fee ?? p.deliveryFee), lines: items.map((i: any) => ({ name: str(i.name ?? i.product_name), qty: num(i.quantity ?? i.qty ?? 1), unit_price: num(i.price ?? i.unit_price ?? i.paid_price) })) };
    }
  }
}

function str(x: any): string | undefined { return x == null ? undefined : String(x); }
