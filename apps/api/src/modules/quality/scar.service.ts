import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { supplierScars } from '../../database/schema/supplier-scar';
import { vendors, grClaims } from '../../database/schema/procurement';
import { docCountersTenant } from '../../database/schema/system';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const OPEN_STATES = ['open', 'supplier_responded', 'pending_closure'];
const SEVERITIES = ['minor', 'major', 'critical'];

// QMS-4 — Supplier Corrective Action Request (SCAR / 8D). A formal corrective-action request issued to a
// vendor with supplier-response tracking and a CLOSURE GATE (QC-04) before the supplier is requalified.
// Builds on the existing supplier claim (gr_claims) + scorecard (supplier_scorecards) spine — it never
// recomputes a scorecard; it references a claim/vendor and records the closure verdict.
//
// QC-04 (maker-checker / detective): a SCAR is CLOSED only by a DIFFERENT user than the raiser
// (closed_by ≠ raised_by → 403 SOD_SELF_APPROVAL) AND only after the supplier has responded and the 8D
// root_cause + corrective_action are populated (SCAR_INCOMPLETE), recording an effectiveness verdict. The
// detective read GET /api/quality/scar/open?days=N is the overdue supplier-corrective-action worklist.
@Injectable()
export class ScarService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async nextScarNo(tenantId: number | null) {
    const r = await this.db.insert(docCountersTenant)
      .values({ docType: 'SCAR', tenantId: tenantId ?? 0, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `SCAR-${String(Number(r[0]!.n)).padStart(5, '0')}`;
  }

  private async assertScar(id: number) {
    const [s] = await this.db.select().from(supplierScars).where(eq(supplierScars.id, id)).limit(1);
    if (!s) throw new NotFoundException({ code: 'SCAR_NOT_FOUND', message: `SCAR ${id} not found`, messageTh: `ไม่พบใบร้องขอการแก้ไข (SCAR) ${id}` });
    return s;
  }

  private fmt(s: any) {
    return {
      id: Number(s.id), scar_no: s.scarNo, vendor_id: s.vendorId != null ? Number(s.vendorId) : null,
      source_claim_no: s.sourceClaimNo, defect_summary: s.defectSummary, severity: s.severity,
      containment: s.containment, root_cause: s.rootCause, corrective_action: s.correctiveAction,
      preventive_action: s.preventiveAction, status: s.status, effectiveness: s.effectiveness,
      due_date: s.dueDate, raised_by: s.raisedBy, supplier_responded_by: s.supplierRespondedBy,
      supplier_responded_at: s.supplierRespondedAt, closed_by: s.closedBy, closed_at: s.closedAt,
      reject_reason: s.rejectReason, created_at: s.createdAt,
    };
  }

  // ── Raise a SCAR (quality/creditors) — optionally sourced from a real gr_claim ──
  async raise(dto: { vendor_id: number; source_claim_no?: string; defect_summary: string; severity?: string; containment?: string; due_date?: string }, user: JwtUser) {
    const db = this.db;
    if (!(Number(dto.vendor_id) > 0)) throw new BadRequestException({ code: 'VENDOR_REQUIRED', message: 'vendor_id is required', messageTh: 'ต้องระบุผู้ขาย' });
    if (!dto.defect_summary?.trim()) throw new BadRequestException({ code: 'DEFECT_REQUIRED', message: 'defect_summary is required', messageTh: 'ต้องระบุรายละเอียดข้อบกพร่อง' });
    const severity = dto.severity ?? 'major';
    if (!SEVERITIES.includes(severity)) throw new BadRequestException({ code: 'BAD_SEVERITY', message: `severity must be one of ${SEVERITIES.join('/')}`, messageTh: 'ระดับความรุนแรงไม่ถูกต้อง' });

    const [v] = await db.select().from(vendors).where(eq(vendors.id, Number(dto.vendor_id))).limit(1);
    if (!v) throw new NotFoundException({ code: 'VENDOR_NOT_FOUND', message: `Vendor ${dto.vendor_id} not found`, messageTh: `ไม่พบผู้ขาย ${dto.vendor_id}` });

    // If a source claim is quoted it MUST reference a real gr_claim for this vendor (no fabricated defect
    // reference) — mirrors the EXP-12 claim-window control (a claim must reference a real receipt).
    if (dto.source_claim_no) {
      const [c] = await db.select().from(grClaims).where(eq(grClaims.claimNo, dto.source_claim_no)).limit(1);
      if (!c) throw new BadRequestException({ code: 'CLAIM_NOT_FOUND', message: `Source claim ${dto.source_claim_no} not found`, messageTh: `ไม่พบใบเคลม ${dto.source_claim_no}` });
      if (c.vendorId != null && Number(c.vendorId) !== Number(dto.vendor_id)) throw new BadRequestException({ code: 'CLAIM_VENDOR_MISMATCH', message: 'Source claim belongs to a different vendor', messageTh: 'ใบเคลมนี้เป็นของผู้ขายรายอื่น' });
    }

    const scarNo = await this.nextScarNo(user.tenantId ?? null);
    const [row] = await db.insert(supplierScars).values({
      tenantId: user.tenantId ?? null, scarNo, vendorId: Number(dto.vendor_id), sourceClaimNo: dto.source_claim_no ?? null,
      defectSummary: dto.defect_summary.trim(), severity, containment: dto.containment ?? null,
      status: 'open', dueDate: dto.due_date ?? null, raisedBy: user.username,
    }).returning();
    return this.fmt(row);
  }

  // ── Supplier response (records the vendor's 8D response; open → supplier_responded) ──
  async respond(id: number, dto: { containment?: string; root_cause?: string; corrective_action?: string; preventive_action?: string; responder?: string }, user: JwtUser) {
    const db = this.db;
    const s = await this.assertScar(id);
    if (!OPEN_STATES.includes(s.status)) throw new BadRequestException({ code: 'SCAR_NOT_OPEN', message: `SCAR ${s.scarNo} is ${s.status} — cannot record a response`, messageTh: `SCAR ${s.scarNo} สถานะ ${s.status} ไม่สามารถบันทึกการตอบกลับได้` });
    const [row] = await db.update(supplierScars).set({
      containment: dto.containment ?? s.containment,
      rootCause: dto.root_cause ?? s.rootCause,
      correctiveAction: dto.corrective_action ?? s.correctiveAction,
      preventiveAction: dto.preventive_action ?? s.preventiveAction,
      status: 'supplier_responded',
      supplierRespondedBy: dto.responder ?? user.username,
      supplierRespondedAt: new Date(),
    }).where(eq(supplierScars.id, id)).returning();
    return this.fmt(row);
  }

  // ── Submit for closure review (raiser side; supplier_responded → pending_closure) ──
  async submitClosure(id: number, user: JwtUser) {
    const db = this.db;
    const s = await this.assertScar(id);
    if (s.status === 'closed' || s.status === 'rejected') throw new BadRequestException({ code: 'SCAR_ALREADY_CLOSED', message: `SCAR ${s.scarNo} is already ${s.status}`, messageTh: `SCAR ${s.scarNo} ถูกปิด/ปฏิเสธแล้ว` });
    if (!s.supplierRespondedAt || !s.rootCause?.trim() || !s.correctiveAction?.trim())
      throw new BadRequestException({ code: 'SCAR_INCOMPLETE', message: 'Supplier response with root_cause + corrective_action is required before submitting for closure', messageTh: 'ต้องมีการตอบกลับจากผู้ขายพร้อมสาเหตุรากเหง้าและการแก้ไขก่อนส่งปิด' });
    const [row] = await db.update(supplierScars).set({ status: 'pending_closure' }).where(eq(supplierScars.id, id)).returning();
    return this.fmt(row);
  }

  // ── Close the SCAR (QC-04 maker-checker). closer ≠ raiser; requires a complete 8D response; records an
  //    effectiveness verdict. Closing an `effective` SCAR is the gate that lets a suppressed supplier be
  //    requalified — we RECORD the verdict here (we never touch the scorecard math). ──
  async close(id: number, dto: { effectiveness?: string }, user: JwtUser) {
    const db = this.db;
    const s = await this.assertScar(id);
    if (s.status === 'closed' || s.status === 'rejected') throw new BadRequestException({ code: 'SCAR_ALREADY_CLOSED', message: `SCAR ${s.scarNo} is already ${s.status}`, messageTh: `SCAR ${s.scarNo} ถูกปิด/ปฏิเสธแล้ว` });
    // QC-04 gate 1: the 8D response must be complete (supplier responded + root cause + corrective action).
    if (!s.supplierRespondedAt || !s.rootCause?.trim() || !s.correctiveAction?.trim())
      throw new BadRequestException({ code: 'SCAR_INCOMPLETE', message: 'Cannot close a SCAR without a supplier response and populated root_cause + corrective_action', messageTh: 'ไม่สามารถปิด SCAR โดยไม่มีการตอบกลับจากผู้ขายและสาเหตุรากเหง้า/การแก้ไข' });
    // QC-04 gate 2: the closer must differ from the raiser (maker-checker; binds even Admin).
    if (s.raisedBy && s.raisedBy === user.username)
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'The SCAR raiser cannot close their own SCAR — a different authorised reviewer must sign off the 8D closure', messageTh: 'ผู้เปิด SCAR ไม่สามารถปิด SCAR ของตนเองได้ ต้องให้ผู้ตรวจสอบรายอื่นอนุมัติการปิด' });
    const effectiveness = dto.effectiveness ?? 'effective';
    if (!['effective', 'ineffective'].includes(effectiveness))
      throw new BadRequestException({ code: 'BAD_EFFECTIVENESS', message: 'effectiveness must be effective|ineffective', messageTh: 'ผลลัพธ์ต้อง effective|ineffective' });
    const [row] = await db.update(supplierScars).set({ status: 'closed', effectiveness, closedBy: user.username, closedAt: new Date() }).where(eq(supplierScars.id, id)).returning();
    return { ...this.fmt(row), requalifies_supplier: effectiveness === 'effective' };
  }

  // ── Reject the SCAR closure (reviewer declines the 8D response; ≠ raiser). reason required. ──
  async reject(id: number, dto: { reason?: string }, user: JwtUser) {
    const db = this.db;
    const s = await this.assertScar(id);
    if (s.status === 'closed' || s.status === 'rejected') throw new BadRequestException({ code: 'SCAR_ALREADY_CLOSED', message: `SCAR ${s.scarNo} is already ${s.status}`, messageTh: `SCAR ${s.scarNo} ถูกปิด/ปฏิเสธแล้ว` });
    if (!dto.reason?.trim()) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A rejection reason is required', messageTh: 'ต้องระบุเหตุผลการปฏิเสธ' });
    if (s.raisedBy && s.raisedBy === user.username)
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'The SCAR raiser cannot decide their own SCAR — a different authorised reviewer must reject the closure', messageTh: 'ผู้เปิด SCAR ไม่สามารถตัดสิน SCAR ของตนเองได้ ต้องให้ผู้ตรวจสอบรายอื่นดำเนินการ' });
    const [row] = await db.update(supplierScars).set({ status: 'rejected', rejectReason: dto.reason.trim(), closedBy: user.username, closedAt: new Date() }).where(eq(supplierScars.id, id)).returning();
    return this.fmt(row);
  }

  // ── Register list (tenant-scoped; RLS also scopes) ──
  async list(q: { status?: string; vendor_id?: number }, user: JwtUser) {
    const db = this.db;
    const conds: any[] = [];
    if (user.tenantId != null) conds.push(eq(supplierScars.tenantId, user.tenantId));
    if (q.status) conds.push(eq(supplierScars.status, q.status));
    if (q.vendor_id) conds.push(eq(supplierScars.vendorId, Number(q.vendor_id)));
    const rows = await db.select().from(supplierScars).where(conds.length ? and(...conds) : undefined).orderBy(desc(supplierScars.id)).limit(500);
    return { scars: rows.map((r: any) => this.fmt(r)), count: rows.length };
  }

  async detail(id: number) {
    return this.fmt(await this.assertScar(id));
  }

  // ── QC-04 detective read: the overdue SCAR worklist. Open SCARs whose due_date falls within the horizon
  //    (past-due, or due within `days`). Each row flags whether it is already overdue vs as_of. ──
  async openWorklist(q: { days?: number; as_of?: string }, user: JwtUser) {
    const db = this.db;
    const asOf = q.as_of ?? ymd();
    const days = Math.max(0, Number(q.days ?? 0));
    const horizon = ymd(new Date(new Date(`${asOf}T00:00:00Z`).getTime() + days * 86400000));
    const conds: any[] = [inArray(supplierScars.status, OPEN_STATES)];
    if (user.tenantId != null) conds.push(eq(supplierScars.tenantId, user.tenantId));
    const rows = await db.select().from(supplierScars).where(and(...conds)).orderBy(supplierScars.dueDate);
    const due = rows.filter((r: any) => r.dueDate && String(r.dueDate) <= horizon);
    const scars = due.map((r: any) => {
      const overdue = String(r.dueDate) < asOf;
      const daysOverdue = overdue ? Math.round((new Date(`${asOf}T00:00:00Z`).getTime() - new Date(`${r.dueDate}T00:00:00Z`).getTime()) / 86400000) : 0;
      return { ...this.fmt(r), overdue, days_overdue: daysOverdue };
    });
    return { scars, count: scars.length, overdue: scars.filter((s: any) => s.overdue).length, as_of: asOf, days };
  }
}
