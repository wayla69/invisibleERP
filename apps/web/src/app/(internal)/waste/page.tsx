'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, TriangleAlert, Coins } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notifySuccess, notifyError } from '@/lib/notify';

// W1 — waste / spoilage logging. Reason-coded ingredient waste; costed waste posts Dr 5810 / Cr 1200.
interface Waste { waste_no: string; item_id: string; item_description: string | null; qty: number; uom: string | null; reason_code: string; disposition: string | null; unit_cost: number; total_cost: number; journal_no: string | null; logged_by: string | null; created_at: string }
interface Resp { waste: Waste[]; count: number; total_qty: number; total_cost: number; by_reason: { reason: string; qty: number; cost: number; count: number }[] }

// Reason codes → i18n key (labels resolve via t(); raw code is the guarded fallback).
const REASON_KEY: Record<string, string> = { damage: 'iv.waste_reason_damage', expiry: 'iv.waste_reason_expiry', spoilage: 'iv.waste_reason_spoilage', overproduction: 'iv.waste_reason_overproduction', prep_error: 'iv.waste_reason_prep_error', void_fire: 'iv.waste_reason_void_fire', other: 'iv.waste_reason_other' };
// Disposition (WHAT happened to it — POS-5a) → i18n key.
const DISPOSITION_KEY: Record<string, string> = { discard: 'iv.waste_disp_discard', compost: 'iv.waste_disp_compost', donate: 'iv.waste_disp_donate', staff_meal: 'iv.waste_disp_staff_meal', rework: 'iv.waste_disp_rework', return_supplier: 'iv.waste_disp_return_supplier' };

export default function WastePage() {
  const { t } = useLang();
  const reasonLabel = (code: string) => (REASON_KEY[code] ? t(REASON_KEY[code]) : code);
  const dispositionLabel = (code: string | null) => (code && DISPOSITION_KEY[code] ? t(DISPOSITION_KEY[code]) : code ?? '—');
  const qc = useQueryClient();
  const q = useQuery<Resp>({ queryKey: ['waste'], queryFn: () => api('/api/inventory/waste'), refetchInterval: 30_000 });
  const d = q.data;

  const [form, setForm] = useState({ item_id: '', qty: '', reason_code: 'spoilage', disposition: 'discard', unit_cost: '', notes: '' });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const log = useMutation({
    mutationFn: () => api('/api/inventory/waste', { method: 'POST', body: JSON.stringify({
      item_id: form.item_id, qty: Number(form.qty), reason_code: form.reason_code, disposition: form.disposition,
      unit_cost: form.unit_cost ? Number(form.unit_cost) : undefined, notes: form.notes || undefined,
    }) }),
    onSuccess: (r: any) => { notifySuccess(`${t('iv.waste_logged', { no: r.waste_no })}${r.total_cost ? ` (${baht(r.total_cost)})` : ''}`); setForm({ item_id: '', qty: '', reason_code: 'spoilage', disposition: 'discard', unit_cost: '', notes: '' }); qc.invalidateQueries({ queryKey: ['waste'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <ModulePage
      title={t('iv.waste_title')}
      description={t('iv.waste_desc')}
      query={q}
      stats={d && (
        <>
          <StatCard label={t('iv.waste_stat_value')} value={baht(d.total_cost)} icon={Coins} tone={d.total_cost > 0 ? 'warning' : 'success'} />
          <StatCard label={t('iv.waste_stat_count')} value={num(d.count)} icon={Trash2} tone="default" />
          <StatCard label={t('iv.waste_stat_top_reason')} value={d.by_reason[0] ? reasonLabel(d.by_reason[0].reason) : '—'} icon={TriangleAlert} tone={d.by_reason.length ? 'danger' : 'default'} hint={d.by_reason[0] ? baht(d.by_reason[0].cost) : ''} />
          <StatCard label={t('iv.waste_stat_total_qty')} value={num(d.total_qty)} icon={Trash2} tone="default" />
        </>
      )}
      statsClassName="xl:grid-cols-4"
    >
      <div className="mb-4 rounded-xl border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('iv.waste_form_title')}</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <FormField label={t('iv.waste_field_item')}><Input value={form.item_id} onChange={(e) => set('item_id', e.target.value)} placeholder={t('iv.waste_item_ph')} /></FormField>
          <FormField label={t('inv.col_qty')}><Input type="number" min={0} step="any" value={form.qty} onChange={(e) => set('qty', e.target.value)} /></FormField>
          <FormField label={t('iv.waste_field_reason')}>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.reason_code} onChange={(e) => set('reason_code', e.target.value)}>
              {Object.entries(REASON_KEY).map(([k, key]) => <option key={k} value={k}>{t(key)}</option>)}
            </select>
          </FormField>
          <FormField label={t('iv.waste_field_disposition')}>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.disposition} onChange={(e) => set('disposition', e.target.value)}>
              {Object.entries(DISPOSITION_KEY).map(([k, key]) => <option key={k} value={k}>{t(key)}</option>)}
            </select>
          </FormField>
          <FormField label={t('iv.waste_field_unit_cost')}><Input type="number" min={0} step="any" value={form.unit_cost} onChange={(e) => set('unit_cost', e.target.value)} placeholder={t('iv.waste_unit_cost_ph')} /></FormField>
          <div className="flex items-end"><Button disabled={log.isPending || !form.item_id || !form.qty} onClick={() => log.mutate()}>{t('fin.save')}</Button></div>
        </div>
      </div>

      {/* by-reason breakdown */}
      {d && d.by_reason.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {d.by_reason.map((r) => (
            <Badge key={r.reason} variant="outline" className="gap-1.5 py-1.5">
              {reasonLabel(r.reason)}: <strong>{baht(r.cost)}</strong> <span className="text-muted-foreground">({num(r.qty)} · {r.count})</span>
            </Badge>
          ))}
        </div>
      )}

      {d && (
        <DataTable
          rows={d.waste}
          rowKey={(r) => r.waste_no}
          emptyState={{ icon: Trash2, title: t('iv.waste_empty_title'), description: t('iv.waste_empty_desc') }}
          columns={[
            { key: 'waste_no', label: t('dash.col_no'), render: (r) => <span className="font-mono text-sm">{r.waste_no}</span> },
            { key: 'item', label: t('iv.waste_col_item'), render: (r) => r.item_description || r.item_id },
            { key: 'qty', label: t('inv.col_qty'), align: 'right', render: (r) => `${num(r.qty)}${r.uom ? ' ' + r.uom : ''}` },
            { key: 'reason', label: t('iv.waste_col_reason'), render: (r) => <Badge variant="muted">{reasonLabel(r.reason_code)}</Badge> },
            { key: 'disposition', label: t('iv.waste_col_disposition'), render: (r) => <Badge variant="outline">{dispositionLabel(r.disposition)}</Badge> },
            { key: 'total_cost', label: t('iv.waste_col_value'), align: 'right', render: (r) => r.total_cost > 0 ? baht(r.total_cost) : '—' },
            { key: 'journal_no', label: t('iv.waste_col_journal'), render: (r) => r.journal_no ? <span className="font-mono text-xs">{r.journal_no}</span> : '—' },
            { key: 'created_at', label: t('dash.col_date'), render: (r) => thaiDate(r.created_at) },
          ]}
        />
      )}
    </ModulePage>
  );
}
