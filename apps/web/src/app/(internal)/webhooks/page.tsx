'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Webhook, Plus, Trash2, RefreshCw, Send, History } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface EventDef { key: string; label: string; label_en: string }
interface Hook { id: number; url: string; events: string[]; active: boolean; createdBy: string | null; createdAt: string | null }
interface Delivery { id: number; webhook_id: number; event: string; status: string; status_code: number | null; attempts: number; error: string | null; created_at: string | null; delivered_at: string | null }

export default function WebhooksPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('st.wh.title')} description={t('st.wh.desc')} />
      <Tabs tabs={[
        { key: 'endpoints', label: t('st.wh.tab_endpoints'), content: <Endpoints /> },
        { key: 'deliveries', label: t('st.wh.tab_deliveries'), content: <Deliveries /> },
      ]} />
    </div>
  );
}

function Endpoints() {
  const { t } = useLang();
  const qc = useQueryClient();
  const cat = useQuery<{ events: EventDef[] }>({ queryKey: ['wh-events'], queryFn: () => api('/api/platform/webhooks/events') });
  const q = useQuery<Hook[]>({ queryKey: ['wh-list'], queryFn: () => api('/api/platform/webhooks') });
  const [url, setUrl] = useState(''); const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState('');
  const allEvents = cat.data?.events ?? [];

  const create = useMutation({
    mutationFn: () => api<{ secret: string }>('/api/platform/webhooks', { method: 'POST', body: JSON.stringify({ url, events }) }),
    onSuccess: (r) => { setSecret(r.secret); notifySuccess(t('st.wh.created')); setUrl(''); setEvents([]); qc.invalidateQueries({ queryKey: ['wh-list'] }); },
    onError: (e: Error) => { notifyError(e.message); setSecret(''); },
  });
  const remove = useMutation({ mutationFn: (id: number) => api(`/api/platform/webhooks/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['wh-list'] }) });
  const toggle = (k: string) => setEvents((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Webhook className="h-4 w-4" />{t('st.wh.register_new')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div><Label>{t('st.wh.url')}</Label><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/ierp-webhook" /></div>
          <div>
            <Label>{t('st.wh.events_label')}</Label>
            <div className="mt-1 flex flex-wrap gap-2">
              {allEvents.map((e) => (
                <button key={e.key} type="button" onClick={() => toggle(e.key)}
                  className={`rounded-full border px-3 py-1 text-xs ${events.includes(e.key) ? 'bg-primary text-primary-foreground' : 'bg-background'}`}>
                  {e.label} <code className="opacity-70">{e.key}</code>
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={!url || create.isPending} onClick={() => create.mutate()}><Plus className="mr-1 h-4 w-4" />{t('st.wh.register')}</Button>
          </div>
          {secret && (
            <div className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
              <div className="font-medium">{t('st.wh.secret_label')}</div>
              <code className="break-all">{secret}</code>
              <div className="mt-1 text-xs text-muted-foreground">{t('st.wh.verify_prefix')} <code>HMAC-SHA256(secret, `${'{timestamp}'}.${'{body}'}`)</code> {t('st.wh.verify_compare')} <code>X-IERP-Signature</code></div>
            </div>
          )}
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'url', label: 'URL', render: (r) => <code className="text-xs">{r.url}</code> },
            { key: 'events', label: t('st.wh.col_events'), render: (r) => (r.events?.length ? r.events.map((e) => <Badge key={e} variant="muted" className="mr-1">{e}</Badge>) : <Badge variant="info">{t('st.wh.all')}</Badge>) },
            { key: 'active', label: t('fin.col_status'), render: (r) => <Badge variant={r.active ? 'success' : 'muted'}>{r.active ? t('st.wh.active') : t('st.wh.inactive')}</Badge> },
            { key: 'createdAt', label: t('st.wh.col_created'), render: (r) => r.createdAt ? new Date(r.createdAt).toLocaleString('th-TH') : '—' },
            { key: 'act', label: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(r.id)}><Trash2 className="h-4 w-4" /></Button> },
          ]}
          emptyState={{ icon: Webhook, title: t('st.wh.empty_ep_title'), description: t('st.wh.empty_ep_desc') }}
        />
      </StateView>
    </div>
  );
}

function Deliveries() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ deliveries: Delivery[] }>({ queryKey: ['wh-deliveries'], queryFn: () => api('/api/platform/webhooks/deliveries'), refetchInterval: 15_000 });
  const redeliver = useMutation({ mutationFn: (id: number) => api(`/api/platform/webhooks/deliveries/${id}/redeliver`, { method: 'POST' }), onSuccess: (r: any) => { notifySuccess(t('st.wh.redelivered', { id: r.id, status: r.status })); qc.invalidateQueries({ queryKey: ['wh-deliveries'] }); } });
  const dispatch = useMutation({ mutationFn: () => api('/api/platform/webhooks/dispatch', { method: 'POST' }), onSuccess: (r: any) => { notifySuccess(t('st.wh.dispatched', { delivered: r.delivered, still_failed: r.still_failed })); qc.invalidateQueries({ queryKey: ['wh-deliveries'] }); } });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Button variant="outline" disabled={dispatch.isPending} onClick={() => dispatch.mutate()}><RefreshCw className="mr-1 h-4 w-4" />{t('st.wh.dispatch_btn')}</Button>
      </div>
      <StateView q={q}>
        <DataTable
          rows={q.data?.deliveries ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'created_at', label: t('st.wh.col_time'), render: (r) => r.created_at ? new Date(r.created_at).toLocaleString('th-TH') : '—' },
            { key: 'event', label: t('st.wh.col_events'), render: (r) => <code className="text-xs">{r.event}</code> },
            { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={r.status === 'delivered' ? 'success' : r.status === 'failed' ? 'destructive' : 'muted'}>{r.status}</Badge> },
            { key: 'attempts', label: t('st.wh.col_attempts'), align: 'right', render: (r) => r.attempts },
            { key: 'error', label: t('st.wh.col_error'), render: (r) => <span className="text-xs text-muted-foreground">{r.error ?? ''}</span> },
            { key: 'act', label: '', align: 'right', render: (r) => r.status !== 'delivered' ? <Button size="sm" variant="ghost" disabled={redeliver.isPending} onClick={() => redeliver.mutate(r.id)} title={t('st.wh.redeliver_title')}><Send className="h-4 w-4" /></Button> : null },
          ]}
          emptyState={{ icon: History, title: t('st.wh.empty_del_title'), description: t('st.wh.empty_del_desc') }}
        />
      </StateView>
    </div>
  );
}
