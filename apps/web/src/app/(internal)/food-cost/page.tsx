'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Utensils, Percent, TrendingUp, AlertTriangle, Scale, CalendarSearch, UtensilsCrossed, Soup } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLang } from '@/lib/i18n';

interface MarginItem { sku: string; name: string; price: number; cost: number; margin: number; margin_pct: number; food_cost_pct: number; has_recipe: boolean; costed: boolean }
interface FoodCost { target_pct: number; summary: { items: number; costed: number; uncosted: number; avg_food_cost_pct: number; over_target: number }; items: MarginItem[] }
interface Ingredient { ingredient_item_id: string; description: string | null; cost: number; recipes_using: number }
interface VarItem { item_id: string; description: string | null; unit_cost: number; theoretical_use: number; actual_use: number; variance_qty: number; theoretical_cost: number; actual_cost: number; variance_cost: number; variance_pct: number; anomaly: string }
interface VarReason { reason_code: string; variance_cost: number; theoretical_cost: number; lines: number; variance_pct: number }
interface VarStation { station: string; variance_cost: number; theoretical_cost: number; lines: number; variance_pct: number }
interface Variance { from: string; to: string; summary: { items: number; theoretical_cost: number; actual_cost: number; variance_cost: number; variance_pct: number; unfavorable_cost: number; favorable_cost: number; anomalies: number }; by_reason?: VarReason[]; by_station?: VarStation[]; items: VarItem[] }

export default function FoodCostPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('mf.fc_title')} description={t('mf.fc_desc')} />
      <Tabs tabs={[
        { key: 'menu', label: t('mf.fc_tab_margins'), content: <Margins /> },
        { key: 'ingredients', label: t('mf.fc_tab_ingredients'), content: <Ingredients /> },
        { key: 'variance', label: t('mf.fc_tab_variance'), content: <VarianceTab /> },
      ]} />
    </div>
  );
}

function VarianceTab() {
  const { t } = useLang();
  // Reason-code label (key-based, guarded — falls back to the raw code if the catalog lacks the key).
  const reasonLabel = (code: string) => { const k = `mf.fc_reason_${code}`; const v = t(k); return v === k ? code : v; };
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() + 7 * 3600 * 1000 - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const q = useQuery<Variance>({ queryKey: ['food-variance', from, to], queryFn: () => api(`/api/menu/food-cost/variance?from=${from}&to=${to}`) });
  const s = q.data?.summary;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div><Label>{t('mf.from')}</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" /></div>
        <div><Label>{t('mf.to')}</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" /></div>
      </div>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('mf.fc_theoretical_cost')} value={baht(s?.theoretical_cost ?? 0)} icon={Utensils} tone="primary" hint={t('mf.fc_theoretical_hint')} />
              <StatCard label={t('mf.fc_net_variance')} value={baht(s?.variance_cost ?? 0)} icon={Scale} tone={(s?.variance_cost ?? 0) > 0 ? 'danger' : 'success'} hint={t('mf.fc_of_theoretical', { pct: s?.variance_pct ?? 0 })} />
              <StatCard label={t('mf.fc_unfavorable')} value={baht(s?.unfavorable_cost ?? 0)} icon={AlertTriangle} tone={(s?.unfavorable_cost ?? 0) > 0 ? 'warning' : 'default'} hint={t('mf.fc_unfavorable_hint')} />
              <StatCard label={t('mf.fc_anomalies')} value={num(s?.anomalies ?? 0)} icon={TrendingUp} tone={(s?.anomalies ?? 0) > 0 ? 'danger' : 'default'} />
            </div>
            {((q.data.by_reason?.length ?? 0) > 0 || (q.data.by_station?.length ?? 0) > 0) && (
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t('mf.fc_by_reason')}</h3>
                  <DataTable
                    rows={q.data.by_reason ?? []}
                    rowKey={(r) => r.reason_code}
                    columns={[
                      { key: 'reason_code', label: t('mf.fc_col_reason'), render: (r) => reasonLabel(r.reason_code) },
                      { key: 'variance_cost', label: t('mf.fc_col_variance_baht'), align: 'right', render: (r) => <span className={r.variance_cost > 0 ? 'text-destructive tabular' : 'text-success tabular'}>{baht(r.variance_cost)}</span> },
                      { key: 'variance_pct', label: '%', align: 'right', render: (r) => <span className="tabular">{r.variance_pct}%</span> },
                    ]}
                    emptyState={{ icon: Scale, title: t('mf.fc_no_reason') }}
                  />
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t('mf.fc_by_station')}</h3>
                  <DataTable
                    rows={q.data.by_station ?? []}
                    rowKey={(r) => r.station}
                    columns={[
                      { key: 'station', label: t('mf.fc_col_station'), render: (r) => r.station },
                      { key: 'variance_cost', label: t('mf.fc_col_variance_baht'), align: 'right', render: (r) => <span className={r.variance_cost > 0 ? 'text-destructive tabular' : 'text-success tabular'}>{baht(r.variance_cost)}</span> },
                      { key: 'variance_pct', label: '%', align: 'right', render: (r) => <span className="tabular">{r.variance_pct}%</span> },
                    ]}
                    emptyState={{ icon: Scale, title: t('mf.fc_no_station') }}
                  />
                </div>
              </div>
            )}
            <DataTable
              rows={q.data.items}
              rowKey={(r) => r.item_id}
              columns={[
                { key: 'item_id', label: t('mf.col_material'), render: (r) => <span>{r.description ?? r.item_id}</span> },
                { key: 'theoretical_use', label: t('mf.fc_col_theoretical_use'), align: 'right', render: (r) => num(r.theoretical_use) },
                { key: 'actual_use', label: t('mf.fc_col_actual_use'), align: 'right', render: (r) => num(r.actual_use) },
                { key: 'variance_qty', label: t('mf.fc_col_variance'), align: 'right', render: (r) => <span className="tabular">{r.variance_qty}</span> },
                { key: 'variance_cost', label: t('mf.fc_col_variance_baht'), align: 'right', render: (r) => <span className={r.variance_cost > 0 ? 'text-destructive tabular' : 'text-success tabular'}>{baht(r.variance_cost)}</span> },
                { key: 'variance_pct', label: '% ', align: 'right', render: (r) => <Badge variant={r.anomaly === 'High' ? 'destructive' : r.anomaly === 'Medium' ? 'warning' : 'muted'}>{r.variance_pct}%</Badge> },
              ]}
              emptyState={{
                icon: CalendarSearch,
                title: t('mf.fc_variance_empty_title'),
                description: t('mf.fc_variance_empty_desc'),
              }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

function Margins() {
  const { t } = useLang();
  const q = useQuery<FoodCost>({ queryKey: ['food-cost'], queryFn: () => api('/api/menu/food-cost') });
  const s = q.data?.summary;
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('mf.fc_total_dishes')} value={num(s?.items ?? 0)} icon={Utensils} tone="primary" hint={t('mf.fc_costed_hint', { costed: num(s?.costed ?? 0), uncosted: num(s?.uncosted ?? 0) })} />
            <StatCard label={t('mf.fc_avg_foodcost')} value={`${s?.avg_food_cost_pct ?? 0}%`} icon={Percent} tone={(s?.avg_food_cost_pct ?? 0) > (q.data.target_pct) ? 'warning' : 'success'} hint={t('mf.fc_target_hint', { pct: q.data.target_pct })} />
            <StatCard label={t('mf.fc_over_target')} value={num(s?.over_target ?? 0)} icon={AlertTriangle} tone={(s?.over_target ?? 0) > 0 ? 'danger' : 'default'} hint={t('mf.fc_over_hint', { pct: q.data.target_pct })} />
            <StatCard label={t('mf.fc_costed_dishes')} value={num(s?.costed ?? 0)} icon={TrendingUp} tone="info" />
          </div>
          <DataTable
            rows={q.data.items}
            rowKey={(r) => r.sku}
            columns={[
              { key: 'name', label: t('mf.col_dish'), render: (r) => <span>{r.name}{!r.costed && <Badge variant="muted" className="ml-2 text-[10px]">{t('mf.fc_uncosted_badge')}</Badge>}</span> },
              { key: 'price', label: t('mf.col_sell_price'), align: 'right', render: (r) => <span className="tabular">{baht(r.price)}</span> },
              { key: 'cost', label: t('mf.fc_col_cost'), align: 'right', render: (r) => <span className="tabular">{baht(r.cost)}</span> },
              { key: 'margin', label: t('mf.fc_col_margin'), align: 'right', render: (r) => <span className="tabular">{baht(r.margin)}</span> },
              { key: 'food_cost_pct', label: t('mf.fc_col_foodcost_pct'), align: 'right', render: (r) => <Badge variant={r.food_cost_pct > q.data!.target_pct ? 'destructive' : r.costed ? 'success' : 'muted'}>{r.food_cost_pct}%</Badge> },
              { key: 'margin_pct', label: t('mf.fc_col_margin_pct'), align: 'right', render: (r) => <span className="tabular">{r.margin_pct}%</span> },
            ]}
            emptyState={{
              icon: UtensilsCrossed,
              title: t('mf.menu_empty_title'),
              description: t('mf.fc_dishes_empty_desc'),
            }}
          />
        </div>
      )}
    </StateView>
  );
}

function Ingredients() {
  const q = useQuery<{ ingredients: Ingredient[] }>({ queryKey: ['ingredient-cost'], queryFn: () => api('/api/menu/ingredient-cost') });
  return (
    <StateView q={q}>
      <DataTable
        rows={q.data?.ingredients ?? []}
        rowKey={(r) => r.ingredient_item_id}
        columns={[
          { key: 'ingredient_item_id', label: 'วัตถุดิบ' },
          { key: 'description', label: 'รายละเอียด', render: (r) => r.description ?? '—' },
          { key: 'recipes_using', label: 'ใช้ในสูตร', align: 'right', render: (r) => num(r.recipes_using) },
          { key: 'cost', label: 'ต้นทุนรวม/เสิร์ฟ', align: 'right', render: (r) => <span className="tabular">{baht(r.cost)}</span> },
        ]}
        emptyState={{
          icon: Soup,
          title: 'ยังไม่มีสูตร/วัตถุดิบ',
          description: 'ผูกสูตร (recipe/BoM) ให้เมนู เพื่อดูต้นทุนวัตถุดิบที่ดันต้นทุนอาหาร',
        }}
      />
    </StateView>
  );
}
