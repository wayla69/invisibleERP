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
  { key: 'manufacturing', label: 'การผลิต / โรงงาน', label_en: 'Manufacturing', objects: [
    { object_key: 'bom', label: 'สูตรการผลิต (BOM)', label_en: 'Bill of materials', icon: 'Factory' },
    { object_key: 'work_center', label: 'ศูนย์การผลิต', label_en: 'Work center', icon: 'Cog' },
  ] },
  { key: 'construction', label: 'ก่อสร้าง / รับเหมา', label_en: 'Construction', objects: [
    { object_key: 'boq', label: 'รายการวัสดุ/ปริมาณงาน (BoQ)', label_en: 'Bill of quantities', icon: 'ClipboardList' },
    { object_key: 'subcontractor', label: 'ผู้รับเหมาช่วง', label_en: 'Subcontractor', icon: 'HardHat' },
  ] },
  { key: 'ecommerce', label: 'อีคอมเมิร์ซ / ขายออนไลน์', label_en: 'E-commerce', objects: [
    { object_key: 'sales_channel', label: 'ช่องทางขายออนไลน์', label_en: 'Online sales channel', icon: 'ShoppingCart' },
    { object_key: 'promotion_plan', label: 'แผนโปรโมชั่น', label_en: 'Promotion plan', icon: 'Tag' },
  ] },
  { key: 'hospitality', label: 'โรงแรม / ที่พัก', label_en: 'Hospitality', objects: [
    { object_key: 'room_type', label: 'ประเภทห้องพัก', label_en: 'Room type', icon: 'BedDouble' },
    { object_key: 'menu_recipe', label: 'สูตรอาหาร', label_en: 'Recipe', icon: 'ChefHat' },
  ] },
  { key: 'healthcare', label: 'สุขภาพ / คลินิก', label_en: 'Healthcare', objects: [
    { object_key: 'service_item', label: 'รายการบริการ/หัตถการ', label_en: 'Service item', icon: 'Stethoscope' },
    { object_key: 'drug_item', label: 'รายการยา/เวชภัณฑ์', label_en: 'Drug / supply', icon: 'Pill' },
  ] },
  { key: 'professional', label: 'บริการวิชาชีพ / ที่ปรึกษา', label_en: 'Professional services', objects: [
    { object_key: 'engagement', label: 'งานที่ปรึกษา (Engagement)', label_en: 'Engagement', icon: 'Briefcase' },
    { object_key: 'rate_card', label: 'อัตราค่าบริการ', label_en: 'Rate card', icon: 'DollarSign' },
  ] },
  { key: 'agriculture', label: 'เกษตรกรรม', label_en: 'Agriculture', objects: [
    { object_key: 'crop_plan', label: 'แผนการเพาะปลูก', label_en: 'Crop plan', icon: 'Sprout' },
    { object_key: 'harvest_batch', label: 'ล็อตผลผลิต', label_en: 'Harvest batch', icon: 'Wheat' },
  ] },
  { key: 'automotive', label: 'ยานยนต์ / ศูนย์บริการ', label_en: 'Automotive & service', objects: [
    { object_key: 'service_job', label: 'ใบงานซ่อม', label_en: 'Service job', icon: 'Wrench' },
    { object_key: 'part_catalog', label: 'แคตตาล็อกอะไหล่', label_en: 'Parts catalog', icon: 'Cog' },
  ] },
  { key: 'logistics', label: 'โลจิสติกส์ / ขนส่ง', label_en: 'Logistics & transport', objects: [
    { object_key: 'delivery_route', label: 'เส้นทางจัดส่ง', label_en: 'Delivery route', icon: 'Truck' },
    { object_key: 'vehicle', label: 'ยานพาหนะ', label_en: 'Vehicle', icon: 'Truck' },
  ] },
  { key: 'education', label: 'การศึกษา', label_en: 'Education', objects: [
    { object_key: 'course', label: 'คอร์ส/หลักสูตร', label_en: 'Course', icon: 'GraduationCap' },
    { object_key: 'class_schedule', label: 'ตารางเรียน', label_en: 'Class schedule', icon: 'CalendarDays' },
  ] },
  { key: 'nonprofit', label: 'องค์กรไม่แสวงหากำไร', label_en: 'Non-profit', objects: [
    { object_key: 'program', label: 'โครงการ/กิจกรรม', label_en: 'Program', icon: 'HeartHandshake' },
    { object_key: 'donor', label: 'ผู้บริจาค/ผู้สนับสนุน', label_en: 'Donor', icon: 'HandCoins' },
  ] },
  { key: 'realestate', label: 'อสังหาริมทรัพย์ / ให้เช่า', label_en: 'Real estate', objects: [
    { object_key: 'property_unit', label: 'ยูนิต/ห้องให้เช่า', label_en: 'Property unit', icon: 'Building2' },
    { object_key: 'lease_agreement', label: 'สัญญาเช่า', label_en: 'Lease agreement', icon: 'FileSignature' },
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
