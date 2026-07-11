'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, UserCheck, UserX, ClipboardList, Play, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

// GRC-2 (ITGC-AC-21) — line-item Access Recertification Campaign with closed-loop revocation. Open a
// campaign (snapshots every user's effective access), keep/revoke each user in-app, then certify — which
// asserts every line is decided (ITEMS_PENDING) and ACTUALLY removes the grants of every 'revoke' line.
// Gated 'users' (access administration); the API enforces the same.
const statusVariant = (s: string) => (s === 'certified' ? 'secondary' : s === 'in_review' ? 'warning' : 'default');

export default function AccessRecertClient({ initialCerts }: { initialCerts?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);

  const certs = useQuery<any>({ queryKey: ['recert-campaigns'], queryFn: () => api('/api/admin/users/access-review/certifications'), initialData: initialCerts });
  const campaigns: any[] = certs.data?.reviews ?? [];

  const open = useMutation({
    mutationFn: () => { const period = prompt(t('st.recert.period_prompt')); if (!period) return Promise.resolve(null); const notes = prompt(t('st.recert.notes_prompt')) ?? undefined; return api('/api/admin/users/access-review/campaign', { method: 'POST', body: JSON.stringify({ period, notes }) }); },
    onSuccess: (r: any) => { if (r) { notifySuccess(t('st.recert.opened', { period: r.period, n: r.items_total })); qc.invalidateQueries({ queryKey: ['recert-campaigns'] }); setSelected(r.id); } },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-4">
      <PageHeader title={t('st.recert.title')} description={t('st.recert.subtitle')} />
      <Card className="gap-3 p-5">
        <h3 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck className="size-4" /> {t('st.recert.new_campaign')}</h3>
        <p className="text-sm text-muted-foreground">{t('st.recert.new_desc')}</p>
        <Button className="w-fit" size="sm" disabled={open.isPending} onClick={() => open.mutate()}><Play className="size-4" /> {t('st.recert.open_btn')}</Button>
      </Card>

      {selected != null && <CampaignDetail id={selected} onClose={() => setSelected(null)} />}

      <StateView q={certs}>
        <Card className="gap-3 p-5">
          <h3 className="flex items-center gap-2 text-base font-semibold"><ClipboardList className="size-4" /> {t('st.recert.history')}</h3>
          <DataTable
            rows={campaigns}
            rowKey={(r: any) => r.id}
            emptyState={{ icon: ClipboardList, title: t('st.recert.empty_title'), description: t('st.recert.empty_desc') }}
            columns={[
              { key: 'period', label: t('st.recert.col_period') },
              { key: 'status', label: t('st.recert.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status) as any}>{t(`st.recert.status_${r.status}`)}</Badge> },
              { key: 'reviewed_by', label: t('st.recert.col_reviewer') },
              { key: 'items_total', label: t('st.recert.col_items'), render: (r: any) => r.items_total ?? r.user_count ?? '—' },
              { key: 'items_revoked', label: t('st.recert.col_revoked'), render: (r: any) => r.items_revoked ?? '—' },
              { key: 'open', label: '', render: (r: any) => <Button size="sm" variant="outline" onClick={() => setSelected(r.id)}>{t('st.recert.review_btn')}</Button> },
            ]}
          />
        </Card>
      </StateView>
    </div>
  );
}

function CampaignDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['recert-campaign', id], queryFn: () => api(`/api/admin/users/access-review/campaign/${id}`) });
  const c = q.data;
  const items: any[] = c?.items ?? [];
  const frozen = c?.status === 'certified';

  const decide = useMutation({
    mutationFn: (v: { username: string; decision: 'keep' | 'revoke' }) => api(`/api/admin/users/access-review/campaign/${id}/items/${v.username}`, { method: 'POST', body: JSON.stringify({ decision: v.decision }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['recert-campaign', id] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const certify = useMutation({
    mutationFn: () => api(`/api/admin/users/access-review/campaign/${id}/certify`, { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(t('st.recert.certified', { revoked: r.items_revoked, kept: r.items_kept })); qc.invalidateQueries({ queryKey: ['recert-campaign', id] }); qc.invalidateQueries({ queryKey: ['recert-campaigns'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="gap-3 border-primary/40 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck className="size-4" /> {t('st.recert.campaign')} {c?.period ?? id}</h3>
        {c && <Badge variant={statusVariant(c.status) as any}>{t(`st.recert.status_${c.status}`)}</Badge>}
        {c && <span className="text-sm text-muted-foreground">{t('st.recert.pending_count', { n: c.pending })}</span>}
        <div className="ml-auto flex gap-2">
          <Button size="sm" disabled={frozen || (c?.pending ?? 1) > 0 || certify.isPending} onClick={() => certify.mutate()}><CheckCircle2 className="size-4" /> {t('st.recert.certify_btn')}</Button>
          <Button size="sm" variant="outline" onClick={onClose}>{t('st.recert.close_btn')}</Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{t('st.recert.detail_desc')}</p>
      <StateView q={q}>
        <DataTable
          rows={items}
          rowKey={(r: any) => r.username}
          columns={[
            { key: 'username', label: t('st.recert.col_user') },
            { key: 'role', label: t('st.recert.col_role'), render: (r: any) => <Badge variant="secondary">{r.role ?? '—'}</Badge> },
            { key: 'current_perms', label: t('st.recert.col_access'), render: (r: any) => <span className="text-xs text-muted-foreground">{(r.current_perms ?? []).length} · {(r.current_perms ?? []).slice(0, 6).join(', ')}{(r.current_perms ?? []).length > 6 ? '…' : ''}</span> },
            { key: 'decision', label: t('st.recert.col_decision'), render: (r: any) => (
              <div className="flex items-center gap-2">
                <Button size="sm" variant={r.decision === 'keep' ? 'default' : 'outline'} disabled={frozen || decide.isPending} onClick={() => decide.mutate({ username: r.username, decision: 'keep' })}><UserCheck className="size-3.5" /> {t('st.recert.keep')}</Button>
                <Button size="sm" variant={r.decision === 'revoke' ? 'destructive' : 'outline'} disabled={frozen || decide.isPending} onClick={() => decide.mutate({ username: r.username, decision: 'revoke' })}><UserX className="size-3.5" /> {t('st.recert.revoke')}</Button>
                {r.actioned && <Badge variant="secondary">{t('st.recert.actioned')}</Badge>}
              </div>
            ) },
          ]}
        />
      </StateView>
    </Card>
  );
}
