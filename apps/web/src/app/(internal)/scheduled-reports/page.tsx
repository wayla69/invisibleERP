'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Plus, Trash2, Play, RefreshCw, History } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ReportType { key: string; label: string; label_en: string }
interface Catalog { report_types: ReportType[]; frequencies: string[] }
interface Subscription { id: number; name: string; report_type: string; frequency: string; recipients: { email?: string }[]; is_active: boolean; next_run_at: string | null }
interface Run { id: number; name: string; report_type: string; frequency: string; status: string; recipients_count: number; error: string | null; ran_at: string | null }

// Frequency key map — resolved to a localized label via t() at render time (raw key fallback).
const FREQ_KEY: Record<string, string> = { daily: 'pb.freq_daily', weekly: 'pb.freq_weekly', monthly: 'pb.freq_monthly' };

export default function ScheduledReportsPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('pb.sr_title')} description={t('pb.sr_subtitle')} />
      <Tabs tabs={[
        { key: 'subs', label: t('pb.sr_tab_subs'), content: <Subscriptions /> },
        { key: 'runs', label: t('pb.sr_tab_runs'), content: <Runs /> },
      ]} />
    </div>
  );
}

function Subscriptions() {
  const { t } = useLang();
  const freqLabel = (f: string) => (FREQ_KEY[f] ? t(FREQ_KEY[f]) : f);
  const qc = useQueryClient();
  const cat = useQuery<Catalog>({ queryKey: ['report-types'], queryFn: () => api('/api/bi/report-types') });
  const q = useQuery<{ subscriptions: Subscription[] }>({ queryKey: ['bi-subscriptions'], queryFn: () => api('/api/bi/subscriptions') });
  const [name, setName] = useState(''); const [reportType, setReportType] = useState(''); const [frequency, setFrequency] = useState('daily'); const [email, setEmail] = useState('');
  const types = cat.data?.report_types ?? [];

  const create = useMutation({
    mutationFn: () => api('/api/bi/subscriptions', { method: 'POST', body: JSON.stringify({ name, report_type: reportType || types[0]?.key, frequency, recipients: email ? [{ email }] : [] }) }),
    onSuccess: () => { notifySuccess(t('pb.sr_created', { name })); setName(''); setEmail(''); qc.invalidateQueries({ queryKey: ['bi-subscriptions'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const sweep = useMutation({
    mutationFn: () => api('/api/bi/subscriptions/run', { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(t('pb.sr_swept', { n: r.ran_count })); qc.invalidateQueries({ queryKey: ['bi-subscriptions'] }); qc.invalidateQueries({ queryKey: ['bi-runs'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const runNow = useMutation({
    mutationFn: (id: number) => api(`/api/bi/subscriptions/${id}/run`, { method: 'POST' }),
    onSuccess: (r: any) => { if (r.status === 'success') notifySuccess(t('pb.sr_sent', { n: r.delivered })); else notifyError(t('pb.sr_send_failed', { err: r.error ?? '' })); qc.invalidateQueries({ queryKey: ['bi-runs'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const remove = useMutation({ mutationFn: (id: number) => api(`/api/bi/subscriptions/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['bi-subscriptions'] }) });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><CalendarClock className="h-4 w-4" />{t('pb.sr_setup')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="sm:col-span-2"><Label>{t('pb.sr_report_name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('pb.sr_ph_name')} /></div>
            <div><Label>{t('pb.sr_report_type')}</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={reportType} onChange={(e) => setReportType(e.target.value)}>
                {types.map((rt) => <option key={rt.key} value={rt.key}>{rt.label}</option>)}
              </select>
            </div>
            <div><Label>{t('pb.sr_frequency')}</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                {(cat.data?.frequencies ?? ['daily', 'weekly', 'monthly']).map((f) => <option key={f} value={f}>{freqLabel(f)}</option>)}
              </select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>{t('pb.sr_recipient_email')}</Label><Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cfo@example.com" /></div>
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={!name || (!reportType && !types.length) || create.isPending} onClick={() => create.mutate()}><Plus className="mr-1 h-4 w-4" />{t('pb.sr_create_btn')}</Button>
            <Button variant="outline" disabled={sweep.isPending} onClick={() => sweep.mutate()}><RefreshCw className="mr-1 h-4 w-4" />{t('pb.sr_run_due_now')}</Button>
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data?.subscriptions ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'name', label: t('pb.sr_report_name') },
            { key: 'report_type', label: t('pb.col_type'), render: (r) => <code className="text-xs">{r.report_type}</code> },
            { key: 'frequency', label: t('pb.sr_col_freq'), render: (r) => <Badge variant="muted">{freqLabel(r.frequency)}</Badge> },
            { key: 'recipients', label: t('pb.sr_col_recipients'), render: (r) => (r.recipients ?? []).map((x) => x.email).filter(Boolean).join(', ') || '—' },
            { key: 'next_run_at', label: t('pb.sr_col_next_run'), render: (r) => r.next_run_at ? new Date(r.next_run_at).toLocaleString('th-TH') : '—' },
            { key: 'run', label: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" disabled={runNow.isPending} onClick={() => runNow.mutate(r.id)} title={t('pb.sr_run_now')}><Play className="h-4 w-4" /></Button> },
            { key: 'act', label: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(r.id)}><Trash2 className="h-4 w-4" /></Button> },
          ]}
          emptyState={{ icon: CalendarClock, title: t('pb.sr_empty_title'), description: t('pb.sr_empty_desc') }}
        />
      </StateView>
    </div>
  );
}

function Runs() {
  const { t } = useLang();
  const q = useQuery<{ runs: Run[] }>({ queryKey: ['bi-runs'], queryFn: () => api('/api/bi/runs'), refetchInterval: 15_000 });
  return (
    <StateView q={q}>
      <DataTable
        rows={q.data?.runs ?? []}
        rowKey={(r) => r.id}
        columns={[
          { key: 'ran_at', label: t('pb.sr_col_time'), render: (r) => r.ran_at ? new Date(r.ran_at).toLocaleString('th-TH') : '—' },
          { key: 'name', label: t('pb.sr_col_report') },
          { key: 'report_type', label: t('pb.col_type'), render: (r) => <code className="text-xs">{r.report_type}</code> },
          { key: 'recipients_count', label: t('pb.sr_col_sent_to'), align: 'right', render: (r) => r.recipients_count },
          { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={r.status === 'success' ? 'success' : 'destructive'}>{r.status === 'success' ? t('pb.status_success') : t('pb.status_failed')}</Badge> },
          { key: 'error', label: t('pb.col_note'), render: (r) => r.error ?? '' },
        ]}
        emptyState={{ icon: History, title: t('pb.sr_empty_runs_title'), description: t('pb.sr_empty_runs_desc') }}
      />
    </StateView>
  );
}
