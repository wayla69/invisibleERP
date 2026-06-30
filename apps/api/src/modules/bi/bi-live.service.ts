import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';

export interface BiLiveEvent { type: string; tenant_id?: number | null; at?: string; [k: string]: any }

// Real-time streaming analytics (docs/22 Phase B) — an in-process event bus for live KPI/business signals,
// mirroring the proven pos-scale RealtimeService pattern. publish() fans out to SSE subscribers and keeps a
// small per-tenant-filterable ring buffer so a dashboard that just connected (or a harness) can read the
// recent feed over HTTP. In-memory + per-process: fine for a single API node; a multi-node deploy would back
// it with Redis pub/sub (out of scope, see docs/22 §5).
@Injectable()
export class BiLiveService {
  private subject = new Subject<BiLiveEvent>();
  private buffer: BiLiveEvent[] = [];

  publish(event: BiLiveEvent): void {
    const e = { at: new Date().toISOString(), ...event };
    this.buffer.push(e);
    if (this.buffer.length > 200) this.buffer.shift();
    this.subject.next(e);
  }

  stream(): Observable<BiLiveEvent> { return this.subject.asObservable(); }

  recent(tenantId?: number | null, limit = 50): BiLiveEvent[] {
    const rows = tenantId == null ? this.buffer : this.buffer.filter((e) => e.tenant_id == null || e.tenant_id === tenantId);
    return rows.slice(-limit).reverse();
  }
}
