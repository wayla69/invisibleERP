'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, XCircle, AlarmClock } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

// SVC-3 — renewal queue (SVC-02 maker-checker: a pending renewal must be approved by a DIFFERENT user than
// the proposer — the API returns 403 SOD_SELF_APPROVAL otherwise) + the expiring-contract worklist.
export default function RenewalsClient({ initialRenewals, initialExpiring }: { initialRenewals?: any; initialExpiring?: any }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('svc.ren.title')} description={t('svc.ren.subtitle')} />
      <Tabs tabs={[
        { key: 'queue', label: t('svc.ren.tab_queue'), content: <Queue initialRenewals={initialRenewals} /> },
        { key: 'expiring', label: t('svc.ren.tab_expiring'), content: <Expiring initialExpiring={initialExpiring} /> },
      ]} />
    </div>
  );
}

const statusBadge = (t: (k: string) => string, s: string) =>
  s === 'approved' ? <Badge variant="success">{t('svc.ren.status_approved')}</Badge>
  : s === 'rejected' ? <Badge variant="destructive">{t('svc.ren.status_rejected')}</Badge>
  : <Badge variant="warning">{t('svc.ren.status_pending')}</Badge>;

function Queue({ initialRenewals }: { initialRenewals?: any }) {
  const { t, fmtNumber } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['svc-renewals', 'pending'], queryFn: () => api('/api/service/renewals?status=pending'), initialData: initialRenewals });

  const approve = useMutation({
    mutationFn: (id: number) => api(`/api/service/renewals/${id}/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('svc.ren.approved_ok')); qc.invalidateQueries({ queryKey: ['svc-renewals'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });
  const reject = useMutation({
    mutationFn: (id: number) => api(`/api/service/renewals/${id}/reject`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => { notifySuccess(t('svc.ren.rejected_ok')); qc.invalidateQueries({ queryKey: ['svc-renewals'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });

  const rows: any[] = q.data?.renewals ?? [];
  return (
    <StateView q={q}>
      {rows.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">{t('svc.ren.empty_queue')}</Card>
      ) : (
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="p-3">{t('svc.ren.col_renewal_no')}</th>
              <th className="p-3 text-right">{t('svc.ren.col_base')}</th>
              <th className="p-3 text-right">{t('svc.ren.col_uplift')}</th>
              <th className="p-3 text-right">{t('svc.ren.col_new_value')}</th>
              <th className="p-3">{t('svc.ren.col_term')}</th>
              <th className="p-3">{t('svc.ren.col_requested_by')}</th>
              <th className="p-3">{t('svc.ren.col_status')}</th>
              <th className="p-3 text-right">{t('svc.ren.col_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="p-3 font-medium">{r.renewal_no}</td>
                <td className="p-3 text-right">{fmtNumber(r.base_value)}</td>
                <td className="p-3 text-right">{fmtNumber(r.uplift_pct)}%</td>
                <td className="p-3 text-right font-semibold">{fmtNumber(r.new_value)}</td>
                <td className="p-3 whitespace-nowrap text-xs text-muted-foreground">{r.proposed_start} → {r.proposed_end}</td>
                <td className="p-3 text-xs text-muted-foreground">{r.requested_by}</td>
                <td className="p-3">{statusBadge(t, r.status)}</td>
                <td className="p-3">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => approve.mutate(r.id)} disabled={approve.isPending}>
                      <CheckCircle2 className="size-4" /><span className="hidden sm:inline">{t('svc.ren.btn_approve')}</span>
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => reject.mutate(r.id)} disabled={reject.isPending}>
                      <XCircle className="size-4" /><span className="hidden sm:inline">{t('svc.ren.btn_reject')}</span>
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      )}
    </StateView>
  );
}

function Expiring({ initialExpiring }: { initialExpiring?: any }) {
  const { t, fmtNumber } = useLang();
  const [days, setDays] = useState(60);
  const q = useQuery<any>({ queryKey: ['svc-expiring', days], queryFn: () => api(`/api/service/contracts/expiring?days=${days}`), initialData: days === 60 ? initialExpiring : undefined });
  const rows: any[] = q.data?.expiring ?? [];
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2 text-sm">
        <AlarmClock className="size-4 text-muted-foreground" />
        <label htmlFor="svc-days">{t('svc.ren.days_horizon')}</label>
        <select id="svc-days" className="rounded-md border bg-background px-2 py-1" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[30, 60, 90, 180].map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <StateView q={q}>
        {rows.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">{t('svc.ren.empty_expiring')}</Card>
        ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3">{t('svc.ren.col_contract_no')}</th>
                <th className="p-3">{t('svc.ren.col_customer')}</th>
                <th className="p-3">{t('svc.ren.col_end_date')}</th>
                <th className="p-3 text-right">{t('svc.ren.col_days')}</th>
                <th className="p-3 text-right">{t('svc.ren.col_monthly')}</th>
                <th className="p-3">{t('svc.ren.col_auto_renew')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="p-3 font-medium">{c.contract_no}</td>
                  <td className="p-3">{c.customer_name}</td>
                  <td className="p-3 whitespace-nowrap">
                    {c.end_date}
                    {c.expired && <Badge variant="destructive" className="ms-2">{t('svc.ren.expired_badge')}</Badge>}
                  </td>
                  <td className="p-3 text-right">{c.days_to_expiry}</td>
                  <td className="p-3 text-right">{fmtNumber(c.monthly_value)}</td>
                  <td className="p-3">{c.auto_renew ? <CalendarClock className="size-4 text-muted-foreground" /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        )}
      </StateView>
    </div>
  );
}
