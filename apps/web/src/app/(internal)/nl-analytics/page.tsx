'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { MessageSquare, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
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
            <DataTable
              dense
              rows={rows}
              rowKey={(_, i) => i}
              emptyText={t('pb.no_data')}
              columns={[
                { key: 'dim', label: res.result.dimension, sortable: true, render: (r) => (
                  <div>
                    <div>{String(r.dim)}</div>
                    {/* inline share-of-sales bar (kept from the hand-rolled grid) */}
                    <div className="mt-0.5 h-1.5 rounded bg-primary/20"><div className="h-1.5 rounded bg-primary" style={{ width: `${Math.round((Number(r.sales_total) / maxSales) * 100)}%` }} /></div>
                  </div>
                ) },
                { key: 'sales_total', label: t('pb.col_sales'), align: 'right', sortable: true, render: (r) => <span className="tabular-nums">{money(r.sales_total)}</span> },
                { key: 'orders', label: t('pb.nl_col_orders'), align: 'right', sortable: true, render: (r) => <span className="tabular-nums">{num(r.orders)}</span> },
              ]}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
