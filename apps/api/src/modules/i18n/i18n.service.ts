import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users, tenants } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// C1 (Platform Phase 20) — i18n / locale framework. Resolves a user's effective UI locale
// (user override → tenant default → 'th'), lets a user set their own, and lets an admin set the tenant
// default. SEA-ready locale set; the web message catalogs key off these codes. No GL; RLS-scoped writes.
export const LOCALES = [
  { code: 'th', label: 'ไทย', label_en: 'Thai' },
  { code: 'en', label: 'English', label_en: 'English' },
  { code: 'ms', label: 'Bahasa Melayu', label_en: 'Malay' },
  { code: 'vi', label: 'Tiếng Việt', label_en: 'Vietnamese' },
  { code: 'id', label: 'Bahasa Indonesia', label_en: 'Indonesian' },
] as const;
const CODES = LOCALES.map((l) => l.code) as readonly string[];

@Injectable()
export class I18nService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  locales() { return { locales: LOCALES.map((l) => ({ ...l })), default: 'th' }; }

  private assertCode(code: string) {
    if (!CODES.includes(code)) throw new BadRequestException({ code: 'BAD_LOCALE', message: `locale must be one of ${CODES.join(', ')}`, messageTh: 'ภาษาที่เลือกไม่รองรับ' });
  }

  // user.locale → tenant.default_language → 'th'
  async resolveMe(user: JwtUser) {
    const db = this.db;
    const [u] = await db.select({ locale: users.locale }).from(users).where(eq(users.username, user.username)).limit(1);
    if (u?.locale && CODES.includes(u.locale)) return { locale: u.locale, source: 'user' };
    if (user.tenantId != null) {
      const [t] = await db.select({ dl: tenants.defaultLanguage }).from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
      if (t?.dl && CODES.includes(t.dl)) return { locale: t.dl, source: 'tenant' };
    }
    return { locale: 'th', source: 'default' };
  }

  async setMe(user: JwtUser, locale: string) {
    this.assertCode(locale);
    await (this.db as any).update(users).set({ locale }).where(eq(users.username, user.username));
    return { locale };
  }

  async setTenantDefault(user: JwtUser, locale: string) {
    this.assertCode(locale);
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'no tenant in context', messageTh: 'ไม่มีกิจการในบริบท' });
    await (this.db as any).update(tenants).set({ defaultLanguage: locale }).where(eq(tenants.id, user.tenantId));
    return { locale };
  }
}
