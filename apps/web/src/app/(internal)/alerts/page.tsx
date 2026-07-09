'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BellRing, Plus, Trash2, Play, History } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { num, thaiDateTime } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { ModulePage } from '@/components/module-page';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Metric { key: string; label: string; label_en: string; unit: string }
interface Catalog { metrics: Metric[]; operators: string[]; channels: string[] }
interface Rule { id: number; name: string; metric: string; operator: string; threshold: number; channel: string; target_role: string | null; target_to: string | null; severity: string; cooldown_hours: number; active: boolean; last_fired_at: string | null }
interface AlertEvent { id: number; name: string; metric: string; value: number; threshold: number; severity: string; channel: string; fired_at: string | null }

const OP_LABEL: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' };

export default function AlertsPage() {
  const { t } = useLang();
  return (
    <div>
      <ModulePage title={t('st.alert.title')} description={t('st.alert.subtitle')} tabs={[
        { key: 'rules', label: t('st.alert.tab_rules'), content: <Rules /> },
        { key: 'events', label: t('st.alert.tab_events'), content: <Events /> },
      ]} />
    </div>
  );
}

function Rules() {
  const { t } = useLang();
  const qc = useQueryClient();
  const cat = useQuery<Catalog>({ queryKey: ['alert-metrics'], queryFn: () => api('/api/alerts/metrics') });
  const prev = useQuery<{ values: Record<string, number> }>({ queryKey: ['alert-preview'], queryFn: () => api('/api/alerts/preview') });
  const q = useQuery<{ rules: Rule[] }>({ queryKey: ['alert-rules'], queryFn: () => api('/api/alerts/rules') });
  const [name, setName] = useState(''); const [metric, setMetric] = useState(''); const [operator, setOperator] = useState('gte'); const [threshold, setThreshold] = useState('');
  const [channel, setChannel] = useState('notification'); const [targetRole, setTargetRole] = useState(''); const [targetTo, setTargetTo] = useState(''); const [severity, setSeverity] = useState('warning'); const [cooldown, setCooldown] = useState('12');
  const metrics = cat.data?.metrics ?? [];
  const create = useMutation({
    mutationFn: () => api('/api/alerts/rules', { method: 'POST', body: JSON.stringify({ name, metric: metric || metrics[0]?.key, operator, threshold: Number(threshold) || 0, channel, target_role: targetRole || undefined, target_to: targetTo || undefined, severity, cooldown_hours: Number(cooldown) || 0 }) }),
    onSuccess: () => { notifySuccess(t('st.alert.rule_added', { name })); setName(''); setThreshold(''); qc.invalidateQueries({ queryKey: ['alert-rules'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const run = useMutation({
    mutationFn: () => api('/api/alerts/run', { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(t('st.alert.checked', { fired: r.fired_count, suppressed: r.suppressed })); qc.invalidateQueries({ queryKey: ['alert-rules'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const toggle = useMutation({ mutationFn: ({ id, active }: { id: number; active: boolean }) => api(`/api/alerts/rules/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }) });
  const remove = useMutation({ mutationFn: (id: number) => api(`/api/alerts/rules/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }) });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><BellRing className="h-4 w-4" />{t('st.alert.create_rule')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="sm:col-span-2"><Label>{t('st.alert.rule_name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('st.alert.rule_name_ph')} /></div>
            <div><Label>{t('st.alert.metric')}</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={metric} onChange={(e) => setMetric(e.target.value)}>
                {metrics.map((m) => <option key={m.key} value={m.key}>{m.label} ({prev.data?.values?.[m.key] ?? 0})</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-1">
              <div><Label>{t('st.alert.condition')}</Label>
                <select className="h-9 w-full rounded-md border bg-background px-1 text-sm" value={operator} onChange={(e) => setOperator(e.target.value)}>
                  {(cat.data?.operators ?? []).map((o) => <option key={o} value={o}>{OP_LABEL[o] ?? o}</option>)}
                </select>
              </div>
              <div><Label>{t('st.alert.threshold')}</Label><Input value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="1" /></div>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <div><Label>{t('st.alert.channel')}</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={channel} onChange={(e) => setChannel(e.target.value)}>
                {(cat.data?.channels ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {channel === 'notification'
              ? <div><Label>{t('st.alert.notify_role')}</Label><Input value={targetRole} onChange={(e) => setTargetRole(e.target.value)} placeholder="Warehouse" /></div>
              : <div><Label>{t('st.alert.recipient', { channel })}</Label><Input value={targetTo} onChange={(e) => setTargetTo(e.target.value)} placeholder={t('st.alert.recipient_ph')} /></div>}
            <div><Label>{t('st.alert.severity')}</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={severity} onChange={(e) => setSeverity(e.target.value)}>
                {['info', 'warning', 'critical'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div><Label>{t('st.alert.cooldown')}</Label><Input value={cooldown} onChange={(e) => setCooldown(e.target.value)} /></div>
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={!name || (!metric && !metrics.length) || create.isPending} onClick={() => create.mutate()}><Plus className="mr-1 h-4 w-4" />{t('st.alert.add_rule')}</Button>
            <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate()}><Play className="mr-1 h-4 w-4" />{t('st.alert.check_now')}</Button>
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data?.rules ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'name', label: t('st.alert.rule_name') },
            { key: 'metric', label: t('st.alert.condition'), render: (r) => <code className="text-xs">{r.metric} {OP_LABEL[r.operator] ?? r.operator} {r.threshold}</code> },
            { key: 'channel', label: t('st.alert.channel'), render: (r) => <Badge variant="muted">{r.channel}{r.target_role ? ` · ${r.target_role}` : ''}</Badge> },
            { key: 'severity', label: t('st.alert.severity'), render: (r) => <Badge variant={r.severity === 'critical' ? 'destructive' : r.severity === 'warning' ? 'warning' : 'info'}>{r.severity}</Badge> },
            { key: 'active', label: t('fin.col_status'), render: (r) => <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: r.id, active: !r.active })}><Badge variant={r.active ? 'success' : 'muted'}>{r.active ? t('st.alert.on') : t('st.alert.off')}</Badge></Button> },
            { key: 'act', label: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(r.id)}><Trash2 className="h-4 w-4" /></Button> },
          ]}
          emptyState={{ icon: BellRing, title: t('st.alert.empty_title'), description: t('st.alert.empty_desc') }}
        />
      </StateView>
    </div>
  );
}

function Events() {
  const { t } = useLang();
  const q = useQuery<{ events: AlertEvent[] }>({ queryKey: ['alert-events'], queryFn: () => api('/api/alerts/events'), refetchInterval: 15_000 });
  return (
    <StateView q={q}>
      <DataTable
        rows={q.data?.events ?? []}
        rowKey={(r) => r.id}
        columns={[
          { key: 'fired_at', label: t('st.alert.col_time'), render: (r) => thaiDateTime(r.fired_at) },
          { key: 'name', label: t('st.alert.col_rule') },
          { key: 'metric', label: t('st.alert.metric'), render: (r) => <code className="text-xs">{r.metric}</code> },
          { key: 'value', label: t('st.alert.col_value'), align: 'right', render: (r) => <span className="tabular">{num(r.value)} / {num(r.threshold)}</span> },
          { key: 'severity', label: t('st.alert.severity'), render: (r) => <Badge variant={r.severity === 'critical' ? 'destructive' : r.severity === 'warning' ? 'warning' : 'info'}>{r.severity}</Badge> },
          { key: 'channel', label: t('st.alert.channel'), render: (r) => r.channel },
        ]}
        emptyState={{ icon: History, title: t('st.alert.events_empty_title'), description: t('st.alert.events_empty_desc') }}
      />
    </StateView>
  );
}
