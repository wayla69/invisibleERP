import { Injectable } from '@nestjs/common';
import { type Observable } from 'rxjs';
import { RealtimeBus } from '../../common/realtime-bus';

export interface RealtimeEvent { type: string; tenant_id?: number | null; at?: string; [k: string]: any }

// P2a realtime — table/KDS state events over SSE. Backed by the shared RealtimeBus (docs/24 R1-3):
// in-memory on a single node (default), Redis pub/sub across replicas when REALTIME_REDIS_URL is set —
// so a kitchen display connected to node B sees an order fired on node A.
@Injectable()
export class RealtimeService {
  private bus = new RealtimeBus<RealtimeEvent>('ierp:rt:pos');

  publish(event: RealtimeEvent) { this.bus.publish(event); }

  stream(): Observable<RealtimeEvent> { return this.bus.stream(); }

  recent(tenantId?: number | null, limit = 50): RealtimeEvent[] { return this.bus.recent(tenantId, limit); }
}

// Minimal ESC/POS cash-drawer pulse (ESC p m t1 t2) — what a local print agent sends to kick the drawer.
export function drawerKickEscPos(): Buffer {
  return Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
}
