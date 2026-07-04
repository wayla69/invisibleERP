'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, Coins, ShieldCheck, Save, Boxes, SlidersHorizontal } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const methodVariant = (m: string) =>
  m === 'FIFO' ? 'info' : m === 'AVG' ? 'secondary' : m === 'STD' ? 'warning' : 'muted';

export default function CostingPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('mx.costing_title')}
        description={t('mx.costing_desc')}
      />
      <Tabs
        tabs={[
          { key: 'valuation', label: t('mx.costing_tab_valuation'), content: <ValuationTab /> },
          { key: 'config', label: t('mx.costing_tab_config'), content: <ConfigTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Valuation ─────────────────────────
function ValuationTab() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['costing-valuation'], queryFn: () => api('/api/costing/valuation') });
  const items: any[] = q.data?.items ?? [];

  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('mx.costing_total_value')} value={baht(q.data.total_value)} icon={Coins} tone="primary" />
            <StatCard label={t('mx.costing_gl_1200')} value={baht(q.data.gl_1200)} icon={Calculator} tone="info" />
            <StatCard label={t('mx.costing_item_count')} value={num(items.length)} icon={Boxes} tone="default" />
            <StatCard
              label={t('mx.costing_ties_label')}
              value={<Badge variant={q.data.ties ? 'success' : 'destructive'}>{q.data.ties ? t('mx.costing_ties_yes') : t('mx.costing_ties_no')}</Badge>}
              icon={ShieldCheck}
              tone={q.data.ties ? 'success' : 'danger'}
            />
          </div>
          <DataTable
            rows={items}
            columns={[
              { key: 'item_id', label: t('mx.costing_col_item') },
              { key: 'method', label: t('mx.costing_col_method'), render: (r: any) => <Badge variant={methodVariant(r.method)}>{r.method}</Badge> },
              { key: 'qty', label: t('mx.costing_col_qty'), align: 'right', render: (r: any) => <span className="tabular">{num(r.qty)}</span> },
              { key: 'unit_cost', label: t('mx.costing_col_unit_cost'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.unit_cost)}</span> },
              { key: 'value', label: t('mx.costing_col_value'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.value)}</span> },
            ]}
            emptyState={{
              icon: Boxes,
              title: t('mx.costing_empty_val_title'),
              description: t('mx.costing_empty_val_desc'),
            }}
          />
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── Config ─────────────────────────
function ConfigTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['costing-config'], queryFn: () => api('/api/costing/config') });

  const [itemId, setItemId] = useState('');
  const [method, setMethod] = useState<'FIFO' | 'AVG' | 'STD'>('FIFO');
  const [standardCost, setStandardCost] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api<{ item_id: string | null; method: string }>('/api/costing/config', {
        method: 'PUT',
        body: JSON.stringify({
          item_id: itemId || null,
          method,
          standard_cost: method === 'STD' && standardCost !== '' ? Number(standardCost) : null,
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('mx.costing_saved', { item: r.item_id ?? t('mx.costing_default'), method: r.method }));
      qc.invalidateQueries({ queryKey: ['costing-config'] });
      qc.invalidateQueries({ queryKey: ['costing-valuation'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const config: any[] = q.data?.config ?? [];

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('mx.costing_tab_config')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('mx.costing_config_hint')}</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="cfg-item">{t('mx.costing_col_item')}</Label>
              <Input id="cfg-item" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder={t('mx.costing_default_ph')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cfg-method">{t('mx.costing_col_method')}</Label>
              <select
                id="cfg-method"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={method}
                onChange={(e) => setMethod(e.target.value as any)}
              >
                <option value="FIFO">FIFO</option>
                <option value="AVG">{t('mx.costing_avg_option')}</option>
                <option value="STD">{t('mx.costing_std_option')}</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cfg-std">{t('mx.costing_std_cost')}</Label>
              <Input
                id="cfg-std"
                type="number"
                min="0"
                value={standardCost}
                onChange={(e) => setStandardCost(e.target.value)}
                disabled={method !== 'STD'}
                placeholder={method === 'STD' ? '0.00' : '—'}
              />
            </div>
          </div>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            <Save className="size-4" /> {save.isPending ? t('mx.costing_saving') : t('mx.costing_save_config')}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={config}
            columns={[
              { key: 'item_id', label: t('mx.costing_col_item'), render: (r: any) => r.item_id ?? t('mx.costing_default_ph') },
              { key: 'method', label: t('mx.costing_col_method'), render: (r: any) => <Badge variant={methodVariant(r.method)}>{r.method}</Badge> },
              { key: 'standard_cost', label: t('mx.costing_std_cost'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.standard_cost)}</span> },
              { key: 'avg_cost', label: t('mx.costing_avg_cost'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.avg_cost)}</span> },
              { key: 'on_hand', label: t('mx.costing_on_hand'), align: 'right', render: (r: any) => <span className="tabular">{num(r.on_hand)}</span> },
            ]}
            emptyState={{
              icon: SlidersHorizontal,
              title: t('mx.costing_empty_cfg_title'),
              description: t('mx.costing_empty_cfg_desc'),
            }}
          />
        )}
      </StateView>
    </div>
  );
}
