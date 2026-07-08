'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { MessageSquare, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { num } from '@/lib/format';

const money = (x: number) => num(x, 2);
type Res = { question: string; resolved: { dimension: string; date_from?: string; date_to?: string } | null; source: string; result: { dimension: string; rows: any[] } | null };

// NL analytics (Platform Phase 17 — B3). Plain-language question → governed query over the semantic layer.
export default function NlAnalyticsPage() {
  const { t } = useLang();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Res | null>(null);
  const [err, setErr] = useState('');
  const ask = useMutation({
    mutationFn: () => api<Res>('/api/nl-analytics/ask', { method: 'POST', body: JSON.stringify({ question: q }) }),
    onSuccess: (r) => { setRes(r); setErr(''); },
    onError: (e: any) => setErr(`❌ ${e.message}`),
  });
  const rows = res?.result?.rows ?? [];
  const maxSales = Math.max(1, ...rows.map((r) => Number(r.sales_total) || 0));

  return (
    <div>
      <PageHeader title={t('pb.nl_title')} description={t('pb.nl_subtitle')} />

      <Card className="mb-6">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><MessageSquare className="size-4 text-primary" /> {t('pb.nl_ask')}</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <input className="h-9 flex-1 rounded-md border bg-transparent px-3 text-sm" placeholder={t('pb.nl_ph')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && q.trim() && ask.mutate()} />
            <Button disabled={ask.isPending || !q.trim()} onClick={() => ask.mutate()}>{ask.isPending ? <Loader2 className="size-4 animate-spin" /> : t('pb.nl_ask_btn')}</Button>
          </div>
          {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
          {res?.resolved && <p className="mt-2 text-xs text-muted-foreground">{t('pb.nl_interpreted')} <span className="font-medium">{res.resolved.dimension}</span>{res.resolved.date_from ? t('pb.nl_from', { d: res.resolved.date_from }) : ''}{res.resolved.date_to ? t('pb.nl_to', { d: res.resolved.date_to }) : ''} ({res.source})</p>}
        </CardContent>
      </Card>

      {res?.result && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t('pb.result')}</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('pb.no_data')}</p> : (
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left text-muted-foreground"><th className="px-2 py-1 font-medium">{res.result.dimension}</th><th className="px-2 py-1 text-right font-medium">{t('pb.col_sales')}</th><th className="px-2 py-1 text-right font-medium">{t('pb.nl_col_orders')}</th></tr></thead>
                <tbody>{rows.map((r, i) => (
                  <tr key={i} className="border-b">
                    <td className="px-2 py-1"><div>{String(r.dim)}</div><div className="mt-0.5 h-1.5 rounded bg-primary/20"><div className="h-1.5 rounded bg-primary" style={{ width: `${Math.round((Number(r.sales_total) / maxSales) * 100)}%` }} /></div></td>
                    <td className="px-2 py-1 text-right tabular-nums">{money(r.sales_total)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{num(r.orders)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
