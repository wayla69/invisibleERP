'use client';

import { useEffect, useRef, useState } from 'react';
import { getToken } from '@/lib/api';

// ── SSE assistant ───────────────────────────────────────────────────────────
// ใช้ fetch() + ReadableStream reader (ไม่ใช่ EventSource) เพราะ EventSource
// ตั้ง Authorization header ไม่ได้ — เราต้องส่ง Bearer token ผ่าน header เดิม
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

    const token = getToken();
    const params = new URLSearchParams({ message: msg });
    if (history.length) params.set('history', JSON.stringify(history.slice(-20)));

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch(`${BASE}/api/chat/stream?${params.toString()}`, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
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
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 48px)' }}>
      <h1 style={{ marginTop: 0 }}>🤖 AI Assistant</h1>
      <p className="label" style={{ marginTop: -8 }}>
        ถาม AI เกี่ยวกับยอดขาย สต๊อก การเงิน และการสั่งซื้อ — ดึงข้อมูลจริงจากระบบ
      </p>

      {/* quick prompts */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0 12px' }}>
        {QUICK_PROMPTS.map((p) => (
          <button
            key={p}
            className="btn"
            disabled={streaming}
            onClick={() => send(p)}
            style={{ fontSize: 13, padding: '6px 12px', background: 'var(--card)', color: 'var(--navy)', border: '1px solid var(--border)' }}
          >
            {p}
          </button>
        ))}
      </div>

      {/* message list */}
      <div
        ref={listRef}
        className="card"
        style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}
      >
        {messages.length === 0 && (
          <p className="label" style={{ margin: 'auto', textAlign: 'center' }}>
            เริ่มสนทนาด้วยการพิมพ์คำถาม หรือเลือกปุ่มลัดด้านบน
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '78%',
              background: m.role === 'user' ? 'linear-gradient(135deg, var(--navy), var(--navy2))' : 'var(--bg)',
              color: m.role === 'user' ? '#fff' : 'var(--text)',
              border: m.role === 'user' ? '0' : '1px solid var(--border)',
              borderRadius: 12,
              padding: '10px 14px',
              fontSize: 15,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 1.55,
            }}
          >
            {m.content || (streaming && m.role === 'assistant' ? <span className="label">กำลังคิด…</span> : '')}
          </div>
        ))}
      </div>

      {error && (
        <div className="label" style={{ color: 'var(--ruby)', marginTop: 8 }}>
          ⚠️ {error}
        </div>
      )}

      {/* composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}
      >
        <input
          className="input"
          style={{ marginTop: 0, flex: 1 }}
          placeholder="พิมพ์คำถาม… (เช่น สรุปยอดขายเดือนนี้)"
          value={input}
          disabled={streaming}
          onChange={(e) => setInput(e.target.value)}
        />
        {streaming ? (
          <button type="button" className="btn" onClick={stop} style={{ background: 'var(--ruby)' }}>
            ⏹ หยุด
          </button>
        ) : (
          <button type="submit" className="btn" disabled={!input.trim()}>
            ส่ง ➤
          </button>
        )}
      </form>
    </div>
  );
}
