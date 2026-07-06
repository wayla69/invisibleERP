'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CircleDollarSign, RefreshCw, ShieldAlert, ShieldOff } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { notifySuccess, notifyError } from '@/lib/notify';

interface CreditPosition {
  tenant_id: number;
  customer: string;
  credit_term: number | null;
  credit_limit: number;
  exposure: number;
  overdue: number;
  max_overdue_days: number;
  available_credit: number | null;
  over_limit: boolean;
  serious_overdue: boolean;
  manual_hold: boolean;
  on_hold: boolean;
}

interface CreditEvent {
  event_type: 'hold' | 'release' | 'limit_change';
  old_limit: number | null;
  new_limit: number | null;
  reason: string | null;
  actioned_by: string;
  created_at: string;
}

export default function CreditHoldPage() {
  const { t } = useLang();
  const qc = useQueryClient();

  const positions = useQuery<{ positions: CreditPosition[]; count: number; on_hold_count: number; as_of: string }>({
    queryKey: ['credit-positions'],
    queryFn: () => api('/api/finance/ar/credit-positions'),
    refetchInterval: 60000,
  });

  // Hold / release dialog state
  const [holdDialog, setHoldDialog] = useState<{ tenantId: number; customer: string; action: 'hold' | 'release' } | null>(null);
  const [holdReason, setHoldReason] = useState('');

  // Credit limit change dialog state
  const [limitDialog, setLimitDialog] = useState<{ tenantId: number; customer: string; currentLimit: number } | null>(null);
  const [newLimit, setNewLimit] = useState('');
  const [limitReason, setLimitReason] = useState('');

  // Credit events (audit trail) dialog state
  const [eventsTenantId, setEventsTenantId] = useState<number | null>(null);
  const events = useQuery<{ tenant_id: number; count: number; events: CreditEvent[] }>({
    queryKey: ['credit-events', eventsTenantId],
    queryFn: () => api(`/api/finance/ar/credit-events?tenant_id=${eventsTenantId}`),
    enabled: eventsTenantId != null,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['credit-positions'] });

  const placeHold = useMutation<{ customer: string }, Error, { tenant_id: number; reason?: string }>({
    mutationFn: (b) => api('/api/finance/ar/credit-hold', { method: 'POST', body: JSON.stringify(b) }) as Promise<{ customer: string }>,
    onSuccess: (r) => { notifySuccess(t('fnx.credhold.toast_held', { customer: r.customer })); setHoldDialog(null); setHoldReason(''); refresh(); },
    onError: (e: any) => notifyError(e?.message ?? t('fnx.credhold.err_hold')),
  });

  const releaseHold = useMutation<{ customer: string }, Error, { tenant_id: number; reason?: string }>({
    mutationFn: (b) => api('/api/finance/ar/credit-release', { method: 'POST', body: JSON.stringify(b) }) as Promise<{ customer: string }>,
    onSuccess: (r) => { notifySuccess(t('fnx.credhold.toast_released', { customer: r.customer })); setHoldDialog(null); setHoldReason(''); refresh(); },
    onError: (e: any) => notifyError(e?.message ?? t('fnx.credhold.err_release')),
  });

  // REV-08 (audit G7): a credit-limit change is staged for an independent approver — reflect the pending outcome.
  const changeLimit = useMutation<{ customer: string; new_limit: number; pending?: boolean }, Error, { tenant_id: number; new_limit: number; reason?: string }>({
    mutationFn: (b) => api('/api/finance/ar/credit-limit', { method: 'POST', body: JSON.stringify(b) }) as Promise<{ customer: string; new_limit: number; pending?: boolean }>,
    onSuccess: (r) => {
      notifySuccess(t('fnx.credhold.toast_limit_pending', { customer: r.customer, newLimit: baht(r.new_limit) }));
      setLimitDialog(null); setNewLimit(''); setLimitReason('');
      qc.invalidateQueries({ queryKey: ['credit-limit-pending'] });
      refresh();
    },
    onError: (e: any) => notifyError(e?.message ?? t('fnx.credhold.err_limit')),
  });

  // Pending credit-limit approvals (a change must be approved by a different user).
  const pendingLimits = useQuery<{ requests: { req_no: string; customer: string; old_limit: number; new_limit: number; reason: string | null; requested_by: string }[] }>({
    queryKey: ['credit-limit-pending'], queryFn: () => api('/api/finance/ar/credit-limit/pending'),
  });
  const approveLimit = useMutation<{ customer: string; new_limit: number }, Error, string>({
    mutationFn: (reqNo) => api(`/api/finance/ar/credit-limit/${reqNo}/approve`, { method: 'POST' }) as Promise<{ customer: string; new_limit: number }>,
    onSuccess: (r) => { notifySuccess(t('fnx.credhold.toast_limit_approved', { customer: r.customer, newLimit: baht(r.new_limit) })); qc.invalidateQueries({ queryKey: ['credit-limit-pending'] }); refresh(); },
    onError: (e: any) => notifyError(e?.message ?? t('fnx.credhold.err_limit')),
  });
  const rejectLimit = useMutation<unknown, Error, string>({
    mutationFn: (reqNo) => api(`/api/finance/ar/credit-limit/${reqNo}/reject`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => { notifySuccess(t('fnx.credhold.toast_limit_rejected')); qc.invalidateQueries({ queryKey: ['credit-limit-pending'] }); },
    onError: (e: any) => notifyError(e?.message ?? t('fnx.credhold.err_limit')),
  });
  const pendingLimitRows = pendingLimits.data?.requests ?? [];

  const data = positions.data;
  const totalExposure = (data?.positions ?? []).reduce((a, p) => a + p.exposure, 0);
  const totalOverdue = (data?.positions ?? []).reduce((a, p) => a + p.overdue, 0);

  const actionPending = placeHold.isPending || releaseHold.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('fnx.credhold.title')}
        description={t('fnx.credhold.desc')}
      />

      {/* REV-08 (audit G7): credit-limit changes staged for an independent approver. */}
      {pendingLimitRows.length > 0 && (
        <Card className="border-amber-300 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="size-4" /> {t('fnx.credhold.pending_title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">{t('fnx.credhold.pending_desc')}</p>
            {pendingLimitRows.map((r) => (
              <div key={r.req_no} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2.5 text-sm">
                <span className="font-medium">{r.customer}</span>
                <span className="text-muted-foreground">{baht(r.old_limit)} → <span className="font-medium text-foreground">{baht(r.new_limit)}</span></span>
                {r.reason && <span className="text-xs text-muted-foreground">· {r.reason}</span>}
                <Badge variant="secondary" className="text-xs">{r.requested_by}</Badge>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" disabled={approveLimit.isPending} onClick={() => approveLimit.mutate(r.req_no)}>{t('fnx.credhold.btn_approve')}</Button>
                  <Button size="sm" variant="outline" disabled={rejectLimit.isPending} onClick={() => rejectLimit.mutate(r.req_no)}>{t('fnx.credhold.btn_reject')}</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t('fnx.credhold.stat_on_hold')}
          value={data ? String(data.on_hold_count) : '—'}
          icon={ShieldAlert}
          tone="danger"
          hint={t('fnx.credhold.stat_on_hold_hint')}
        />
        <StatCard
          label={t('fnx.credhold.stat_exposure')}
          value={data ? baht(totalExposure) : '—'}
          icon={CircleDollarSign}
          tone="warning"
          hint={t('fnx.credhold.stat_exposure_hint')}
        />
        <StatCard
          label={t('fnx.credhold.stat_overdue')}
          value={data ? baht(totalOverdue) : '—'}
          icon={AlertTriangle}
          tone="danger"
          hint={t('fnx.credhold.stat_overdue_hint')}
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">{data ? t('fnx.credhold.positions_title_count', { count: data.count, as_of: data.as_of }) : t('fnx.credhold.positions_title')}</CardTitle>
          <Button variant="outline" size="sm" onClick={refresh} disabled={positions.isFetching}>
            <RefreshCw className={`mr-1 size-4 ${positions.isFetching ? 'animate-spin' : ''}`} />
            {t('fnx.credhold.refresh')}
          </Button>
        </CardHeader>
        <CardContent>
          <StateView q={positions}>
            <DataTable
              rows={data?.positions ?? []}
              rowKey={(r) => String(r.tenant_id)}
              emptyState={{ icon: ShieldOff, title: t('fnx.credhold.empty_title'), description: t('fnx.credhold.empty_desc') }}
              columns={[
                { key: 'customer', label: t('fin.col_customer') },
                {
                  key: 'exposure', label: t('fin.col_outstanding'), align: 'right',
                  render: (r) => <span className="tabular-nums">{baht(r.exposure)}</span>,
                },
                {
                  key: 'overdue', label: t('fnx.credhold.col_overdue'), align: 'right',
                  render: (r) => <span className={`tabular-nums ${r.overdue > 0 ? 'text-destructive' : ''}`}>{baht(r.overdue)}</span>,
                },
                {
                  key: 'max_overdue_days', label: t('fnx.credhold.col_max_overdue'), align: 'right',
                  render: (r) => <span className={`tabular-nums ${r.max_overdue_days > 90 ? 'text-destructive font-medium' : ''}`}>{r.max_overdue_days}d</span>,
                },
                {
                  key: 'credit_limit', label: t('fnx.credhold.col_limit'), align: 'right',
                  render: (r) => <span className="tabular-nums">{r.credit_limit > 0 ? baht(r.credit_limit) : '—'}</span>,
                },
                {
                  key: 'available_credit', label: t('fnx.credhold.col_available'), align: 'right',
                  render: (r) => (
                    <span className={`tabular-nums ${r.over_limit ? 'text-destructive font-medium' : ''}`}>
                      {r.available_credit != null ? baht(r.available_credit) : '—'}
                    </span>
                  ),
                },
                {
                  key: 'status', label: t('fin.col_status'), sortable: false,
                  render: (r) => (
                    <div className="flex flex-wrap gap-1">
                      {r.manual_hold && <Badge variant="destructive">{t('fnx.credhold.badge_manual_hold')}</Badge>}
                      {r.over_limit && <Badge variant="destructive">{t('fnx.credhold.badge_over_limit')}</Badge>}
                      {r.serious_overdue && <Badge variant="destructive">{t('fnx.credhold.badge_overdue_90')}</Badge>}
                      {!r.on_hold && <Badge variant="success">{t('fnx.credhold.badge_normal')}</Badge>}
                    </div>
                  ),
                },
                {
                  key: 'actions', label: '', sortable: false,
                  render: (r) => (
                    <div className="flex gap-1">
                      {!r.manual_hold ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => { setHoldDialog({ tenantId: r.tenant_id, customer: r.customer, action: 'hold' }); setHoldReason(''); }}
                        >
                          <ShieldAlert className="mr-1 size-3.5" />
                          {t('fnx.credhold.action_hold')}
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => { setHoldDialog({ tenantId: r.tenant_id, customer: r.customer, action: 'release' }); setHoldReason(''); }}
                        >
                          <ShieldOff className="mr-1 size-3.5" />
                          {t('fnx.credhold.action_release')}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setLimitDialog({ tenantId: r.tenant_id, customer: r.customer, currentLimit: r.credit_limit }); setNewLimit(String(r.credit_limit > 0 ? r.credit_limit : '')); setLimitReason(''); }}
                      >
                        {t('fnx.credhold.action_limit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEventsTenantId(r.tenant_id)}
                      >
                        {t('fnx.credhold.action_history')}
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </StateView>
        </CardContent>
      </Card>

      {/* Place / release hold dialog */}
      <Dialog
        open={holdDialog != null}
        onOpenChange={(o) => { if (!o) { setHoldDialog(null); setHoldReason(''); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {holdDialog?.action === 'hold' ? t('fnx.credhold.dlg_hold_title', { customer: holdDialog.customer }) : t('fnx.credhold.dlg_release_title', { customer: holdDialog?.customer ?? '' })}
            </DialogTitle>
          </DialogHeader>
          {holdDialog?.action === 'release' && (
            <p className="text-sm text-muted-foreground">{t('fnx.credhold.sod_note')}</p>
          )}
          <div className="grid gap-2">
            <Label>{t('fnx.credhold.reason')} {holdDialog?.action === 'hold' ? t('fnx.credhold.optional') : t('fnx.credhold.optional')}</Label>
            <Input
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value)}
              placeholder={holdDialog?.action === 'hold' ? t('fnx.credhold.hold_reason_ph') : t('fnx.credhold.release_reason_ph')}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setHoldDialog(null); setHoldReason(''); }}>{t('fin.cancel')}</Button>
            {holdDialog?.action === 'hold' ? (
              <Button
                variant="destructive"
                disabled={actionPending}
                onClick={() => placeHold.mutate({ tenant_id: holdDialog.tenantId, reason: holdReason || undefined })}
              >
                {t('fnx.credhold.confirm_hold')}
              </Button>
            ) : (
              <Button
                disabled={actionPending}
                onClick={() => holdDialog && releaseHold.mutate({ tenant_id: holdDialog.tenantId, reason: holdReason || undefined })}
              >
                {t('fnx.credhold.confirm_release')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Credit limit change dialog */}
      <Dialog
        open={limitDialog != null}
        onOpenChange={(o) => { if (!o) { setLimitDialog(null); setNewLimit(''); setLimitReason(''); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('fnx.credhold.dlg_limit_title', { customer: limitDialog?.customer ?? '' })}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>{t('fnx.credhold.current_limit')}</Label>
              <p className="text-sm text-muted-foreground">{limitDialog ? (limitDialog.currentLimit > 0 ? baht(limitDialog.currentLimit) : t('fnx.credhold.unlimited')) : '—'}</p>
            </div>
            <div className="grid gap-2">
              <Label>{t('fnx.credhold.new_limit')}</Label>
              <Input
                type="number"
                min="0"
                step="1000"
                value={newLimit}
                onChange={(e) => setNewLimit(e.target.value)}
                placeholder={t('fnx.credhold.new_limit_ph')}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t('fnx.credhold.reason')}</Label>
              <Input
                value={limitReason}
                onChange={(e) => setLimitReason(e.target.value)}
                placeholder={t('fnx.credhold.limit_reason_ph')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLimitDialog(null)}>{t('fin.cancel')}</Button>
            <Button
              disabled={changeLimit.isPending || newLimit === '' || Number(newLimit) < 0}
              onClick={() => limitDialog && changeLimit.mutate({ tenant_id: limitDialog.tenantId, new_limit: Number(newLimit), reason: limitReason || undefined })}
            >
              {t('fin.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Credit events audit trail dialog */}
      <Dialog
        open={eventsTenantId != null}
        onOpenChange={(o) => { if (!o) setEventsTenantId(null); }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('fnx.credhold.history_title')}</DialogTitle>
          </DialogHeader>
          <StateView q={events}>
            <DataTable
              rows={events.data?.events ?? []}
              rowKey={(_, i) => String(i)}
              emptyState={{ icon: ShieldOff, title: t('fnx.credhold.history_empty_title'), description: t('fnx.credhold.history_empty_desc') }}
              columns={[
                {
                  key: 'event_type', label: t('fnx.credhold.col_event_type'),
                  render: (r) => (
                    <Badge variant={r.event_type === 'hold' ? 'destructive' : r.event_type === 'release' ? 'success' : 'default'}>
                      {r.event_type === 'hold' ? t('fnx.credhold.evt_hold') : r.event_type === 'release' ? t('fnx.credhold.evt_release') : t('fnx.credhold.evt_limit')}
                    </Badge>
                  ),
                },
                { key: 'reason', label: t('fnx.credhold.reason'), render: (r) => r.reason ?? '—' },
                { key: 'actioned_by', label: t('fnx.credhold.col_actioned_by') },
                { key: 'created_at', label: t('fnx.credhold.col_time'), render: (r) => thaiDate(r.created_at) },
              ]}
            />
          </StateView>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEventsTenantId(null)}>{t('fnx.credhold.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
