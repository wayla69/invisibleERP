import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { moduleConfigs } from '../../database/schema';
import { MODULE_KEYS, ALWAYS_ON_MODULES, type Permission } from '@ierp/shared';

// System-wide module enable/disable (mirrors legacy tbl_module_config). module_key == permission key.
// Global table (no tenant_id → no RLS): a platform-wide switch, faithful to "hides for all".
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
    return { modules, disabled: modules.filter((x) => !x.enabled).map((x) => x.key) };
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
