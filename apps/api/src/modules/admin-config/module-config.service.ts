import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { moduleConfigs } from '../../database/schema';
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
    return { modules, disabled: modules.filter((x) => !x.enabled).map((x) => x.key), navDisabled };
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
