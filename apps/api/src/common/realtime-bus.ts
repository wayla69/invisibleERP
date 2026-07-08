// Shared realtime event bus (docs/27 R1-3 / AUD-ARC-03).
// The two SSE buses (pos-scale RealtimeService, bi BiLiveService) were in-memory rxjs Subjects — correct on
// a single API node, but on 2+ replicas an event published on node A silently never reaches an SSE client
// connected to node B (live KDS / live BI dropouts). This bus keeps the exact same public surface
// (publish / stream / recent ring buffer) and adds an OPTIONAL cross-node transport:
//
//   REALTIME_REDIS_URL unset (default, CI/PGlite, single-node) → pure in-memory, behavior unchanged.
//   REALTIME_REDIS_URL set → every publish goes out via Redis pub/sub and the local subject/buffer are fed
//   ONLY from the subscription — one delivery path, so our own messages aren't double-delivered and every
//   node (including the publisher) sees the identical stream.
//
// The `recent()` ring buffer stays per-process by design: a freshly started node has an empty buffer until
// events flow (documented in docs/ops/deployment.md). If the Redis publish fails, the event falls back to
// LOCAL delivery (same-node clients still update) and a throttled ops alert fires — degraded, not silent.
import { Subject, type Observable } from 'rxjs';
import { captureOpsAlert } from '../observability/instrumentation';

export interface BusEvent { type: string; tenant_id?: number | null; at?: string; [k: string]: any }

// Minimal cross-node transport contract — production uses ioredis; tests inject a fake.
export interface RealtimeTransport {
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string, onMessage: (message: string) => void): Promise<unknown>;
  close?(): Promise<unknown>;
}

// Lazily builds the shared ioredis transport (two connections: pub + sub — a subscribed ioredis connection
// cannot publish). Lazy so importing this file never touches the network and CI needs no Redis.
let sharedTransport: RealtimeTransport | null | undefined;
function defaultTransport(): RealtimeTransport | null {
  if (sharedTransport !== undefined) return sharedTransport;
  const url = (process.env.REALTIME_REDIS_URL ?? '').trim();
  if (!url) { sharedTransport = null; return null; }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Redis = require('ioredis');
  const pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  const sub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  const handlers = new Map<string, (m: string) => void>();
  sub.on('message', (channel: string, message: string) => handlers.get(channel)?.(message));
  sharedTransport = {
    publish: (channel, message) => pub.publish(channel, message),
    subscribe: async (channel, onMessage) => { handlers.set(channel, onMessage); await sub.subscribe(channel); },
    close: async () => { try { await pub.quit(); await sub.quit(); } catch { /* shutdown best-effort */ } },
  };
  return sharedTransport;
}

let lastPublishAlertAt = 0;

export class RealtimeBus<E extends BusEvent = BusEvent> {
  private subject = new Subject<E>();
  private buffer: E[] = [];
  private subscribed = false;
  private readonly transport: RealtimeTransport | null;

  constructor(private readonly channel: string, transport?: RealtimeTransport | null) {
    this.transport = transport !== undefined ? transport : defaultTransport();
  }

  private deliverLocal(e: E): void {
    this.buffer.push(e);
    if (this.buffer.length > 200) this.buffer.shift();
    this.subject.next(e);
  }

  private ensureSubscribed(): void {
    if (this.subscribed || !this.transport) return;
    this.subscribed = true;
    void this.transport.subscribe(this.channel, (message) => {
      try { this.deliverLocal(JSON.parse(message) as E); } catch { /* a malformed frame must not kill the stream */ }
    });
  }

  publish(event: E): void {
    const e = { at: new Date().toISOString(), ...event } as E;
    if (!this.transport) { this.deliverLocal(e); return; }
    this.ensureSubscribed();
    void this.transport.publish(this.channel, JSON.stringify(e)).catch((err) => {
      // Degraded cross-node fan-out: same-node clients still get the event; alert ops (throttled).
      this.deliverLocal(e);
      const now = Date.now();
      if (now - lastPublishAlertAt >= 60_000) {
        lastPublishAlertAt = now;
        captureOpsAlert('realtime_redis_publish_failed', { channel: this.channel, degraded: 'event delivered LOCALLY only — other nodes missed it' }, err);
      }
    });
  }

  stream(): Observable<E> {
    this.ensureSubscribed();
    return this.subject.asObservable();
  }

  recent(tenantId?: number | null, limit = 50): E[] {
    this.ensureSubscribed();
    // A concrete tenant sees ONLY its own events. The old `e.tenant_id == null || …` clause meant any
    // event published with a null tenant_id was delivered to EVERY tenant (security review L-7 cross-tenant
    // leak). Platform (null-tenant) events now reach only the god view (tenantId == null → whole buffer).
    const rows = tenantId == null ? this.buffer : this.buffer.filter((e) => e.tenant_id === tenantId);
    return rows.slice(-limit).reverse();
  }
}
