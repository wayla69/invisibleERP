'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Factory, Plus, Play, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DocSelect } from '@/components/doc-select';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { useLang } from '@/lib/i18n';

type Wo = {
  wo_no: string; bom_code: string; product_name: string; uom: string;
  qty_planned: number; qty_produced: number; status: string;
  material_cost: number; labor_cost: number; overhead_cost: number; total_cost: number; unit_cost: number;
  yield_variance: number | null;
};

export default function ManufacturingPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ work_orders: Wo[]; count: number }>({ queryKey: ['work-orders'], queryFn: () => api('/api/manufacturing/work-orders') });
  const [bomCode, setBomCode] = useState('');
  // BOM master pending list — the BOM is picked from a dropdown, not typed.
  const bomsQ = useQuery<any>({ queryKey: ['boms-for-picker'], queryFn: () => api('/api/bom/master'), retry: false });
  const bomOptions = (bomsQ.data?.boms ?? []).map((b: any) => ({ value: b.bom_code ?? b.bomCode, label: b.product_name ?? b.productName ?? undefined }));
  const [qty, setQty] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: ['work-orders'] });
  const create = useMutation({
    mutationFn: () => api<Wo>('/api/manufacturing/work-orders', { method: 'POST', body: JSON.stringify({ bom_code: bomCode, qty_planned: Number(qty) || 0 }) }),
    onSuccess: (r) => { notifySuccess(t('mf.mfg_created', { wo: r.wo_no, cost: baht(r.total_cost) })); setBomCode(''); setQty(''); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const act = useMutation({
    mutationFn: (p: { woNo: string; action: 'issue' | 'complete'; actual_material?: number }) => api<any>(`/api/manufacturing/work-orders/${p.woNo}/${p.action}`, { method: 'POST', body: JSON.stringify(p.action === 'complete' && p.actual_material != null ? { actual_material: p.actual_material } : {}) }),
    onSuccess: (r) => { notifySuccess(r.status === 'Released' ? t('mf.mfg_issued', { wip: baht(r.wip_cost), entry: r.entry_no }) : `${t('mf.mfg_completed', { fg: baht(r.fg_value) })}${r.yield_variance ? t('mf.mfg_yield_var', { amt: baht(r.yield_variance) }) : ''}${r.material_variance ? t('mf.mfg_mat_var', { amt: baht(r.material_variance) }) : ''} — ${r.entry_no}`); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const wos = q.data?.work_orders ?? [];
  const wip = wos.filter((w) => w.status === 'Released').reduce((a, w) => a + w.total_cost, 0);
  const fg = wos.filter((w) => w.status === 'Completed').reduce((a, w) => a + w.total_cost, 0);

  return (
    <div>
      <PageHeader title={t('mf.mfg_title')} description={t('mf.mfg_desc')} />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard label={t('mf.wo_label')} value={q.data?.count ?? 0} icon={Factory} tone="primary" />
        <StatCard label={t('mf.mfg_wip')} value={baht(wip)} tone="primary" />
        <StatCard label={t('mf.mfg_fg')} value={baht(fg)} tone="primary" />
      </div>

      <Card className="mb-5 gap-3 p-5">
        <h3 className="text-base font-semibold">{t('mf.mfg_create')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('mf.mfg_bom_label')}</Label><DocSelect className="w-64" value={bomCode} onValueChange={setBomCode} options={bomOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder="BOM-CAKE" /></div>
          <div className="grid gap-1.5"><Label>{t('mf.mfg_qty_label')}</Label><Input type="number" min="0" value={qty} onChange={(e) => setQty(e.target.value)} className="w-32" /></div>
          <Button onClick={() => create.mutate()} disabled={!bomCode || !qty || create.isPending}><Plus className="size-4" /> {t('mf.create')}</Button>
        </div>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={wos}
            columns={[
              { key: 'wo_no', label: t('mf.mfg_col_wono') },
              { key: 'product_name', label: t('mf.col_product'), render: (r: Wo) => `${r.product_name ?? ''} (${r.bom_code})` },
              { key: 'qty_planned', label: t('inv.col_qty'), align: 'right', render: (r: Wo) => `${r.qty_planned} ${r.uom ?? ''}` },
              { key: 'material_cost', label: t('mf.col_material'), align: 'right', render: (r: Wo) => <span className="tabular">{baht(r.material_cost)}</span> },
              { key: 'total_cost', label: t('mf.col_total_cost'), align: 'right', render: (r: Wo) => <span className="tabular">{baht(r.total_cost)}</span> },
              { key: 'unit_cost', label: t('mf.col_unit_cost'), align: 'right', render: (r: Wo) => <span className="tabular">{baht(r.unit_cost)}</span> },
              { key: 'yield_variance', label: t('mf.col_yield_var'), align: 'right', render: (r: Wo) => r.yield_variance == null ? '—' : <span className={`tabular ${Math.abs(r.yield_variance) >= 0.01 ? 'font-medium text-destructive' : 'text-muted-foreground'}`} title={t('mf.mfg_yield_title')}>{baht(r.yield_variance)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r: Wo) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              {
                key: 'action',
                label: t('mf.col_action'),
                sortable: false,
                render: (r: Wo) =>
                  r.status === 'Open' ? (
                    <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate({ woNo: r.wo_no, action: 'issue' })}><Play className="size-4" /> {t('mf.mfg_issue')}</Button>
                  ) : r.status === 'Released' ? (
                    <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => { const am = window.prompt(t('mf.mfg_actual_prompt')); act.mutate({ woNo: r.wo_no, action: 'complete', actual_material: am && am.trim() ? Number(am) : undefined }); }}><CheckCircle2 className="size-4" /> {t('mf.mfg_complete')}</Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  ),
              },
            ]}
            emptyState={{
              icon: Factory,
              title: t('mf.mfg_empty_title'),
              description: t('mf.mfg_empty_desc'),
            }}
          />
        )}
      </StateView>
    </div>
  );
}
