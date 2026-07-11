import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, desc, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees, perfCycles, perfGoals, perfReviews } from '../../database/schema';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// HR-3 Performance management — appraisal cycles, OKR-style goals (weights validated ≤100% per employee/cycle),
// and the self→manager→calibration→sign-off review workflow. Control HR-03 (review sign-off SoD): the manager
// rating + sign-off must be done by someone OTHER than the reviewee (manager_emp_code ≠ emp_code; the signer's
// linked employee ≠ emp_code), and a review may only be signed once it carries a manager rating.

export interface CycleDto { name: string; period_start?: string; period_end?: string }
export interface GoalDto { cycle_id: number; emp_code: string; title: string; description?: string; weight_pct?: number; metric?: string; target?: string; status?: string }
export interface GoalPatchDto { progress_pct?: number; status?: string }
export interface ReviewDto { cycle_id: number; emp_code: string; self_rating?: number; comments?: string }
export interface ManagerRatingDto { manager_emp_code: string; manager_rating: number; comments?: string }
export interface SignDto { calibrated_rating?: number }

// Which read scope the caller gets: HR/exec see everything; a bare `ess` employee sees only their own rows.
const HR_READ = ['hr', 'hr_admin', 'exec'];

@Injectable()
export class HcmPerfService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async emp(code: string) {
    const [e] = await this.db.select().from(employees).where(eq(employees.empCode, code)).limit(1);
    if (!e) throw new NotFoundException({ code: 'EMP_NOT_FOUND', message: `Employee ${code} not found`, messageTh: 'ไม่พบพนักงาน' });
    return e;
  }

  // Resolve the caller to their own emp_code via the ESS user_name link (null if the login isn't an employee).
  private async callerEmpCode(user: JwtUser): Promise<string | null> {
    const [e] = await this.db.select({ empCode: employees.empCode }).from(employees).where(eq(employees.userName, user.username)).limit(1);
    return e?.empCode ?? null;
  }

  private isHr(user: JwtUser): boolean {
    return (user.permissions ?? []).some((p) => HR_READ.includes(p));
  }

  // ── Cycles ──────────────────────────────────────────────────────────────
  async listCycles(_user: JwtUser) {
    const rows = await this.db.select().from(perfCycles).orderBy(desc(perfCycles.id)).limit(100);
    return { cycles: rows.map((r) => ({ id: Number(r.id), name: r.name, period_start: r.periodStart, period_end: r.periodEnd, status: r.status, created_by: r.createdBy })), count: rows.length };
  }

  async createCycle(dto: CycleDto, user: JwtUser) {
    const [row] = await this.db.insert(perfCycles).values({
      tenantId: user.tenantId ?? null, name: dto.name, periodStart: dto.period_start ?? null, periodEnd: dto.period_end ?? null,
      status: 'open', createdBy: user.username,
    }).returning({ id: perfCycles.id });
    return { id: Number(row!.id), name: dto.name, status: 'open' };
  }

  async closeCycle(id: number, _user: JwtUser) {
    const [c] = await this.db.select().from(perfCycles).where(eq(perfCycles.id, Number(id))).limit(1);
    if (!c) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND', message: `Cycle ${id} not found`, messageTh: 'ไม่พบรอบประเมิน' });
    if (c.status === 'closed') return { id: Number(id), status: 'closed', already: true };
    await this.db.update(perfCycles).set({ status: 'closed' }).where(eq(perfCycles.id, Number(id)));
    return { id: Number(id), status: 'closed' };
  }

  // ── Goals ───────────────────────────────────────────────────────────────
  async listGoals(cycleId: number | undefined, empCode: string | undefined, user: JwtUser) {
    // ess-only callers are scoped to their own emp_code (own goals); HR/exec see all.
    const own = this.isHr(user) ? empCode : (await this.callerEmpCode(user)) ?? '\x00none';
    const conds: SQL[] = [];
    if (cycleId != null) conds.push(eq(perfGoals.cycleId, Number(cycleId)));
    if (own != null) conds.push(eq(perfGoals.empCode, own));
    const rows = await this.db.select().from(perfGoals).where(conds.length ? and(...conds) : undefined).orderBy(desc(perfGoals.id)).limit(200);
    return { goals: rows.map((r) => ({ id: Number(r.id), cycle_id: Number(r.cycleId), emp_code: r.empCode, title: r.title, description: r.description, weight_pct: n(r.weightPct), metric: r.metric, target: r.target, status: r.status, progress_pct: n(r.progressPct) })), count: rows.length };
  }

  // Weight soft-check: the sum of a cycle's goal weights for ONE employee must stay ≤ 100%.
  private async assertWeight(cycleId: number, empCode: string, addWeight: number, excludeGoalId?: number) {
    const rows = await this.db.select({ id: perfGoals.id, w: perfGoals.weightPct }).from(perfGoals)
      .where(and(eq(perfGoals.cycleId, Number(cycleId)), eq(perfGoals.empCode, empCode)));
    const existing = rows.filter((r) => excludeGoalId == null || Number(r.id) !== Number(excludeGoalId)).reduce((a, r) => a + n(r.w), 0);
    if (existing + addWeight > 100.0001)
      throw new BadRequestException({ code: 'WEIGHT_EXCEEDED', message: `Goal weights for ${empCode} would total ${existing + addWeight}% (> 100%)`, messageTh: 'น้ำหนักเป้าหมายรวมเกิน 100%' });
  }

  async createGoal(dto: GoalDto, user: JwtUser) {
    const [c] = await this.db.select().from(perfCycles).where(eq(perfCycles.id, Number(dto.cycle_id))).limit(1);
    if (!c) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND', message: `Cycle ${dto.cycle_id} not found`, messageTh: 'ไม่พบรอบประเมิน' });
    if (c.status === 'closed') throw new BadRequestException({ code: 'CYCLE_CLOSED', message: 'Cycle is closed', messageTh: 'รอบประเมินปิดแล้ว' });
    const e = await this.emp(dto.emp_code);
    const w = n(dto.weight_pct);
    if (w < 0) throw new BadRequestException({ code: 'BAD_WEIGHT', message: 'weight_pct must be ≥ 0', messageTh: 'น้ำหนักต้องไม่ติดลบ' });
    await this.assertWeight(dto.cycle_id, dto.emp_code, w);
    const [row] = await this.db.insert(perfGoals).values({
      tenantId: e.tenantId ?? user.tenantId ?? null, cycleId: Number(dto.cycle_id), empCode: dto.emp_code, title: dto.title,
      description: dto.description ?? null, weightPct: fx(w, 2), metric: dto.metric ?? null, target: dto.target ?? null,
      status: dto.status ?? 'active', progressPct: fx(0, 2),
    }).returning({ id: perfGoals.id });
    return { id: Number(row!.id), cycle_id: Number(dto.cycle_id), emp_code: dto.emp_code, title: dto.title, weight_pct: w, status: dto.status ?? 'active' };
  }

  async patchGoal(id: number, dto: GoalPatchDto, _user: JwtUser) {
    const [g] = await this.db.select().from(perfGoals).where(eq(perfGoals.id, Number(id))).limit(1);
    if (!g) throw new NotFoundException({ code: 'GOAL_NOT_FOUND', message: `Goal ${id} not found`, messageTh: 'ไม่พบเป้าหมาย' });
    const set: Record<string, unknown> = {};
    if (dto.progress_pct != null) {
      const p = n(dto.progress_pct);
      if (p < 0 || p > 100) throw new BadRequestException({ code: 'BAD_PROGRESS', message: 'progress_pct must be 0..100', messageTh: 'ความคืบหน้าต้องอยู่ระหว่าง 0-100' });
      set.progressPct = fx(p, 2);
    }
    if (dto.status != null) set.status = dto.status;
    if (!Object.keys(set).length) return { id: Number(id), unchanged: true };
    await this.db.update(perfGoals).set(set).where(eq(perfGoals.id, Number(id)));
    return { id: Number(id), progress_pct: dto.progress_pct != null ? n(dto.progress_pct) : n(g.progressPct), status: dto.status ?? g.status };
  }

  // ── Reviews (HR-03 sign-off SoD) ──────────────────────────────────────────
  async listReviews(cycleId: number | undefined, empCode: string | undefined, user: JwtUser) {
    const own = this.isHr(user) ? empCode : (await this.callerEmpCode(user)) ?? '\x00none';
    const conds: SQL[] = [];
    if (cycleId != null) conds.push(eq(perfReviews.cycleId, Number(cycleId)));
    if (own != null) conds.push(eq(perfReviews.empCode, own));
    const rows = await this.db.select().from(perfReviews).where(conds.length ? and(...conds) : undefined).orderBy(desc(perfReviews.id)).limit(200);
    return { reviews: rows.map((r) => this.reviewOut(r)), count: rows.length };
  }

  private reviewOut(r: typeof perfReviews.$inferSelect) {
    return {
      id: Number(r.id), cycle_id: Number(r.cycleId), emp_code: r.empCode,
      self_rating: r.selfRating != null ? n(r.selfRating) : null,
      manager_rating: r.managerRating != null ? n(r.managerRating) : null,
      manager_emp_code: r.managerEmpCode, calibrated_rating: r.calibratedRating != null ? n(r.calibratedRating) : null,
      comments: r.comments, status: r.status, signed_by: r.signedBy, signed_at: r.signedAt,
    };
  }

  // Self-assessment — creates (or returns the existing) review for (cycle, employee) in 'self' status.
  async createReview(dto: ReviewDto, user: JwtUser) {
    const [c] = await this.db.select().from(perfCycles).where(eq(perfCycles.id, Number(dto.cycle_id))).limit(1);
    if (!c) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND', message: `Cycle ${dto.cycle_id} not found`, messageTh: 'ไม่พบรอบประเมิน' });
    if (c.status === 'closed') throw new BadRequestException({ code: 'CYCLE_CLOSED', message: 'Cycle is closed', messageTh: 'รอบประเมินปิดแล้ว' });
    const e = await this.emp(dto.emp_code);
    const [row] = await this.db.insert(perfReviews).values({
      tenantId: e.tenantId ?? user.tenantId ?? null, cycleId: Number(dto.cycle_id), empCode: dto.emp_code,
      selfRating: dto.self_rating != null ? fx(dto.self_rating, 2) : null, comments: dto.comments ?? null, status: 'self',
    }).returning({ id: perfReviews.id });
    return { id: Number(row!.id), cycle_id: Number(dto.cycle_id), emp_code: dto.emp_code, self_rating: dto.self_rating ?? null, status: 'self' };
  }

  // Manager rating — HR-03: the manager (manager_emp_code) must differ from the reviewee.
  async managerRate(id: number, dto: ManagerRatingDto, _user: JwtUser) {
    const [r] = await this.db.select().from(perfReviews).where(eq(perfReviews.id, Number(id))).limit(1);
    if (!r) throw new NotFoundException({ code: 'REVIEW_NOT_FOUND', message: `Review ${id} not found`, messageTh: 'ไม่พบใบประเมิน' });
    if (r.status === 'signed') throw new BadRequestException({ code: 'REVIEW_SIGNED', message: 'Review already signed', messageTh: 'ใบประเมินลงนามแล้ว' });
    if (dto.manager_emp_code === r.empCode)
      throw new ForbiddenException({ code: 'SOD_SELF_REVIEW', message: 'The reviewee cannot rate/sign their own review', messageTh: 'ผู้ถูกประเมินให้คะแนน/ลงนามใบประเมินของตนเองไม่ได้' });
    await this.db.update(perfReviews).set({
      managerRating: fx(dto.manager_rating, 2), managerEmpCode: dto.manager_emp_code,
      comments: dto.comments ?? r.comments, status: 'manager',
    }).where(eq(perfReviews.id, Number(id)));
    return { id: Number(id), manager_rating: n(dto.manager_rating), manager_emp_code: dto.manager_emp_code, status: 'manager' };
  }

  // Sign-off — HR-03: (1) the review must carry a manager rating; (2) the signer's own employee ≠ the reviewee.
  async signReview(id: number, dto: SignDto, user: JwtUser) {
    const [r] = await this.db.select().from(perfReviews).where(eq(perfReviews.id, Number(id))).limit(1);
    if (!r) throw new NotFoundException({ code: 'REVIEW_NOT_FOUND', message: `Review ${id} not found`, messageTh: 'ไม่พบใบประเมิน' });
    if (r.status === 'signed') return { id: Number(id), status: 'signed', already: true };
    if (r.managerRating == null)
      throw new BadRequestException({ code: 'NO_MANAGER_RATING', message: 'Review has no manager rating to sign off', messageTh: 'ยังไม่มีคะแนนจากผู้จัดการ ให้ลงนามไม่ได้' });
    const signerEmp = await this.callerEmpCode(user);
    if (signerEmp && signerEmp === r.empCode)
      throw new ForbiddenException({ code: 'SOD_SELF_REVIEW', message: 'The reviewee cannot sign off their own review', messageTh: 'ผู้ถูกประเมินลงนามใบประเมินของตนเองไม่ได้' });
    const calibrated = dto.calibrated_rating != null ? fx(dto.calibrated_rating, 2) : (r.calibratedRating ?? r.managerRating);
    await this.db.update(perfReviews).set({
      calibratedRating: calibrated, status: 'signed', signedBy: user.username, signedAt: new Date(),
    }).where(eq(perfReviews.id, Number(id)));
    return { id: Number(id), status: 'signed', signed_by: user.username, calibrated_rating: n(calibrated) };
  }
}
