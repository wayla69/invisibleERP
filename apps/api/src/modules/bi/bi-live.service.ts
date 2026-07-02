import { Injectable } from '@nestjs/common';
import { type Observable } from 'rxjs';
import { RealtimeBus } from '../../common/realtime-bus';

export interface BiLiveEvent { type: string; tenant_id?: number | null; at?: string; [k: string]: any }

// Real-time streaming analytics (docs/22 Phase B) — live KPI/business signals over SSE. Backed by the
// shared RealtimeBus (docs/24 R1-3): in-memory on a single node (default), Redis pub/sub across replicas
// when REALTIME_REDIS_URL is set — so an event published on node A reaches an SSE client on node B.
@Injectable()
export class BiLiveService {
  private bus = new RealtimeBus<BiLiveEvent>('ierp:rt:bi');

  publish(event: BiLiveEvent): void { this.bus.publish(event); }

  stream(): Observable<BiLiveEvent> { return this.bus.stream(); }

  recent(tenantId?: number | null, limit = 50): BiLiveEvent[] { return this.bus.recent(tenantId, limit); }
}
