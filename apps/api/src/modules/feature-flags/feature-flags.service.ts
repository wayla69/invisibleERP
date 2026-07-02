import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { featureFlags } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// Step 10 — feature flags / Labs. The default registry (CORE on / LABS off) is in code; a tenant overrides
// individual flags. LABS modules are the thin, demo-grade ones we hide so diligence sees a tight, deep core
// — re-enabled per real customer demand. `labs_visible` is the master switch for whether the Labs nav
// section shows at all.
export interface FlagDef { key: string; label: string; description: string; tier: 'CORE' | 'LABS'; enabled: boolean }

const DEFAULT_FLAGS: FlagDef[] = [
  { key: 'labs_visible', label: 'แสดงส่วน Labs', description: 'เปิดให้เห็นโมดูลทดลอง (Labs) ในเมนู', tier: 'CORE', enabled: false },
  { key: 'consolidation', label: 'การรวมงบ (Consolidation)', description: 'งบการเงินรวมหลายบริษัท', tier: 'LABS', enabled: false },
  { key: 'intercompany', label: 'ระหว่างบริษัท (Intercompany)', description: 'รายการและตัดยอดระหว่างบริษัทในเครือ', tier: 'LABS', enabled: false },
  { key: 'manufacturing_mrp', label: 'การผลิต / MRP', description: 'วางแผนความต้องการวัตถุดิบเชิงผลิต', tier: 'LABS', enabled: false },
  { key: 'sourcing_rfq', label: 'จัดหา / RFQ', description: 'ขอใบเสนอราคา/ประมูลซัพพลายเออร์', tier: 'LABS', enabled: false },
  { key: 'gamification', label: 'เกมิฟิเคชัน', description: 'แต้ม/ภารกิจ/รางวัลพนักงาน', tier: 'LABS', enabled: false },
  { key: 'referrals', label: 'แนะนำเพื่อน (Referrals)', description: 'โปรแกรมแนะนำลูกค้า', tier: 'LABS', enabled: false },
  { key: 'wheels', label: 'วงล้อลุ้นรางวัล', description: 'กิจกรรมวงล้อ/ลุ้นโชค', tier: 'LABS', enabled: false },
  { key: 'custom_objects', label: 'อ็อบเจกต์กำหนดเอง', description: 'สร้างตาราง/ฟิลด์เองนอกระบบหลัก', tier: 'LABS', enabled: false },
];

@Injectable()
export class FeatureFlagsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Effective flags = the default registry overlaid with this tenant's overrides.
  async list(user: JwtUser) {
    const db = this.db;
    const overrides = await db.select().from(featureFlags).where(eq(featureFlags.tenantId, user.tenantId as number));
    const byKey = new Map<string, any>(overrides.map((o: any) => [o.flagKey, o]));
    const flags = DEFAULT_FLAGS.map((d) => ({ ...d, enabled: byKey.has(d.key) ? byKey.get(d.key).enabled : d.enabled, source: byKey.has(d.key) ? 'override' : 'default' }));
    return { flags, count: flags.length };
  }

  async setFlag(key: string, enabled: boolean, user: JwtUser) {
    const db = this.db;
    if (!DEFAULT_FLAGS.some((d) => d.key === key)) throw new BadRequestException({ code: 'UNKNOWN_FLAG', message: `Unknown flag ${key}`, messageTh: 'ไม่พบฟีเจอร์นี้' });
    await db.insert(featureFlags).values({ tenantId: user.tenantId, flagKey: key, enabled })
      .onConflictDoUpdate({ target: [featureFlags.tenantId, featureFlags.flagKey], set: { enabled } });
    return this.list(user);
  }
}
