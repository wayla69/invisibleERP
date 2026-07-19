import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { branches, tenants, menuCategories, menuItems, diningTables, projects } from '../../database/schema';

// B3 (docs/51 Track B) — the idempotent first-run starter pack behind POST /api/tenant/starter-pack.
// Always: the HQ branch (the original ITGC-AC-18 #4 minimal starter, unchanged for every tenant).
// SME companies additionally get a small INDUSTRY starter kit so the ~15 nav items B1 leaves visible land
// on non-empty screens. Each industry maps to ONE of four seed kinds (extended 2026-07-18 to cover all 16
// curated industries): a food/retail POS **catalog** (+ **dining tables** for hospitality), a **warehouse**
// branch, or a **demo project**. Everything seeded is tenant-scoped data under the operator's own duties
// (the shared `items` master is deliberately NOT touched — it has no tenant_id and demo rows would leak to
// every company). Each piece seeds only when its table is EMPTY for the tenant and reports created/skipped,
// so repeat calls are safe (same contract the HQ-branch starter always had). Enterprise companies get
// exactly the pre-B3 behaviour (HQ only).

type MenuType = 'food' | 'drink' | 'retail';
interface CatalogSpec { cat: string; items: { sku: string; name: string; type: MenuType; price: string }[] }

// Industry → sample POS catalog (a category + two priced items). Absent industries seed no catalog.
const CATALOGS: Record<string, CatalogSpec> = {
  restaurant: { cat: 'อาหารจานหลัก', items: [
    { sku: 'DEMO-001', name: 'ข้าวผัดตัวอย่าง', type: 'food', price: '60.00' },
    { sku: 'DEMO-002', name: 'ชาเย็นตัวอย่าง', type: 'drink', price: '35.00' },
  ] },
  hospitality: { cat: 'อาหารและเครื่องดื่ม', items: [
    { sku: 'DEMO-001', name: 'อาหารเช้าตัวอย่าง', type: 'food', price: '250.00' },
    { sku: 'DEMO-002', name: 'น้ำดื่มตัวอย่าง', type: 'drink', price: '20.00' },
  ] },
  retail: { cat: 'สินค้าทั่วไป', items: [
    { sku: 'DEMO-001', name: 'สินค้าตัวอย่าง A', type: 'retail', price: '100.00' },
    { sku: 'DEMO-002', name: 'สินค้าตัวอย่าง B', type: 'retail', price: '250.00' },
  ] },
  ecommerce: { cat: 'สินค้าออนไลน์', items: [
    { sku: 'DEMO-001', name: 'สินค้าออนไลน์ตัวอย่าง A', type: 'retail', price: '150.00' },
    { sku: 'DEMO-002', name: 'สินค้าออนไลน์ตัวอย่าง B', type: 'retail', price: '350.00' },
  ] },
  automotive: { cat: 'อะไหล่และบริการ', items: [
    { sku: 'DEMO-001', name: 'น้ำมันเครื่องตัวอย่าง', type: 'retail', price: '350.00' },
    { sku: 'DEMO-002', name: 'ค่าบริการเปลี่ยนถ่ายตัวอย่าง', type: 'retail', price: '200.00' },
  ] },
  healthcare: { cat: 'บริการและเวชภัณฑ์', items: [
    { sku: 'DEMO-001', name: 'ค่าตรวจตัวอย่าง', type: 'retail', price: '500.00' },
    { sku: 'DEMO-002', name: 'ยาตัวอย่าง', type: 'retail', price: '120.00' },
  ] },
  education: { cat: 'คอร์สและอุปกรณ์', items: [
    { sku: 'DEMO-001', name: 'คอร์สเรียนตัวอย่าง', type: 'retail', price: '2500.00' },
    { sku: 'DEMO-002', name: 'หนังสือตัวอย่าง', type: 'retail', price: '350.00' },
  ] },
};

// Industries that also want sample dining tables (a POS food-service floor).
const TABLE_INDUSTRIES = new Set(['restaurant', 'hospitality']);
// Industries that get a WH1 warehouse branch (stock-heavy operations).
const WAREHOUSE_INDUSTRIES = new Set(['distribution', 'manufacturing', 'agriculture', 'logistics']);
// Industries that get a demo project → the project name to seed.
const PROJECT_NAMES: Record<string, string> = {
  services: 'โปรเจกต์ตัวอย่าง',
  construction: 'งานก่อสร้างตัวอย่าง',
  professional: 'งานที่ปรึกษาตัวอย่าง',
  realestate: 'โครงการอสังหาฯ ตัวอย่าง',
  nonprofit: 'โครงการ/กิจกรรมตัวอย่าง',
};

@Injectable()
export class StarterPackService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async isEmpty(table: typeof menuItems | typeof diningTables | typeof projects, tenantId: number): Promise<boolean> {
    const [r] = await this.db.select({ n: sql<number>`count(*)` }).from(table).where(eq(table.tenantId, tenantId));
    return Number(r?.n ?? 0) === 0;
  }

  private async seedCatalog(tenantId: number, spec: CatalogSpec): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [cat] = await tx.insert(menuCategories).values({ tenantId, code: 'GEN', name: spec.cat, sort: 0 }).returning({ id: menuCategories.id });
      await tx.insert(menuItems).values(spec.items.map((i) => ({ tenantId, sku: i.sku, name: i.name, categoryId: cat!.id, type: i.type, price: i.price })));
    });
  }

  private async seedWarehouse(tenantId: number, username: string): Promise<boolean> {
    const [{ n } = { n: 0 }] = await this.db.select({ n: sql<number>`count(*)` }).from(branches)
      .where(and(eq(branches.tenantId, tenantId), eq(branches.code, 'WH1')));
    if (Number(n) > 0) return false;
    await this.db.insert(branches).values({ tenantId, code: 'WH1', name: 'คลังสินค้า 1', isHq: false, active: true, createdBy: username });
    return true;
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

    // POS catalog (menu_* is the priced source of truth POS/dine-in/portal sell from).
    const catalog = CATALOGS[industry];
    if (catalog) {
      if (await this.isEmpty(menuItems, tenantId)) { await this.seedCatalog(tenantId, catalog); created.push('menu_starter'); }
      else skipped.push('menu_starter');
    }

    // Dining tables (food-service floor).
    if (TABLE_INDUSTRIES.has(industry)) {
      if (await this.isEmpty(diningTables, tenantId)) {
        await this.db.insert(diningTables).values(Array.from({ length: 4 }, (_, i) => ({ tenantId, tableNo: `T${i + 1}`, seats: 4 })));
        created.push('dining_tables');
      } else skipped.push('dining_tables');
    }

    // Warehouse branch (stock-heavy operations).
    if (WAREHOUSE_INDUSTRIES.has(industry)) {
      if (await this.seedWarehouse(tenantId, username)) created.push('wh_branch');
      else skipped.push('wh_branch');
    }

    // Demo project (project-driven delivery).
    const projectName = PROJECT_NAMES[industry];
    if (projectName) {
      if (await this.isEmpty(projects, tenantId)) {
        await this.db.insert(projects).values({ tenantId, projectCode: 'PRJ-DEMO', name: projectName, status: 'Open', createdBy: username });
        created.push('demo_project');
      } else skipped.push('demo_project');
    }

    return { created, skipped };
  }
}
