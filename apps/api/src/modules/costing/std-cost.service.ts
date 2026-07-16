import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { and, eq, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { itemCosting, stdCostRevisions, stdCostRevisionLines } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { DocNumberService } from '../../common/doc-number.service';
import { n, fx } from '../../database/queries';
import { bizYmdDash } from '../../common/bizdate';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const r4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// GL anchors — mirror costing.service.ts: inventory control 1200, and the STD-cost variance account 5500
// (Purchase Price Variance — the standard-cost variance home; favourable = credit, unfavourable = debit).
const GL_INVENTORY = '1200';
const GL_STD_VARIANCE = '5500';

// ── INV-4 (control COST-02) — Standard-cost roll / inventory revaluation ──
// A STD-costed item's standard cost is set once via /api/costing/config and otherwise never changes. This
// service governs a PERIODIC revision of that standard under maker-checker: a preparer proposes a new standard
// per item (snapshotting current on-hand), and a DISTINCT approver approves it (approved_by ≠ prepared_by →
// 403 SOD_SELF_APPROVAL — the runtime control; the md_config↔exec duty split is the standing SoD conflict).
// On approval the on-hand is REVALUED at the new standard (revaluation = on_hand_snapshot × (new − old)), the
// stored standard rolls forward (so subsequent issues cost at the new standard), and a balanced revaluation JE
// posts (Dr/Cr 1200 Inventory ↔ 5500 std-cost variance — the PPV convention). Draft → Approved only.
@Injectable()
export class StdCostService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
    private readonly docNo: DocNumberService,
  ) {}

  // ── Maker: propose a new standard per item + snapshot on-hand (posts NOTHING; header stays Draft) ──
  async revise(tenantId: number, dto: { reason?: string; lines: { item_id: string; new_std: number }[] }, user: JwtUser) {
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'A tenant context is required to revise standard costs', messageTh: 'ต้องมีบริบทกิจการเพื่อปรับปรุงต้นทุนมาตรฐาน' });
    const lines = dto.lines ?? [];
    if (!lines.length) throw new BadRequestException({ code: 'NO_LINES', message: 'At least one item line is required', messageTh: 'ต้องมีอย่างน้อยหนึ่งรายการ' });
    const seen = new Set<string>();
    const prepared: { itemId: string; oldStd: number; newStd: number; onHand: number; reval: number }[] = [];
    for (const l of lines) {
      const itemId = String(l.item_id ?? '').trim();
      if (!itemId) throw new BadRequestException({ code: 'ITEM_REQUIRED', message: 'item_id is required on every line', messageTh: 'ต้องระบุรหัสสินค้าในทุกบรรทัด' });
      if (seen.has(itemId)) throw new BadRequestException({ code: 'DUPLICATE_ITEM', message: `Item ${itemId} appears more than once`, messageTh: `สินค้า ${itemId} ซ้ำในคำขอเดียวกัน` });
      seen.add(itemId);
      const newStd = r4(l.new_std);
      if (!(newStd >= 0)) throw new BadRequestException({ code: 'BAD_STD', message: `New standard cost for ${itemId} must be ≥ 0`, messageTh: 'ต้นทุนมาตรฐานใหม่ต้องไม่ติดลบ' });
      // The item MUST be STD-costed (a per-item item_costing row with method STD) — only such items carry a
      // standard to roll and an on-hand mirror to revalue. FIFO/AVG items are valued differently (rejected).
      const [ic] = await this.db.select().from(itemCosting).where(and(eq(itemCosting.tenantId, tenantId), eq(itemCosting.itemId, itemId))).limit(1);
      if (!ic || ic.method !== 'STD') throw new BadRequestException({ code: 'STD_ITEM_REQUIRED', message: `Item ${itemId} is not standard-costed (method STD) — set its costing method to STD first`, messageTh: `สินค้า ${itemId} ไม่ได้ใช้วิธีต้นทุนมาตรฐาน (STD) — ตั้งค่าวิธีคิดต้นทุนเป็น STD ก่อน` });
      const oldStd = n(ic.standardCost);
      const onHand = n(ic.onHand);
      const reval = r2(onHand * (newStd - oldStd));
      prepared.push({ itemId, oldStd, newStd, onHand, reval });
    }
    const revNo = await this.docNo.nextDaily('SCR');
    const total = r2(prepared.reduce((a, p) => a + p.reval, 0));
    await this.db.insert(stdCostRevisions).values({
      tenantId, revNo, status: 'Draft', reason: dto.reason ?? null,
      revaluationTotal: fx(total, 2), preparedBy: user.username,
    });
    await this.db.insert(stdCostRevisionLines).values(prepared.map((p) => ({
      tenantId, revNo, itemId: p.itemId,
      oldStd: fx(p.oldStd, 4), newStd: fx(p.newStd, 4),
      onHandSnapshot: fx(p.onHand, 4), revaluationAmount: fx(p.reval, 2),
    })));
    return { rev_no: revNo, status: 'Draft' as const, revaluation_total: total, line_count: prepared.length, prepared_by: user.username };
  }

  private shapeLine(l: any) {
    return {
      item_id: l.itemId, old_std: n(l.oldStd), new_std: n(l.newStd),
      on_hand_snapshot: n(l.onHandSnapshot), revaluation_amount: n(l.revaluationAmount),
    };
  }
  private shapeHeader(h: any) {
    return {
      rev_no: h.revNo, status: h.status, reason: h.reason, revaluation_total: n(h.revaluationTotal),
      je_no: h.jeNo, prepared_by: h.preparedBy, prepared_at: h.preparedAt,
      approved_by: h.approvedBy, approved_at: h.approvedAt,
    };
  }

  // ── The revision register (worklist) ──
  async list(tenantId: number, status?: string) {
    const where = status
      ? and(eq(stdCostRevisions.tenantId, tenantId), eq(stdCostRevisions.status, status))
      : eq(stdCostRevisions.tenantId, tenantId);
    const rows = await this.db.select().from(stdCostRevisions).where(where).orderBy(desc(stdCostRevisions.id)).limit(200);
    return { revisions: rows.map((h: any) => this.shapeHeader(h)), count: rows.length };
  }

  // ── Detail: proposed vs current + the revalue impact ──
  async detail(tenantId: number, revNo: string) {
    const [h] = await this.db.select().from(stdCostRevisions).where(and(eq(stdCostRevisions.tenantId, tenantId), eq(stdCostRevisions.revNo, revNo))).limit(1);
    if (!h) throw new NotFoundException({ code: 'REVISION_NOT_FOUND', message: `Standard-cost revision ${revNo} not found`, messageTh: `ไม่พบคำขอปรับปรุงต้นทุนมาตรฐาน ${revNo}` });
    const lineRows = await this.db.select().from(stdCostRevisionLines).where(and(eq(stdCostRevisionLines.tenantId, tenantId), eq(stdCostRevisionLines.revNo, revNo))).orderBy(stdCostRevisionLines.id);
    // Live current standard per item — for a still-Draft revision this equals old_std; after approval it is
    // the rolled-forward new_std. Surfaced so the screen can show "proposed vs current".
    const lines = [];
    for (const l of lineRows) {
      const [ic] = await this.db.select().from(itemCosting).where(and(eq(itemCosting.tenantId, tenantId), eq(itemCosting.itemId, l.itemId))).limit(1);
      lines.push({ ...this.shapeLine(l), current_std: ic ? n(ic.standardCost) : null });
    }
    return { ...this.shapeHeader(h), lines };
  }

  // ── Checker: a DISTINCT user approves → roll the standard + post the revaluation JE ──
  async approve(tenantId: number, revNo: string, approver: JwtUser, selfApprovalReason?: string | null) {
    const [h] = await this.db.select().from(stdCostRevisions).where(and(eq(stdCostRevisions.tenantId, tenantId), eq(stdCostRevisions.revNo, revNo))).limit(1);
    if (!h) throw new NotFoundException({ code: 'REVISION_NOT_FOUND', message: `Standard-cost revision ${revNo} not found`, messageTh: `ไม่พบคำขอปรับปรุงต้นทุนมาตรฐาน ${revNo}` });
    if (h.status !== 'Draft') throw new ConflictException({ code: 'NOT_DRAFT', message: `Revision ${revNo} is already ${h.status}`, messageTh: `คำขอ ${revNo} ไม่ได้อยู่สถานะร่างแล้ว` });
    await assertMakerChecker(this.db, { user: approver, maker: h.preparedBy, event: 'inv.stdcost.approve', ref: revNo, reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve a standard-cost revision you prepared', messageTh: 'ผู้จัดทำไม่สามารถอนุมัติคำขอปรับปรุงต้นทุนของตนเองได้ (แบ่งแยกหน้าที่)' });
    const lineRows = await this.db.select().from(stdCostRevisionLines).where(and(eq(stdCostRevisionLines.tenantId, tenantId), eq(stdCostRevisionLines.revNo, revNo))).orderBy(stdCostRevisionLines.id);
    // Roll the stored standard forward on every STD-costed item line (subsequent issues cost at the new std).
    for (const l of lineRows) {
      await this.db.update(itemCosting).set({ standardCost: fx(n(l.newStd), 4), updatedAt: new Date() })
        .where(and(eq(itemCosting.tenantId, tenantId), eq(itemCosting.itemId, l.itemId)));
    }
    // Revaluation JE (idempotent on STDREV/revNo). total > 0 (standard rose → inventory worth more):
    // Dr 1200 / Cr 5500 (favourable). total < 0 (standard fell): Cr 1200 / Dr 5500 (unfavourable). The two
    // legs are equal by construction so the JE always balances. total == 0 posts nothing.
    const total = r2(lineRows.reduce((a: number, l: any) => a + n(l.revaluationAmount), 0));
    let jeNo: string | null = null;
    if (Math.abs(total) >= 0.005 && !(await this.ledger.alreadyPosted('STDREV', revNo, tenantId))) {
      // docs/43 PR-5: the variance leg shares the COSTING.PPV event key (same 5500 default) — an
      // override re-routes GRV PPV and the standard-cost revaluation together; 1200 stays pinned.
      const varAcct = (await this.ledger.postingOverrides('COSTING.PPV', tenantId)).ppv ?? postingDefault('COSTING.PPV', 'ppv');
      const jeLines = total > 0
        ? [{ account_code: GL_INVENTORY, debit: total }, { account_code: varAcct, credit: total }]
        : [{ account_code: GL_INVENTORY, credit: -total }, { account_code: varAcct, debit: -total }];
      const res = await this.ledger.postEntry({
        date: bizYmdDash(), source: 'STDREV', sourceRef: revNo, tenantId,
        memo: `Standard-cost revaluation ${revNo}`, createdBy: approver.username, lines: jeLines,
      });
      jeNo = res.entry_no ?? null;
    }
    await this.db.update(stdCostRevisions).set({ status: 'Approved', approvedBy: approver.username, approvedAt: new Date(), jeNo, revaluationTotal: fx(total, 2) }).where(eq(stdCostRevisions.id, Number(h.id)));
    return { rev_no: revNo, status: 'Approved' as const, revaluation_total: total, je_no: jeNo, approved_by: approver.username, prepared_by: h.preparedBy };
  }
}
