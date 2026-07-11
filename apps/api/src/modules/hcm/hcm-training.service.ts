import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, lte, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees, trainingCourses, trainingSessions, trainingEnrollments, certifications } from '../../database/schema';
import { StatusLogService } from '../../common/status-log.service';
import { isUniqueViolation } from '../../common/db-error';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface CourseDto { course_code: string; name: string; category?: string; is_mandatory?: boolean; requires_score?: boolean; pass_score?: number; validity_months?: number; active?: boolean }
export interface SessionDto { course_code: string; session_date?: string; instructor?: string; location?: string; capacity?: number }
export interface EnrollDto { session_id: number; emp_code: string }
export interface CompleteDto { status?: 'completed' | 'failed'; score?: number; completed_date?: string }

// HR-7 (docs/42, Wave 3) — Training & Certifications on the payroll.employees identity (emp_code).
// Control HR-07 (mandatory-training / certification compliance):
//   PREVENTIVE — completing an enrollment on a course flagged `requires_score` with NO score is blocked
//                (SCORE_REQUIRED); completing a non-existent/foreign enrollment → 404.
//   AUTOMATED  — completing an enrollment for a course with `validity_months` set MINTS/renews a certifications
//                row (expiry_date = completed_date + validity_months); a mandatory course with no validity still
//                mints a non-expiring mandatory certification (so the compliance read can flag a lapse).
//   DETECTIVE  — GET /api/hcm/training/compliance?days=N returns employees whose MANDATORY-course certifications
//                are expired or expiring within N days (default 30) — the periodic recurring-training evidence.
const HR_READ = ['hr', 'hr_admin', 'exec'];

// Add `months` calendar months to a YYYY-MM-DD date, clamping the day to the target month's length (e.g.
// 2026-01-31 + 1 month → 2026-02-28). Returns a YYYY-MM-DD string on the business calendar.
function addMonths(ymdStr: string, months: number): string {
  const [y, m, d] = ymdStr.slice(0, 10).split('-').map(Number);
  const base = new Date(Date.UTC(y!, (m! - 1) + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d!, lastDay));
  return base.toISOString().slice(0, 10);
}

@Injectable()
export class HcmTrainingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly statusLog: StatusLogService,
  ) {}

  private isHr(user: JwtUser): boolean {
    return user.role === 'Admin' || (user.permissions ?? []).some((p) => HR_READ.includes(p));
  }
  private async callerEmpCode(user: JwtUser): Promise<string | null> {
    const [e] = await this.db.select({ empCode: employees.empCode }).from(employees).where(eq(employees.userName, user.username)).limit(1);
    return e?.empCode ?? null;
  }
  private async emp(code: string) {
    const [e] = await this.db.select().from(employees).where(eq(employees.empCode, code)).limit(1);
    if (!e) throw new NotFoundException({ code: 'EMP_NOT_FOUND', message: `Employee ${code} not found`, messageTh: 'ไม่พบพนักงาน' });
    return e;
  }
  private async courseByCode(code: string) {
    const [c] = await this.db.select().from(trainingCourses).where(eq(trainingCourses.courseCode, code)).limit(1);
    if (!c) throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: `Course ${code} not found`, messageTh: 'ไม่พบหลักสูตร' });
    return c;
  }

  // ── Courses ────────────────────────────────────────────────────────────────
  async listCourses(_user: JwtUser) {
    const rows = await this.db.select().from(trainingCourses).orderBy(trainingCourses.courseCode);
    return {
      courses: rows.map((r) => ({
        id: Number(r.id), course_code: r.courseCode, name: r.name, category: r.category,
        is_mandatory: r.isMandatory === true, requires_score: r.requiresScore === true,
        pass_score: r.passScore != null ? n(r.passScore) : null,
        validity_months: r.validityMonths != null ? Number(r.validityMonths) : null, active: r.active !== false,
      })),
      count: rows.length,
    };
  }

  async createCourse(dto: CourseDto, user: JwtUser) {
    if (dto.validity_months != null && dto.validity_months < 0)
      throw new BadRequestException({ code: 'BAD_VALIDITY', message: 'validity_months must be ≥ 0', messageTh: 'อายุใบรับรองต้องไม่ติดลบ' });
    try {
      const [row] = await this.db.insert(trainingCourses).values({
        tenantId: user.tenantId ?? null, courseCode: dto.course_code, name: dto.name,
        category: dto.category ?? 'general', isMandatory: dto.is_mandatory === true, requiresScore: dto.requires_score === true,
        passScore: dto.pass_score != null ? fx(dto.pass_score, 2) : null,
        validityMonths: dto.validity_months != null ? Math.trunc(dto.validity_months) : null, active: dto.active !== false,
      }).returning({ id: trainingCourses.id });
      return { id: Number(row!.id), course_code: dto.course_code, name: dto.name, is_mandatory: dto.is_mandatory === true, validity_months: dto.validity_months ?? null };
    } catch (e) {
      if (isUniqueViolation(e))
        throw new BadRequestException({ code: 'COURSE_EXISTS', message: `Course ${dto.course_code} already exists`, messageTh: 'รหัสหลักสูตรซ้ำ' });
      throw e;
    }
  }

  // ── Sessions ───────────────────────────────────────────────────────────────
  async listSessions(courseCode: string | undefined, _user: JwtUser) {
    const courseById = new Map<number, { code: string; name: string }>(
      (await this.db.select().from(trainingCourses)).map((c) => [Number(c.id), { code: c.courseCode, name: c.name }]));
    const conds: SQL[] = [];
    if (courseCode) {
      const c = await this.courseByCode(courseCode);
      conds.push(eq(trainingSessions.courseId, Number(c.id)));
    }
    const rows = await this.db.select().from(trainingSessions).where(conds.length ? and(...conds) : undefined).orderBy(desc(trainingSessions.id)).limit(200);
    return {
      sessions: rows.map((r) => ({
        id: Number(r.id), course_id: Number(r.courseId),
        course_code: courseById.get(Number(r.courseId))?.code ?? null, course_name: courseById.get(Number(r.courseId))?.name ?? null,
        session_date: r.sessionDate, instructor: r.instructor ?? null, location: r.location ?? null,
        capacity: r.capacity != null ? Number(r.capacity) : null, status: r.status,
      })),
      count: rows.length,
    };
  }

  async createSession(dto: SessionDto, user: JwtUser) {
    const course = await this.courseByCode(dto.course_code);
    const [row] = await this.db.insert(trainingSessions).values({
      tenantId: course.tenantId ?? user.tenantId ?? null, courseId: Number(course.id),
      sessionDate: dto.session_date ?? ymd(), instructor: dto.instructor ?? null, location: dto.location ?? null,
      capacity: dto.capacity != null ? Math.trunc(dto.capacity) : null, status: 'scheduled',
    }).returning({ id: trainingSessions.id });
    return { id: Number(row!.id), course_code: dto.course_code, session_date: dto.session_date ?? ymd(), status: 'scheduled' };
  }

  // ── Enrollments (ess own-scope reads) ──────────────────────────────────────
  async listEnrollments(empCode: string | undefined, sessionId: number | undefined, user: JwtUser) {
    // ess-only callers are scoped to their own emp_code; HR/exec see all (or filter by emp_code).
    const own = this.isHr(user) ? empCode : (await this.callerEmpCode(user)) ?? '\x00none';
    const conds: SQL[] = [];
    if (own != null) conds.push(eq(trainingEnrollments.empCode, own));
    if (sessionId != null) conds.push(eq(trainingEnrollments.sessionId, Number(sessionId)));
    const sessions = new Map<number, typeof trainingSessions.$inferSelect>(
      (await this.db.select().from(trainingSessions)).map((s) => [Number(s.id), s]));
    const courses = new Map<number, { code: string; name: string }>(
      (await this.db.select().from(trainingCourses)).map((c) => [Number(c.id), { code: c.courseCode, name: c.name }]));
    const rows = await this.db.select().from(trainingEnrollments).where(conds.length ? and(...conds) : undefined).orderBy(desc(trainingEnrollments.id)).limit(200);
    return {
      enrollments: rows.map((r) => {
        const s = sessions.get(Number(r.sessionId));
        const c = s ? courses.get(Number(s.courseId)) : undefined;
        return {
          id: Number(r.id), session_id: Number(r.sessionId), emp_code: r.empCode,
          course_code: c?.code ?? null, course_name: c?.name ?? null, session_date: s?.sessionDate ?? null,
          status: r.status, score: r.score != null ? n(r.score) : null, completed_date: r.completedDate ?? null,
        };
      }),
      count: rows.length,
    };
  }

  async enroll(dto: EnrollDto, user: JwtUser) {
    await this.emp(dto.emp_code);
    const [session] = await this.db.select().from(trainingSessions).where(eq(trainingSessions.id, Number(dto.session_id))).limit(1);
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: `Session ${dto.session_id} not found`, messageTh: 'ไม่พบรอบอบรม' });
    // Block a duplicate enrollment on the same session.
    const [dup] = await this.db.select({ id: trainingEnrollments.id }).from(trainingEnrollments)
      .where(and(eq(trainingEnrollments.empCode, dto.emp_code), eq(trainingEnrollments.sessionId, Number(dto.session_id)))).limit(1);
    if (dup) throw new BadRequestException({ code: 'ALREADY_ENROLLED', message: `${dto.emp_code} is already enrolled in session ${dto.session_id}`, messageTh: 'พนักงานลงทะเบียนรอบนี้อยู่แล้ว' });
    const [row] = await this.db.insert(trainingEnrollments).values({
      tenantId: session.tenantId ?? user.tenantId ?? null, sessionId: Number(dto.session_id), empCode: dto.emp_code, status: 'enrolled',
    }).returning({ id: trainingEnrollments.id });
    return { id: Number(row!.id), session_id: Number(dto.session_id), emp_code: dto.emp_code, status: 'enrolled' };
  }

  // HR-07 — mark an enrollment completed|failed. SCORE_REQUIRED gate on a requires_score course; on a
  // successful `completed` for a mandatory-OR-recert course, MINT/renew a certifications row.
  async complete(id: number, dto: CompleteDto, user: JwtUser) {
    const [r] = await this.db.select().from(trainingEnrollments).where(eq(trainingEnrollments.id, Number(id))).limit(1);
    if (!r) throw new NotFoundException({ code: 'ENROLLMENT_NOT_FOUND', message: `Enrollment ${id} not found`, messageTh: 'ไม่พบการลงทะเบียนอบรม' });
    if (r.status === 'completed') return { id: Number(id), status: 'completed', already: true };
    const target = dto.status ?? 'completed';
    const [session] = await this.db.select().from(trainingSessions).where(eq(trainingSessions.id, Number(r.sessionId))).limit(1);
    const [course] = session ? await this.db.select().from(trainingCourses).where(eq(trainingCourses.id, Number(session.courseId))).limit(1) : [undefined];

    // PREVENTIVE gate — a `completed` transition on a requires_score course must carry a score.
    if (target === 'completed' && course?.requiresScore === true && dto.score == null)
      throw new BadRequestException({ code: 'SCORE_REQUIRED', message: `Course ${course.courseCode} requires a score to complete`, messageTh: 'หลักสูตรนี้ต้องบันทึกคะแนนก่อนจบ' });

    const completedDate = dto.completed_date ?? ymd();
    await this.db.update(trainingEnrollments).set({
      status: target, score: dto.score != null ? fx(dto.score, 2) : null, completedDate,
    }).where(eq(trainingEnrollments.id, Number(id)));

    let cert: { id: number; cert_code: string; expiry_date: string | null } | null = null;
    // AUTOMATED cert-mint — a successful completion on a course that either has a recert cadence
    // (validity_months) or is mandatory mints/renews a certifications row (HR-07 evidence).
    if (target === 'completed' && course && (course.isMandatory === true || (course.validityMonths ?? 0) > 0)) {
      const vm = course.validityMonths ?? 0;
      const expiry = vm > 0 ? addMonths(completedDate, vm) : null;
      // Supersede any prior active certification for the same employee+course so the compliance read
      // evaluates the freshest credential only.
      await this.db.update(certifications).set({ status: 'superseded' })
        .where(and(eq(certifications.empCode, r.empCode), eq(certifications.sourceCourseId, Number(course.id)), eq(certifications.status, 'active')));
      const [c] = await this.db.insert(certifications).values({
        tenantId: r.tenantId ?? user.tenantId ?? null, empCode: r.empCode,
        certCode: course.courseCode, name: course.name, sourceCourseId: Number(course.id),
        isMandatory: course.isMandatory === true, issuedDate: completedDate, expiryDate: expiry, status: 'active',
      }).returning({ id: certifications.id });
      cert = { id: Number(c!.id), cert_code: course.courseCode, expiry_date: expiry };
      await this.statusLog.log('TRAINCERT', String(c!.id), 'Issued', 'Issued', user.username,
        `HR-07 cert minted: ${r.empCode} completed ${course.courseCode}${expiry ? ` — expires ${expiry}` : ' (non-expiring)'}`);
    }

    return { id: Number(id), status: target, emp_code: r.empCode, score: dto.score ?? null, completed_date: completedDate, certification: cert };
  }

  // ── Certifications ─────────────────────────────────────────────────────────
  async listCertifications(empCode: string | undefined, user: JwtUser) {
    const own = this.isHr(user) ? empCode : (await this.callerEmpCode(user)) ?? '\x00none';
    const today = ymd();
    const rows = await this.db.select().from(certifications)
      .where(own != null ? eq(certifications.empCode, own) : undefined).orderBy(desc(certifications.id)).limit(200);
    return {
      certifications: rows.map((r) => this.certOut(r, today)),
      count: rows.length,
    };
  }

  private certOut(r: typeof certifications.$inferSelect, today: string) {
    const expired = r.expiryDate != null && r.expiryDate < today;
    return {
      id: Number(r.id), emp_code: r.empCode, cert_code: r.certCode, name: r.name,
      source_course_id: r.sourceCourseId != null ? Number(r.sourceCourseId) : null, is_mandatory: r.isMandatory === true,
      issued_date: r.issuedDate, expiry_date: r.expiryDate ?? null,
      status: r.status === 'active' && expired ? 'expired' : r.status, expired,
    };
  }

  // HR-07 DETECTIVE read — employees whose MANDATORY-course certifications are expired or expiring within
  // `days` (default 30). The periodic recurring-training compliance evidence. Non-mandatory certs and
  // superseded rows are excluded; a non-expiring mandatory cert is compliant (never surfaced).
  async compliance(days: number | undefined, user: JwtUser) {
    const window = Number.isFinite(days) && (days as number) >= 0 ? Math.trunc(days as number) : 30;
    const today = ymd();
    const cutoff = addDays(today, window);
    const own = this.isHr(user) ? undefined : (await this.callerEmpCode(user)) ?? '\x00none';
    const conds: SQL[] = [eq(certifications.isMandatory, true), eq(certifications.status, 'active'), lte(certifications.expiryDate, cutoff)];
    if (own != null) conds.push(eq(certifications.empCode, own));
    // Only mandatory, active certs with a real expiry at or before the horizon can lapse (a non-expiring
    // mandatory cert is compliant and is never surfaced).
    const rows = await this.db.select().from(certifications).where(and(...conds)).orderBy(certifications.expiryDate);
    const items = rows
      .filter((r) => r.expiryDate != null)
      .map((r) => ({
        emp_code: r.empCode, cert_code: r.certCode, name: r.name, issued_date: r.issuedDate,
        expiry_date: r.expiryDate as string, expired: (r.expiryDate as string) < today,
        days_to_expiry: daysBetween(today, r.expiryDate as string),
      }));
    return {
      as_of: today, window_days: window, horizon: cutoff,
      expired: items.filter((i) => i.expired).length,
      expiring: items.filter((i) => !i.expired).length,
      count: items.length,
      items,
    };
  }
}

// ── date helpers (business-calendar YYYY-MM-DD string math) ──────────────────────────────────────────────
function addDays(ymdStr: string, days: number): string {
  const [y, m, d] = ymdStr.slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return t.toISOString().slice(0, 10);
}
function daysBetween(from: string, to: string): number {
  const [ay, am, ad] = from.slice(0, 10).split('-').map(Number);
  const [by, bm, bd] = to.slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86400000);
}
