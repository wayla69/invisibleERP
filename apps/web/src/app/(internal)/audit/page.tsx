'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScrollText, Download, Search, SearchX } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
import { notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface AuditRow {
  id: number; ts: string | null; actor: string | null; tenant_id: number | null; action: string | null;
  entity: string | null; entity_id: string | null; ip: string | null; request_id: string | null; status: string | null; meta: unknown;
}

const PAGE = 50;

export default function AuditPage() {
  const { t } = useLang();
  const [actor, setActor] = useState(''); const [action, setAction] = useState(''); const [status, setStatus] = useState('');
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [applied, setApplied] = useState({ actor: '', action: '', status: '', from: '', to: '' });
  const [page, setPage] = useState(0);

  const qs = (extra: Record<string, string | number>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...applied, ...extra })) if (v !== '' && v != null) p.set(k, String(v));
    return p.toString();
  };
  const q = useQuery<{ rows: AuditRow[]; total: number; limit: number; offset: number }>({
    queryKey: ['audit', applied, page],
    queryFn: () => api(`/api/admin/audit?${qs({ limit: PAGE, offset: page * PAGE })}`),
  });

  const apply = () => { setApplied({ actor, action, status, from, to }); setPage(0); };
  const filtering = Object.values(applied).some((v) => v !== '');
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div>
      <PageHeader title={t('st.aud.title')} description={t('st.aud.desc')} />
      <Card className="mb-4">
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-3 lg:grid-cols-6">
          <div><Label>{t('st.aud.actor')}</Label><Input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="username" /></div>
          <div><Label>{t('st.aud.action')}</Label><Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="/api/orders" /></div>
          <div><Label>{t('fin.col_status')}</Label>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('st.aud.all')}</option><option value="success">success</option><option value="fail">fail</option>
            </select>
          </div>
          <div><Label>{t('st.aud.from')}</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Label>{t('st.aud.to')}</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="flex items-end gap-2">
            <Button onClick={apply}><Search className="mr-1 h-4 w-4" />{t('st.aud.search')}</Button>
            <Button variant="outline" onClick={() => apiDownload(`/api/admin/audit/export?${qs({})}`, 'audit-log.csv').catch((e) => notifyError(e.message))}><Download className="h-4 w-4" /></Button>
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data?.rows ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'ts', label: t('st.aud.col_time'), render: (r) => r.ts ? new Date(r.ts).toLocaleString('th-TH') : '—' },
            { key: 'actor', label: t('st.aud.col_actor'), render: (r) => r.actor ?? <span className="text-muted-foreground">{t('st.aud.system')}</span> },
            { key: 'action', label: t('st.aud.col_action'), render: (r) => <code className="text-xs">{r.action}</code> },
            { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={r.status === 'success' ? 'success' : 'destructive'}>{r.status}</Badge> },
            { key: 'ip', label: 'IP', render: (r) => <span className="text-xs text-muted-foreground">{r.ip ?? '—'}</span> },
            { key: 'request_id', label: 'Request', render: (r) => <span className="text-xs text-muted-foreground">{r.request_id?.slice(0, 8) ?? '—'}</span> },
          ]}
          emptyState={
            filtering
              ? {
                  icon: SearchX,
                  title: t('st.aud.empty_filter_title'),
                  description: t('st.aud.empty_filter_desc'),
                  action: (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setActor(''); setAction(''); setStatus(''); setFrom(''); setTo('');
                        setApplied({ actor: '', action: '', status: '', from: '', to: '' });
                        setPage(0);
                      }}
                    >
                      {t('inv.clear_filter')}
                    </Button>
                  ),
                }
              : {
                  icon: ScrollText,
                  title: t('st.aud.empty_title'),
                  description: t('st.aud.empty_desc'),
                }
          }
        />
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>{t('st.aud.pagination', { total: total.toLocaleString('th-TH'), page: page + 1, pages })}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t('st.aud.prev')}</Button>
            <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>{t('st.aud.next')}</Button>
          </div>
        </div>
      </StateView>
    </div>
  );
}
