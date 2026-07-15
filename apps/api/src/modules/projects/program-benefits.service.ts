import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DrizzleDb } from '../../database/database.module';
import { programBenefits, programBenefitMeasurements, projects } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import { r2 } from './projects.helpers';
import type { JwtUser } from '../../common/decorators';
import type { BenefitDto, BenefitMeasurementDto, BenefitConfirmDto } from './projects.service';

// Program benefits-realization sub-service (PPM Wave P4, PROJ-27) — a PLAIN class built in the ProjectsService
// ctor body (not a DI provider), mirroring ProjectsPortfolioService. Benefits justify a program's investment:
// a program declares expected benefits (baseline → target by a date), actuals are logged over time
// (append-only), and the realization view compares actual vs target and flags shortfalls. CLOSING a benefit
// (realized / not_realized) is a maker-checker sign-off — the confirmer must differ from the benefit's author
// (SOD_SELF_APPROVAL) — so a program owner can't self-certify that promised value was delivered.
export class ProgramBenefitsService {
  constructor(private readonly db: DrizzleDb) {}

  private tid(user: JwtUser): number | null {
    return user.tenantId ?? null;
  }

  // A program is identified by projects.program_code — validate at least one project carries it.
  private async assertProgram(programCode: string): Promise<void> {
    const [p] = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.programCode, programCode)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: `No project belongs to program ${programCode}`, messageTh: 'ไม่พบโปรแกรม' });
  }

  private async benefitById(id: number): Promise<any> {
    const [b] = await this.db.select().from(programBenefits).where(eq(programBenefits.id, Number(id))).limit(1);
    if (!b) throw new NotFoundException({ code: 'BENEFIT_NOT_FOUND', message: `Benefit ${id} not found`, messageTh: 'ไม่พบผลประโยชน์' });
    return b;
  }

  async declareBenefit(programCode: string, dto: BenefitDto, user: JwtUser) {
    const db = this.db;
    await this.assertProgram(programCode);
    const name = (dto.name ?? '').trim();
    if (!name) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'A benefit name is required', messageTh: 'ต้องระบุชื่อผลประโยชน์' });
    if (dto.target_value == null) throw new BadRequestException({ code: 'TARGET_REQUIRED', message: 'A target value is required', messageTh: 'ต้องระบุค่าเป้าหมาย' });
    const [cnt] = await db.select({ c: sql<string>`count(*)` }).from(programBenefits);
    const benefitNo = `PB-${String(Number(n(cnt?.c)) + 1).padStart(4, '0')}`;
    await db.insert(programBenefits).values({
      tenantId: this.tid(user), programCode, benefitNo, name,
      category: dto.category === 'non_financial' ? 'non_financial' : 'financial',
      unit: dto.unit ?? null, baselineValue: r2(n(dto.baseline_value ?? 0)).toFixed(2),
      targetValue: r2(n(dto.target_value)).toFixed(2), targetDate: dto.target_date ?? null,
      owner: dto.owner ?? null, status: 'open', createdBy: user.username,
    });
    return this.listBenefits(programCode);
  }

  // Append an actual measurement. The benefit must still be open (a closed benefit's realization is settled).
  async recordMeasurement(benefitId: number, dto: BenefitMeasurementDto, user: JwtUser) {
    const b = await this.benefitById(benefitId);
    if (b.status !== 'open') throw new BadRequestException({ code: 'BENEFIT_CLOSED', message: `Benefit is already ${b.status}`, messageTh: 'ผลประโยชน์ถูกปิดแล้ว' });
    if (dto.measured_value == null) throw new BadRequestException({ code: 'VALUE_REQUIRED', message: 'A measured value is required', messageTh: 'ต้องระบุค่าที่วัดได้' });
    await this.db.insert(programBenefitMeasurements).values({
      tenantId: this.tid(user), benefitId: Number(b.id),
      measuredValue: r2(n(dto.measured_value)).toFixed(2), measuredAt: dto.measured_at ?? ymd(),
      note: dto.note ?? null, recordedBy: user.username,
    });
    return this.listBenefits(b.programCode);
  }

  // Maker-checker closure: mark the benefit realized / not_realized. The confirmer must differ from the
  // benefit's author, and only an open benefit can be closed.
  async confirmBenefit(benefitId: number, dto: BenefitConfirmDto, user: JwtUser) {
    const db = this.db;
    const b = await this.benefitById(benefitId);
    if (b.status !== 'open') throw new BadRequestException({ code: 'BENEFIT_ALREADY_CONFIRMED', message: `Benefit is already ${b.status}`, messageTh: 'ผลประโยชน์ถูกยืนยันแล้ว' });
    const result = dto.result === 'not_realized' ? 'not_realized' : dto.result === 'realized' ? 'realized' : null;
    if (!result) throw new BadRequestException({ code: 'BAD_RESULT', message: "result must be 'realized' or 'not_realized'", messageTh: 'ผลต้องเป็น realized หรือ not_realized' });
    if (b.createdBy === user.username) throw new BadRequestException({ code: 'SOD_SELF_APPROVAL', message: 'The confirmer must differ from the benefit author (segregation of duties)', messageTh: 'ผู้ยืนยันต้องไม่ใช่ผู้สร้าง (แบ่งแยกหน้าที่)' });
    await db.update(programBenefits).set({
      status: result, confirmedBy: user.username, confirmedAt: sql`now()`, confirmNotes: dto.notes ?? null, updatedAt: sql`now()`,
    }).where(eq(programBenefits.id, Number(b.id)));
    return this.listBenefits(b.programCode);
  }

  async listBenefits(programCode: string) {
    const db = this.db;
    const rows = await db.select().from(programBenefits).where(eq(programBenefits.programCode, programCode)).orderBy(asc(programBenefits.id));
    const ids = rows.map((r: any) => Number(r.id));
    // Latest measurement per benefit (most recent measured_at, tie-broken by id).
    const measurements = ids.length
      ? await db.select().from(programBenefitMeasurements).where(inArray(programBenefitMeasurements.benefitId, ids)).orderBy(desc(programBenefitMeasurements.measuredAt), desc(programBenefitMeasurements.id))
      : [];
    const latestByBenefit = new Map<number, any>();
    const countByBenefit = new Map<number, number>();
    for (const m of measurements) {
      const bid = Number(m.benefitId);
      countByBenefit.set(bid, (countByBenefit.get(bid) ?? 0) + 1);
      if (!latestByBenefit.has(bid)) latestByBenefit.set(bid, m);
    }

    const today = ymd();
    const shaped = rows.map((b: any) => {
      const baseline = n(b.baselineValue), target = n(b.targetValue);
      const latest = latestByBenefit.get(Number(b.id));
      const actual = latest ? n(latest.measuredValue) : baseline;
      const range = target - baseline;
      const pct = range !== 0 ? r2(((actual - baseline) / range) * 100) : (actual >= target ? 100 : 0);
      const overdue = b.status === 'open' && !!b.targetDate && String(b.targetDate) < today && pct < 100;
      const health = b.status === 'realized' ? 'realized' : b.status === 'not_realized' ? 'not_realized'
        : pct >= 100 ? 'met' : pct >= 50 ? 'on_track' : 'at_risk';
      return {
        id: Number(b.id), benefit_no: b.benefitNo, name: b.name, category: b.category, unit: b.unit,
        baseline_value: baseline, target_value: target, target_date: b.targetDate, owner: b.owner,
        status: b.status, current_actual: actual, realization_pct: pct, overdue, health,
        measurements_count: countByBenefit.get(Number(b.id)) ?? 0,
        created_by: b.createdBy, confirmed_by: b.confirmedBy, confirmed_at: b.confirmedAt,
      };
    });

    const fin = shaped.filter((s) => s.category === 'financial');
    const rollup = {
      benefit_count: shaped.length,
      financial_target: r2(fin.reduce((t, s) => t + s.target_value, 0)),
      financial_actual: r2(fin.reduce((t, s) => t + s.current_actual, 0)),
      realized_count: shaped.filter((s) => s.status === 'realized').length,
      not_realized_count: shaped.filter((s) => s.status === 'not_realized').length,
      at_risk_count: shaped.filter((s) => s.status === 'open' && (s.overdue || s.health === 'at_risk')).length,
      avg_realization_pct: shaped.length ? r2(shaped.reduce((t, s) => t + s.realization_pct, 0) / shaped.length) : 0,
    };
    return { program_code: programCode, benefits: shaped, rollup };
  }
}
