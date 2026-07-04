'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, DollarSign, LayoutTemplate, Users, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
const today = () => new Date().toISOString().slice(0, 10);

// PMO configuration — rate cards (P2), reusable WBS templates (B2), and cross-project resource utilization.
export default function ProjectSettingsPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('pj.settings_title')} description={t('pj.settings_desc')} />
      <Tabs tabs={[
        { key: 'rates', label: t('pj.tab_rate_cards'), content: <RateCards /> },
        { key: 'templates', label: t('pj.tab_wbs_templates'), content: <Templates /> },
        { key: 'util', label: t('pj.tab_utilization'), content: <Utilization /> },
      ]} />
    </div>
  );
}

function RateCards() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['rate-cards'], queryFn: () => api('/api/projects/rate-cards') });
  const [f, setF] = useState({ role: '', cost_rate: '', bill_rate: '', effective_from: today(), effective_to: '' });
  const add = useMutation({
    mutationFn: () => api('/api/projects/rate-cards', { method: 'POST', body: JSON.stringify({ role: f.role, cost_rate: Number(f.cost_rate) || 0, bill_rate: Number(f.bill_rate) || 0, effective_from: f.effective_from || undefined, effective_to: f.effective_to || undefined }) }),
    onSuccess: () => { notifySuccess(t('pj.toast_rate_added')); setF({ role: '', cost_rate: '', bill_rate: '', effective_from: today(), effective_to: '' }); qc.invalidateQueries({ queryKey: ['rate-cards'] }); }, onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('pj.add_rate_heading')}</h3>
        <p className="text-xs text-muted-foreground">{t('pj.rate_note')}</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="grid gap-1.5"><Label>{t('pj.col_role')}</Label><Input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} placeholder={t('pj.ph_senior_dev')} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.col_cost_rate')}</Label><Input type="number" min="0" value={f.cost_rate} onChange={(e) => setF({ ...f, cost_rate: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.col_bill_rate')}</Label><Input type="number" min="0" value={f.bill_rate} onChange={(e) => setF({ ...f, bill_rate: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_effective_from')}</Label><Input type="date" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_effective_to')}</Label><Input type="date" value={f.effective_to} onChange={(e) => setF({ ...f, effective_to: e.target.value })} /></div>
        </div>
        <div><Button onClick={() => add.mutate()} disabled={!f.role || add.isPending}><Plus className="size-4" /> {t('pj.btn_add_rate')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && (
        <DataTable
          rows={q.data.rate_cards ?? []}
          rowKey={(r: any) => r.id}
          columns={[
            { key: 'role', label: t('pj.col_role') },
            { key: 'cost_rate', label: t('pj.col_cost_rate'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.cost_rate)}</span> },
            { key: 'bill_rate', label: t('pj.col_bill_rate'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.bill_rate)}</span> },
            { key: 'margin', label: t('pj.col_margin_hr'), align: 'right', render: (r: any) => <span className="tabular">{baht((r.bill_rate || 0) - (r.cost_rate || 0))}</span> },
            { key: 'effective_from', label: t('pj.col_from') },
            { key: 'effective_to', label: t('pj.col_to'), render: (r: any) => r.effective_to ?? '—' },
          ]}
          emptyState={{ icon: DollarSign, title: t('pj.empty_rates_title'), description: t('pj.empty_rates_desc') }}
        />
      )}</StateView>
    </div>
  );
}

type Item = { item_type: 'task' | 'milestone'; name: string; planned_hours: string; planned_cost: string; offset_start_days: string; offset_end_days: string; billing_percent: string };
const emptyItem = (): Item => ({ item_type: 'task', name: '', planned_hours: '', planned_cost: '', offset_start_days: '0', offset_end_days: '0', billing_percent: '' });

function Templates() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['project-templates'], queryFn: () => api('/api/projects/templates') });
  const [meta, setMeta] = useState({ name: '', code: '', description: '' });
  const [items, setItems] = useState<Item[]>([emptyItem()]);
  const setItem = (i: number, patch: Partial<Item>) => setItems((xs) => xs.map((x, ix) => ix === i ? { ...x, ...patch } : x));
  const create = useMutation({
    mutationFn: () => api('/api/projects/templates', { method: 'POST', body: JSON.stringify({
      name: meta.name, code: meta.code || undefined, description: meta.description || undefined,
      items: items.filter((it) => it.name.trim()).map((it, ix) => ({
        item_type: it.item_type, seq: ix + 1, name: it.name,
        planned_hours: Number(it.planned_hours) || 0, planned_cost: Number(it.planned_cost) || 0,
        offset_start_days: Number(it.offset_start_days) || 0, offset_end_days: Number(it.offset_end_days) || 0,
        billing_percent: it.item_type === 'milestone' && it.billing_percent ? Number(it.billing_percent) : undefined,
      })),
    }) }),
    onSuccess: (r: any) => { notifySuccess(t('pj.toast_template_created', { code: r.code ?? meta.name })); setMeta({ name: '', code: '', description: '' }); setItems([emptyItem()]); qc.invalidateQueries({ queryKey: ['project-templates'] }); }, onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('pj.create_wbs_template')}</h3>
        <p className="text-xs text-muted-foreground">{t('pj.template_note')}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5"><Label>{t('pj.f_template_name')}</Label><Input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_code')}</Label><Input value={meta.code} onChange={(e) => setMeta({ ...meta, code: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_description')}</Label><Input value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></div>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between"><Label>{t('pj.template_items_label')}</Label><Button size="sm" variant="outline" onClick={() => setItems((xs) => [...xs, emptyItem()])}><Plus className="size-4" /> {t('pj.btn_add_item')}</Button></div>
          {items.map((it, i) => (
            <div key={i} className="grid items-end gap-2 rounded-lg border border-border/60 p-3 sm:grid-cols-7">
              <div className="grid gap-1.5"><Label className="text-xs">{t('pj.col_type')}</Label>
                <select className={selectCls} value={it.item_type} onChange={(e) => setItem(i, { item_type: e.target.value as 'task' | 'milestone' })}>
                  <option value="task">{t('pj.opt_task')}</option><option value="milestone">{t('pj.opt_milestone')}</option>
                </select>
              </div>
              <div className="grid gap-1.5 sm:col-span-2"><Label className="text-xs">{t('pj.f_generic_name')}</Label><Input value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} /></div>
              {it.item_type === 'task' ? (
                <>
                  <div className="grid gap-1.5"><Label className="text-xs">{t('pj.col_hours')}</Label><Input type="number" min="0" value={it.planned_hours} onChange={(e) => setItem(i, { planned_hours: e.target.value })} /></div>
                  <div className="grid gap-1.5"><Label className="text-xs">{t('pj.col_budget')}</Label><Input type="number" min="0" value={it.planned_cost} onChange={(e) => setItem(i, { planned_cost: e.target.value })} /></div>
                </>
              ) : (
                <div className="grid gap-1.5 sm:col-span-2"><Label className="text-xs">{t('pj.col_billing_pct')}</Label><Input type="number" min="0" max="100" value={it.billing_percent} onChange={(e) => setItem(i, { billing_percent: e.target.value })} /></div>
              )}
              <div className="grid gap-1.5"><Label className="text-xs">{t('pj.f_offset_start')}</Label><Input type="number" min="0" value={it.offset_start_days} onChange={(e) => setItem(i, { offset_start_days: e.target.value })} /></div>
              <div className="flex gap-1">
                <div className="grid flex-1 gap-1.5"><Label className="text-xs">{t('pj.f_offset_end')}</Label><Input type="number" min="0" value={it.offset_end_days} onChange={(e) => setItem(i, { offset_end_days: e.target.value })} /></div>
                {items.length > 1 && <Button size="sm" variant="ghost" className="self-end" onClick={() => setItems((xs) => xs.filter((_, ix) => ix !== i))}><Trash2 className="size-4" /></Button>}
              </div>
            </div>
          ))}
        </div>
        <div><Button onClick={() => create.mutate()} disabled={!meta.name || !items.some((it) => it.name.trim()) || create.isPending}><Plus className="size-4" /> {t('pj.btn_create_template')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && (
        <DataTable
          rows={q.data.templates ?? []}
          rowKey={(r: any) => r.code}
          columns={[
            { key: 'code', label: t('pj.col_code') },
            { key: 'name', label: t('pj.col_template_name') },
            { key: 'item_count', label: t('pj.col_item_count'), align: 'right', render: (r: any) => <Badge variant="secondary">{r.item_count}</Badge> },
          ]}
          emptyState={{ icon: LayoutTemplate, title: t('pj.empty_templates_title'), description: t('pj.empty_templates_desc') }}
        />
      )}</StateView>
    </div>
  );
}

function Utilization() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['resource-utilization'], queryFn: () => api('/api/projects/resources/utilization') });
  const rows = q.data?.utilization ?? [];
  return (
    <div className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label={t('pj.stat_total_resources')} value={rows.length} icon={Users} tone="primary" />
        <StatCard label={t('pj.stat_over_capacity')} value={q.data?.over_allocated_count ?? 0} icon={ShieldAlert} tone={(q.data?.over_allocated_count ?? 0) > 0 ? 'danger' : 'success'} />
      </div>
      <StateView q={q}>{q.data && (
        <DataTable
          rows={rows}
          rowKey={(r: any) => r.resource_name}
          columns={[
            { key: 'resource_name', label: t('pj.col_resource') },
            { key: 'allocated_pct', label: t('pj.col_total_alloc'), align: 'right', render: (r: any) => (
              <div className="ml-auto flex w-40 items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${r.over_allocated ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${Math.min(100, r.allocated_pct)}%` }} /></div>
                <span className={`tabular w-12 text-right text-xs ${r.over_allocated ? 'font-medium text-destructive' : ''}`}>{r.allocated_pct}%</span>
              </div>
            ) },
            { key: 'over_allocated', label: t('fin.col_status'), render: (r: any) => r.over_allocated ? <Badge variant="destructive">{t('pj.over_capacity_badge')}</Badge> : <Badge variant="success">{t('pj.normal_badge')}</Badge> },
          ]}
          emptyState={{ icon: Users, title: t('pj.empty_util_title'), description: t('pj.empty_util_desc') }}
        />
      )}</StateView>
    </div>
  );
}
