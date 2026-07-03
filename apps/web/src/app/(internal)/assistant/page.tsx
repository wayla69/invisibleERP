'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, Send, Sparkles, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAssistantChat } from '@/hooks/use-assistant-chat';

// ── SSE assistant ───────────────────────────────────────────────────────────
// สถานะ + สตรีมมิ่งอยู่ใน useAssistantChat (แชร์กับ floating widget) — หน้านี้ให้เฉพาะ UI เต็มหน้า

// quick prompts (ภาษาไทย) — ปุ่มลัดถามคำถามที่พบบ่อย
const QUICK_PROMPTS = [
  'สรุปยอดขายวันนี้',
  'สินค้าที่สต๊อกต่ำกว่าจุดสั่งซื้อ',
  'KPI การเงินตอนนี้เป็นอย่างไร',
  'เจ้าหนี้ที่ค้างชำระมีอะไรบ้าง',
  'รายการสินค้าที่ควรสั่งซื้อเพิ่ม',
];

export default function AssistantPage() {
  const { messages, streaming, error, send, stop } = useAssistantChat();
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // auto-scroll ลงล่างสุดเมื่อมีข้อความใหม่
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming]);

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
          setInput('');
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
