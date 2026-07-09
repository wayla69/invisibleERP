'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { BarChart3, Play, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { DataTable } from '@/components/data-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { num } from '@/lib/format';
import { selectCls } from '@/components/form-controls';

type Measure = { key: string; label: string; label_en: string; unit: string };
type Dimension = { key: string; label: string; label_en: string };
type Model = { fact: string; label: string; measures: Measure[]; dimensions: Dimension[] };
type RunResult = { dimension: string; measures: string[]; rows: any[] };

const money = (x: number) => num(x, 2);

export default function QueryStudioPage() {
  const { t } = useLang();
  const [dimension, setDimension] = useState('period_month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState<RunResult | null>(null);
  const [msg, setMsg] = useState('');

  const model = useQuery<Model>({ queryKey: ['query-model'], queryFn: () => api('/api/query/model') });
  const measures = model.data?.measures ?? [];

  const run = useMutation({
    mutationFn: () => api<RunResult>('/api/query/run', { method: 'POST', body: JSON.stringify({ dimension, date_from: from || undefined, date_to: to || undefined }) }),
    onSuccess: (r) => { setResult(r); setMsg(''); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const maxSales = Math.max(1, ...((result?.rows ?? []).map((r) => Number(r.sales_total) || 0)));

  return (
    <div>
      <PageHeader title={t('pb.query_title')} description={t('pb.query_subtitle')} />

      <Card className="mb-6">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><BarChart3 className="size-4 text-primary" /> {t('pb.query_build_report')}</CardTitle></CardHeader>
        <CardContent>
          <StateView q={model}>
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1">
                <Label>{t('pb.query_group_by')}</Label>
                <select className={selectCls} value={dimension} onChange={(e) => setDimension(e.target.value)}>
                  {(model.data?.dimensions ?? []).map((d) => <option key={d.key} value={d.key}>{d.label} ({d.label_en})</option>)}
                </select>
              </div>
              <div className="grid gap-1"><Label>{t('pb.query_date_from')}</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
              <div className="grid gap-1"><Label>{t('pb.query_date_to')}</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
              <Button disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} {t('pb.query_run')}</Button>
            </div>
            {msg && <p className="mt-2 text-sm text-destructive">{msg}</p>}
          </StateView>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t('pb.query_result_by', { label: model.data?.dimensions.find((d) => d.key === result.dimension)?.label ?? result.dimension })}</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <DataTable
              dense
              rows={result.rows}
              rowKey={(_, i) => i}
              emptyText={t('pb.query_no_data')}
              columns={[
                { key: 'dim', label: model.data?.dimensions.find((d) => d.key === result.dimension)?.label ?? result.dimension, sortable: true, render: (r) => (
                  <div>
                    <div>{String(r.dim)}</div>
                    {/* inline share-of-sales bar (kept from the hand-rolled grid) */}
                    <div className="mt-0.5 h-1.5 rounded bg-primary/20"><div className="h-1.5 rounded bg-primary" style={{ width: `${Math.round((Number(r.sales_total) / maxSales) * 100)}%` }} /></div>
                  </div>
                ) },
                { key: 'sales_total', label: measures.find((m) => m.key === 'sales_total')?.label ?? 'sales_total', align: 'right', sortable: true, render: (r) => <span className="tabular-nums">{money(r.sales_total)}</span> },
                { key: 'orders', label: measures.find((m) => m.key === 'orders')?.label ?? 'orders', align: 'right', sortable: true, render: (r) => <span className="tabular-nums">{num(r.orders)}</span> },
                { key: 'avg_order', label: measures.find((m) => m.key === 'avg_order')?.label ?? 'avg_order', align: 'right', sortable: true, render: (r) => <span className="tabular-nums">{money(r.avg_order)}</span> },
                { key: 'discount_total', label: measures.find((m) => m.key === 'discount_total')?.label ?? 'discount_total', align: 'right', sortable: true, render: (r) => <span className="tabular-nums">{money(r.discount_total)}</span> },
                { key: 'tax_total', label: measures.find((m) => m.key === 'tax_total')?.label ?? 'tax_total', align: 'right', sortable: true, render: (r) => <span className="tabular-nums">{money(r.tax_total)}</span> },
              ]}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
