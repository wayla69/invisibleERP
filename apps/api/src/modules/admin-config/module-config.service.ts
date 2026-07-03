import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { asc, like, notLike } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { moduleConfigs, navGroupOrder } from '../../database/schema';
import { MODULE_KEYS, ALWAYS_ON_MODULES, type Permission } from '@ierp/shared';

// System-wide module enable/disable (mirrors legacy tbl_module_config). module_key == permission key.
// Global table (no tenant_id → no RLS): a platform-wide switch, faithful to "hides for all".
//
// The same table also stores per-menu VISIBILITY overrides under the `nav:<href>` namespace (added for the
// menu-customization page): an admin can hide an individual sidebar entry (or a whole category, by hiding
// all its hrefs) without disabling the underlying permission/module. These rows are pure navigation
// chrome — the permission guard (disabledSet) only iterates MODULE_KEYS, so a `nav:` row never blocks an
// API route. Menu visibility is a usability control, NOT a security boundary (permissions/modules remain
// the enforced control). Two hrefs can never be hidden, so an admin can't lock themselves out.
const NAV_PREFIX = 'nav:';
const NAV_ALWAYS_VISIBLE = ['/settings', '/admin/users'];
// `nav_group_order` doubles as the menu-ITEM order store: a row keyed `item:<scope>|<href>` (scope = the
// container's i18n title — a group or sub-section) orders items WITHIN that container. Group-order rows use
// the bare group title. The `item:`/bare split keeps both in one table (no extra migration).
const ITEM_PREFIX = 'item:';
const ITEM_SEP = '|';

@Injectable()
export class ModuleConfigService {
  private cache: { at: number; disabled: Set<string> } | null = null;
  private readonly TTL = 5000; // ms — keep the per-request guard read off the hot path

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async loadMap(): Promise<Map<string, boolean>> {
    const db = this.db;
    const rows = await db.select().from(moduleConfigs);
    const m = new Map<string, boolean>();
    for (const r of rows) m.set(String(r.moduleKey), r.enabled === true || String(r.enabled) === 't');
    return m;
  }

  private isAlwaysOn(k: string): boolean {
    return (ALWAYS_ON_MODULES as string[]).includes(k);
  }

  async list() {
    const m = await this.loadMap();
    const modules = MODULE_KEYS.map((k) => ({
      key: k,
      enabled: this.isAlwaysOn(k) ? true : (m.get(k) ?? true),
      always_on: this.isAlwaysOn(k),
    }));
    // Hidden menu entries (nav:<href> overrides set to false). Lockout-critical routes are never hidden.
    const navDisabled: string[] = [];
    for (const [k, v] of m) {
      if (k.startsWith(NAV_PREFIX) && v === false) {
        const href = k.slice(NAV_PREFIX.length);
        if (!NAV_ALWAYS_VISIBLE.includes(href)) navDisabled.push(href);
      }
    }
    const { groupOrder, itemOrder } = await this.loadOrder();
    return { modules, disabled: modules.filter((x) => !x.enabled).map((x) => x.key), navDisabled, groupOrder, itemOrder };
  }

  // Admin-curated sidebar ordering: `groupOrder` = category order (bare group titles); `itemOrder` = per
  // container (group/sub-section title → ordered hrefs). Empty ⇒ clients fall back to nav.ts code order.
  private async loadOrder(): Promise<{ groupOrder: string[]; itemOrder: Record<string, string[]> }> {
    const rows = await this.db.select().from(navGroupOrder).orderBy(asc(navGroupOrder.sortOrder));
    const groupOrder: string[] = [];
    const itemOrder: Record<string, string[]> = {};
    for (const r of rows) {
      const k = String(r.groupKey);
      if (k.startsWith(ITEM_PREFIX)) {
        const rest = k.slice(ITEM_PREFIX.length);
        const sep = rest.indexOf(ITEM_SEP);
        if (sep < 0) continue;
        const scope = rest.slice(0, sep);
        const href = rest.slice(sep + 1);
        (itemOrder[scope] ??= []).push(href);
      } else {
        groupOrder.push(k);
      }
    }
    return { groupOrder, itemOrder };
  }

  // Replace the whole category order with `order` (an ordered list of nav-group i18n keys). Full-replace
  // keeps it idempotent and drops stale keys; presentation-only, never touches permissions/modules. Only
  // the group-order rows are touched — item-order rows (`item:*`) are preserved.
  async setGroupOrder(order: string[], user: { username?: string }) {
    const clean = [...new Set(order.filter((k) => typeof k === 'string' && k.length > 0 && !k.startsWith(ITEM_PREFIX)))];
    const db = this.db;
    const now = new Date();
    await db.delete(navGroupOrder).where(notLike(navGroupOrder.groupKey, `${ITEM_PREFIX}%`));
    if (clean.length > 0) {
      await db.insert(navGroupOrder).values(
        clean.map((groupKey, i) => ({ groupKey, sortOrder: i, updatedAt: now, updatedBy: user.username ?? null })),
      );
    }
    return { groupOrder: clean };
  }

  // Order the menu items WITHIN one container (`scope` = a group or sub-section i18n title); `order` is that
  // container's full list of hrefs. Full-replace for the scope; other scopes + the group order are untouched.
  async setItemOrder(scope: string, order: string[], user: { username?: string }) {
    if (!scope || scope.includes(ITEM_SEP)) return { scope, itemOrder: [] };
    const clean = [...new Set(order.filter((h) => typeof h === 'string' && h.startsWith('/')))];
    const db = this.db;
    const now = new Date();
    // Escape LIKE wildcards in the scope (some sub-section titles contain `_`, e.g. nav.sub.ar_ap).
    const escScope = scope.replace(/([\\%_])/g, '\\$1');
    await db.delete(navGroupOrder).where(like(navGroupOrder.groupKey, `${ITEM_PREFIX}${escScope}${ITEM_SEP}%`));
    if (clean.length > 0) {
      await db.insert(navGroupOrder).values(
        clean.map((href, i) => ({ groupKey: `${ITEM_PREFIX}${scope}${ITEM_SEP}${href}`, sortOrder: i, updatedAt: now, updatedBy: user.username ?? null })),
      );
    }
    return { scope, itemOrder: clean };
  }

  // Reset menu CHROME to defaults: clear all visibility overrides (nav:<href> rows) and the category order,
  // so every menu shows and groups fall back to code order. Deliberately leaves the module on/off flags
  // (real MODULE_KEYS) untouched — those are a separate, API-enforced control, not "menu arrangement".
  async resetNav(_user: { username?: string }) {
    const db = this.db;
    await db.delete(moduleConfigs).where(like(moduleConfigs.moduleKey, `${NAV_PREFIX}%`));
    await db.delete(navGroupOrder);
    return { reset: true };
  }

  // Show/hide one or more sidebar entries by href (bulk = a category/sub-section toggle). Only affects nav
  // visibility, never permissions. Lockout-critical routes are silently skipped. `enabled=false` hides.
  async setNavFlags(hrefs: string[], enabled: boolean, user: { username?: string }) {
    const targets = [...new Set(hrefs)].filter(
      (h) => typeof h === 'string' && h.startsWith('/') && !NAV_ALWAYS_VISIBLE.includes(h),
    );
    const skipped = hrefs.length - targets.length;
    if (targets.length === 0) return { updated: 0, skipped, enabled };
    const db = this.db;
    const now = new Date();
    for (const href of targets) {
      await db
        .insert(moduleConfigs)
        .values({ moduleKey: NAV_PREFIX + href, enabled, updatedAt: now, updatedBy: user.username ?? null })
        .onConflictDoUpdate({ target: moduleConfigs.moduleKey, set: { enabled, updatedAt: now, updatedBy: user.username ?? null } });
    }
    return { updated: targets.length, skipped, enabled };
  }

  async setFlag(key: string, enabled: boolean, user: { username?: string }) {
    if (!(MODULE_KEYS as string[]).includes(key)) {
      throw new BadRequestException({ code: 'BAD_MODULE', message: `Unknown module: ${key}`, messageTh: 'ไม่รู้จักโมดูลนี้' });
    }
    if (this.isAlwaysOn(key)) {
      this.cache = null;
      return { key, enabled: true, note: 'always_on' };
    }
    const db = this.db;
    const now = new Date();
    await db
      .insert(moduleConfigs)
      .values({ moduleKey: key, enabled, updatedAt: now, updatedBy: user.username ?? null })
      .onConflictDoUpdate({ target: moduleConfigs.moduleKey, set: { enabled, updatedAt: now, updatedBy: user.username ?? null } });
    this.cache = null; // invalidate guard cache immediately
    return { key, enabled };
  }

  // Cached disabled-module set used by ModuleEnabledGuard (avoids a DB hit every request).
  async disabledSet(): Promise<Set<string>> {
    const nowMs = Date.now();
    if (this.cache && nowMs - this.cache.at < this.TTL) return this.cache.disabled;
    const m = await this.loadMap();
    const disabled = new Set<string>();
    for (const k of MODULE_KEYS as string[]) {
      if (this.isAlwaysOn(k)) continue;
      if (m.get(k) === false) disabled.add(k);
    }
    this.cache = { at: nowMs, disabled };
    return disabled;
  }
}
