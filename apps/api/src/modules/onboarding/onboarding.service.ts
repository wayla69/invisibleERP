import { Inject, Injectable, BadRequestException, Optional } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { onboardingProgress, packInstalls, customObjects, tenants } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { LedgerService } from '../ledger/ledger.service';
import { isIndustryKey } from '../ledger/coa-templates';

// E1 (Platform Phase 26) — guided onboarding + industry template packs. A curated setup checklist (per-tenant
// completion) + one-click industry packs that seed a working set of custom objects (reusing the A1 store).
// Pack apply is idempotent (skips an object the tenant already has) and posts NOTHING to the GL; RLS-scoped.
const STEPS = [
  { key: 'branding', label: 'ตั้งค่าโลโก้และแบรนด์', label_en: 'Set up branding & logo' },
  { key: 'theme', label: 'เลือกธีมแบรนด์ (White-label)', label_en: 'Pick a brand theme' },
  { key: 'locale', label: 'เลือกภาษาที่ใช้งาน', label_en: 'Choose your language' },
  { key: 'first_product', label: 'เพิ่มสินค้าแรก', label_en: 'Add your first product' },
  { key: 'first_sale', label: 'บันทึกการขายแรก', label_en: 'Record your first sale' },
  { key: 'invite_user', label: 'เชิญเพื่อนร่วมงาน', label_en: 'Invite a teammate' },
];
const PACKS = [
  { key: 'restaurant', label: 'ร้านอาหาร', label_en: 'Restaurant', objects: [
    { object_key: 'menu_recipe', label: 'สูตรอาหาร', label_en: 'Recipe', icon: 'ChefHat' },
    { object_key: 'ingredient_supplier', label: 'ผู้จัดส่งวัตถุดิบ', label_en: 'Ingredient supplier', icon: 'Truck' },
  ] },
  { key: 'retail', label: 'ค้าปลีก', label_en: 'Retail', objects: [
    { object_key: 'promotion_plan', label: 'แผนโปรโมชั่น', label_en: 'Promotion plan', icon: 'Tag' },
  ] },
  { key: 'distribution', label: 'ค้าส่ง / กระจายสินค้า', label_en: 'Distribution', objects: [
    { object_key: 'delivery_route', label: 'เส้นทางจัดส่ง', label_en: 'Delivery route', icon: 'Truck' },
  ] },
  { key: 'services', label: 'ธุรกิจบริการ', label_en: 'Services', objects: [
    { object_key: 'service_job', label: 'งานบริการ', label_en: 'Service job', icon: 'Wrench' },
  ] },
];

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly ledger?: LedgerService, // optional so hand-constructed test instances still work
  ) {}

  packs() { return { packs: PACKS.map((p) => ({ key: p.key, label: p.label, label_en: p.label_en, objects: p.objects.length })) }; }

  async status(user: JwtUser) {
    const db = this.db;
    const done = new Set((await db.select({ k: onboardingProgress.stepKey }).from(onboardingProgress)).map((r: any) => r.k));
    const installs = (await db.select({ k: packInstalls.packKey }).from(packInstalls)).map((r: any) => r.k);
    const steps = STEPS.map((s) => ({ ...s, done: done.has(s.key) }));
    const percent = Math.round((steps.filter((s) => s.done).length / STEPS.length) * 100);
    return { steps, percent, installed_packs: installs };
  }

  async completeStep(user: JwtUser, key: string) {
    if (!STEPS.some((s) => s.key === key)) throw new BadRequestException({ code: 'BAD_STEP', message: 'unknown onboarding step', messageTh: 'ขั้นตอนไม่ถูกต้อง' });
    const db = this.db;
    const [exists] = await db.select({ id: onboardingProgress.id }).from(onboardingProgress).where(eq(onboardingProgress.stepKey, key)).limit(1);
    if (!exists) await db.insert(onboardingProgress).values({ tenantId: user.tenantId ?? null, stepKey: key, doneBy: user.username });
    return { key, done: true };
  }

  async resetStep(user: JwtUser, key: string) {
    await this.db.delete(onboardingProgress).where(eq(onboardingProgress.stepKey, key));
    return { key, done: false };
  }

  async applyPack(user: JwtUser, packKey: string) {
    const pack = PACKS.find((p) => p.key === packKey);
    if (!pack) throw new BadRequestException({ code: 'BAD_PACK', message: `pack must be one of ${PACKS.map((p) => p.key).join(', ')}`, messageTh: 'ชุดอุตสาหกรรมไม่ถูกต้อง' });
    const db = this.db;
    let created = 0;
    for (const o of pack.objects) {
      // RLS already scopes custom_objects to the caller's tenant, so matching object_key alone is sufficient.
      const [exists] = await db.select({ id: customObjects.id }).from(customObjects).where(eq(customObjects.objectKey, o.object_key)).limit(1);
      if (!exists) { await db.insert(customObjects).values({ tenantId: user.tenantId ?? null, objectKey: o.object_key, label: o.label, labelEn: o.label_en, icon: o.icon, createdBy: user.username }); created++; }
    }
    const [already] = await db.select({ id: packInstalls.id }).from(packInstalls).where(eq(packInstalls.packKey, packKey)).limit(1);
    if (!already) await db.insert(packInstalls).values({ tenantId: user.tenantId ?? null, packKey, installedBy: user.username });

    // Adopting an industry pack also records the tenant's industry and provisions that industry's
    // Chart-of-Accounts overlay (GL-10). Idempotent + additive, so re-applying only adds missing accounts.
    let coa_accounts = 0;
    if (isIndustryKey(packKey) && user.tenantId != null && this.ledger) {
      await db.update(tenants).set({ industry: packKey }).where(eq(tenants.id, user.tenantId));
      const res = await this.ledger.provisionTenantCoA(user.tenantId, packKey);
      coa_accounts = res.accounts;
    }
    return { pack: packKey, objects_created: created, coa_accounts };
  }
}
