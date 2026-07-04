'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ChefHat, ShoppingCart, Soup, FilePlus } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useLang } from '@/lib/i18n';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="mb-4 gap-3 p-4">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      {children}
    </Card>
  );
}

export default function ProductionPlanPage() {
  const { t } = useLang();
  const [days, setDays] = useState(1);
  const [lookback, setLookback] = useState(28);
  const q = useQuery<any>({
    queryKey: ['production-plan', days, lookback],
    queryFn: () => api(`/api/menu/production-plan?days=${days}&lookback=${lookback}`),
  });
  const createPo = useMutation({
    // one-click draft PO from the buy list (omit a null uom — the procurement API wants string-or-absent).
    mutationFn: () => api<{ po_no: string }>('/api/procurement/pos', {
      method: 'POST',
      body: JSON.stringify({
        remarks: t('mf.plan_po_remark'),
        items: (q.data?.purchase_orders ?? []).map((i: any) => ({ item_id: i.item_id, item_description: i.description, order_qty: i.order_qty, unit_price: i.unit_price, ...(i.uom ? { uom: i.uom } : {}) })),
      }),
    }),
    onSuccess: (r) => notifySuccess(t('mf.plan_po_created', { po: r.po_no })),
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div>
      <PageHeader
        title={t('mf.plan_title')}
        description={t('mf.plan_desc')}
        actions={
          <div className="flex items-end gap-2">
            <div className="grid gap-1"><Label htmlFor="days" className="text-xs">{t('mf.plan_ahead_days')}</Label><Input id="days" type="number" min={1} max={14} value={days} onChange={(e) => setDays(Math.max(1, +e.target.value))} className="h-9 w-36" /></div>
            <div className="grid gap-1"><Label htmlFor="lookback" className="text-xs">{t('mf.plan_lookback_days')}</Label><Input id="lookback" type="number" min={7} max={90} value={lookback} onChange={(e) => setLookback(Math.max(7, +e.target.value))} className="h-9 w-36" /></div>
          </div>
        }
      />
      <StateView q={q}>
        {q.data && (
          <>
            <div className="mb-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
              <StatCard label={t('mf.plan_horizon')} value={t('mf.days', { n: q.data.horizon_days })} icon={Soup} hint={t('mf.plan_forecast_hint', { n: q.data.lookback_days })} />
              <StatCard label={t('mf.plan_dishes_prep')} value={num(q.data.summary.dishes_to_prep)} icon={ChefHat} tone="primary" />
              <StatCard label={t('mf.plan_ingredients_order')} value={num(q.data.summary.ingredients_to_order)} icon={ShoppingCart} tone={q.data.summary.ingredients_to_order > 0 ? 'warning' : 'success'} />
            </div>

            <Section title={t('mf.plan_prep_title')}>
              <DataTable
                rows={q.data.prep}
                rowKey={(r: any) => r.sku}
                emptyState={{
                  icon: ChefHat,
                  title: t('mf.plan_prep_empty_title'),
                  description: t('mf.plan_prep_empty_desc'),
                }}
                columns={[
                  { key: 'name', label: t('mf.col_dish') },
                  { key: 'velocity_per_day', label: t('mf.plan_col_velocity'), align: 'right', render: (r: any) => num(r.velocity_per_day) },
                  { key: 'forecast_qty', label: t('mf.plan_col_forecast'), align: 'right', render: (r: any) => num(r.forecast_qty) },
                  { key: 'prep_suggestion', label: t('mf.plan_col_prep'), align: 'right', render: (r: any) => <strong>{num(r.prep_suggestion)}</strong> },
                  { key: 'model', label: t('mf.col_model'), render: (r: any) => <Badge variant="muted" className="font-mono text-[10px]">{r.model}{typeof r.forecast_wape === 'number' ? ` · ${Math.round((1 - r.forecast_wape) * 100)}%` : ''}</Badge> },
                  { key: 'ingredient_short', label: t('mf.col_material'), render: (r: any) => r.ingredient_short ? <Badge variant="warning">{t('mf.plan_short')}</Badge> : <Badge variant="muted">{t('mf.plan_enough')}</Badge> },
                ]}
              />
            </Section>

            <Section title={t('mf.plan_buy_title')}>
              {q.data.purchase_orders.length === 0
                ? <p className="text-sm text-muted-foreground">{t('mf.plan_no_buy')}</p>
                : (
                  <>
                  <div className="mb-1 flex items-center justify-end">
                    <Button size="sm" disabled={createPo.isPending} onClick={() => createPo.mutate()}>
                      <FilePlus className="size-4" /> {createPo.isPending ? t('mf.plan_creating') : t('mf.plan_create_po')}
                    </Button>
                  </div>
                  <DataTable
                    rows={q.data.purchase_orders}
                    rowKey={(r: any) => r.item_id}
                    columns={[
                      { key: 'description', label: t('mf.col_material'), render: (r: any) => r.description ?? r.item_id },
                      { key: 'current_stock', label: t('mf.col_stock'), align: 'right', render: (r: any) => num(r.current_stock) },
                      { key: 'required', label: t('mf.plan_col_required'), align: 'right', render: (r: any) => num(r.required) },
                      { key: 'order_qty', label: t('mf.plan_col_suggest_order'), align: 'right', render: (r: any) => <strong>{num(r.order_qty)} {r.uom ?? ''}</strong> },
                    ]}
                  />
                  </>
                )}
            </Section>
          </>
        )}
      </StateView>
    </div>
  );
}
