import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, runGlobalDb, type DrizzleDb } from '../../database/database.module';
import { tenantUiConfig } from '../../database/schema';
import { MODULE_KEYS, ALWAYS_ON_MODULES } from '@ierp/shared';

// PER-TENANT menu & module customization (migration 0231). Each tenant owns its own module on/off + menu
// visibility + category/item order — one JSON blob in `tenant_ui_config`.
//
// `tenant_ui_config` is a GLOBAL table (no RLS) that is logically tenant-scoped: like the notification inbox,
// EVERY read/write filters by tenant_id EXPLICITLY. This is deliberate and load-bearing — ModuleEnabledGuard
// reads the disabled-module set OUTSIDE the per-request RLS transaction (guards run before the tenant-tx
// interceptor), so an RLS policy would return zero rows there and silently break API enforcement. Explicit
// filtering keeps enforcement correct in the guard and isolates tenants everywhere else.
//
// Two hrefs can never be hidden (admin-lockout guard). Module on/off blocks the API for that tenant;
// hiding a menu is chrome only. `resetNav` clears menu arrangement but keeps module on/off.
const NAV_ALWAYS_VISIBLE = ['/settings', '/admin/users'];

interface UiConfig {
  modulesOff?: string[]; // permission keys turned off for this tenant (API-blocked)
  hidden?: string[]; // hrefs hidden from this tenant's sidebar (chrome only)
  groupOrder?: string[]; // category (nav-group title) order
  itemOrder?: Record<string, string[]>; // per container (group/sub title → ordered hrefs)
}

@Injectable()
export class ModuleConfigService {
  // Per-tenant guard cache (module on/off), keyed by tenant id. Avoids a DB hit on every guarded request.
  private cache = new Map<string, { at: number; disabled: Set<string> }>();
  private readonly TTL = 5000; // ms

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private isAlwaysOn(k: string): boolean {
    return (ALWAYS_ON_MODULES as string[]).includes(k);
  }

  // Read one tenant's config blob (explicit tenant filter — never relies on RLS; see file header).
  private async loadConfig(tenantId: number | null): Promise<UiConfig> {
    if (tenantId == null) return {};
    // Read from ModuleEnabledGuard, which runs BEFORE the per-request tenant tx — so this is a base-pool read
    // with no ALS context. Explicit `tenant_id` filter (no cross-tenant leak); declared global so the
    // fail-closed proxy (STRICT_TENANT_PROXY) permits it.
    const rows = await runGlobalDb('module-config:load', () =>
      this.db.select().from(tenantUiConfig).where(eq(tenantUiConfig.tenantId, tenantId)));
    const c = rows[0]?.config as UiConfig | undefined;
    return c && typeof c === 'object' ? c : {};
  }

  // Merge a patch into the tenant's config and persist (upsert on tenant_id). Invalidates that tenant's cache.
  private async saveConfig(tenantId: number | null, patch: Partial<UiConfig>, user: { username?: string }): Promise<UiConfig> {
    if (tenantId == null) {
      throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context for UI config', messageTh: 'ไม่พบบริษัทของผู้ใช้' });
    }
    const next: UiConfig = { ...(await this.loadConfig(tenantId)), ...patch };
    const now = new Date();
    await this.db
      .insert(tenantUiConfig)
      .values({ tenantId, config: next, updatedAt: now, updatedBy: user.username ?? null })
      .onConflictDoUpdate({ target: tenantUiConfig.tenantId, set: { config: next, updatedAt: now, updatedBy: user.username ?? null } });
    this.cache.delete(String(tenantId));
    return next;
  }

  async list(tenantId: number | null) {
    const c = await this.loadConfig(tenantId);
    const off = new Set(c.modulesOff ?? []);
    const modules = MODULE_KEYS.map((k) => ({
      key: k,
      enabled: this.isAlwaysOn(k) ? true : !off.has(k),
      always_on: this.isAlwaysOn(k),
    }));
    return {
      modules,
      disabled: modules.filter((x) => !x.enabled).map((x) => x.key),
      navDisabled: (c.hidden ?? []).filter((h) => !NAV_ALWAYS_VISIBLE.includes(h)),
      groupOrder: c.groupOrder ?? [],
      itemOrder: c.itemOrder ?? {},
    };
  }

  // Turn a module (permission key) on/off for this tenant. 'users' is always-on.
  async setFlag(tenantId: number | null, key: string, enabled: boolean, user: { username?: string }) {
    if (!(MODULE_KEYS as string[]).includes(key)) {
      throw new BadRequestException({ code: 'BAD_MODULE', message: `Unknown module: ${key}`, messageTh: 'ไม่รู้จักโมดูลนี้' });
    }
    if (this.isAlwaysOn(key)) return { key, enabled: true, note: 'always_on' };
    const c = await this.loadConfig(tenantId);
    const off = new Set(c.modulesOff ?? []);
    if (enabled) off.delete(key);
    else off.add(key);
    await this.saveConfig(tenantId, { modulesOff: [...off] }, user);
    return { key, enabled };
  }

  // Show/hide one or more sidebar entries by href (bulk = a category/sub-section toggle). Chrome only.
  async setNavFlags(tenantId: number | null, hrefs: string[], enabled: boolean, user: { username?: string }) {
    const targets = [...new Set(hrefs)].filter((h) => typeof h === 'string' && h.startsWith('/') && !NAV_ALWAYS_VISIBLE.includes(h));
    const skipped = hrefs.length - targets.length;
    if (targets.length === 0) return { updated: 0, skipped, enabled };
    const c = await this.loadConfig(tenantId);
    const hidden = new Set(c.hidden ?? []);
    for (const h of targets) {
      if (enabled) hidden.delete(h);
      else hidden.add(h);
    }
    await this.saveConfig(tenantId, { hidden: [...hidden] }, user);
    return { updated: targets.length, skipped, enabled };
  }

  // Full-replace the category order (ordered nav-group titles).
  async setGroupOrder(tenantId: number | null, order: string[], user: { username?: string }) {
    const clean = [...new Set(order.filter((k) => typeof k === 'string' && k.length > 0))];
    await this.saveConfig(tenantId, { groupOrder: clean }, user);
    return { groupOrder: clean };
  }

  // Order the items within one container (scope = group/sub-section title). Other scopes untouched.
  async setItemOrder(tenantId: number | null, scope: string, order: string[], user: { username?: string }) {
    if (!scope) return { scope, itemOrder: [] };
    const clean = [...new Set(order.filter((h) => typeof h === 'string' && h.startsWith('/')))];
    const c = await this.loadConfig(tenantId);
    const itemOrder = { ...(c.itemOrder ?? {}) };
    if (clean.length > 0) itemOrder[scope] = clean;
    else delete itemOrder[scope];
    await this.saveConfig(tenantId, { itemOrder }, user);
    return { scope, itemOrder: clean };
  }

  // Reset menu ARRANGEMENT to defaults (show all + default order) — keeps module on/off (a separate control).
  async resetNav(tenantId: number | null, user: { username?: string }) {
    await this.saveConfig(tenantId, { hidden: [], groupOrder: [], itemOrder: {} }, user);
    return { reset: true };
  }

  // Disabled-module set for the guard — per-tenant, cached (TTL). Read via explicit tenant filter (the guard
  // runs before the RLS tx, so RLS can't be relied on here — see file header).
  async disabledSet(tenantId: number | null): Promise<Set<string>> {
    const key = String(tenantId ?? '');
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.TTL) return hit.disabled;
    const c = await this.loadConfig(tenantId);
    const disabled = new Set<string>();
    for (const k of c.modulesOff ?? []) {
      if ((MODULE_KEYS as string[]).includes(k) && !this.isAlwaysOn(k)) disabled.add(k);
    }
    this.cache.set(key, { at: now, disabled });
    return disabled;
  }
}
