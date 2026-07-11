import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { eq, and, sql, lte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { capas, capaActions } from '../../database/schema/quality-capa';
import { docCountersTenant } from '../../database/schema/system';
import { ymd } from '../../database/queries';
import { isUniqueViolation } from '../../common/db-error';
import type { JwtUser } from '../../common/decorators';

const ACTION_TYPES = ['corrective', 'preventive', 'both'] as const;
const SOURCE_TYPES = ['ncr', 'gr_claim', 'complaint', 'audit', 'manual'] as const;
const EFFECTIVENESS = ['effective', 'ineffective'] as const;
type ActionType = (typeof ACTION_TYPES)[number];
type Effectiveness = (typeof EFFECTIVENESS)[number];

// QMS-2 — CAPA (Corrective & Preventive Action) lifecycle with effectiveness sign-off (control QC-02).
// A first-class corrective-action loop: root-cause → action plan (child actions) → submit → INDEPENDENT
// effectiveness verification → closure. The QC-02 control lives in `verify`: a CAPA may reach 'closed' ONLY
// when a DIFFERENT user than the owner/creator verifies it (verified_by ≠ owner/created_by →
// 403 SOD_SELF_APPROVAL) AND every child action is 'done' (else ACTIONS_INCOMPLETE); an 'ineffective'
// verification REOPENS the CAPA (in_progress) rather than closing it. A detective read surfaces overdue
// open CAPAs (target_date passed, not closed/cancelled). Tenant-scoped (RLS, canonical 0232 policy). No GL.
@Injectable()
export class CapaService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Create a CAPA ───────────────────────────────────────────────────────────
  async createCapa(dto: {
    title: string; problem_statement?: string; root_cause?: string; action_type?: string;
    owner?: string; target_date?: string; source_type?: string; source_ref?: string;
  }, user: JwtUser) {
    const actionType = this.assertActionType(dto.action_type ?? 'corrective');
    const sourceType = dto.source_type != null ? this.assertSourceType(dto.source_type) : null;
    if (!dto.title?.trim())
      throw new BadRequestException({ code: 'TITLE_REQUIRED', message: 'A CAPA title is required', messageTh: 'ต้องระบุหัวข้อ CAPA' });
    const owner = (dto.owner?.trim() || user.username)!;
    const capaNo = await this.nextCapaNo(user.tenantId!);
    try {
      const [row] = await this.db.insert(capas).values({
        tenantId: user.tenantId!, capaNo, sourceType, sourceRef: dto.source_ref ?? null,
        title: dto.title.trim(), problemStatement: dto.problem_statement ?? null, rootCause: dto.root_cause ?? null,
        actionType, owner, targetDate: dto.target_date ?? null, status: 'open', createdBy: user.username,
      }).returning();
      return this.fmtCapa(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'CAPA_EXISTS', message: `CAPA ${capaNo} already exists`, messageTh: `CAPA ${capaNo} มีอยู่แล้ว` });
      throw e;
    }
  }

  async listCapas(user: JwtUser, status?: string) {
    const where = status
      ? and(eq(capas.tenantId, user.tenantId!), eq(capas.status, status))
      : eq(capas.tenantId, user.tenantId!);
    const rows = await this.db.select().from(capas).where(where).orderBy(sql`${capas.id} DESC`);
    return { capas: rows.map((r: any) => this.fmtCapa(r)), count: rows.length };
  }

  async getCapa(id: number, user: JwtUser) {
    const capa = await this.assertCapa(id, user);
    const actions = await this.db.select().from(capaActions)
      .where(eq(capaActions.capaId, id)).orderBy(capaActions.seq);
    return { ...this.fmtCapa(capa), actions: actions.map((a: any) => this.fmtAction(a)) };
  }

  // ── Child action items ────────────────────────────────────────────────────────
  async addAction(id: number, dto: { description: string; owner?: string; due_date?: string }, user: JwtUser) {
    const capa = await this.assertCapa(id, user);
    if (['closed', 'cancelled'].includes(capa.status))
      throw new BadRequestException({ code: 'CAPA_CLOSED', message: `CAPA ${capa.capaNo} is ${capa.status}; no actions can be added`, messageTh: `CAPA ${capa.capaNo} ถูกปิด/ยกเลิกแล้ว เพิ่มกิจกรรมไม่ได้` });
    if (!dto.description?.trim())
      throw new BadRequestException({ code: 'DESCRIPTION_REQUIRED', message: 'An action description is required', messageTh: 'ต้องระบุรายละเอียดกิจกรรม' });
    const seqRows = await this.db.select({ maxSeq: sql<number>`coalesce(max(${capaActions.seq}), 0)` })
      .from(capaActions).where(eq(capaActions.capaId, id));
    const nextSeq = Number(seqRows[0]?.maxSeq ?? 0) + 1;
    const [row] = await this.db.insert(capaActions).values({
      tenantId: user.tenantId!, capaId: id, seq: nextSeq, description: dto.description.trim(),
      owner: dto.owner ?? capa.owner, dueDate: dto.due_date ?? null, status: 'pending',
    }).returning();
    // First action added on an 'open' CAPA moves it into 'in_progress' (work is now underway).
    if (capa.status === 'open')
      await this.db.update(capas).set({ status: 'in_progress' }).where(eq(capas.id, id));
    return this.fmtAction(row);
  }

  async completeAction(id: number, actionId: number, user: JwtUser) {
    const capa = await this.assertCapa(id, user);
    const [action] = await this.db.select().from(capaActions)
      .where(and(eq(capaActions.id, actionId), eq(capaActions.capaId, id), eq(capaActions.tenantId, user.tenantId!))).limit(1);
    if (!action) throw new NotFoundException({ code: 'ACTION_NOT_FOUND', message: `Action ${actionId} not found on CAPA ${capa.capaNo}`, messageTh: 'ไม่พบกิจกรรม' });
    if (action.status === 'done') return this.fmtAction(action);
    const [row] = await this.db.update(capaActions)
      .set({ status: 'done', completedBy: user.username, completedAt: new Date() })
      .where(eq(capaActions.id, actionId)).returning();
    return this.fmtAction(row);
  }

  // ── Submit for verification ─────────────────────────────────────────────────
  // Moves a CAPA whose corrective work is complete to 'pending_verification' so an INDEPENDENT verifier can
  // sign off effectiveness. Requires at least one action (a CAPA with no action plan cannot be effective).
  async submit(id: number, user: JwtUser) {
    const capa = await this.assertCapa(id, user);
    if (!['open', 'in_progress'].includes(capa.status))
      throw new BadRequestException({ code: 'BAD_STATUS', message: `CAPA ${capa.capaNo} cannot be submitted from status ${capa.status}`, messageTh: `CAPA ${capa.capaNo} สถานะ ${capa.status} ส่งตรวจสอบไม่ได้` });
    const actions = await this.db.select().from(capaActions).where(eq(capaActions.capaId, id));
    if (actions.length === 0)
      throw new BadRequestException({ code: 'NO_ACTIONS', message: 'A CAPA needs at least one action item before it can be submitted for verification', messageTh: 'ต้องมีกิจกรรมอย่างน้อยหนึ่งรายการก่อนส่งตรวจสอบ' });
    const [row] = await this.db.update(capas).set({ status: 'pending_verification' }).where(eq(capas.id, id)).returning();
    return this.fmtCapa(row);
  }

  // ── QC-02 effectiveness verification (maker-checker) ─────────────────────────
  // The control. A CAPA closes ONLY when a verifier who is NEITHER the owner NOR the creator signs off
  // (verified_by ≠ owner/created_by → SOD_SELF_APPROVAL) AND every child action is 'done'
  // (else ACTIONS_INCOMPLETE), recording the effectiveness_result. An 'ineffective' verification REOPENS the
  // CAPA (in_progress) — the root cause was not resolved — rather than closing it.
  async verify(id: number, dto: { result: string; note?: string }, user: JwtUser) {
    const capa = await this.assertCapa(id, user);
    if (capa.status !== 'pending_verification')
      throw new BadRequestException({ code: 'NOT_PENDING_VERIFICATION', message: `CAPA ${capa.capaNo} is not pending verification (status=${capa.status})`, messageTh: `CAPA ${capa.capaNo} ไม่อยู่สถานะรอตรวจสอบประสิทธิผล` });
    if (user.username === capa.owner || user.username === capa.createdBy)
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'The effectiveness verifier must differ from the CAPA owner/creator (segregation of duties)', messageTh: 'ผู้ตรวจสอบประสิทธิผลต้องไม่ใช่เจ้าของ/ผู้สร้าง CAPA (แบ่งแยกหน้าที่)' });
    const result = this.assertEffectiveness(dto.result);
    const openActions = await this.db.select({ n: sql<number>`count(*)` }).from(capaActions)
      .where(and(eq(capaActions.capaId, id), eq(capaActions.status, 'pending')));
    if (Number(openActions[0]!.n) > 0)
      throw new BadRequestException({ code: 'ACTIONS_INCOMPLETE', message: 'All CAPA action items must be done before effectiveness can be verified', messageTh: 'ต้องปิดกิจกรรม CAPA ทั้งหมดก่อนตรวจสอบประสิทธิผล' });
    const [row] = await this.db.update(capas).set({
      status: result === 'effective' ? 'closed' : 'in_progress',
      effectivenessResult: result, verifiedBy: user.username, verifiedAt: new Date(),
    }).where(eq(capas.id, id)).returning();
    return this.fmtCapa(row);
  }

  // Reject the verification (evidence insufficient) — sends the CAPA back to in_progress WITHOUT recording an
  // effectiveness result. Also a distinct-user action (an owner cannot reject-bounce their own to hide it).
  async reject(id: number, dto: { reason?: string }, user: JwtUser) {
    const capa = await this.assertCapa(id, user);
    if (capa.status !== 'pending_verification')
      throw new BadRequestException({ code: 'NOT_PENDING_VERIFICATION', message: `CAPA ${capa.capaNo} is not pending verification (status=${capa.status})`, messageTh: `CAPA ${capa.capaNo} ไม่อยู่สถานะรอตรวจสอบประสิทธิผล` });
    if (!dto.reason?.trim())
      throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A reject reason is required', messageTh: 'ต้องระบุเหตุผลการตีกลับ' });
    if (user.username === capa.owner || user.username === capa.createdBy)
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'The verifier must differ from the CAPA owner/creator (segregation of duties)', messageTh: 'ผู้ตรวจสอบต้องไม่ใช่เจ้าของ/ผู้สร้าง CAPA (แบ่งแยกหน้าที่)' });
    const [row] = await this.db.update(capas).set({ status: 'in_progress' }).where(eq(capas.id, id)).returning();
    return this.fmtCapa(row);
  }

  // Cancel a CAPA (superseded / raised in error). Cannot cancel an already closed/cancelled one.
  async cancel(id: number, dto: { reason?: string }, user: JwtUser) {
    const capa = await this.assertCapa(id, user);
    if (['closed', 'cancelled'].includes(capa.status))
      throw new BadRequestException({ code: 'BAD_STATUS', message: `CAPA ${capa.capaNo} is already ${capa.status}`, messageTh: `CAPA ${capa.capaNo} ถูกปิด/ยกเลิกแล้ว` });
    const [row] = await this.db.update(capas).set({ status: 'cancelled' }).where(eq(capas.id, id)).returning();
    return this.fmtCapa(row);
  }

  // ── Detective read: overdue CAPAs ────────────────────────────────────────────
  // Open (not closed/cancelled) CAPAs whose target_date has passed — the corrective-action loop is slipping.
  async overdue(days: number, user: JwtUser) {
    const asOf = ymd();
    const cutoff = Number.isFinite(days) ? this.addDays(asOf, Math.trunc(days)) : asOf;
    const rows = await this.db.select().from(capas)
      .where(and(
        eq(capas.tenantId, user.tenantId!),
        lte(capas.targetDate, cutoff),
        sql`${capas.status} NOT IN ('closed', 'cancelled')`,
      )).orderBy(capas.targetDate);
    return { as_of: asOf, cutoff, capas: rows.map((r: any) => this.fmtCapa(r)), count: rows.length };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  private assertActionType(v: string): ActionType {
    if (!ACTION_TYPES.includes(v as ActionType))
      throw new BadRequestException({ code: 'BAD_ACTION_TYPE', message: `action_type must be one of ${ACTION_TYPES.join('/')}`, messageTh: 'ประเภทการดำเนินการไม่ถูกต้อง' });
    return v as ActionType;
  }

  private assertSourceType(v: string): string {
    if (!SOURCE_TYPES.includes(v as (typeof SOURCE_TYPES)[number]))
      throw new BadRequestException({ code: 'BAD_SOURCE_TYPE', message: `source_type must be one of ${SOURCE_TYPES.join('/')}`, messageTh: 'ประเภทแหล่งที่มาไม่ถูกต้อง' });
    return v;
  }

  private assertEffectiveness(v: string): Effectiveness {
    if (!EFFECTIVENESS.includes(v as Effectiveness))
      throw new BadRequestException({ code: 'BAD_RESULT', message: `result must be one of ${EFFECTIVENESS.join('/')}`, messageTh: 'ผลการตรวจสอบต้องเป็น effective หรือ ineffective' });
    return v as Effectiveness;
  }

  private addDays(ymdStr: string, days: number): string {
    const [y, m, d] = ymdStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
    return dt.toISOString().slice(0, 10);
  }

  private async nextCapaNo(tenantId: number) {
    const r = await this.db.insert(docCountersTenant)
      .values({ docType: 'CAPA', tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `CAPA-${String(Number(r[0]!.n)).padStart(5, '0')}`;
  }

  private async assertCapa(id: number, user: JwtUser) {
    const [c] = await this.db.select().from(capas).where(and(eq(capas.id, id), eq(capas.tenantId, user.tenantId!))).limit(1);
    if (!c) throw new NotFoundException({ code: 'CAPA_NOT_FOUND', message: `CAPA ${id} not found`, messageTh: 'ไม่พบ CAPA' });
    return c;
  }

  private fmtCapa(c: any) {
    return {
      id: Number(c.id), capa_no: c.capaNo, source_type: c.sourceType, source_ref: c.sourceRef,
      title: c.title, problem_statement: c.problemStatement, root_cause: c.rootCause, action_type: c.actionType,
      owner: c.owner, target_date: c.targetDate, status: c.status, effectiveness_result: c.effectivenessResult,
      verified_by: c.verifiedBy, verified_at: c.verifiedAt, created_by: c.createdBy, created_at: c.createdAt,
    };
  }

  private fmtAction(a: any) {
    return {
      id: Number(a.id), capa_id: Number(a.capaId), seq: Number(a.seq), description: a.description,
      owner: a.owner, due_date: a.dueDate, status: a.status, completed_by: a.completedBy, completed_at: a.completedAt,
    };
  }
}
