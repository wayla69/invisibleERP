// Contract tests for the shared-cache adapter (workstream 2.5 — docs/27 §R1-6).
// No live Redis in CI, so the RemoteCacheStore is a fake (the realtime-bus.test.ts pattern): two TtlCache
// instances sharing one fake store model two API replicas sharing one Redis. Proves: default-inert
// (no store ⇒ pure in-memory, the pre-adapter behavior), cross-node read-through, write-through,
// local seeding on a remote hit, cross-node prefix bust, TTL-0 bypass, and fail-open degradation.
import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../src/common/ttl-cache';
import type { RemoteCacheStore } from '../src/common/cache-remote';

// In-memory fake Redis honouring PX-style expiry, shared between "nodes".
function fakeStore() {
  const kv = new Map<string, { v: string; exp: number }>();
  const store: RemoteCacheStore & { kv: Map<string, { v: string; exp: number }>; calls: Record<string, number> } = {
    kv,
    calls: { get: 0, set: 0, del: 0, delPrefix: 0 },
    async get(key) {
      this.calls.get++;
      const e = kv.get(key);
      if (!e) return null;
      if (Date.now() >= e.exp) { kv.delete(key); return null; }
      return e.v;
    },
    async set(key, value, ttlMs) { this.calls.set++; kv.set(key, { v: value, exp: Date.now() + ttlMs }); },
    async del(key) { this.calls.del++; kv.delete(key); },
    async delPrefix(prefix) { this.calls.delPrefix++; for (const k of [...kv.keys()]) if (k.startsWith(prefix)) kv.delete(k); },
  };
  return store;
}

const tick = () => new Promise((r) => setTimeout(r, 0)); // let fire-and-forget writes land

describe('TtlCache shared-store adapter (2.5)', () => {
  it('default-inert: no remote store ⇒ pure in-memory compute-through (pre-adapter behavior)', async () => {
    const cache = new TtlCache(1000, null);
    const compute = vi.fn(async () => ({ n: 1 }));
    expect(await cache.wrap('bi:1:k', 30_000, compute)).toEqual({ n: 1 });
    expect(await cache.wrap('bi:1:k', 30_000, compute)).toEqual({ n: 1 });
    expect(compute).toHaveBeenCalledTimes(1); // second call served locally
  });

  it('write-through: a computed value lands in the shared store (JSON, with TTL)', async () => {
    const remote = fakeStore();
    const cache = new TtlCache(1000, remote);
    await cache.wrap('bi:1:board', 30_000, async () => ({ mtd: 214 }));
    await tick();
    expect(remote.calls.set).toBe(1);
    expect(JSON.parse(remote.kv.get('bi:1:board')!.v)).toEqual({ mtd: 214 });
  });

  it('cross-node read-through: node B serves node A\'s cached value without recomputing, and seeds its local map', async () => {
    const remote = fakeStore();
    const nodeA = new TtlCache(1000, remote);
    const nodeB = new TtlCache(1000, remote);
    await nodeA.wrap('bi:1:board', 30_000, async () => ({ mtd: 214 }));
    await tick();
    const computeB = vi.fn(async () => ({ mtd: -1 }));
    expect(await nodeB.wrap('bi:1:board', 30_000, computeB)).toEqual({ mtd: 214 });
    expect(computeB).not.toHaveBeenCalled();
    // remote hit seeded node B's local map: the next read stays in-process (no second remote get)
    const gets = remote.calls.get;
    expect(await nodeB.wrap('bi:1:board', 30_000, computeB)).toEqual({ mtd: 214 });
    expect(remote.calls.get).toBe(gets);
  });

  it('cross-node prefix bust: deletePrefix on node A drops the tenant\'s entries in the shared store', async () => {
    const remote = fakeStore();
    const nodeA = new TtlCache(1000, remote);
    const nodeB = new TtlCache(1000, remote);
    await nodeA.wrap('bi:1:board', 30_000, async () => 'T1');
    await nodeA.wrap('bi:2:board', 30_000, async () => 'T2');
    await tick();
    nodeA.deletePrefix('bi:1:');
    await tick();
    const compute = vi.fn(async () => 'FRESH');
    expect(await nodeB.wrap('bi:1:board', 30_000, compute)).toBe('FRESH'); // busted → recomputed
    expect(await nodeB.wrap('bi:2:board', 30_000, vi.fn(async () => 'X'))).toBe('T2'); // other tenant untouched
  });

  it('delete propagates a single-key bust to the shared store', async () => {
    const remote = fakeStore();
    const cache = new TtlCache(1000, remote);
    await cache.wrap('k1', 30_000, async () => 1);
    await tick();
    cache.delete('k1');
    await tick();
    expect(remote.kv.has('k1')).toBe(false);
    expect(remote.calls.del).toBe(1);
  });

  it('TTL ≤ 0 (caching disabled) never touches the shared store', async () => {
    const remote = fakeStore();
    const cache = new TtlCache(1000, remote);
    const compute = vi.fn(async () => 42);
    expect(await cache.wrap('k', 0, compute)).toBe(42);
    expect(await cache.wrap('k', 0, compute)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(remote.calls.get + remote.calls.set).toBe(0);
  });

  it('fail-open: a throwing store degrades to compute — the read never fails', async () => {
    const broken: RemoteCacheStore = {
      get: async () => { throw new Error('ECONNREFUSED'); },
      set: async () => { throw new Error('ECONNREFUSED'); },
      del: async () => { throw new Error('ECONNREFUSED'); },
      delPrefix: async () => { throw new Error('ECONNREFUSED'); },
    };
    const cache = new TtlCache(1000, broken);
    expect(await cache.wrap('k', 30_000, async () => 'OK')).toBe('OK');
    expect(() => cache.delete('k')).not.toThrow();
    expect(() => cache.deletePrefix('bi:1:')).not.toThrow();
    await tick();
    // local map still works while degraded
    const compute = vi.fn(async () => 'AGAIN');
    expect(await cache.wrap('k2', 30_000, compute)).toBe('AGAIN');
    expect(await cache.wrap('k2', 30_000, compute)).toBe('AGAIN');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('a stale/expired shared entry is a miss (fake honours PX expiry)', async () => {
    const remote = fakeStore();
    remote.kv.set('k', { v: JSON.stringify('OLD'), exp: Date.now() - 1 });
    const cache = new TtlCache(1000, remote);
    expect(await cache.wrap('k', 30_000, async () => 'NEW')).toBe('NEW');
  });
});
