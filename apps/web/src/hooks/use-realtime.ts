'use client';

import { useEffect, useRef, useState } from 'react';
import { hasSession } from '@/lib/api';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

export interface RealtimeEvent {
  type: string;
  tenant_id?: number | null;
  at?: string;
  [k: string]: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Subscribe to the POS realtime SSE stream (`/api/pos/scale/events/stream`) so a second terminal reflects
 * KDS/table changes the instant they happen, instead of waiting for its poll.
 *
 * The browser EventSource API can't send an Authorization header, so we stream via fetch + ReadableStream
 * (mirrors the assistant page) with the Bearer token. Auto-reconnects with capped backoff; `onEvent` is
 * called per event. Returns `{ connected }` for a live/offline badge. No-op during SSR or when logged out.
 */
export function useRealtime(onEvent: (e: RealtimeEvent) => void, opts?: { path?: string }): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const path = opts?.path ?? '/api/pos/scale/events/stream';

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let stopped = false;
    let ctrl: AbortController | null = null;
    let backoff = 1000;

    const loop = async () => {
      while (!stopped) {
        if (!hasSession()) { await sleep(2000); continue; }
        ctrl = new AbortController();
        try {
          // Auth via the httpOnly cookie (credentials:'include'); the EventSource-style stream rides the cookie.
          const res = await fetch(`${BASE}${path}`, { credentials: 'include', headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
          if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
          setConnected(true);
          backoff = 1000;
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const frames = buf.split('\n\n');
            buf = frames.pop() ?? '';
            for (const frame of frames) {
              const data = frame.split('\n').find((l) => l.startsWith('data:'));
              if (!data) continue;
              try { cb.current(JSON.parse(data.slice(5).trim()) as RealtimeEvent); } catch { /* ignore malformed frame */ }
            }
          }
        } catch { /* network drop / abort — fall through to reconnect */ } finally {
          setConnected(false);
        }
        if (!stopped) { await sleep(backoff); backoff = Math.min(backoff * 2, 15000); }
      }
    };
    void loop();
    return () => { stopped = true; ctrl?.abort(); };
  }, [path]);

  return { connected };
}
