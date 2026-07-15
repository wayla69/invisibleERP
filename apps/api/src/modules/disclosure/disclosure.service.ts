import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { disclosureChecklists, disclosureItems } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { currentTenantStore } from '../../common/tenant-context';
import { assertMakerChecker } from '../../common/control-profile';
import type { JwtUser } from '../../common/decorators';

// CLS-02 (control GL-26) — Disclosure / close-package checklist (governed close binder).
// A per-period disclosure binder that governs the reporting package (SEC disclosure-controls expectation).
// Lifecycle: Draft (preparer opens + seeds the standard TFRS/SEC items) → items completed/NA (each with
// optional support-doc evidence via doc_attachments docType DISC) → Reviewed (a DISTINCT reviewer signs off;
// blocked while any item is Open → ITEMS_INCOMPLETE; reviewer ≠ preparer → SOD_SELF_APPROVAL) → Issued (the
// financials are released). Detective/monitoring — posts NOTHING to the GL.

const ITEM_STATUSES = ['Open', 'Complete', 'NA'] as const;
type ItemStatus = (typeof ITEM_STATUSES)[number];

// Standard disclosure / close-package items seeded on open (TFRS/IFRS + SEC disclosure-controls baseline).
const STANDARD_ITEMS: { item: string; standardRef: string; owner: string }[] = [
  { item: 'Statement of financial position prepared & agreed to the trial balance', standardRef: 'TAS 1 / TFRS', owner: 'Financial Controller' },
  { item: 'Statement of comprehensive income prepared & agreed to the trial balance', standardRef: 'TAS 1 / TFRS', owner: 'Financial Controller' },
  { item: 'Statement of cash flows prepared (indirect method) & reconciled', standardRef: 'TAS 7', owner: 'Financial Controller' },
  { item: 'Statement of changes in equity prepared', standardRef: 'TAS 1', owner: 'Financial Controller' },
  { item: 'Related-party transactions & balances disclosure compiled', standardRef: 'TAS 24', owner: 'Financial Controller' },
  { item: 'Revenue disaggregation & contract-balance disclosure compiled', standardRef: 'TFRS 15', owner: 'Revenue Accountant' },
  { item: 'Leases (ROU asset / lease liability) note compiled', standardRef: 'TFRS 16', owner: 'Financial Controller' },
  { item: 'Income tax & deferred tax reconciliation compiled', standardRef: 'TAS 12', owner: 'Tax Manager' },
  { item: 'Commitments & contingencies / subsequent-events review documented', standardRef: 'TAS 10 / TAS 37', owner: 'Financial Controller' },
  { item: 'Segment / operating-segment disclosure compiled', standardRef: 'TFRS 8', owner: 'Financial Controller' },
  { item: 'Management review & disclosure-controls sign-off (SEC/SOX)', standardRef: 'SEC disclosure controls', owner: 'CFO' },
];

@Injectable()
export class DisclosureService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  private tenantId(): number | null {
    return currentTenantStore()?.tenantId ?? null;
  }

  // ───────────────────── Open a checklist (seed standard items) ─────────────────────
  // Upsert-safe: an existing non-Issued checklist for the period is returned as-is (idempotent open).
  async open(dto: { period: string; title?: string; preparedBy: string }) {
    if (!/^\d{4}-\d{2}$/.test(dto.period ?? '')) {
      throw new BadRequestException({ code: 'BAD_PERIOD', message: 'period must be YYYY-MM', messageTh: 'งวดต้องเป็น YYYY-MM' });
    }
    const db = this.db;
    const tenantId = this.tenantId();
    const existing = await this.findByPeriod(dto.period, tenantId);
    if (existing && existing.status !== 'Issued') {
      return this.get(Number(existing.id));
    }
    const checklistNo = await this.docNo.nextDaily('DISC');
    const [chk] = await db.insert(disclosureChecklists).values({
      tenantId: tenantId as number,
      checklistNo,
      period: dto.period,
      title: dto.title ?? `Disclosure checklist ${dto.period}`,
      status: 'Draft',
      preparedBy: dto.preparedBy,
    }).returning();
    await db.insert(disclosureItems).values(STANDARD_ITEMS.map((it, i) => ({
      tenantId: tenantId as number,
      checklistId: Number(chk!.id),
      seq: i + 1,
      item: it.item,
      standardRef: it.standardRef,
      owner: it.owner,
      status: 'Open',
    })));
    return this.get(Number(chk!.id));
  }

  // ───────────────────── Read ─────────────────────
  async list() {
    const db = this.db;
    const tenantId = this.tenantId();
    const rows = await db.select().from(disclosureChecklists)
      .where(tenantId == null ? undefined : eq(disclosureChecklists.tenantId, tenantId))
      .orderBy(desc(disclosureChecklists.id));
    return { checklists: rows.map((r: any) => this.shape(r, [])), count: rows.length };
  }

  async get(id: number) {
    const db = this.db;
    const [chk] = await db.select().from(disclosureChecklists).where(eq(disclosureChecklists.id, id)).limit(1);
    if (!chk) throw new NotFoundException({ code: 'CHECKLIST_NOT_FOUND', message: `Disclosure checklist ${id} not found`, messageTh: 'ไม่พบรายการตรวจสอบการเปิดเผยข้อมูล' });
    return this.shape(chk, await this.itemsFor(id));
  }

  // ───────────────────── Update an item (complete / NA + attach support) ─────────────────────
  async updateItem(dto: { checklistId: number; itemId: number; status?: string; supportDocRef?: string; owner?: string; notes?: string; updatedBy: string }) {
    const db = this.db;
    const chk = await this.getChecklistRow(dto.checklistId);
    if (chk.status === 'Issued') {
      throw new BadRequestException({ code: 'ALREADY_ISSUED', message: 'The financials for this checklist have been issued', messageTh: 'งบการเงินของรายการนี้ถูกออกแล้ว' });
    }
    const [item] = await db.select().from(disclosureItems)
      .where(and(eq(disclosureItems.id, dto.itemId), eq(disclosureItems.checklistId, dto.checklistId))).limit(1);
    if (!item) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: `Disclosure item ${dto.itemId} not found`, messageTh: 'ไม่พบรายการเปิดเผยข้อมูล' });

    const patch: any = {};
    if (dto.status !== undefined) {
      if (!(ITEM_STATUSES as readonly string[]).includes(dto.status)) {
        throw new BadRequestException({ code: 'BAD_STATUS', message: `status must be one of ${ITEM_STATUSES.join('/')}`, messageTh: 'สถานะไม่ถูกต้อง' });
      }
      patch.status = dto.status as ItemStatus;
      if (dto.status === 'Complete' || dto.status === 'NA') {
        patch.completedBy = dto.updatedBy;
        patch.completedAt = new Date();
      } else {
        patch.completedBy = null;
        patch.completedAt = null;
      }
    }
    if (dto.supportDocRef !== undefined) patch.supportDocRef = dto.supportDocRef || null;
    if (dto.owner !== undefined) patch.owner = dto.owner || null;
    if (dto.notes !== undefined) patch.notes = dto.notes || null;
    await db.update(disclosureItems).set(patch).where(eq(disclosureItems.id, dto.itemId));
    return this.get(dto.checklistId);
  }

  // ───────────────────── Review (maker-checker sign-off gate) ─────────────────────
  // GL-26: every item must be Complete/NA (else ITEMS_INCOMPLETE listing the open items) and the reviewer
  // MUST differ from the preparer (else SOD_SELF_APPROVAL). Moves Draft → Reviewed.
  async review(dto: { checklistId: number; reviewedBy: string }, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const chk = await this.getChecklistRow(dto.checklistId);
    if (chk.status !== 'Draft') {
      throw new BadRequestException({ code: 'NOT_DRAFT', message: `Checklist is ${chk.status}, not Draft`, messageTh: 'รายการนี้ไม่อยู่ในสถานะร่าง' });
    }
    if (chk.preparedBy && chk.preparedBy === dto.reviewedBy) {
      await assertMakerChecker(db, { user, maker: user.username, event: 'gl.disclosure.review', ref: String(dto.checklistId), reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: the preparer cannot review their own disclosure checklist', messageTh: 'ผู้จัดทำตรวจสอบรายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const items = await this.itemsFor(dto.checklistId);
    const open = items.filter((i: any) => i.status === 'Open');
    if (open.length > 0) {
      throw new BadRequestException({ code: 'ITEMS_INCOMPLETE', message: `Disclosure items still open: ${open.map((i: any) => i.seq).join(', ')}`, messageTh: 'ยังมีรายการเปิดเผยข้อมูลที่ยังไม่เสร็จ', open: open.map((i: any) => i.id) });
    }
    await db.update(disclosureChecklists).set({ status: 'Reviewed', reviewedBy: dto.reviewedBy, reviewedAt: new Date() }).where(eq(disclosureChecklists.id, dto.checklistId));
    return this.get(dto.checklistId);
  }

  // ───────────────────── Issue (release the financials) ─────────────────────
  // GL-26: only a Reviewed checklist can be Issued (the sign-off gate held). Moves Reviewed → Issued.
  async issue(dto: { checklistId: number; issuedBy: string }) {
    const db = this.db;
    const chk = await this.getChecklistRow(dto.checklistId);
    if (chk.status === 'Issued') {
      throw new BadRequestException({ code: 'ALREADY_ISSUED', message: 'Checklist already issued', messageTh: 'รายการนี้ถูกออกแล้ว' });
    }
    if (chk.status !== 'Reviewed') {
      throw new BadRequestException({ code: 'NOT_REVIEWED', message: 'Checklist must be Reviewed before the financials are issued', messageTh: 'ต้องผ่านการสอบทานก่อนออกงบการเงิน' });
    }
    await db.update(disclosureChecklists).set({ status: 'Issued', issuedBy: dto.issuedBy, issuedAt: new Date() }).where(eq(disclosureChecklists.id, dto.checklistId));
    return this.get(dto.checklistId);
  }

  // ───────────────────── helpers ─────────────────────
  private async getChecklistRow(id: number) {
    const [chk] = await this.db.select().from(disclosureChecklists).where(eq(disclosureChecklists.id, id)).limit(1);
    if (!chk) throw new NotFoundException({ code: 'CHECKLIST_NOT_FOUND', message: `Disclosure checklist ${id} not found`, messageTh: 'ไม่พบรายการตรวจสอบการเปิดเผยข้อมูล' });
    return chk;
  }

  private async findByPeriod(period: string, tenantId: number | null) {
    const conds = [eq(disclosureChecklists.period, period)];
    if (tenantId != null) conds.push(eq(disclosureChecklists.tenantId, tenantId));
    const rows = await this.db.select().from(disclosureChecklists).where(and(...conds)).orderBy(desc(disclosureChecklists.id)).limit(1);
    return rows[0] ?? null;
  }

  private async itemsFor(checklistId: number) {
    const rows = await this.db.select().from(disclosureItems)
      .where(eq(disclosureItems.checklistId, checklistId)).orderBy(disclosureItems.seq);
    return rows.map((r: any) => ({
      id: Number(r.id),
      seq: r.seq,
      item: r.item,
      standard_ref: r.standardRef ?? null,
      owner: r.owner ?? null,
      status: r.status,
      support_doc_ref: r.supportDocRef ?? null,
      completed_by: r.completedBy ?? null,
      completed_at: r.completedAt ?? null,
      notes: r.notes ?? null,
    }));
  }

  private shape(r: any, items: any[]) {
    return {
      id: Number(r.id),
      checklist_no: r.checklistNo,
      period: r.period,
      title: r.title ?? null,
      status: r.status,
      prepared_by: r.preparedBy ?? null,
      prepared_at: r.preparedAt ?? null,
      reviewed_by: r.reviewedBy ?? null,
      reviewed_at: r.reviewedAt ?? null,
      issued_by: r.issuedBy ?? null,
      issued_at: r.issuedAt ?? null,
      note: r.note ?? null,
      created_at: r.createdAt ?? null,
      items,
    };
  }
}
