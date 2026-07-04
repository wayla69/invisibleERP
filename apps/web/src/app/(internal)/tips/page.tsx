'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Coins, HandCoins, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notifySuccess, notifyError } from '@/lib/notify';

// B3 — tip pooling / distribution. Tips accrue to 2300 Tips Payable on checkout; a manager pays the
// pool out to staff (Dr 2300 / Cr 1000), clearing the liability. SoD: distributing needs order_mgt/exec.
interface Dist { dist_no: string; period_from: string; period_to: string; method: string; pool_amount: number; journal_no: string | null; created_by: string | null; created_at: string; lines: { staff: string; amount: number; share: number }[] }
interface ListResp { distributions: Dist[]; count: number; gl_outstanding: number }
interface Pool { from: string; to: string; collected: number; distributed: number; available: number; gl_outstanding: number }

function today() { const d = new Date(); return d.toISOString().slice(0, 10); }
function monthStart() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; }

export default function TipsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const list = useQuery<ListResp>({ queryKey: ['tips'], queryFn: () => api('/api/restaurant/tips'), refetchInterval: 30_000 });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['tips'] }); qc.invalidateQueries({ queryKey: ['tip-pool'] }); };

  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [method, setMethod] = useState<'equal' | 'hours' | 'weight'>('equal');
  const [staff, setStaff] = useState('');

  const pool = useQuery<Pool>({ queryKey: ['tip-pool', from, to], queryFn: () => api(`/api/restaurant/tips/pool?from=${from}&to=${to}`) });

  const distribute = useMutation({
    mutationFn: () => {
      const rows = staff.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).map((line) => {
        const [name, val] = line.split(/[:\s]+/);
        return method === 'equal' ? { staff: name } : method === 'hours' ? { staff: name, hours: Number(val) || 0 } : { staff: name, weight: Number(val) || 0 };
      });
      return api('/api/restaurant/tips/distribute', { method: 'POST', body: JSON.stringify({ from, to, method, staff: rows }) });
    },
    onSuccess: (r: any) => { notifySuccess(t('px.tips_distributed_ok', { amount: baht(r.amount), count: r.lines.length })); setStaff(''); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const d = list.data;
  return (
    <ModulePage
      title={t('px.tips_title')}
      description={t('px.tips_desc')}
      query={list}
      stats={d && (
        <>
          <StatCard label={t('px.tips_outstanding')} value={baht(d.gl_outstanding)} icon={Coins} tone={d.gl_outstanding > 0 ? 'warning' : 'success'} hint={t('px.tips_outstanding_hint')} />
          <StatCard label={t('px.tips_available')} value={baht(pool.data?.available ?? 0)} icon={HandCoins} tone="primary" />
          <StatCard label={t('px.tips_collected')} value={baht(pool.data?.collected ?? 0)} icon={Wallet} tone="default" />
          <StatCard label={t('px.tips_distributed_count')} value={String(d.count)} icon={HandCoins} tone="default" hint={t('px.tips_times')} />
        </>
      )}
      statsClassName="xl:grid-cols-4"
    >
      <div className="mb-4 rounded-xl border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('px.tips_distribute_heading')}</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FormField label={t('px.tips_from')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
          <FormField label={t('px.tips_to')}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
          <FormField label={t('px.tips_method')}>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={method} onChange={(e) => setMethod(e.target.value as any)}>
              <option value="equal">{t('px.tips_method_equal')}</option>
              <option value="hours">{t('px.tips_method_hours')}</option>
              <option value="weight">{t('px.tips_method_weight')}</option>
            </select>
          </FormField>
          <div className="flex items-end"><div className="text-sm text-muted-foreground">{t('px.tips_available_inline')} <strong className="text-foreground">{baht(pool.data?.available ?? 0)}</strong></div></div>
          <FormField label={method === 'equal' ? t('px.tips_staff_lines') : t('px.tips_staff_weighted', { unit: method === 'hours' ? t('px.tips_unit_hours') : t('px.tips_unit_weight') })} className="lg:col-span-3">
            <textarea className="min-h-[72px] w-full rounded-md border bg-background p-2 text-sm" value={staff} onChange={(e) => setStaff(e.target.value)} placeholder={method === 'equal' ? t('px.tips_staff_ph_equal') : t('px.tips_staff_ph_weighted')} />
          </FormField>
          <div className="flex items-end"><Button disabled={distribute.isPending || !staff.trim() || (pool.data?.available ?? 0) <= 0} onClick={() => distribute.mutate()}>{t('px.tips_distribute_btn')}</Button></div>
        </div>
      </div>

      {d && (
        <DataTable
          rows={d.distributions}
          rowKey={(r) => r.dist_no}
          emptyState={{ icon: HandCoins, title: t('px.tips_empty_title'), description: t('px.tips_empty_desc') }}
          columns={[
            { key: 'dist_no', label: t('dash.col_no'), render: (r) => <span className="font-mono text-sm">{r.dist_no}</span> },
            { key: 'period', label: t('px.tips_col_period'), render: (r) => `${r.period_from} → ${r.period_to}` },
            { key: 'method', label: t('px.tips_col_method'), render: (r) => (['equal', 'hours', 'weight'].includes(r.method) ? t(`px.tips_m_${r.method}`) : r.method) },
            { key: 'pool_amount', label: t('px.tips_col_total'), align: 'right', render: (r) => baht(r.pool_amount) },
            { key: 'lines', label: t('px.tips_col_staff'), render: (r) => <span className="text-muted-foreground text-xs">{r.lines.map((l) => `${l.staff} ${baht(l.amount)}`).join(' · ')}</span> },
            { key: 'created_at', label: t('dash.col_date'), render: (r) => thaiDate(r.created_at) },
          ]}
        />
      )}
    </ModulePage>
  );
}
