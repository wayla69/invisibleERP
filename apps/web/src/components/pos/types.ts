// Shared types for the touch POS register (menu grid + cart + checkout).
// Mirrors the API shapes from `GET /api/menu`, `GET /api/menu/items/:sku`, `POST /api/menu/resolve`.

export interface MenuItem {
  id: number;
  sku: string;
  name: string;
  name_en: string | null;
  category_id?: number | null;
  type: string; // food | drink | retail | combo
  price: number;
  station_code?: string;
  is_available: boolean;   // 86 flag
  available_now: boolean;  // server-computed day-parting (Asia/Bangkok)
  has_modifiers?: boolean;
  image_url?: string | null;
}

export interface MenuCategory {
  id: number;
  code: string;
  name: string;
  name_en: string | null;
  color: string | null;
  sort: number;
  items: MenuItem[];
}

export interface MenuResp {
  categories: MenuCategory[];
  uncategorized: MenuItem[];
  item_count: number;
}

export interface CartModifier { option_id: number; label: string; price_delta: number }

export interface CartLine {
  key: string;            // client-side row id
  item_id: number;        // menu item id
  sku: string;
  name: string;
  unit_price: number;     // includes modifier deltas
  qty: number;
  discount_pct: number;
  station_code?: string;
  modifier_option_ids?: number[];
  modifiers?: CartModifier[];
  notes?: string;
}

/** A line's net amount after its per-line discount. */
export function lineAmount(l: CartLine): number {
  return Math.round(l.qty * l.unit_price * (1 - (l.discount_pct || 0) / 100) * 100) / 100;
}

/** An item is sellable right now when it is not 86'd and inside its day-part window. */
export function sellable(it: MenuItem): boolean {
  return it.is_available !== false && it.available_now !== false;
}
