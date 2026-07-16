import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { branches, tenants, menuCategories, menuItems, diningTables, projects } from '../../database/schema';

// B3 (docs/51 Track B) — the idempotent first-run starter pack behind POST /api/tenant/starter-pack.
// Always: the HQ branch (the original ITGC-AC-18 #4 minimal starter, unchanged for every tenant).
// SME companies additionally get a small INDUSTRY starter kit so the ~15 nav items B1 leaves visible land
// on non-empty screens: restaurant → a sample menu category/items + a few dining tables; retail → a sample
// POS catalog; distribution → a WH1 warehouse branch; services → a demo project. Everything seeded is
// tenant-scoped data under the operator's own duties (the shared `items` master is deliberately NOT
// touched — it has no tenant_id and demo rows would leak to every company). Each piece seeds only when its
// table is EMPTY for the tenant and reports created/skipped, so repeat calls are safe (same contract the
// HQ-branch starter always had). Enterprise companies get exactly the pre-B3 behaviour (HQ only).
@Injectable()
export class StarterPackService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async isEmpty(table: typeof menuItems | typeof diningTables | typeof projects, tenantId: number): Promise<boolean> {
    const [r] = await this.db.select({ n: sql<number>`count(*)` }).from(table).where(eq(table.tenantId, tenantId));
    return Number(r?.n ?? 0) === 0;
  }

  async apply(tenantId: number, username: string): Promise<{ created: string[]; skipped: string[] }> {
    const created: string[] = [];
    const skipped: string[] = [];

    const [{ n: branchN } = { n: 0 }] = await this.db.select({ n: sql<number>`count(*)` }).from(branches).where(eq(branches.tenantId, tenantId));
    if (Number(branchN) === 0) {
      await this.db.insert(branches).values({ tenantId, code: 'HQ', name: 'สำนักงานใหญ่', isHq: true, active: true, createdBy: username });
      created.push('hq_branch');
    } else {
      skipped.push('hq_branch');
    }

    const [t] = await this.db.select({ industry: tenants.industry, profile: tenants.controlProfile }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (t?.profile !== 'sme') return { created, skipped }; // enterprise: pre-B3 behaviour, HQ only

    const industry = t.industry ?? 'general';
    if (industry === 'restaurant' || industry === 'retail') {
      // Sample POS catalog (menu_* is the priced source of truth POS/dine-in/portal sell from).
      if (await this.isEmpty(menuItems, tenantId)) {
        const isResto = industry === 'restaurant';
        await this.db.transaction(async (tx) => {
          const [cat] = await tx.insert(menuCategories).values({
            tenantId, code: 'GEN', name: isResto ? 'อาหารจานหลัก' : 'สินค้าทั่วไป', sort: 0,
          }).returning({ id: menuCategories.id });
          await tx.insert(menuItems).values(
            isResto
              ? [
                  { tenantId, sku: 'DEMO-001', name: 'ข้าวผัดตัวอย่าง', categoryId: cat!.id, type: 'food' as const, price: '60.00' },
                  { tenantId, sku: 'DEMO-002', name: 'ชาเย็นตัวอย่าง', categoryId: cat!.id, type: 'drink' as const, price: '35.00' },
                ]
              : [
                  { tenantId, sku: 'DEMO-001', name: 'สินค้าตัวอย่าง A', categoryId: cat!.id, type: 'retail' as const, price: '100.00' },
                  { tenantId, sku: 'DEMO-002', name: 'สินค้าตัวอย่าง B', categoryId: cat!.id, type: 'retail' as const, price: '250.00' },
                ],
          );
        });
        created.push('menu_starter');
      } else {
        skipped.push('menu_starter');
      }
    }
    if (industry === 'restaurant') {
      if (await this.isEmpty(diningTables, tenantId)) {
        await this.db.insert(diningTables).values(
          Array.from({ length: 4 }, (_, i) => ({ tenantId, tableNo: `T${i + 1}`, seats: 4 })),
        );
        created.push('dining_tables');
      } else {
        skipped.push('dining_tables');
      }
    }
    if (industry === 'distribution') {
      const [{ n: whN } = { n: 0 }] = await this.db.select({ n: sql<number>`count(*)` }).from(branches)
        .where(and(eq(branches.tenantId, tenantId), eq(branches.code, 'WH1')));
      if (Number(whN) === 0) {
        await this.db.insert(branches).values({ tenantId, code: 'WH1', name: 'คลังสินค้า 1', isHq: false, active: true, createdBy: username });
        created.push('wh_branch');
      } else {
        skipped.push('wh_branch');
      }
    }
    if (industry === 'services') {
      if (await this.isEmpty(projects, tenantId)) {
        await this.db.insert(projects).values({
          tenantId, projectCode: 'PRJ-DEMO', name: 'โปรเจกต์ตัวอย่าง', status: 'Open', createdBy: username,
        });
        created.push('demo_project');
      } else {
        skipped.push('demo_project');
      }
    }
    return { created, skipped };
  }
}
