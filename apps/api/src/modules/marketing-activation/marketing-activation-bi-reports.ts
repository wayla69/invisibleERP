import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, isNotNull, lte, sql, gt } from 'drizzle-orm';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { miJourneys, miSaveRuns } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { NbaOrchestratorService } from './nba-orchestrator.service';
import { SaveAutopilotService } from './save-autopilot.service';

// docs/62 Phase 1 — the marketing AUTOPILOT CADENCE: scheduled action jobs over the docs/61 tools,
// discovered by BiReportRegistrarService (never a new branch/ctor param in bi-generate). The jobs only
// ever act as the MAKER: auto-stage attributes `<actor> (auto)` and everything a human must decide stays
// human — journey activation (MKT-22) and policy approval (MKT-24) remain maker-checker (the scheduler's
// synthesized username can never equal a human approver, so SOD is structurally clean). Measurement is a
// read (the MKT-19 discipline) and is idempotent by its own guards.
//
// Idempotency contract (the fx-reval "graceful no-op" pattern):
//  • autostage jobs keep AT MOST ONE auto-staged item in flight (Pending, or Active/unmeasured for
//    journeys; unmeasured for save runs) — a re-run stages nothing and says why;
//  • preconditions that are a human's job (no approved policy, nothing contactable) are caught and
//    reported as a nudge in the summary, never thrown (a schedule must not alert on "waiting for you");
//  • mkt_measure_windows enumerates rows whose window elapsed and measures each once (ALREADY_MEASURED
//    can't recur because the enumeration filters measured_at IS NULL).

const AUTO_SUFFIX = ' (auto)';

@Injectable()
export class MarketingActivationBiReports implements BiReportSource {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly nba: NbaOrchestratorService,
    private readonly save: SaveAutopilotService,
  ) {}

  // The scheduled principal, attributed so requested_by shows the sweep was machine-made (B4 precedent).
  private autoUser(user: JwtUser): JwtUser {
    return { ...user, username: `${user?.username ?? 'system'}${AUTO_SUFFIX}` };
  }

  private errCode(e: any): string | undefined {
    return e?.response?.code ?? (typeof e?.getResponse === 'function' ? (e.getResponse() as { code?: string })?.code : undefined);
  }

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'mkt_nba_autostage',
        generate: async (f, user) => {
          const tenantId = user.tenantId;
          // One auto-staged journey in flight: Pending (awaiting activation) or Active-but-unmeasured.
          const [inFlight] = await this.db.select({ journeyNo: miJourneys.journeyNo, status: miJourneys.status })
            .from(miJourneys)
            .where(and(
              tenantId == null ? sql`false` : eq(miJourneys.tenantId, tenantId),
              sql`${miJourneys.requestedBy} like ${'%' + AUTO_SUFFIX}`,
              sql`(${miJourneys.status} = 'Pending' or (${miJourneys.status} = 'Active' and ${miJourneys.measuredAt} is null))`,
            )).limit(1);
          if (inFlight) {
            return {
              data: { staged: 0, in_flight: inFlight.journeyNo, status: inFlight.status },
              summary: `NBA autostage: ${inFlight.journeyNo} is still in flight (${inFlight.status}) — nothing staged`,
              summaryTh: `จัดแผน NBA อัตโนมัติ: ${inFlight.journeyNo} ยังค้างอยู่ (${inFlight.status}) — ไม่จัดแผนใหม่`,
            };
          }
          try {
            const r: any = await this.nba.stageJourney(this.autoUser(user), {
              segment: typeof f?.segment === 'string' ? f.segment : undefined,
              control_pct: typeof f?.control_pct === 'number' ? f.control_pct : undefined,
              channel: typeof f?.channel === 'string' ? f.channel : undefined,
            });
            return {
              data: { staged: 1, ...r },
              summary: `NBA autostage: staged ${r.journey_no} (${r.treatment_count} treatment / ${r.control_count} control) — awaiting human activation (MKT-22)`,
              summaryTh: `จัดแผน NBA อัตโนมัติ: ${r.journey_no} (ทดลอง ${r.treatment_count} / ควบคุม ${r.control_count}) — รอคนเปิดใช้งาน`,
            };
          } catch (e: any) {
            if (this.errCode(e) === 'NO_TARGETS') {
              return { data: { staged: 0, reason: 'NO_TARGETS' }, summary: 'NBA autostage: no contactable targets — nothing staged', summaryTh: 'จัดแผน NBA อัตโนมัติ: ไม่มีเป้าหมายที่ติดต่อได้ — ไม่จัดแผน' };
            }
            throw e;
          }
        },
      },
      {
        type: 'mkt_save_autostage',
        generate: async (f, user) => {
          const tenantId = user.tenantId;
          // One auto-staged, not-yet-measured save run in flight.
          const [inFlight] = await this.db.select({ runNo: miSaveRuns.runNo })
            .from(miSaveRuns)
            .where(and(
              tenantId == null ? sql`false` : eq(miSaveRuns.tenantId, tenantId),
              sql`${miSaveRuns.requestedBy} like ${'%' + AUTO_SUFFIX}`,
              isNull(miSaveRuns.measuredAt),
            )).limit(1);
          if (inFlight) {
            return {
              data: { staged: 0, in_flight: inFlight.runNo },
              summary: `Save autostage: ${inFlight.runNo} is still unmeasured — nothing staged`,
              summaryTh: `รอบรักษาลูกค้าอัตโนมัติ: ${inFlight.runNo} ยังไม่วัดผล — ไม่จัดรอบใหม่`,
            };
          }
          try {
            const r: any = await this.save.stageRun(this.autoUser(user), {
              segment: typeof f?.segment === 'string' ? f.segment : undefined,
              control_pct: typeof f?.control_pct === 'number' ? f.control_pct : undefined,
              window_days: typeof f?.window_days === 'number' ? f.window_days : undefined,
            });
            return {
              data: { staged: 1, ...r },
              summary: `Save autostage: staged ${r.run_no} (${r.treatment_count} treatment / ${r.control_count} control, cost ${r.offer_cost}) — offers stay capped by the approved policy (MKT-24)`,
              summaryTh: `รอบรักษาลูกค้าอัตโนมัติ: ${r.run_no} (ทดลอง ${r.treatment_count} / ควบคุม ${r.control_count}) — เพดานตามนโยบายที่อนุมัติ`,
            };
          } catch (e: any) {
            const code = this.errCode(e);
            if (code === 'NO_ACTIVE_POLICY') {
              return { data: { staged: 0, reason: code }, summary: 'Save autostage: no APPROVED save-offer policy — stage one and have a different user approve it', summaryTh: 'รอบรักษาลูกค้าอัตโนมัติ: ยังไม่มีนโยบายที่อนุมัติ — ต้องอนุมัติโดยคนก่อน' };
            }
            if (code === 'NO_AT_RISK_TARGETS') {
              return { data: { staged: 0, reason: code }, summary: 'Save autostage: no at-risk, save-worthy, consented customers today — nothing staged', summaryTh: 'รอบรักษาลูกค้าอัตโนมัติ: วันนี้ไม่มีลูกค้าเสี่ยงที่เข้าเกณฑ์ — ไม่จัดรอบ' };
            }
            throw e;
          }
        },
      },
      {
        type: 'mkt_measure_windows',
        generate: async (_f, user) => {
          const tenantId = user.tenantId;
          const now = new Date();
          const tenantCond = (col: any) => (tenantId == null ? sql`false` : eq(col, tenantId));
          // Journeys due: Active, unmeasured, window elapsed, and a control arm exists (NO_CONTROL rows
          // can never be measured — enumerating them would alert forever on a structural fact).
          const dueJourneys = await this.db.select({ journeyNo: miJourneys.journeyNo })
            .from(miJourneys)
            .where(and(tenantCond(miJourneys.tenantId), eq(miJourneys.status, 'Active'), isNull(miJourneys.measuredAt), isNotNull(miJourneys.measureAfter), lte(miJourneys.measureAfter, now), gt(miJourneys.controlCount, 0)));
          const dueRuns = await this.db.select({ runNo: miSaveRuns.runNo })
            .from(miSaveRuns)
            .where(and(tenantCond(miSaveRuns.tenantId), isNull(miSaveRuns.measuredAt), isNotNull(miSaveRuns.measureAfter), lte(miSaveRuns.measureAfter, now), gt(miSaveRuns.controlCount, 0)));

          // measured_by carries the (auto) marker too — the evidence trail shows the machine measured it.
          const journeys: Array<Record<string, unknown>> = [];
          for (const j of dueJourneys) journeys.push(await this.nba.measureJourney(this.autoUser(user), { journey_no: j.journeyNo }));
          const runs: Array<Record<string, unknown>> = [];
          for (const r of dueRuns) runs.push(await this.save.measureRun(this.autoUser(user), { run_no: r.runNo }));

          return {
            data: { measured_journeys: journeys.length, measured_runs: runs.length, journeys, runs },
            summary: `Measured ${journeys.length} journey(s) + ${runs.length} save run(s) whose window elapsed — realized lift now feeds the Segment×Channel ROI ranking (⑤)`,
            summaryTh: `วัดผลแล้ว ${journeys.length} แผน + ${runs.length} รอบที่ครบกำหนด — lift จริงถูกส่งเข้า ROI กลุ่ม × ช่องทาง`,
          };
        },
      },
    ];
  }
}
