import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { qualityInspections } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;

export interface InspectDto {
  ref_type: 'WO' | 'GR';
  ref_doc?: string;
  item_id?: string;
  item_description?: string;
  qty_inspected: number;
  qty_passed: number;
  qty_failed?: number;
  disposition?: 'Accept' | 'Rework' | 'Quarantine' | 'Scrap';
  unit_cost?: number;
  notes?: string;
}

// Quality inspection. A Scrap disposition writes the failed value off the source account to scrap loss.
@Injectable()
export class QualityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
  ) {}

  async inspect(dto: InspectDto, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    const failed = r2(dto.qty_failed != null ? n(dto.qty_failed) : n(dto.qty_inspected) - n(dto.qty_passed));
    if (failed < 0) throw new BadRequestException({ code: 'BAD_QTY', message: 'passed cannot exceed inspected', messageTh: 'จำนวนผ่านมากกว่าจำนวนตรวจไม่ได้' });
    const disposition = dto.disposition ?? (failed > 0 ? 'Quarantine' : 'Accept');
    const scrapValue = disposition === 'Scrap' ? r2(failed * n(dto.unit_cost)) : 0;
    const inspNo = `INS-${String(Date.now()).slice(-10)}`;

    const [row] = await db.insert(qualityInspections).values({
      tenantId, inspNo, refType: dto.ref_type, refDoc: dto.ref_doc ?? null, itemId: dto.item_id ?? null, itemDescription: dto.item_description ?? null,
      qtyInspected: fx(n(dto.qty_inspected), 3), qtyPassed: fx(n(dto.qty_passed), 3), qtyFailed: fx(failed, 3),
      disposition, scrapValue: fx(scrapValue, 2), notes: dto.notes ?? null, inspectedBy: user.username,
    }).returning({ id: qualityInspections.id });

    let entryNo: string | null = null;
    if (scrapValue > 0) {
      // write the scrapped value off the source: WO scrap → WIP(1250); GR scrap → Inventory(1200); else Finished Goods(1210).
      const creditAcct = dto.ref_type === 'WO' ? '1250' : dto.ref_type === 'GR' ? '1200' : '1210';
      // docs/43 PR-5: the scrap-loss leg follows the tenant posting-rule (QA.SCRAP) ?? registry default;
      // the ref-type-resolved source credit (1250/1200/1210 controls) stays pinned.
      const scrapAcct = (await this.ledger.postingOverrides('QA.SCRAP', tenantId)).scrap_loss ?? postingDefault('QA.SCRAP', 'scrap_loss');
      const je: any = await this.ledger.postEntry({
        source: 'QA-SCRAP', sourceRef: inspNo, tenantId, memo: `Scrap ${dto.item_id ?? ''} ${inspNo}`, createdBy: user.username,
        lines: [
          { account_code: scrapAcct, debit: scrapValue, memo: 'Scrap/rework loss' },
          { account_code: creditAcct, credit: scrapValue, memo: `Scrap from ${dto.ref_type}` },
        ],
      });
      entryNo = je.entry_no;
      await db.update(qualityInspections).set({ entryNo }).where(eq(qualityInspections.id, Number(row!.id)));
    }
    return { insp_no: inspNo, ref_type: dto.ref_type, ref_doc: dto.ref_doc, disposition, qty_failed: failed, scrap_value: scrapValue, entry_no: entryNo };
  }

  async list(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(qualityInspections).orderBy(desc(qualityInspections.id)).limit(100);
    return {
      inspections: rows.map((r: any) => ({ insp_no: r.inspNo, ref_type: r.refType, ref_doc: r.refDoc, item_id: r.itemId, qty_inspected: n(r.qtyInspected), qty_passed: n(r.qtyPassed), qty_failed: n(r.qtyFailed), disposition: r.disposition, scrap_value: n(r.scrapValue), entry_no: r.entryNo, inspected_by: r.inspectedBy, inspected_at: r.inspectedAt })),
      count: rows.length,
    };
  }
}
