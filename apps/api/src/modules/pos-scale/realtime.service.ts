import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';

export interface RealtimeEvent { type: string; tenant_id?: number | null; at?: string; [k: string]: any }

// P2a realtime — in-process event bus for table/KDS state. publish() fans out to SSE subscribers and
// keeps a small ring buffer so a terminal that just connected (or a test) can read recent activity.
// In-memory + per-process: fine for a single API node; a multi-node deploy would back this with Redis pub/sub.
@Injectable()
export class RealtimeService {
  private subject = new Subject<RealtimeEvent>();
  private buffer: RealtimeEvent[] = [];

  publish(event: RealtimeEvent) {
    const e = { ...event };
    this.buffer.push(e);
    if (this.buffer.length > 200) this.buffer.shift();
    this.subject.next(e);
  }

  stream(): Observable<RealtimeEvent> { return this.subject.asObservable(); }

  recent(tenantId?: number | null, limit = 50): RealtimeEvent[] {
    const rows = tenantId == null ? this.buffer : this.buffer.filter((e) => e.tenant_id == null || e.tenant_id === tenantId);
    return rows.slice(-limit).reverse();
  }
}

// Minimal ESC/POS cash-drawer pulse (ESC p m t1 t2) — what a local print agent sends to kick the drawer.
export function drawerKickEscPos(): Buffer {
  return Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
}
