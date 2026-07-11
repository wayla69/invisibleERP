import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, desc, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees, hrPositions, jobRequisitions, candidates, applications, offers } from '../../database/schema';
import { StatusLogService } from '../../common/status-log.service';
import { isUniqueViolation } from '../../common/db-error';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// HR-4 (docs/42, Wave 2) — Recruiting / ATS: requisition → candidate pipeline → offer → hire on the
// payroll.employees identity. Control HR-04 lives here:
//   1. a job_requisition must be `approved` by a DIFFERENT user than requested_by (SOD_SELF_APPROVAL) before an
//      application may advance to the offer/hired stages, or an offer be created (REQUISITION_NOT_APPROVED);
//   2. an offer must be approved by hr_admin/exec (≠ the offer creator, SOD_SELF_APPROVAL) before convert
//      (OFFER_NOT_APPROVED);
//   3. hiring (offer convert / advancing an application to 'hired') beyond the requisition headcount →
//      HEADCOUNT_EXCEEDED (mirrors the HR-01 establishment control).

export interface RequisitionDto { req_no?: string; position_code?: string; dept_id?: number; headcount?: number; justification?: string }
export interface CandidateDto { cand_no?: string; name: string; email?: string; phone?: string; source?: string; resume_url?: string }
export interface ApplicationDto { req_no: string; cand_no: string; stage?: string; rating?: number; notes?: string }
export interface StageDto { stage: string; rating?: number; notes?: string }
export interface OfferDto { application_id: number; offered_salary?: number; offered_grade?: string; start_date?: string }

const STAGES = ['applied', 'screen', 'interview', 'offer', 'hired', 'rejected'];
const HIRE_TRACK = ['offer', 'hired']; // stages that require an APPROVED requisition (HR-04)

@Injectable()
export class HcmRecruitingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly statusLog: StatusLogService,
  ) {}

  // ── Requisitions ───────────────────────────────────────────────────────────
  async listRequisitions(_user: JwtUser) {
    const rows = await this.db.select().from(jobRequisitions).orderBy(desc(jobRequisitions.id)).limit(200);
    const posById = new Map<number, string>((await this.db.select({ id: hrPositions.id, code: hrPositions.positionCode }).from(hrPositions)).map((p) => [Number(p.id), p.code]));
    // Hires so far per requisition (applications at the 'hired' stage) so the caller sees remaining seats.
    const hired = await this.hiredCountMap();
    return {
      requisitions: rows.map((r) => ({
        id: Number(r.id), req_no: r.reqNo,
        position_id: r.positionId != null ? Number(r.positionId) : null,
        position_code: r.positionId != null ? (posById.get(Number(r.positionId)) ?? null) : null,
        dept_id: r.deptId != null ? Number(r.deptId) : null, headcount: Number(r.headcount ?? 0),
        hired: hired.get(Number(r.id)) ?? 0, status: r.status,
        justification: r.justification ?? null, requested_by: r.requestedBy ?? null, approved_by: r.approvedBy ?? null,
      })),
      count: rows.length,
    };
  }

  async createRequisition(dto: RequisitionDto, user: JwtUser) {
    let positionId: number | null = null;
    if (dto.position_code) positionId = Number((await this.posByCode(dto.position_code)).id);
    const headcount = dto.headcount == null ? 1 : Math.trunc(Number(dto.headcount));
    if (headcount < 1) throw new BadRequestException({ code: 'BAD_HEADCOUNT', message: 'headcount must be ≥ 1', messageTh: 'จำนวนอัตราต้องไม่น้อยกว่า 1' });
    const reqNo = (dto.req_no?.trim()) || `REQ${String(Date.now()).slice(-6)}`;
    try {
      const [row] = await this.db.insert(jobRequisitions).values({
        tenantId: user.tenantId ?? null, reqNo, positionId, deptId: dto.dept_id ?? null, headcount,
        status: 'pending', justification: dto.justification ?? null, requestedBy: user.username,
      }).returning({ id: jobRequisitions.id });
      return { id: Number(row!.id), req_no: reqNo, headcount, status: 'pending', requested_by: user.username };
    } catch (e) {
      if (isUniqueViolation(e))
        throw new BadRequestException({ code: 'REQUISITION_EXISTS', message: `Requisition ${reqNo} already exists`, messageTh: 'เลขที่ใบขออัตราซ้ำ' });
      throw e;
    }
  }

  // HR-04 maker-checker: the approver must differ from the requester; only a pending/draft requisition may move.
  async approveRequisition(reqNo: string, user: JwtUser) {
    const req = await this.reqByNo(reqNo);
    if (req.status === 'approved') return { req_no: reqNo, status: 'approved', already: true };
    if (!['pending', 'draft'].includes(req.status))
      throw new BadRequestException({ code: 'REQUISITION_NOT_PENDING', message: `Requisition ${reqNo} is ${req.status}`, messageTh: 'ใบขออัตราไม่อยู่สถานะรออนุมัติ' });
    if (req.requestedBy && req.requestedBy === user.username)
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'The requester cannot approve their own requisition', messageTh: 'ผู้ขอไม่สามารถอนุมัติใบขออัตราของตนเองได้' });
    await this.db.update(jobRequisitions).set({ status: 'approved', approvedBy: user.username }).where(eq(jobRequisitions.id, Number(req.id)));
    await this.statusLog.log('JOBREQ', String(req.id), req.status, 'Approved', user.username, `HR-04 requisition approved (headcount ${req.headcount})`);
    return { req_no: reqNo, status: 'approved', approved_by: user.username };
  }

  async rejectRequisition(reqNo: string, user: JwtUser) {
    const req = await this.reqByNo(reqNo);
    if (req.status === 'rejected') return { req_no: reqNo, status: 'rejected', already: true };
    await this.db.update(jobRequisitions).set({ status: 'rejected', approvedBy: user.username }).where(eq(jobRequisitions.id, Number(req.id)));
    await this.statusLog.log('JOBREQ', String(req.id), req.status, 'Rejected', user.username, 'HR-04 requisition rejected');
    return { req_no: reqNo, status: 'rejected' };
  }

  private async reqByNo(reqNo: string) {
    const [r] = await this.db.select().from(jobRequisitions).where(eq(jobRequisitions.reqNo, reqNo)).limit(1);
    if (!r) throw new NotFoundException({ code: 'REQUISITION_NOT_FOUND', message: `Requisition ${reqNo} not found`, messageTh: 'ไม่พบใบขออัตรา' });
    return r;
  }

  private async posByCode(code: string) {
    const [p] = await this.db.select().from(hrPositions).where(eq(hrPositions.positionCode, code)).limit(1);
    if (!p) throw new NotFoundException({ code: 'POSITION_NOT_FOUND', message: `Position ${code} not found`, messageTh: 'ไม่พบตำแหน่ง' });
    return p;
  }

  // Count of hired applications (stage='hired') per requisition id.
  private async hiredCountMap(): Promise<Map<number, number>> {
    const rows = await this.db.select({ reqId: applications.requisitionId, c: sql<number>`count(*)::int` })
      .from(applications).where(eq(applications.stage, 'hired')).groupBy(applications.requisitionId);
    return new Map(rows.map((r) => [Number(r.reqId), Number(r.c)]));
  }

  // ── Candidates ─────────────────────────────────────────────────────────────
  async listCandidates(_user: JwtUser) {
    const rows = await this.db.select().from(candidates).orderBy(desc(candidates.id)).limit(500);
    return {
      candidates: rows.map((r) => ({
        id: Number(r.id), cand_no: r.candNo, name: r.name, email: r.email ?? null, phone: r.phone ?? null,
        source: r.source ?? null, resume_url: r.resumeUrl ?? null,
      })),
      count: rows.length,
    };
  }

  async createCandidate(dto: CandidateDto, user: JwtUser) {
    const candNo = (dto.cand_no?.trim()) || `CAND${String(Date.now()).slice(-6)}`;
    try {
      const [row] = await this.db.insert(candidates).values({
        tenantId: user.tenantId ?? null, candNo, name: dto.name, email: dto.email ?? null, phone: dto.phone ?? null,
        source: dto.source ?? null, resumeUrl: dto.resume_url ?? null,
      }).returning({ id: candidates.id });
      return { id: Number(row!.id), cand_no: candNo, name: dto.name };
    } catch (e) {
      if (isUniqueViolation(e))
        throw new BadRequestException({ code: 'CANDIDATE_EXISTS', message: `Candidate ${candNo} already exists`, messageTh: 'รหัสผู้สมัครซ้ำ' });
      throw e;
    }
  }

  private async candByNo(candNo: string) {
    const [c] = await this.db.select().from(candidates).where(eq(candidates.candNo, candNo)).limit(1);
    if (!c) throw new NotFoundException({ code: 'CANDIDATE_NOT_FOUND', message: `Candidate ${candNo} not found`, messageTh: 'ไม่พบผู้สมัคร' });
    return c;
  }

  // ── Applications (pipeline) ────────────────────────────────────────────────
  async listApplications(reqNo: string | undefined, _user: JwtUser) {
    const conds: SQL[] = [];
    if (reqNo) conds.push(eq(applications.requisitionId, Number((await this.reqByNo(reqNo)).id)));
    const rows = await this.db.select().from(applications).where(conds.length ? and(...conds) : undefined).orderBy(desc(applications.id)).limit(500);
    const candById = new Map<number, { no: string; name: string }>((await this.db.select({ id: candidates.id, no: candidates.candNo, name: candidates.name }).from(candidates)).map((c) => [Number(c.id), { no: c.no, name: c.name }]));
    const reqById = new Map<number, string>((await this.db.select({ id: jobRequisitions.id, no: jobRequisitions.reqNo }).from(jobRequisitions)).map((r) => [Number(r.id), r.no]));
    return {
      applications: rows.map((r) => ({
        id: Number(r.id), requisition_id: Number(r.requisitionId), req_no: reqById.get(Number(r.requisitionId)) ?? null,
        candidate_id: Number(r.candidateId), cand_no: candById.get(Number(r.candidateId))?.no ?? null, candidate_name: candById.get(Number(r.candidateId))?.name ?? null,
        stage: r.stage, rating: r.rating != null ? n(r.rating) : null, notes: r.notes ?? null,
      })),
      count: rows.length,
    };
  }

  async createApplication(dto: ApplicationDto, user: JwtUser) {
    const req = await this.reqByNo(dto.req_no);
    const cand = await this.candByNo(dto.cand_no);
    const stage = dto.stage ?? 'applied';
    if (!STAGES.includes(stage)) throw new BadRequestException({ code: 'BAD_STAGE', message: `Unknown stage ${stage}`, messageTh: 'สถานะไม่ถูกต้อง' });
    if (HIRE_TRACK.includes(stage)) this.assertReqApproved(req);
    const [row] = await this.db.insert(applications).values({
      tenantId: user.tenantId ?? null, requisitionId: Number(req.id), candidateId: Number(cand.id),
      stage, rating: dto.rating != null ? fx(dto.rating, 2) : null, notes: dto.notes ?? null,
    }).returning({ id: applications.id });
    return { id: Number(row!.id), req_no: dto.req_no, cand_no: dto.cand_no, stage };
  }

  // HR-04: advancing an application to the offer/hired stages requires an APPROVED requisition; a direct move to
  // 'hired' is also headcount-bound (HEADCOUNT_EXCEEDED) — the establishment cannot be exceeded via the pipeline.
  async advanceStage(id: number, dto: StageDto, _user: JwtUser) {
    const [app] = await this.db.select().from(applications).where(eq(applications.id, Number(id))).limit(1);
    if (!app) throw new NotFoundException({ code: 'APPLICATION_NOT_FOUND', message: `Application ${id} not found`, messageTh: 'ไม่พบใบสมัคร' });
    if (!STAGES.includes(dto.stage)) throw new BadRequestException({ code: 'BAD_STAGE', message: `Unknown stage ${dto.stage}`, messageTh: 'สถานะไม่ถูกต้อง' });
    if (HIRE_TRACK.includes(dto.stage)) {
      const req = await this.reqById(Number(app.requisitionId));
      this.assertReqApproved(req);
      if (dto.stage === 'hired' && app.stage !== 'hired') await this.assertHeadcount(req);
    }
    const set: Record<string, unknown> = { stage: dto.stage };
    if (dto.rating != null) set.rating = fx(dto.rating, 2);
    if (dto.notes != null) set.notes = dto.notes;
    await this.db.update(applications).set(set).where(eq(applications.id, Number(id)));
    return { id: Number(id), stage: dto.stage };
  }

  private assertReqApproved(req: typeof jobRequisitions.$inferSelect) {
    if (req.status !== 'approved')
      throw new ForbiddenException({
        code: 'REQUISITION_NOT_APPROVED',
        message: `Requisition ${req.reqNo} is not approved (${req.status}); an application cannot advance to an offer/hire`,
        messageTh: 'ใบขออัตรายังไม่ได้รับอนุมัติ ไม่สามารถออกข้อเสนอ/จ้างได้',
      });
  }

  private async reqById(id: number) {
    const [r] = await this.db.select().from(jobRequisitions).where(eq(jobRequisitions.id, Number(id))).limit(1);
    if (!r) throw new NotFoundException({ code: 'REQUISITION_NOT_FOUND', message: `Requisition ${id} not found`, messageTh: 'ไม่พบใบขออัตรา' });
    return r;
  }

  // HR-04 headcount bound: the count of already-hired applications for a requisition must stay below its headcount.
  private async assertHeadcount(req: typeof jobRequisitions.$inferSelect) {
    const [{ c: hired } = { c: 0 }] = await this.db.select({ c: sql<number>`count(*)::int` })
      .from(applications).where(and(eq(applications.requisitionId, Number(req.id)), eq(applications.stage, 'hired')));
    if (Number(hired) >= Number(req.headcount ?? 0))
      throw new ForbiddenException({
        code: 'HEADCOUNT_EXCEEDED',
        message: `Requisition ${req.reqNo} is fully hired (${hired}/${req.headcount}); no further hire is allowed`,
        messageTh: 'ใบขออัตราจ้างครบจำนวนแล้ว ไม่สามารถจ้างเพิ่มได้',
      });
  }

  // ── Offers (HR-04 offer authorization) ─────────────────────────────────────
  async listOffers(_user: JwtUser) {
    const rows = await this.db.select().from(offers).orderBy(desc(offers.id)).limit(200);
    return {
      offers: rows.map((r) => ({
        id: Number(r.id), application_id: Number(r.applicationId), offered_salary: n(r.offeredSalary),
        offered_grade: r.offeredGrade ?? null, start_date: r.startDate ?? null, status: r.status,
        created_by: r.createdBy ?? null, approved_by: r.approvedBy ?? null, hired_emp_code: r.hiredEmpCode ?? null,
      })),
      count: rows.length,
    };
  }

  async createOffer(dto: OfferDto, user: JwtUser) {
    const [app] = await this.db.select().from(applications).where(eq(applications.id, Number(dto.application_id))).limit(1);
    if (!app) throw new NotFoundException({ code: 'APPLICATION_NOT_FOUND', message: `Application ${dto.application_id} not found`, messageTh: 'ไม่พบใบสมัคร' });
    // An offer is a hire-track action — the requisition must be approved (HR-04).
    this.assertReqApproved(await this.reqById(Number(app.requisitionId)));
    const [row] = await this.db.insert(offers).values({
      tenantId: user.tenantId ?? null, applicationId: Number(app.id), offeredSalary: fx(dto.offered_salary ?? 0, 2),
      offeredGrade: dto.offered_grade ?? null, startDate: dto.start_date ?? null, status: 'pending', createdBy: user.username,
    }).returning({ id: offers.id });
    // Move the application into the 'offer' stage so the pipeline reflects the outstanding offer.
    if (app.stage !== 'offer' && app.stage !== 'hired') await this.db.update(applications).set({ stage: 'offer' }).where(eq(applications.id, Number(app.id)));
    return { id: Number(row!.id), application_id: Number(app.id), status: 'pending', offered_salary: n(dto.offered_salary ?? 0) };
  }

  // HR-04 offer authorization: the approver must differ from the offer creator (SOD_SELF_APPROVAL).
  async approveOffer(id: number, user: JwtUser) {
    const offer = await this.offerById(id);
    if (offer.status === 'approved') return { id: Number(id), status: 'approved', already: true };
    if (offer.status !== 'pending')
      throw new BadRequestException({ code: 'OFFER_NOT_PENDING', message: `Offer ${id} is ${offer.status}`, messageTh: 'ข้อเสนอไม่อยู่สถานะรออนุมัติ' });
    if (offer.createdBy && offer.createdBy === user.username)
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'The offer creator cannot approve their own offer', messageTh: 'ผู้สร้างข้อเสนอไม่สามารถอนุมัติข้อเสนอของตนเองได้' });
    await this.db.update(offers).set({ status: 'approved', approvedBy: user.username }).where(eq(offers.id, Number(id)));
    await this.statusLog.log('OFFER', String(id), 'pending', 'Approved', user.username, 'HR-04 offer authorized');
    return { id: Number(id), status: 'approved', approved_by: user.username };
  }

  // HR-04: an offer can only convert to a hire once APPROVED (OFFER_NOT_APPROVED), and only within the
  // requisition's headcount (HEADCOUNT_EXCEEDED). Convert creates the payroll.employees row from the candidate.
  async convertOffer(id: number, user: JwtUser) {
    const offer = await this.offerById(id);
    if (offer.hiredEmpCode) return { id: Number(id), status: 'accepted', already: true, emp_code: offer.hiredEmpCode };
    if (offer.status !== 'approved')
      throw new ForbiddenException({ code: 'OFFER_NOT_APPROVED', message: `Offer ${id} is not approved (${offer.status})`, messageTh: 'ข้อเสนอยังไม่ได้รับอนุมัติ' });
    const [app] = await this.db.select().from(applications).where(eq(applications.id, Number(offer.applicationId))).limit(1);
    if (!app) throw new NotFoundException({ code: 'APPLICATION_NOT_FOUND', message: 'Application not found', messageTh: 'ไม่พบใบสมัคร' });
    const req = await this.reqById(Number(app.requisitionId));
    await this.assertHeadcount(req);
    const cand = await this.candByNo((await this.candById(Number(app.candidateId))).candNo);

    // Create the payroll.employees row from the accepted+approved offer (the hire), carrying the candidate's
    // identity, the offered grade/salary and the requisition's position title.
    const empCode = `EMP${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 10)}`;
    const posTitle = req.positionId != null ? (await this.db.select({ title: hrPositions.title }).from(hrPositions).where(eq(hrPositions.id, Number(req.positionId))).limit(1))[0]?.title ?? null : null;
    await this.db.insert(employees).values({
      tenantId: user.tenantId ?? null, empCode, name: cand.name, position: posTitle, jobGrade: offer.offeredGrade ?? null,
      monthlySalary: fx(n(offer.offeredSalary), 2), startDate: offer.startDate ?? ymd(), active: true,
    });
    await this.db.update(offers).set({ status: 'accepted', hiredEmpCode: empCode }).where(eq(offers.id, Number(id)));
    await this.db.update(applications).set({ stage: 'hired' }).where(eq(applications.id, Number(app.id)));
    // Mark the requisition filled once its headcount is met.
    const hiredNow = (await this.db.select({ c: sql<number>`count(*)::int` }).from(applications).where(and(eq(applications.requisitionId, Number(req.id)), eq(applications.stage, 'hired'))))[0]?.c ?? 0;
    if (Number(hiredNow) >= Number(req.headcount ?? 0)) await this.db.update(jobRequisitions).set({ status: 'filled' }).where(eq(jobRequisitions.id, Number(req.id)));
    await this.statusLog.log('OFFER', String(id), 'approved', 'Hired', user.username, `HR-04 hire: ${cand.candNo} → ${empCode}`);
    return { id: Number(id), status: 'accepted', emp_code: empCode, candidate: cand.candNo, req_no: req.reqNo };
  }

  private async offerById(id: number) {
    const [o] = await this.db.select().from(offers).where(eq(offers.id, Number(id))).limit(1);
    if (!o) throw new NotFoundException({ code: 'OFFER_NOT_FOUND', message: `Offer ${id} not found`, messageTh: 'ไม่พบข้อเสนอ' });
    return o;
  }

  private async candById(id: number) {
    const [c] = await this.db.select().from(candidates).where(eq(candidates.id, Number(id))).limit(1);
    if (!c) throw new NotFoundException({ code: 'CANDIDATE_NOT_FOUND', message: `Candidate ${id} not found`, messageTh: 'ไม่พบผู้สมัคร' });
    return c;
  }
}
