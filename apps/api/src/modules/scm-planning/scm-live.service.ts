import { Injectable } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { RealtimeBus, type BusEvent } from '../../common/realtime-bus';

// docs/54 — realtime channel for planning events (run completed/failed, plan submitted/approved/
// converted, demand spike). Same shape as BiLiveService: one bus per domain channel, tenant-tagged,
// and the controller re-filters per subscriber so a null-tenant event never fans out.

export interface ScmLiveEvent extends BusEvent {
  type:
    | 'scm_run_completed' | 'scm_run_failed'
    | 'scm_plan_submitted' | 'scm_plan_approved' | 'scm_plan_converted'
    | 'scm_spike'
    | 'scm_accuracy_degraded'; // docs/59 D4 (SCM-07) — a series' realized WAPE sustained above its baseline
}

@Injectable()
export class ScmLiveService {
  private bus = new RealtimeBus<ScmLiveEvent>('ierp:rt:scm');

  publish(event: ScmLiveEvent): void {
    this.bus.publish(event);
  }

  stream(): Observable<ScmLiveEvent> {
    return this.bus.stream();
  }

  recent(tenantId?: number | null, limit = 50): ScmLiveEvent[] {
    return this.bus.recent(tenantId, limit);
  }
}
