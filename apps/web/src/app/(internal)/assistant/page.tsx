'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, Send, Sparkles, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// ── SSE assistant ───────────────────────────────────────────────────────────
// ใช้ fetch() + ReadableStream reader (ไม่ใช่ EventSource) — auth ผ่าน httpOnly cookie (credentials:'include')
// backend: GET /api/chat/stream?message=...&history=... → SSE `data: {json}\n\n`

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

// quick prompts (ภาษาไทย) — ปุ่มลัดถามคำถามที่พบบ่อย
const QUICK_PROMPTS = [
  'สรุปยอดขายวันนี้',
  'สินค้าที่สต๊อกต่ำกว่าจุดสั่งซื้อ',
  'KPI การเงินตอนนี้เป็นอย่างไร',
  'เจ้าหนี้ที่ค้างชำระมีอะไรบ้าง',
  'รายการสินค้าที่ควรสั่งซื้อเพิ่ม',
];

// แปลง history → รูปแบบ messages ของ Anthropic (role + content เป็น string)
function toApiHistory(msgs: Msg[]): { role: string; content: string }[] {
  return msgs.map((m) => ({ role: m.role, content: m.content }));
}

export default function AssistantPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // auto-scroll ลงล่างสุดเมื่อมีข้อความใหม่
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(text: string) {
    const msg = text.trim();
    if (!msg || streaming) return;
    setError(null);

    const history = toApiHistory(messages);
    const userMsg: Msg = { role: 'user', content: msg };
    // เพิ่ม user message + assistant placeholder (ว่าง) ที่จะถูกเติม delta
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '' }]);
    setInput('');
    setStreaming(true);

    const params = new URLSearchParams({ message: msg });
    if (history.length) params.set('history', JSON.stringify(history.slice(-20)));

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch(`${BASE}/api/chat/stream?${params.toString()}`, {
        method: 'GET',
        credentials: 'include', // auth via the httpOnly cookie
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      // อ่าน stream ทีละ chunk → split ตามขอบเขต SSE event ("\n\n")
      let reading = true;
      while (reading) {
        const { value, done } = await reader.read();
        if (done) { reading = false; break; }
        buf += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleEvent(raw);
        }
      }
      // flush ส่วนที่เหลือ (เผื่อ event สุดท้ายไม่มี \n\n ปิดท้าย)
      if (buf.trim()) handleEvent(buf);
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        setError(e?.message ?? 'การเชื่อมต่อ AI ล้มเหลว');
        // ถ้า assistant ยังว่าง ใส่ข้อความ error ลงไป
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant' && !last.content) {
            copy[copy.length - 1] = { role: 'assistant', content: `⚠️ ${e?.message ?? 'เกิดข้อผิดพลาด'}` };
          }
          return copy;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  // parse บรรทัด "data: {json}" ของแต่ละ SSE event แล้วเติม delta เข้า assistant ล่าสุด
  function handleEvent(raw: string) {
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
        if (last?.role === 'assistant') {
          copy[copy.length - 1] = { role: 'assistant', content: last.content + payload.delta };
        }
        return copy;
      });
    }
    if (payload.done && payload.reply) {
      // ปิดท้าย: ถ้า delta ไม่ครบ ให้ใช้ reply สุดท้ายเป็นความจริง
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === 'assistant' && payload.reply && last.content.length < payload.reply.length) {
          copy[copy.length - 1] = { role: 'assistant', content: payload.reply };
        }
        return copy;
      });
    }
  }

  function stop() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      {/* slim title bar */}
      <div className="mb-3 flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Bot className="size-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">AI Assistant</h1>
          <p className="text-sm text-muted-foreground">
            ถาม AI เกี่ยวกับยอดขาย สต๊อก การเงิน และการสั่งซื้อ — ดึงข้อมูลจริงจากระบบ
          </p>
        </div>
      </div>

      {/* quick prompts */}
      <div className="mb-3 flex flex-wrap gap-2">
        {QUICK_PROMPTS.map((p) => (
          <Button key={p} variant="outline" size="sm" disabled={streaming} onClick={() => send(p)}>
            {p}
          </Button>
        ))}
      </div>

      {/* message list */}
      <div
        ref={listRef}
        className="flex flex-1 flex-col gap-4 overflow-y-auto rounded-xl border bg-card p-4"
      >
        {messages.length === 0 && (
          <div className="m-auto flex flex-col items-center gap-3 text-center text-muted-foreground">
            <Sparkles className="size-8 opacity-40" />
            <p className="text-sm">เริ่มสนทนาด้วยการพิมพ์คำถาม หรือเลือกปุ่มลัดด้านบน</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={cn('flex items-end gap-2', m.role === 'user' ? 'justify-end' : 'justify-start')}
          >
            {m.role === 'assistant' && (
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Bot className="size-4" />
              </div>
            )}
            <div
              className={cn(
                'max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap',
                m.role === 'user'
                  ? 'rounded-br-sm bg-primary text-primary-foreground'
                  : 'rounded-bl-sm bg-muted text-foreground',
              )}
            >
              {m.content || (streaming && m.role === 'assistant' ? (
                <span className="text-muted-foreground">กำลังคิด…</span>
              ) : '')}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <p className="mt-2 text-sm text-destructive">⚠️ {error}</p>
      )}

      {/* composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="sticky bottom-0 mt-3 flex items-center gap-2 bg-background pt-1"
      >
        <Input
          className="flex-1"
          placeholder="พิมพ์คำถาม… (เช่น สรุปยอดขายเดือนนี้)"
          value={input}
          disabled={streaming}
          onChange={(e) => setInput(e.target.value)}
        />
        {streaming ? (
          <Button type="button" variant="destructive" onClick={stop}>
            <Square className="size-4" /> หยุด
          </Button>
        ) : (
          <Button type="submit" disabled={!input.trim()}>
            <Send className="size-4" /> ส่ง
          </Button>
        )}
      </form>
    </div>
  );
}
