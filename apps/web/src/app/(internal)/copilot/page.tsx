'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Bot, Send, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useLang } from '@/lib/i18n';
import { pct } from '@/lib/format';

type Citation = { title: string; ord: number; content: string; score: number };
type Answer = { answer: string; grounded: boolean; citations: Citation[]; source: string };

// Embedded copilot (Platform Phase 15 — B1). Context-aware Q&A grounded in the tenant's knowledge base.
export default function CopilotPage() {
  const { t } = useLang();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Answer | null>(null);
  const [err, setErr] = useState('');
  const ask = useMutation({
    mutationFn: () => api<Answer>('/api/copilot/ask', { method: 'POST', body: JSON.stringify({ question: q }) }),
    onSuccess: (r) => { setRes(r); setErr(''); },
    onError: (e: any) => setErr(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title={t('mx.cp_title')} description={t('mx.cp_desc')} />

      <Card className="mb-6">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Bot className="size-4 text-primary" /> {t('mx.cp_ask')}</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <textarea className="min-h-20 flex-1 rounded-md border bg-transparent p-3 text-sm" placeholder={t('mx.cp_ask_ph')} value={q} onChange={(e) => setQ(e.target.value)} />
            <Button disabled={ask.isPending || !q.trim()} onClick={() => ask.mutate()}>{ask.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}</Button>
          </div>
          {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
        </CardContent>
      </Card>

      {res && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t('mx.cp_answer')} {res.grounded ? <span className="ml-2 rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">{t('mx.cp_grounded')}</span> : <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t('mx.cp_ungrounded')}</span>}</CardTitle></CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm">{res.answer}</p>
            {res.citations?.length > 0 && (
              <div className="mt-4">
                <p className="mb-1 text-xs font-medium text-muted-foreground">{t('mx.cp_citations')}</p>
                <ul className="space-y-2">
                  {res.citations.map((c, i) => (
                    <li key={i} className="rounded border p-2 text-xs">
                      <span className="font-medium">[{c.title}#{c.ord}]</span> <span className="text-muted-foreground">({pct(c.score * 100, 0)})</span>
                      <div className="mt-1 text-muted-foreground">{c.content}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
