import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// E4 (Platform Phase 29) — white-label theming. A tenant sets brand tokens (a brand HUE — applied as an
// in-gamut oklch `--primary`, matching the app's Tailwind-v4 token format — plus corner radius, brand name,
// logo, tagline); the web shell applies them as CSS variables. Presentation-only: no GL; RLS self-scoped to
// the caller's own tenant; logo accepted only as https / data-image (reuses the Phase-9 hardening rule).
const RADIUS: Record<string, string> = { sm: '0.375rem', md: '0.625rem', lg: '0.875rem' };
const DEFAULT = { primary_hue: 20, radius: 'md', brand_name: '', logo_url: '', tagline: '' };

@Injectable()
export class ThemeService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private compute(prefs: any) {
    const t = { ...DEFAULT, ...(prefs ?? {}) };
    return { ...t, primary_css: `oklch(0.48 0.17 ${t.primary_hue})`, radius_css: RADIUS[t.radius] ?? RADIUS.md };
  }

  async get(user: JwtUser) {
    if (user.tenantId == null) return { theme: this.compute({}) };
    const [row] = await this.db.select({ tp: tenants.themePrefs }).from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
    return { theme: this.compute(row?.tp ?? {}) };
  }

  async put(user: JwtUser, body: any) {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'no tenant in context', messageTh: 'ไม่มีกิจการในบริบท' });
    const hue = Number(body.primary_hue);
    if (!Number.isFinite(hue) || hue < 0 || hue > 360) throw new BadRequestException({ code: 'BAD_HUE', message: 'primary_hue must be 0–360', messageTh: 'ค่าสีแบรนด์ต้องอยู่ระหว่าง 0–360' });
    if (!(String(body.radius) in RADIUS)) throw new BadRequestException({ code: 'BAD_RADIUS', message: `radius must be one of ${Object.keys(RADIUS).join(', ')}`, messageTh: 'ค่ามุมโค้งไม่ถูกต้อง' });
    const logo = String(body.logo_url ?? '');
    if (logo && !/^https:\/\//i.test(logo) && !/^data:image\//i.test(logo)) throw new BadRequestException({ code: 'BAD_LOGO', message: 'logo_url must be an https or data-image URI', messageTh: 'โลโก้ต้องเป็น https หรือ data-image' });
    const prefs = {
      primary_hue: Math.round(hue),
      radius: String(body.radius),
      brand_name: String(body.brand_name ?? '').slice(0, 40),
      logo_url: logo.slice(0, 2000),
      tagline: String(body.tagline ?? '').slice(0, 80),
    };
    await this.db.update(tenants).set({ themePrefs: prefs }).where(eq(tenants.id, user.tenantId));
    return { theme: this.compute(prefs) };
  }
}
