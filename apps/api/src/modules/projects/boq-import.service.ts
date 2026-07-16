import { BadRequestException } from '@nestjs/common';
import { desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { projectBoq, projectBoqLines, items } from '../../database/schema';
import { parseCsv, parseXlsx } from '../masterdata/masterdata.service';
import { fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const CATEGORIES = ['material', 'labor', 'subcon', 'other'] as const;
export const BOQ_IMPORT_HEADERS = ['item_no', 'description', 'category', 'uom', 'budget_qty', 'rate', 'wbs_code'] as const;

export interface BoqImportInput { format?: 'rows' | 'csv' | 'xlsx'; csv?: string; xlsx?: string; rows?: Record<string, any>[]; boq_no?: string; title?: string }

// A4 (docs/50 Wave 4) — BoQ Excel/CSV takeoff import (the docs/32 §10 explicit fast-follow). Estimators
// build BoQs in spreadsheets; this lands them as DRAFT lines through the SAME parse engine the masterdata
// bulk IO uses (csv / rows / base64 xlsx — parseCsv/parseXlsx are pure functions, no service coupling).
// FAIL-CLOSED, all-or-nothing: a BoQ is a budget document, so ANY invalid row rejects the whole file with
// a per-row error report (IMPORT_INVALID) — no partial budgets. Approval is unchanged: the import only
// ever creates/extends a DRAFT BoQ; PROJ-12's maker-checker approve + budget sync still gate it.
// A ctor-body plain class (ratchet pattern — the facade keeps thin delegators).
export class BoqImportService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly projectRow: (code: string) => Promise<any>,
    private readonly getBoq: (code: string) => Promise<any>,
  ) {}

  template() {
    return {
      headers: [...BOQ_IMPORT_HEADERS],
      notes: {
        category: `one of ${CATEGORIES.join('/')} (default material)`,
        item_no: 'optional — must exist in the item master when given; uom must match the item master uom when both are set',
        budget_qty_rate: 'budget_amount = budget_qty × rate (computed; non-negative numbers)',
      },
      sample: [
        { item_no: 'CEMENT', description: 'ปูนถุง 50กก.', category: 'material', uom: 'ถุง', budget_qty: 100, rate: 150, wbs_code: '1.1' },
        { item_no: '', description: 'ค่าแรงเทพื้น', category: 'labor', uom: 'จุด', budget_qty: 10, rate: 800, wbs_code: '1.2' },
      ],
    };
  }

  async importBoq(code: string, input: BoqImportInput, user: JwtUser) {
    const p = await this.projectRow(code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const raw = input.format === 'xlsx' ? await parseXlsx(Buffer.from(input.xlsx ?? '', 'base64'))
      : input.format === 'csv' ? parseCsv(input.csv ?? '')
      : (input.rows ?? []);
    if (!raw.length) throw new BadRequestException({ code: 'NO_ROWS', message: 'The import contains no rows', messageTh: 'ไฟล์นำเข้าไม่มีรายการ' });

    // Validate every row against the item master (shared master — items has no tenant_id) fail-closed.
    const itemNos = Array.from(new Set(raw.map((r) => String(r.item_no ?? '').trim()).filter(Boolean)));
    const known = itemNos.length ? await this.db.select({ itemId: items.itemId, uom: items.uom }).from(items).where(inArray(items.itemId, itemNos)) : [];
    const uomByItem = new Map(known.map((k) => [k.itemId, k.uom]));
    const errors: { row: number; code: string; message: string }[] = [];
    const warnings: { row: number; code: string; message: string }[] = [];
    const lines = raw.map((r, i) => {
      const rowNo = i + 1;
      const itemNo = String(r.item_no ?? '').trim() || null;
      const description = String(r.description ?? '').trim() || null;
      const category = (String(r.category ?? '').trim() || 'material').toLowerCase();
      const uom = String(r.uom ?? '').trim() || null;
      const qty = Number(r.budget_qty ?? 0), rate = Number(r.rate ?? 0);
      if (!itemNo && !description) errors.push({ row: rowNo, code: 'DESCRIPTION_REQUIRED', message: 'item_no or description is required' });
      if (!(CATEGORIES as readonly string[]).includes(category)) errors.push({ row: rowNo, code: 'BAD_CATEGORY', message: `category must be one of ${CATEGORIES.join('/')}` });
      if (!Number.isFinite(qty) || qty < 0 || !Number.isFinite(rate) || rate < 0) errors.push({ row: rowNo, code: 'BAD_NUMBER', message: 'budget_qty and rate must be non-negative numbers' });
      // BoQ item_no is free-form in practice (a takeoff often names items before the master does) —
      // an unknown item is an ERROR only when the row has no description to identify it; else a WARNING.
      if (itemNo && !uomByItem.has(itemNo)) (description ? warnings : errors).push({ row: rowNo, code: 'ITEM_NOT_FOUND', message: `item ${itemNo} is not in the item master` });
      else if (itemNo && uom && uomByItem.get(itemNo) && uomByItem.get(itemNo) !== uom) errors.push({ row: rowNo, code: 'UOM_MISMATCH', message: `item ${itemNo} uom is ${uomByItem.get(itemNo)}, not ${uom}` });
      return { itemNo, description, category, uom, qty, rate, wbsCode: String(r.wbs_code ?? '').trim() || null };
    });
    if (errors.length) {
      throw new BadRequestException({ code: 'IMPORT_INVALID', message: `${errors.length} invalid row(s) — nothing imported`, messageTh: `พบ ${errors.length} รายการไม่ถูกต้อง — ไม่นำเข้าใดๆ`, details: { errors, warnings } });
    }

    // Target: the project's latest DRAFT BoQ (append), else a fresh draft header — approval flow unchanged.
    const [latest] = await this.db.select().from(projectBoq).where(eq(projectBoq.projectId, Number(p.id))).orderBy(desc(projectBoq.id)).limit(1);
    let boqId: number;
    let created = false;
    if (latest && latest.status === 'draft') boqId = Number(latest.id);
    else {
      const [h] = await this.db.insert(projectBoq).values({
        projectId: Number(p.id), tenantId, boqNo: input.boq_no?.trim() || `BOQ${String(Date.now()).slice(-8)}`,
        title: input.title ?? 'นำเข้าจากไฟล์ (takeoff import)', status: 'draft', createdBy: user.username,
      }).returning({ id: projectBoq.id });
      boqId = Number(h!.id); created = true;
    }
    const [mx] = await this.db.select({ m: projectBoqLines.lineNo }).from(projectBoqLines).where(eq(projectBoqLines.boqId, boqId)).orderBy(desc(projectBoqLines.lineNo)).limit(1);
    let lineNo = Number(mx?.m ?? 0);
    await this.db.insert(projectBoqLines).values(lines.map((l) => ({
      boqId, projectId: Number(p.id), tenantId, lineNo: ++lineNo,
      category: l.category, itemNo: l.itemNo, wbsCode: l.wbsCode, description: l.description, uom: l.uom,
      budgetQty: fx(l.qty, 4), rate: fx(l.rate, 2), budgetAmount: fx(r2(l.qty * l.rate), 2),
    })));
    const boq = await this.getBoq(code);
    return { imported: lines.length, warnings, created_boq: created, boq_id: boqId, ...boq };
  }
}
