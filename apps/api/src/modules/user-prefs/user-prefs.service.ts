import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { userPrefs } from '../../database/schema/user-prefs';
import type { JwtUser } from '../../common/decorators';

// Shape of the synced preferences blob. Kept deliberately small and forward-compatible.
export interface UserPrefs {
  favorites: string[]; // sidebar ★ pins (hrefs), order = display order
  navFold: Record<string, boolean>; // nav sub-section title → open?
  pos_fav: number[]; // POS menu-item id quick-access list (B2 favourites grid)
}

const MAX_FAVORITES = 100;
const MAX_FOLD_KEYS = 100;
const MAX_POS_FAV = 200;

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
  return { favorites, navFold, pos_fav };
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
    });
    if (row) {
      await db.update(userPrefs).set({ prefs: merged, updatedAt: new Date() }).where(eq(userPrefs.id, row.id));
    } else {
      await db.insert(userPrefs).values({ tenantId: user.tenantId ?? null, owner: user.username, prefs: merged });
    }
    return { ...merged, saved: true };
  }
}
