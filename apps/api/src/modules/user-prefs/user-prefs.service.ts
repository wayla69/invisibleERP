import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { userPrefs } from '../../database/schema/user-prefs';
import type { JwtUser } from '../../common/decorators';

// A saved /shop basket template (รายการประจำ) — a named recurring basket, synced across devices.
export interface ShopTemplate { name: string; lines: { item_id: string; description: string; uom: string; qty: number }[] }

// Shape of the synced preferences blob. Kept deliberately small and forward-compatible.
export interface UserPrefs {
  favorites: string[]; // sidebar ★ pins (hrefs), order = display order
  navFold: Record<string, boolean>; // nav sub-section title → open?
  pos_fav: number[]; // POS menu-item id quick-access list (B2 favourites grid)
  shop_favs: string[]; // /shop favourite item_ids (★ on a catalog card)
  shop_templates: ShopTemplate[]; // /shop saved basket templates (รายการประจำ)
  sme_wizard_done: boolean; // docs/49 v1.3 — the SME first-run setup wizard was completed/dismissed (don't nag again)
}

const MAX_FAVORITES = 100;
const MAX_FOLD_KEYS = 100;
const MAX_POS_FAV = 200;
const MAX_SHOP_FAVS = 300;
const MAX_SHOP_TEMPLATES = 50;
const MAX_TEMPLATE_LINES = 200;

// Normalise one saved basket template — drops junk lines, caps size. Returns null for an unusable entry.
function normTemplate(raw: unknown): ShopTemplate | null {
  const v = (raw ?? {}) as Record<string, unknown>;
  const name = typeof v.name === 'string' ? v.name.trim().slice(0, 120) : '';
  if (!name || !Array.isArray(v.lines)) return null;
  const lines = v.lines
    .map((l) => {
      const o = (l ?? {}) as Record<string, unknown>;
      const item_id = typeof o.item_id === 'string' ? o.item_id.slice(0, 200) : '';
      if (!item_id) return null;
      return {
        item_id,
        description: typeof o.description === 'string' ? o.description.slice(0, 500) : '',
        uom: typeof o.uom === 'string' ? o.uom.slice(0, 40) : '',
        qty: typeof o.qty === 'number' && o.qty > 0 ? Math.floor(o.qty) : 1,
      };
    })
    .filter((x): x is ShopTemplate['lines'][number] => x != null)
    .slice(0, MAX_TEMPLATE_LINES);
  return { name, lines };
}

// Normalise an arbitrary stored/incoming value into a clean UserPrefs (drops junk, caps sizes, dedupes).
function normalize(raw: unknown): UserPrefs {
  const v = (raw ?? {}) as Record<string, unknown>;
  const favorites = Array.isArray(v.favorites)
    ? Array.from(new Set(v.favorites.filter((x): x is string => typeof x === 'string'))).slice(0, MAX_FAVORITES)
    : [];
  const navFold: Record<string, boolean> = {};
  if (v.navFold && typeof v.navFold === 'object') {
    for (const [k, val] of Object.entries(v.navFold as Record<string, unknown>)) {
      if (typeof val === 'boolean' && Object.keys(navFold).length < MAX_FOLD_KEYS) navFold[k] = val;
    }
  }
  const pos_fav = Array.isArray(v.pos_fav)
    ? Array.from(new Set(v.pos_fav.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0))).slice(0, MAX_POS_FAV)
    : [];
  const shop_favs = Array.isArray(v.shop_favs)
    ? Array.from(new Set(v.shop_favs.filter((x): x is string => typeof x === 'string' && !!x))).slice(0, MAX_SHOP_FAVS)
    : [];
  // Templates: normalise each, drop nulls, and keep the last occurrence per name (dedupe by name).
  const byName = new Map<string, ShopTemplate>();
  if (Array.isArray(v.shop_templates)) {
    for (const raw2 of v.shop_templates) { const t = normTemplate(raw2); if (t) byName.set(t.name, t); }
  }
  const shop_templates = [...byName.values()].slice(0, MAX_SHOP_TEMPLATES);
  const sme_wizard_done = v.sme_wizard_done === true;
  return { favorites, navFold, pos_fav, shop_favs, shop_templates, sme_wizard_done };
}

// Per-user UI preferences (sidebar favourites + nav fold-state). Personal: every query is scoped to the
// caller's username, and tenant isolation is enforced by RLS on top. A PUT merges by top-level key so the
// web can patch just `favorites` or just `navFold` without clobbering the other.
@Injectable()
export class UserPrefsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async row(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(userPrefs).where(eq(userPrefs.owner, user.username)).limit(1);
    return rows[0] as { id: number; prefs: unknown } | undefined;
  }

  async get(user: JwtUser): Promise<UserPrefs & { saved: boolean }> {
    const row = await this.row(user);
    return { ...normalize(row?.prefs), saved: !!row };
  }

  async update(patch: Partial<UserPrefs>, user: JwtUser): Promise<UserPrefs & { saved: boolean }> {
    const db = this.db;
    const row = await this.row(user);
    const current = normalize(row?.prefs);
    const merged = normalize({
      favorites: patch.favorites ?? current.favorites,
      navFold: patch.navFold ? { ...current.navFold, ...patch.navFold } : current.navFold,
      pos_fav: patch.pos_fav ?? current.pos_fav,
      shop_favs: patch.shop_favs ?? current.shop_favs,
      shop_templates: patch.shop_templates ?? current.shop_templates,
      sme_wizard_done: patch.sme_wizard_done ?? current.sme_wizard_done,
    });
    if (row) {
      await db.update(userPrefs).set({ prefs: merged, updatedAt: new Date() }).where(eq(userPrefs.id, row.id));
    } else {
      await db.insert(userPrefs).values({ tenantId: user.tenantId ?? null, owner: user.username, prefs: merged });
    }
    return { ...merged, saved: true };
  }
}
