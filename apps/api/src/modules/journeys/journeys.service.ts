import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, desc, lte, isNotNull, gte, sql, inArray } from 'drizzle-orm';
import { DRIZZLE, runGlobalDb, type DrizzleDb } from '../../database/database.module';
import { journeys, journeySteps, journeyEnrollments, posMembers, messageLog, customerProfiles } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { MessagingService } from '../messaging/messaging.service';
import { SavedSegmentsService, type SegmentRule } from '../loyalty/saved-segments.service';
import type { JwtUser } from '../../common/decorators';

// Phase G1 (docs/25) — lifecycle journeys. A journey is a LINEAR list of steps (wait N days → send
// channel/body unless the step's skip-rule matches the member). The runner claims each due enrollment-step
// with an atomic guarded UPDATE (next_run_at is NULLed by the claim, so a concurrent/re-run gets 0 rows —
// at-most-once per step, mirroring the MKT-10 campaign claim; a crash mid-send strands the step rather than
// duplicating it). Sends go through MessagingService (opted-out ⇒ 'skipped', audited in message_log with
// campaign = journey:<code>:<step>) and are FREQUENCY-CAPPED per member. EVERY query is explicitly
// tenant-scoped (the cron/Admin path bypasses RLS). Control: MKT-12.
@Injectable()
export class JourneysService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly messaging: MessagingService,
    private readonly segments: SavedSegmentsService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  async list(user: JwtUser) {
    const db = this.db; const tenantId = this.tid(user);
    const rows = await db.select().from(journeys).where(eq(journeys.tenantId, tenantId)).orderBy(desc(journeys.id));
    const ids = rows.map((r: any) => Number(r.id));
    const steps = ids.length ? await db.select().from(journeySteps).where(and(eq(journeySteps.tenantId, tenantId), inArray(journeySteps.journeyId, ids))) : [];
    const enr = ids.length ? await db.select({ journeyId: journeyEnrollments.journeyId, status: journeyEnrollments.status, c: sql<number>`count(*)` })
      .from(journeyEnrollments).where(and(eq(journeyEnrollments.tenantId, tenantId), inArray(journeyEnrollments.journeyId, ids)))
      .groupBy(journeyEnrollments.journeyId, journeyEnrollments.status) : [];
    return {
      journeys: rows.map((r: any) => {
        const jid = Number(r.id);
        const funnel: Record<string, number> = { active: 0, completed: 0, exited: 0 };
        for (const e of enr) if (Number(e.journeyId) === jid) funnel[e.status] = Number(e.c);
        return { ...shape(r), steps: steps.filter((s: any) => Number(s.journeyId) === jid).sort((a: any, b: any) => a.stepNo - b.stepNo).map(shapeStep), funnel };
      }),
    };
  }

  // Create/edit a journey + its steps (steps replaced wholesale). Only a draft/paused journey may be edited.
  async upsert(dto: any, user: JwtUser) {
    const db = this.db; const tenantId = this.tid(user);
    const stepsIn: any[] = Array.isArray(dto.steps) ? dto.steps : [];
    if (!stepsIn.length) throw new BadRequestException({ code: 'NO_STEPS', message: 'at least one step required', messageTh: 'ต้องมีอย่างน้อย 1 ขั้นตอน' });
    for (let i = 0; i < stepsIn.length; i++) {
      const s = stepsIn[i];
      if (!s.body || !String(s.body).trim()) throw new BadRequestException({ code: 'NO_BODY', message: 'every step needs a body', messageTh: 'ทุกขั้นตอนต้องมีข้อความ' });
      if (s.skip_rule) await this.segments.memberMatchesRule(db, tenantId, -1, s.skip_rule as SegmentRule); // whitelist-validate (member -1 never matches)
      // H1 branch: FORWARD-ONLY (> this step, within the journey) so every path terminates by construction.
      if (s.branch_to_step != null) {
        const target = Number(s.branch_to_step);
        if (!s.branch_rule) throw new BadRequestException({ code: 'BAD_BRANCH', message: 'branch_to_step requires a branch_rule', messageTh: 'การข้ามขั้นต้องมีเงื่อนไข' });
        if (!Number.isInteger(target) || target <= i + 1 || target > stepsIn.length) throw new BadRequestException({ code: 'BAD_BRANCH', message: `branch_to_step must be a later step (got ${target} from step ${i + 1} of ${stepsIn.length})`, messageTh: 'ข้ามได้เฉพาะขั้นถัด ๆ ไปเท่านั้น' });
        await this.segments.memberMatchesRule(db, tenantId, -1, s.branch_rule as SegmentRule);
      }
    }
    if (dto.trigger === 'segment') {
      if (!dto.segment_id) throw new BadRequestException({ code: 'NO_SEGMENT', message: 'segment_id required for a segment-triggered journey', messageTh: 'ต้องระบุเซกเมนต์' });
      await this.segments.membersForSend(db, tenantId, Number(dto.segment_id)); // fail fast on unknown/foreign
    }
    const vals: any = {
      name: dto.name, trigger: dto.trigger === 'segment' ? 'segment' : 'manual',
      segmentId: dto.trigger === 'segment' ? Number(dto.segment_id) : null,
      capMessages: Math.max(0, Number(dto.cap_messages ?? 0)), capWindowDays: Math.max(1, Number(dto.cap_window_days ?? 7)),
      defaultSendHour: Math.min(23, Math.max(0, Number(dto.default_send_hour ?? 10))),
    };
    let row: any;
    if (dto.id) {
      const [cur] = await db.select().from(journeys).where(and(eq(journeys.id, dto.id), eq(journeys.tenantId, tenantId))).limit(1);
      if (!cur) throw new NotFoundException({ code: 'JOURNEY_NOT_FOUND', message: 'Journey not found', messageTh: 'ไม่พบเจอร์นีย์' });
      if (cur.status === 'active') throw new ConflictException({ code: 'JOURNEY_ACTIVE', message: 'Pause the journey before editing', messageTh: 'ต้องพักเจอร์นีย์ก่อนแก้ไข' });
      [row] = await db.update(journeys).set(vals).where(and(eq(journeys.id, dto.id), eq(journeys.tenantId, tenantId))).returning();
      await db.delete(journeySteps).where(and(eq(journeySteps.journeyId, dto.id), eq(journeySteps.tenantId, tenantId)));
    } else {
      const code = await this.docNo.nextDaily('JNY');
      [row] = await db.insert(journeys).values({ ...vals, tenantId, code, createdBy: user.username }).returning();
    }
    const jid = Number(row.id);
    await db.insert(journeySteps).values(stepsIn.map((s: any, i: number) => ({
      tenantId, journeyId: jid, stepNo: i + 1, waitDays: Math.max(0, Number(s.wait_days ?? 0)),
      channel: ['sms', 'email', 'line'].includes(s.channel) ? s.channel : 'sms', body: String(s.body), skipRule: s.skip_rule ?? null,
      branchRule: s.branch_to_step != null ? (s.branch_rule ?? null) : null,
      branchToStep: s.branch_to_step != null ? Number(s.branch_to_step) : null,
    })));
    return { ...shape(row), steps: stepsIn.length };
  }

  async setStatus(id: number, status: 'active' | 'paused', user: JwtUser) {
    const db = this.db; const tenantId = this.tid(user);
    const [r] = await db.update(journeys).set({ status }).where(and(eq(journeys.id, id), eq(journeys.tenantId, tenantId))).returning();
    if (!r) throw new NotFoundException({ code: 'JOURNEY_NOT_FOUND', message: 'Journey not found', messageTh: 'ไม่พบเจอร์นีย์' });
    return shape(r);
  }

  // Enrol one member (manual/API/automation `enroll_journey`). Once-per-member: the unique index dedupes —
  // a re-enrol is a silent no-op (returns enrolled:false). Step 1's wait starts from NOW.
  async enroll(journeyId: number, memberId: number, user: JwtUser, tenantIdOverride?: number) {
    const db = this.db; const tenantId = tenantIdOverride ?? this.tid(user);
    const [j] = await db.select().from(journeys).where(and(eq(journeys.id, journeyId), eq(journeys.tenantId, tenantId))).limit(1);
    if (!j) throw new NotFoundException({ code: 'JOURNEY_NOT_FOUND', message: 'Journey not found', messageTh: 'ไม่พบเจอร์นีย์' });
    if (j.status !== 'active') throw new ConflictException({ code: 'JOURNEY_NOT_ACTIVE', message: 'Journey is not active', messageTh: 'เจอร์นีย์ยังไม่เปิดใช้งาน' });
    const [m] = await db.select({ id: posMembers.id }).from(posMembers).where(and(eq(posMembers.id, memberId), eq(posMembers.tenantId, tenantId), eq(posMembers.active, true))).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const [s1] = await db.select().from(journeySteps).where(and(eq(journeySteps.journeyId, journeyId), eq(journeySteps.stepNo, 1))).limit(1);
    if (!s1) throw new ConflictException({ code: 'NO_STEPS', message: 'Journey has no steps', messageTh: 'เจอร์นีย์ไม่มีขั้นตอน' });
    let nextRunAt = new Date(Date.now() + Number(s1.waitDays) * 86400_000);
    if (Number(s1.waitDays) > 0) nextRunAt = snapForwardToHour(nextRunAt, await this.sendHourFor(db, tenantId, memberId, j)); // H3: right-time send
    const res = await db.insert(journeyEnrollments)
      .values({ tenantId, journeyId, memberId, currentStep: 1, status: 'active', nextRunAt })
      .onConflictDoNothing({ target: [journeyEnrollments.journeyId, journeyEnrollments.memberId] })
      .returning({ id: journeyEnrollments.id });
    return { journey_id: journeyId, member_id: memberId, enrolled: res.length > 0, next_run_at: res.length ? nextRunAt : null };
  }

  // Cron entry — run every ACTIVE journey for the caller's tenant (Admin/HQ ⇒ all tenants with active
  // journeys). @NoTx route: each claim/send/audit auto-commits (gateway sends are irreversible).
  async runDueAll(user: JwtUser) {
    // @NoTx cron sweep: reads/writes across every active tenant on the base pool, each filtered EXPLICITLY by
    // tenant_id. Declared global so the fail-closed proxy (STRICT_TENANT_PROXY) permits the base-pool access.
    return runGlobalDb('journeys:run-due-all', async () => {
      const db = this.db;
      let tenantIds: number[];
      if (user.role === 'Admin' || user.tenantId == null) {
        const rows = await db.selectDistinct({ tid: journeys.tenantId }).from(journeys).where(eq(journeys.status, 'active'));
        tenantIds = rows.map((r: any) => Number(r.tid)).filter((x: number) => x > 0);
      } else tenantIds = [this.tid(user)];
      const results: any[] = []; let totalSent = 0, totalSkipped = 0;
      for (const tid of tenantIds) {
        const r = await this.runDue(tid, user.username ?? 'system:journey-cron');
        totalSent += r.sent; totalSkipped += r.skipped;
        results.push({ tenant_id: tid, ...r });
      }
      return { tenants_processed: tenantIds.length, sent: totalSent, skipped: totalSkipped, results };
    });
  }

  // One tenant's sweep: (1) segment-triggered journeys enrol newly-matching members (unique key dedupes);
  // (2) due enrollment-steps are CLAIMED then executed. Best-effort per enrollment.
  async runDue(tenantId: number, actor: string) {
    const db = this.db;
    const act = await db.select().from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.status, 'active')));
    let enrolled = 0, sent = 0, skipped = 0, completed = 0;
    const sysUser = { tenantId, username: actor, role: 'System' } as unknown as JwtUser;

    for (const j of act) {
      if (j.trigger === 'segment' && j.segmentId) {
        let members: any[] = [];
        try { members = await this.segments.membersForSend(db, tenantId, Number(j.segmentId)); } catch { members = []; }
        for (const m of members) {
          try { const r = await this.enroll(Number(j.id), Number(m.id), sysUser, tenantId); if (r.enrolled) enrolled++; } catch { /* keep going */ }
        }
      }
    }

    const jm = new Map<number, any>(act.map((j: any) => [Number(j.id), j]));
    const due = await db.select().from(journeyEnrollments).where(and(
      eq(journeyEnrollments.tenantId, tenantId), eq(journeyEnrollments.status, 'active'),
      isNotNull(journeyEnrollments.nextRunAt), lte(journeyEnrollments.nextRunAt, new Date()),
      inArray(journeyEnrollments.journeyId, [...jm.keys()].length ? [...jm.keys()] : [-1]),
    ));
    for (const e of due) {
      // CLAIM: null the due-marker atomically; a concurrent runner / re-run claims 0 rows → at-most-once.
      const [claimed] = await db.update(journeyEnrollments).set({ nextRunAt: null })
        .where(and(eq(journeyEnrollments.id, Number(e.id)), eq(journeyEnrollments.tenantId, tenantId),
          eq(journeyEnrollments.status, 'active'), isNotNull(journeyEnrollments.nextRunAt))).returning();
      if (!claimed) continue;
      const j = jm.get(Number(e.journeyId));
      let deferred = false;
      try {
        const r = await this.executeStep(db, tenantId, j, claimed, actor);
        if (r === 'deferred') {
          // W3 quiet-hours deferral: re-arm the SAME step at the retry time — no advance, nothing was sent.
          const retryAt = this.deferredUntil ?? new Date(Date.now() + 3600_000);
          this.deferredUntil = null;
          await db.update(journeyEnrollments).set({ nextRunAt: retryAt })
            .where(and(eq(journeyEnrollments.id, Number(e.id)), eq(journeyEnrollments.tenantId, tenantId)));
          skipped++; deferred = true;
        } else if (r === 'sent') sent++; else if (r === 'completed') completed++; else skipped++;
      } catch { skipped++; }
      if (deferred) continue;
      // Advance (or complete) — even after a skip, so a capped/skipped member still moves through.
      // H1 branch decision: if the just-executed step has a matching branch_rule, jump FORWARD to its
      // target instead of step+1 (forward-only is enforced at create, so this always progresses).
      let nextNo = Number(claimed.currentStep) + 1;
      const [curStep] = await db.select().from(journeySteps).where(and(eq(journeySteps.journeyId, Number(e.journeyId)), eq(journeySteps.stepNo, Number(claimed.currentStep)))).limit(1);
      if (curStep?.branchRule && curStep?.branchToStep != null && Number(curStep.branchToStep) > Number(claimed.currentStep)) {
        try { if (await this.segments.memberMatchesRule(db, tenantId, Number(claimed.memberId), curStep.branchRule as SegmentRule)) nextNo = Number(curStep.branchToStep); } catch { /* bad rule ⇒ linear path */ }
      }
      const [next] = await db.select().from(journeySteps).where(and(eq(journeySteps.journeyId, Number(e.journeyId)), eq(journeySteps.stepNo, nextNo))).limit(1);
      if (next) {
        let nextAt = new Date(Date.now() + Number(next.waitDays) * 86400_000);
        if (Number(next.waitDays) > 0) nextAt = snapForwardToHour(nextAt, await this.sendHourFor(db, tenantId, Number(claimed.memberId), j)); // H3
        await db.update(journeyEnrollments).set({
          currentStep: nextNo, lastStepAt: new Date(),
          nextRunAt: nextAt,
        }).where(and(eq(journeyEnrollments.id, Number(e.id)), eq(journeyEnrollments.tenantId, tenantId)));
      } else {
        await db.update(journeyEnrollments).set({ status: 'completed', lastStepAt: new Date() })
          .where(and(eq(journeyEnrollments.id, Number(e.id)), eq(journeyEnrollments.tenantId, tenantId)));
        completed++;
      }
    }
    return { enrolled, sent, skipped, completed };
  }

  // H3 — the hour a member should be messaged at: their own preferred_hour (histogram mode, v2 scoring)
  // else the journey's default_send_hour.
  private async sendHourFor(db: any, tenantId: number, memberId: number, j: any): Promise<number> {
    const [p] = await db.select({ h: customerProfiles.preferredHour }).from(customerProfiles)
      .where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.memberId, memberId))).limit(1);
    return p?.h != null ? Number(p.h) : Number(j?.defaultSendHour ?? 10);
  }

  // Execute one claimed step: skip-rule → frequency cap → consent-respecting send (audited in message_log).
  // 'deferred' = the governance quiet window blocked the send; runDue re-arms the SAME step (W3, docs/27).
  private async executeStep(db: any, tenantId: number, j: any, enr: any, actor: string): Promise<'sent' | 'skipped' | 'completed' | 'deferred'> {
    const [step] = await db.select().from(journeySteps).where(and(eq(journeySteps.journeyId, Number(enr.journeyId)), eq(journeySteps.stepNo, Number(enr.currentStep)))).limit(1);
    if (!step) return 'completed';
    const memberId = Number(enr.memberId);
    const sysUser = { tenantId, username: actor, role: 'System' } as unknown as JwtUser;
    if (step.skipRule) {
      try { if (await this.segments.memberMatchesRule(db, tenantId, memberId, step.skipRule)) return 'skipped'; } catch { /* bad rule ⇒ don't skip */ }
    }
    if (Number(j?.capMessages ?? 0) > 0) {
      const since = new Date(Date.now() - Number(j.capWindowDays ?? 7) * 86400_000);
      const [c] = await db.select({ c: sql<number>`count(*)` }).from(messageLog).where(and(
        eq(messageLog.tenantId, tenantId), eq(messageLog.memberId, memberId),
        eq(messageLog.status, 'sent'), gte(messageLog.createdAt, since), sql`${messageLog.campaign} LIKE 'journey:%'`));
      if (Number(c?.c ?? 0) >= Number(j.capMessages)) {
        // Audited skip — the cap is a control outcome, not a silent drop.
        await db.insert(messageLog).values({ tenantId, memberId, channel: step.channel, recipient: null, body: step.body, campaign: `journey:${j.code}:${step.stepNo}`, status: 'skipped', provider: null, error: 'frequency cap', createdBy: actor });
        return 'skipped';
      }
    }
    const res: any = await this.messaging.send({ member_id: memberId, channel: step.channel, body: step.body, campaign: `journey:${j.code}:${step.stepNo}` }, sysUser);
    // W3 (docs/27) — a quiet-hours governance deferral re-snaps the SAME step to the retry time instead of
    // advancing past an unsent message. Safe under claim-first: nothing was delivered, so re-arming the
    // due-marker cannot double-send; the step simply fires when the quiet window ends.
    if (res?.status === 'skipped' && res?.error === 'quiet hours' && res?.retry_at) { this.deferredUntil = new Date(res.retry_at); return 'deferred'; }
    return res?.status === 'sent' ? 'sent' : 'skipped';
  }
  // Per-execution deferral marker (set by executeStep when governance defers a send; consumed by runDue).
  private deferredUntil: Date | null = null;
}

// H3 (docs/26) — snap a scheduled time FORWARD to the target hour (Asia/Bangkok). Never backward, so a
// wait can only grow by <24h and cadence contracts hold; immediate steps (wait 0) are not snapped at all.
export function snapForwardToHour(base: Date, hourBkk: number): Date {
  const h = Math.min(23, Math.max(0, Math.floor(hourBkk)));
  const d = new Date(base.getTime() + 7 * 3600_000); // shift into BKK wall-clock
  const snapped = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, 0, 0) - 7 * 3600_000;
  return new Date(snapped >= base.getTime() ? snapped : snapped + 86_400_000);
}

function shape(r: any) {
  return {
    id: Number(r.id), code: r.code, name: r.name, status: r.status, trigger: r.trigger,
    segment_id: r.segmentId != null ? Number(r.segmentId) : null,
    cap_messages: Number(r.capMessages ?? 0), cap_window_days: Number(r.capWindowDays ?? 7),
    default_send_hour: Number(r.defaultSendHour ?? 10),
    created_at: r.createdAt,
  };
}
function shapeStep(s: any) {
  return { step_no: s.stepNo, wait_days: Number(s.waitDays), channel: s.channel, body: s.body, skip_rule: s.skipRule ?? null, branch_rule: s.branchRule ?? null, branch_to_step: s.branchToStep != null ? Number(s.branchToStep) : null };
}
