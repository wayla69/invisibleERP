import { asc, eq, sql } from 'drizzle-orm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DrizzleDb } from '../../database/database.module';
import { projectPhaseGates, projects } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import type { PhaseGateDto, GateDecisionDto } from './projects.service';

// Ordered project lifecycle. A gate advances the project FORWARD along this ladder; the current phase is the
// target of the latest GO gate (a fresh project sits at 'concept').
const PHASES = ['concept', 'planning', 'execution', 'closeout', 'closed'] as const;
type Phase = (typeof PHASES)[number];
const phaseIdx = (p: string): number => (PHASES as readonly string[]).indexOf(p);

// Phase-gate governance sub-service (PPM Wave P4, PROJ-26) — a PLAIN class built in the ProjectsService ctor
// body (not a DI provider), mirroring ProjectsResourcingService. A project advances through its lifecycle
// phases only through a GATE that is SUBMITTED for review then independently authorised: the reviewer's
// decision (GO/HOLD/KILL) must come from a DIFFERENT user than the submitter (SOD_SELF_APPROVAL), and a GO
// advances the project to the gate's target phase. Prevents a project rolling from one phase to the next —
// or continuing to consume capital — with no documented, segregated authorisation.
export class ProjectsGateService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly rowOf: (code: string) => Promise<any>,
  ) {}

  private async project(code: string): Promise<any> {
    const p = await this.rowOf(code);
    if (!p) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${code} not found`, messageTh: 'ไม่พบโครงการ' });
    return p;
  }

  private async gatesForProject(projectId: number): Promise<any[]> {
    return this.db.select().from(projectPhaseGates).where(eq(projectPhaseGates.projectId, Number(projectId))).orderBy(asc(projectPhaseGates.id));
  }

  // The current phase = the target of the LATEST GO gate (gates are id-ascending; scan for the last 'go').
  private currentPhase(gates: any[]): Phase {
    let phase: Phase = 'concept';
    for (const g of gates) if (g.status === 'go') phase = g.targetPhase as Phase;
    return phase;
  }

  private shape(g: any) {
    return {
      id: Number(g.id), gate_key: g.gateKey, name: g.name, target_phase: g.targetPhase, from_phase: g.fromPhase,
      status: g.status, readiness: g.readiness, submitted_by: g.submittedBy, submitted_at: g.submittedAt,
      decided_by: g.decidedBy, decided_at: g.decidedAt, decision_notes: g.decisionNotes,
    };
  }

  private summary(code: string, gates: any[]) {
    const current = this.currentPhase(gates);
    const ci = phaseIdx(current);
    const nextPhase = ci >= 0 && ci < PHASES.length - 1 ? PHASES[ci + 1] : null;
    const pending = gates.find((g) => g.status === 'pending');
    return {
      project_code: code, current_phase: current, next_phase: nextPhase, phase_ladder: [...PHASES],
      pending_gate: pending ? this.shape(pending) : null,
      gates: gates.map((g) => this.shape(g)),
    };
  }

  async listGates(code: string) {
    const p = await this.project(code);
    return this.summary(code, await this.gatesForProject(Number(p.id)));
  }

  // Submit a gate to advance the project to a target phase. Forward-only along the ladder; only one gate may
  // be pending at a time. Posts nothing until an independent reviewer decides it.
  async submitGate(code: string, dto: PhaseGateDto, user: JwtUser) {
    const p = await this.project(code);
    const gates = await this.gatesForProject(Number(p.id));
    const current = this.currentPhase(gates);
    const target = String(dto.target_phase ?? '');
    if (phaseIdx(target) < 0 || target === 'concept') throw new BadRequestException({ code: 'BAD_PHASE', message: `Unknown target phase '${target}'`, messageTh: 'เฟสปลายทางไม่ถูกต้อง', details: { allowed: PHASES.filter((x) => x !== 'concept') } });
    if (phaseIdx(target) <= phaseIdx(current)) throw new BadRequestException({ code: 'BAD_PHASE_ORDER', message: `Target phase '${target}' does not advance the project past its current phase '${current}'`, messageTh: 'เฟสปลายทางต้องอยู่ถัดจากเฟสปัจจุบัน', details: { current_phase: current, target_phase: target } });
    if (gates.some((g) => g.status === 'pending')) throw new BadRequestException({ code: 'GATE_ALREADY_PENDING', message: 'A phase gate is already pending review for this project', messageTh: 'มีเกตที่รอการพิจารณาอยู่แล้ว' });
    await this.db.insert(projectPhaseGates).values({
      tenantId: user.tenantId ?? null, projectId: Number(p.id),
      gateKey: (dto.gate_key ?? '').trim() || `G_${target.toUpperCase()}`, name: dto.name ?? null,
      targetPhase: target, fromPhase: current, status: 'pending', readiness: dto.readiness ?? null,
      submittedBy: user.username,
    });
    return this.summary(code, await this.gatesForProject(Number(p.id)));
  }

  // Independently decide a pending gate: GO advances the project, HOLD/KILL record the outcome without
  // advancing. The decider must differ from the submitter (segregation of duties).
  async decideGate(gateId: number, dto: GateDecisionDto, user: JwtUser) {
    const db = this.db;
    const [g] = await db.select().from(projectPhaseGates).where(eq(projectPhaseGates.id, Number(gateId))).limit(1);
    if (!g) throw new NotFoundException({ code: 'GATE_NOT_FOUND', message: `Phase gate ${gateId} not found`, messageTh: 'ไม่พบเกต' });
    if (g.status !== 'pending') throw new BadRequestException({ code: 'GATE_ALREADY_DECIDED', message: `Gate is already ${g.status}`, messageTh: 'เกตถูกตัดสินแล้ว' });
    const decision = String(dto.decision ?? '');
    if (!['go', 'hold', 'kill'].includes(decision)) throw new BadRequestException({ code: 'BAD_DECISION', message: "Decision must be 'go', 'hold', or 'kill'", messageTh: 'การตัดสินต้องเป็น go / hold / kill' });
    await assertMakerChecker(db, { user, maker: g.submittedBy, event: 'proj.gate.decide', ref: String(gateId), reason: dto.self_approval_reason, code: 'SOD_SELF_APPROVAL', message: 'The reviewer must differ from the gate submitter (segregation of duties)', messageTh: 'ผู้พิจารณาต้องไม่ใช่ผู้ยื่นเกต (แบ่งแยกหน้าที่)', httpStatus: 400 });
    await db.update(projectPhaseGates).set({
      status: decision, decidedBy: user.username, decidedAt: sql`now()`, decisionNotes: dto.notes ?? null, updatedAt: sql`now()`,
    }).where(eq(projectPhaseGates.id, Number(g.id)));
    const [proj] = await db.select({ code: projects.projectCode }).from(projects).where(eq(projects.id, Number(g.projectId))).limit(1);
    return this.summary(proj?.code ?? '', await this.gatesForProject(Number(g.projectId)));
  }
}
