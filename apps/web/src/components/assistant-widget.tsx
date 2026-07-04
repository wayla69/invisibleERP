'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bot, Maximize2, Send, Sparkles, Square, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useLang } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAssistantChat } from '@/hooks/use-assistant-chat';

// Global floating AI helper — an always-available assistant button in the corner of the internal app, so
// users get contextual help without navigating to the full `/assistant` page. Shares the exact chat logic
// (useAssistantChat) with that page; mounted (and permission-gated) by the app shell.

const QUICK_PROMPT_KEYS = ['mx.awid_qp_sales', 'mx.awid_qp_lowstock', 'mx.awid_qp_finance'];

export function AssistantWidget() {
  const { t } = useLang();
  const [open, setOpen] = React.useState(false);
  const { messages, streaming, error, send, stop } = useAssistantChat();
  const [input, setInput] = React.useState('');
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming]);

  return (
    <>
      {/* launcher */}
      <Button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? t('mx.awid_close') : t('mx.awid_open')}
        aria-expanded={open}
        className="fixed bottom-5 right-5 z-50 size-12 rounded-full p-0 shadow-lg print:hidden"
      >
        {open ? <X className="size-5" /> : <Bot className="size-5" />}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label={t('mx.awid_title')}
          className="fixed bottom-20 right-5 z-50 flex h-[520px] w-[min(24rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl print:hidden"
        >
          {/* header */}
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Bot className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-tight">{t('mx.awid_title')}</p>
              <p className="truncate text-xs text-muted-foreground">{t('mx.awid_subtitle')}</p>
            </div>
            <Link
              href="/assistant"
              onClick={() => setOpen(false)}
              aria-label={t('mx.awid_fullscreen')}
              title={t('mx.awid_fullscreen')}
              className="rounded p-1.5 text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Maximize2 className="size-4" />
            </Link>
          </div>

          {/* messages */}
          <div ref={listRef} className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
            {messages.length === 0 && (
              <div className="m-auto flex flex-col items-center gap-3 px-4 text-center text-muted-foreground">
                <Sparkles className="size-7 opacity-40" />
                <p className="text-xs">{t('mx.awid_empty')}</p>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {QUICK_PROMPT_KEYS.map((k) => {
                    const p = t(k);
                    return (
                      <Button key={k} variant="outline" size="sm" className="h-7 text-xs" disabled={streaming} onClick={() => send(p)}>
                        {p}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap',
                    m.role === 'user' ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-muted text-foreground',
                  )}
                >
                  {m.content || (streaming && m.role === 'assistant' ? <span className="text-muted-foreground">{t('mx.awid_thinking')}</span> : '')}
                </div>
              </div>
            ))}
          </div>

          {error && <p className="px-3 pb-1 text-xs text-destructive">⚠️ {error}</p>}

          {/* composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
              setInput('');
            }}
            className="flex items-center gap-2 border-t p-2"
          >
            <Input
              className="flex-1"
              placeholder={t('mx.awid_input_placeholder')}
              value={input}
              disabled={streaming}
              onChange={(e) => setInput(e.target.value)}
            />
            {streaming ? (
              <Button type="button" size="icon" variant="destructive" onClick={stop} aria-label={t('mx.awid_stop')}>
                <Square className="size-4" />
              </Button>
            ) : (
              <Button type="submit" size="icon" disabled={!input.trim()} aria-label={t('mx.awid_send')}>
                <Send className="size-4" />
              </Button>
            )}
          </form>
        </div>
      )}
    </>
  );
}
