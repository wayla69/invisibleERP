// No 'use client' directive needed: this hook is imported only by client components
// (assistant-widget, /assistant page), so it already lives in their client subgraph.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ts } from '@/lib/i18n-static';

// Shared AI-assistant chat state + SSE streaming, used by both the full `/assistant` page and the global
// floating widget. Auth is the httpOnly cookie (credentials:'include'); backend is
// GET /api/chat/stream?message=&history= → SSE `data: {json}\n\n` (delta/done/reply/error).

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

function toApiHistory(msgs: ChatMsg[]): { role: string; content: string }[] {
  return msgs.map((m) => ({ role: m.role, content: m.content }));
}

export function useAssistantChat() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // parse a single "data: {json}" SSE event and fold its delta into the latest assistant message
  const handleEvent = useCallback((raw: string) => {
    const line = raw.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return;
    const json = line.slice(5).trim();
    if (!json) return;
    let payload: { delta?: string; done?: boolean; reply?: string; error?: string };
    try {
      payload = JSON.parse(json);
    } catch {
      return;
    }
    if (payload.error && payload.error !== 'AUTH' && payload.error !== 'STREAM_ERROR') {
      setError(payload.error);
    }
    if (payload.delta) {
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === 'assistant') copy[copy.length - 1] = { role: 'assistant', content: last.content + payload.delta };
        return copy;
      });
    }
    if (payload.done && payload.reply) {
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === 'assistant' && payload.reply && last.content.length < payload.reply.length) {
          copy[copy.length - 1] = { role: 'assistant', content: payload.reply };
        }
        return copy;
      });
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const msg = text.trim();
      if (!msg || streaming) return;
      setError(null);

      const history = toApiHistory(messages);
      setMessages((prev) => [...prev, { role: 'user', content: msg }, { role: 'assistant', content: '' }]);
      setStreaming(true);

      const params = new URLSearchParams({ message: msg });
      if (history.length) params.set('history', JSON.stringify(history.slice(-20)));

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const res = await fetch(`${BASE}/api/chat/stream?${params.toString()}`, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let reading = true;
        while (reading) {
          const { value, done } = await reader.read();
          if (done) { reading = false; break; }
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const rawEvent = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            handleEvent(rawEvent);
          }
        }
        if (buf.trim()) handleEvent(buf);
      } catch (e: any) {
        if (e?.name !== 'AbortError') {
          setError(e?.message ?? ts('err.ai_connection'));
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last?.role === 'assistant' && !last.content) {
              copy[copy.length - 1] = { role: 'assistant', content: `⚠️ ${e?.message ?? ts('err.generic')}` };
            }
            return copy;
          });
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [messages, streaming, handleEvent],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  return { messages, streaming, error, send, stop };
}
