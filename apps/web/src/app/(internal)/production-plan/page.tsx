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
              <StatCard label="วางแผน" value={`${q.data.horizon_days} วัน`} icon={Soup} hint={`พยากรณ์จากยอดขาย ${q.data.lookback_days} วันย้อนหลัง`} />
              <StatCard label="เมนูต้องเตรียม" value={num(q.data.summary.dishes_to_prep)} icon={ChefHat} tone="primary" />
              <StatCard label="วัตถุดิบต้องสั่งซื้อ" value={num(q.data.summary.ingredients_to_order)} icon={ShoppingCart} tone={q.data.summary.ingredients_to_order > 0 ? 'warning' : 'success'} />
            </div>

            <Section title="รายการเตรียมครัว (Prep list) — ทำล่วงหน้าให้พอขาย">
              <DataTable
                rows={q.data.prep}
                rowKey={(r: any) => r.sku}
                emptyState={{
                  icon: ChefHat,
                  title: 'ยังไม่มีรายการเตรียมครัว',
                  description: 'ไม่มีเมนูที่ต้องเตรียมสำหรับช่วงนี้ — ลองเพิ่มจำนวนวันที่วางแผนล่วงหน้า หรือยอดขายย้อนหลังอาจยังไม่พอพยากรณ์',
                }}
                columns={[
                  { key: 'name', label: 'เมนู' },
                  { key: 'velocity_per_day', label: 'ขาย/วัน (เฉลี่ย)', align: 'right', render: (r: any) => num(r.velocity_per_day) },
                  { key: 'forecast_qty', label: 'พยากรณ์', align: 'right', render: (r: any) => num(r.forecast_qty) },
                  { key: 'prep_suggestion', label: 'แนะนำให้เตรียม', align: 'right', render: (r: any) => <strong>{num(r.prep_suggestion)}</strong> },
                  { key: 'model', label: 'โมเดล', render: (r: any) => <Badge variant="muted" className="font-mono text-[10px]">{r.model}{typeof r.forecast_wape === 'number' ? ` · ${Math.round((1 - r.forecast_wape) * 100)}%` : ''}</Badge> },
                  { key: 'ingredient_short', label: 'วัตถุดิบ', render: (r: any) => r.ingredient_short ? <Badge variant="warning">วัตถุดิบไม่พอ</Badge> : <Badge variant="muted">พอ</Badge> },
                ]}
              />
            </Section>

            <Section title="รายการสั่งซื้อวัตถุดิบ (Buy list) — ความต้องการเทียบสต๊อก + จุดสั่งซื้อ">
              {q.data.purchase_orders.length === 0
                ? <p className="text-sm text-muted-foreground">ไม่มีวัตถุดิบที่ต้องสั่งซื้อสำหรับช่วงนี้ ✓</p>
                : (
                  <>
                  <div className="mb-1 flex items-center justify-end">
                    <Button size="sm" disabled={createPo.isPending} onClick={() => createPo.mutate()}>
                      <FilePlus className="size-4" /> {createPo.isPending ? 'กำลังสร้าง…' : 'สร้างใบสั่งซื้อ (ร่าง)'}
                    </Button>
                  </div>
                  <DataTable
                    rows={q.data.purchase_orders}
                    rowKey={(r: any) => r.item_id}
                    columns={[
                      { key: 'description', label: 'วัตถุดิบ', render: (r: any) => r.description ?? r.item_id },
                      { key: 'current_stock', label: 'คงเหลือ', align: 'right', render: (r: any) => num(r.current_stock) },
                      { key: 'required', label: 'ต้องใช้', align: 'right', render: (r: any) => num(r.required) },
                      { key: 'order_qty', label: 'แนะนำสั่งซื้อ', align: 'right', render: (r: any) => <strong>{num(r.order_qty)} {r.uom ?? ''}</strong> },
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
