'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Plus, Timer, Users, Utensils } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, pct } from '@/lib/format';
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
import { useLang } from '@/lib/i18n';

interface Pkg {
  id: number;
  code: string;
  name: string;
  name_en: string | null;
  price_per_pax: number;
  time_limit_min: number;
  overtime_fee_per_pax: number;
  active: boolean;
  item_skus: string[];
}

export default function BuffetPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('mf.buf_title')}
        description={t('mf.buf_desc')}
      />
      <Tabs
        tabs={[
          { key: 'pkgs', label: t('mf.buf_tab_pkgs'), content: <Packages /> },
          { key: 'behaviour', label: t('mf.buf_tab_behaviour'), content: <Behaviour /> },
        ]}
      />
    </div>
  );
}

interface TopItem { name: string; qty: number; orders: number }
interface TierStat {
  tier: { id: number; code: string; name: string; price_per_pax: number };
  sessions: number; covers: number; food_qty: number; items_per_head: number;
  top_items: TopItem[]; revenue: number; avg_bill_per_session: number; overtime_sessions: number; overtime_rate_pct: number;
}

// ───────────────────────── พฤติกรรมตามแพ็กเกจ (behaviour by tier) ─────────────────────────
function Behaviour() {
  const { t: tr } = useLang();
  const q = useQuery<{ tiers: TierStat[] }>({ queryKey: ['buffet-analytics'], queryFn: () => api('/api/restaurant/buffet/analytics') });
  const tiers = q.data?.tiers ?? [];

  return (
    <StateView q={q}>
      {tiers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr('mf.buf_no_data')}</p>
      ) : (
        <div className="space-y-6">
          {tiers.map((t) => (
            <Card key={t.tier.id} className="gap-4">
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  <span>{t.tier.name} <span className="text-sm font-normal text-muted-foreground">· {tr('mf.buf_price_per_pax', { price: baht(t.tier.price_per_pax) })}</span></span>
                  <Badge variant="secondary" className="gap-1"><Users className="size-3" /> {tr('mf.buf_pax', { n: num(t.covers) })}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
                  <StatCard label={tr('mf.buf_sessions')} value={num(t.sessions)} icon={Timer} tone="primary" />
                  <StatCard label={tr('mf.buf_covers')} value={num(t.covers)} icon={Users} tone="info" />
                  <StatCard label={tr('mf.buf_dishes_per_pax')} value={t.items_per_head.toFixed(2)} icon={Utensils} tone="default" hint={tr('mf.buf_total_dishes', { n: num(t.food_qty) })} />
                  <StatCard label={tr('mf.buf_avg_bill')} value={baht(t.avg_bill_per_session)} icon={BarChart3} tone="success" hint={tr('mf.buf_total_revenue', { amt: baht(t.revenue) })} />
                  <StatCard label={tr('mf.buf_overtime')} value={pct(t.overtime_rate_pct, 0)} icon={Timer} tone={t.overtime_rate_pct > 0 ? 'warning' : 'default'} hint={tr('mf.buf_sessions_n', { n: num(t.overtime_sessions) })} />
                </div>
                <div>
                  <h4 className="mb-2 text-sm font-semibold text-muted-foreground">{tr('mf.buf_top_menu')}</h4>
                  <DataTable
                    rows={t.top_items}
                    rowKey={(r) => r.name}
                    columns={[
                      { key: 'name', label: tr('mf.col_dish') },
                      { key: 'qty', label: tr('mf.buf_col_qty_ordered'), align: 'right', render: (r) => num(r.qty) },
                      { key: 'orders', label: tr('mf.buf_col_orders'), align: 'right', render: (r) => num(r.orders) },
                    ]}
                    emptyState={{ icon: Utensils, title: tr('mf.buf_no_orders') }}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </StateView>
  );
}

function Packages() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ packages: Pkg[] }>({ queryKey: ['buffet-packages'], queryFn: () => api('/api/restaurant/buffet/packages') });
  const packages = q.data?.packages ?? [];

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [timeLimit, setTimeLimit] = useState('90');
  const [overtime, setOvertime] = useState('0');
  const [skus, setSkus] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api<Pkg>('/api/restaurant/buffet/packages', {
        method: 'POST',
        body: JSON.stringify({
          code,
          name,
          price_per_pax: Number(price),
          time_limit_min: Number(timeLimit),
          overtime_fee_per_pax: Number(overtime),
          item_skus: skus.split(',').map((s) => s.trim()).filter(Boolean),
        }),
      }),
    onSuccess: (p) => {
      notifySuccess(t('mf.buf_added', { code: p.code, name: p.name }));
      setCode(''); setName(''); setPrice(''); setSkus('');
      qc.invalidateQueries({ queryKey: ['buffet-packages'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const avgPrice = packages.length ? packages.reduce((s, p) => s + p.price_per_pax, 0) / packages.length : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label={t('mf.buf_total_pkgs')} value={num(packages.length)} icon={Utensils} tone="primary" />
        <StatCard label={t('mf.buf_avg_price_pax')} value={baht(avgPrice)} icon={Utensils} tone="default" />
        <StatCard label={t('mf.active')} value={num(packages.filter((p) => p.active).length)} icon={Timer} tone="success" />
      </div>

      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('mf.buf_add_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="bf-code">{t('mf.col_code')}</Label>
              <Input id="bf-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('mf.buf_code_ph')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bf-name">{t('mf.buf_name_label')}</Label>
              <Input id="bf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('mf.buf_name_ph')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bf-price">{t('mf.buf_price_label')}</Label>
              <Input id="bf-price" type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="299" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bf-time">{t('mf.buf_time_label')}</Label>
              <Input id="bf-time" type="number" min="1" value={timeLimit} onChange={(e) => setTimeLimit(e.target.value)} placeholder="90" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bf-ot">{t('mf.buf_ot_label')}</Label>
              <Input id="bf-ot" type="number" min="0" value={overtime} onChange={(e) => setOvertime(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="bf-skus">{t('mf.buf_skus_label')}</Label>
              <Input id="bf-skus" value={skus} onChange={(e) => setSkus(e.target.value)} placeholder={t('mf.buf_skus_ph')} />
            </div>
          </div>
          <Button disabled={!code || !name || price === '' || create.isPending} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? t('mf.saving') : t('mf.buf_add_btn')}
          </Button>
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('mf.buf_tab_pkgs')}</h3>
        <StateView q={q}>
          <DataTable
            rows={packages}
            rowKey={(r) => r.id}
            columns={[
              { key: 'code', label: t('mf.col_code') },
              { key: 'name', label: t('mf.buf_name_label') },
              { key: 'price_per_pax', label: t('mf.buf_col_price_pax'), align: 'right', render: (r) => <span className="tabular">{baht(r.price_per_pax)}</span> },
              { key: 'time_limit_min', label: t('mf.buf_col_time'), align: 'right', render: (r) => num(r.time_limit_min) },
              { key: 'overtime_fee_per_pax', label: t('mf.buf_col_ot'), align: 'right', render: (r) => <span className="tabular">{r.overtime_fee_per_pax > 0 ? baht(r.overtime_fee_per_pax) : '—'}</span> },
              { key: 'item_skus', label: t('mf.buf_col_menu_count'), align: 'right', render: (r) => num(r.item_skus.length) },
              { key: 'active', label: t('fin.col_status'), render: (r) => <Badge variant={r.active ? 'success' : 'muted'}>{r.active ? t('mf.status_active') : t('mf.status_off')}</Badge> },
            ]}
            emptyState={{ icon: Utensils, title: t('mf.buf_empty_title'), description: t('mf.buf_empty_desc') }}
          />
        </StateView>
      </div>
    </div>
  );
}
