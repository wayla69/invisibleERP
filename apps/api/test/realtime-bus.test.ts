import { describe, it, expect } from 'vitest';
import { RealtimeBus, type RealtimeTransport, type BusEvent } from '../src/common/realtime-bus';

// docs/27 R1-3 / AUD-ARC-03 — cross-node fan-out. A fake pub/sub transport shared by two bus instances
// models two API replicas: an event published on "node A" must reach subscribers and the recent() buffer
// on "node B" (this is exactly what the in-memory Subject could not do).
function fakeTransport(): RealtimeTransport & { published: string[] } {
  const handlers = new Map<string, Array<(m: string) => void>>();
  const published: string[] = [];
  return {
    published,
    async publish(channel, message) {
      published.push(message);
      for (const h of handlers.get(channel) ?? []) h(message);
    },
    async subscribe(channel, onMessage) {
      handlers.set(channel, [...(handlers.get(channel) ?? []), onMessage]);
    },
  };
}

const collect = (bus: RealtimeBus) => {
  const seen: BusEvent[] = [];
  bus.stream().subscribe((e) => seen.push(e));
  return seen;
};

describe('RealtimeBus — cross-instance delivery via transport', () => {
  it('an event published on node A reaches node B subscribers and buffer', async () => {
    const t = fakeTransport();
    const nodeA = new RealtimeBus('ierp:rt:test', t);
    const nodeB = new RealtimeBus('ierp:rt:test', t);
    const seenB = collect(nodeB);
    nodeA.publish({ type: 'order_fired', tenant_id: 1, table: 'T5' });
    await new Promise((r) => setTimeout(r, 10));
    expect(seenB.map((e) => e.type)).toEqual(['order_fired']);
    expect(nodeB.recent(1).map((e) => e.type)).toEqual(['order_fired']);
  });

  it('the publisher node sees its own event exactly once (single delivery path)', async () => {
    const t = fakeTransport();
    const nodeA = new RealtimeBus('ierp:rt:test', t);
    const seenA = collect(nodeA);
    nodeA.publish({ type: 'kpi_tick', tenant_id: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(seenA).toHaveLength(1);
    expect(nodeA.recent(2)).toHaveLength(1);
  });

  it('tenant filtering still applies on recent()', async () => {
    const t = fakeTransport();
    const bus = new RealtimeBus('ierp:rt:test', t);
    bus.publish({ type: 'a', tenant_id: 1 });
    bus.publish({ type: 'b', tenant_id: 2 });
    bus.publish({ type: 'c' }); // tenant-less → visible to all
    await new Promise((r) => setTimeout(r, 10));
    expect(bus.recent(1).map((e) => e.type).sort()).toEqual(['a', 'c']);
  });

  it('no transport (single node) → pure in-memory, unchanged behavior', () => {
    const bus = new RealtimeBus('ierp:rt:test', null);
    const seen = collect(bus);
    bus.publish({ type: 'local_only', tenant_id: 1 });
    expect(seen).toHaveLength(1);
    expect(bus.recent(1)).toHaveLength(1);
  });

  it('transport publish failure falls back to LOCAL delivery (degraded, not lost)', async () => {
    const t: RealtimeTransport = {
      publish: async () => { throw new Error('redis down'); },
      subscribe: async () => undefined,
    };
    const bus = new RealtimeBus('ierp:rt:test', t);
    const seen = collect(bus);
    bus.publish({ type: 'degraded', tenant_id: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.map((e) => e.type)).toEqual(['degraded']);
  });
});
