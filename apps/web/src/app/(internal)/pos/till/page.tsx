'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Banknote, CheckCircle2, CircleDollarSign, EyeOff, Lock, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDateTime } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable, type Column } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLang } from '@/lib/i18n';

// Till management screen (SoD: pos_till only — segregated from pos_sell cashier duty).
// Covers: open/close sessions, cash movements (paid-in/out/drop), variance approval.

type TillStatus = 'Open' | 'Closed' | 'Variance';
interface XzReport {
  id: number; till_session_id: number; report_type: string; status: TillStatus;
  generated_by: string; generated_at: string; gross_sales: number; total_cash: number;
  total_card: number; total_refund: number; cash_expected: number; cash_counted: number;
  variance: number; content_hash: string; hash_valid?: boolean;
}
interface XzListResp { reports: XzReport[]; count: number }

export default function PosTillPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [openFloat, setOpenFloat] = useState('');
  const [openDialogOpen, setOpenDialogOpen] = useState(false);
  const [varianceId, setVarianceId] = useState<{ sessionNo: string; variance: number } | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [countedCash, setCountedCash] = useState('');
  const [closeResult, setCloseResult] = useState<{ variance: number; expected_cash: number; variance_status: string } | null>(null);

  const q = useQuery<XzListResp>({
    queryKey: ['xz-reports'],
    queryFn: () => api('/api/payments/xz-reports?limit=50'),
  });
  const d = q.data;

  // Blind-close policy + the tenant's current open till (drives the "close till" flow).
  const settingsQ = useQuery<{ blind_close: boolean }>({
    queryKey: ['till-settings'],
    queryFn: () => api('/api/payments/till/settings'),
  });
  const blind = settingsQ.data?.blind_close === true;
  const currentQ = useQuery<{ open: { id: number; session_no: string } | null }>({
    queryKey: ['till-current'],
    queryFn: () => api('/api/payments/till/current'),
  });
  const openTillNow = currentQ.data?.open ?? null;
  // Expected cash for the close dialog — only fetched when NOT blind (server redacts it anyway when
  // the policy is on; not asking at all keeps the number out of the client entirely).
  const xQ = useQuery<any>({
    queryKey: ['till-x', openTillNow?.id],
    queryFn: () => api(`/api/payments/till/${openTillNow!.id}/x-report`),
    enabled: closeDialogOpen && !blind && openTillNow != null,
  });

  const putBlind = useMutation({
    mutationFn: (on: boolean) => api('/api/payments/till/settings', { method: 'PUT', body: JSON.stringify({ blind_close: on }) }),
    onSuccess: () => { notifySuccess(t('px.till_blind_saved')); qc.invalidateQueries({ queryKey: ['till-settings'] }); },
    onError: (e: any) => notifyError(e?.message ?? t('px.till_blind_save_failed')),
  });

  const closeTill = useMutation({
    mutationFn: () => api('/api/payments/till/close', {
      method: 'POST',
      body: JSON.stringify({ session_no: openTillNow!.session_no, closing_count: parseFloat(countedCash || '0') }),
    }),
    onSuccess: (r: any) => {
      setCloseResult({ variance: r?.variance ?? 0, expected_cash: r?.expected_cash ?? 0, variance_status: r?.variance_status ?? 'NotRequired' });
      qc.invalidateQueries({ queryKey: ['xz-reports'] });
      qc.invalidateQueries({ queryKey: ['till-current'] });
    },
    onError: (e: any) => notifyError(e?.message ?? t('px.till_close_failed')),
  });

  const openTill = useMutation({
    mutationFn: (openingFloat: number) =>
      api('/api/payments/till/open', { method: 'POST', body: JSON.stringify({ opening_float: openingFloat }) }),
    onSuccess: (r: any) => {
      notifySuccess(t('px.till_open_success', { session_no: r?.session_no }));
      setOpenDialogOpen(false);
      setOpenFloat('');
      qc.invalidateQueries({ queryKey: ['xz-reports'] });
    },
    onError: (e: any) => notifyError(e?.message ?? t('px.till_open_failed')),
  });

  const approveVariance = useMutation({
    mutationFn: (sessionNo: string) =>
      api(`/api/payments/till/variance/${encodeURIComponent(sessionNo)}/approve`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess(t('px.till_variance_approve_success')); setVarianceId(null); qc.invalidateQueries({ queryKey: ['xz-reports'] }); },
    onError: (e: any) => notifyError(e?.message ?? t('px.till_approve_failed')),
  });

  const rejectVariance = useMutation({
    mutationFn: ({ sessionNo, reason }: { sessionNo: string; reason: string }) =>
      api(`/api/payments/till/variance/${encodeURIComponent(sessionNo)}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: () => { notifySuccess(t('px.till_variance_reject_success')); setVarianceId(null); setRejectReason(''); qc.invalidateQueries({ queryKey: ['xz-reports'] }); },
    onError: (e: any) => notifyError(e?.message ?? t('px.till_reject_failed')),
  });

  const openSessions = d?.reports.filter((r) => r.status === 'Open').length ?? 0;
  const varianceSessions = d?.reports.filter((r) => r.status === 'Variance').length ?? 0;
  const totalSales = d?.reports.reduce((s, r) => s + r.gross_sales, 0) ?? 0;

  const statusBadge = (r: XzReport) =>
    r.status === 'Variance'
      ? <Badge variant="destructive" className="gap-1"><AlertTriangle className="size-3" />{t('px.till_variance_badge')}</Badge>
      : r.variance !== 0 && r.status === 'Closed'
        ? <Badge variant="outline" className="text-orange-700 border-orange-400">{t('px.till_closed_with_variance')}</Badge>
        : r.status === 'Open'
          ? <Badge variant="secondary" className="bg-green-100 text-green-800">{t('px.till_open_badge')}</Badge>
          : <Badge variant="outline">{t('px.till_closed_badge')}</Badge>;

  const columns: Column<XzReport>[] = [
    { key: 'id', label: '#', render: (r) => `S-${r.till_session_id}` },
    { key: 'generated_at', label: t('px.till_col_open_time'), render: (r) => thaiDateTime(r.generated_at) },
    { key: 'gross_sales', label: t('px.till_col_sales'), align: 'right', render: (r) => baht(r.gross_sales) },
    { key: 'total_cash', label: t('px.till_col_cash'), align: 'right', render: (r) => baht(r.total_cash) },
    { key: 'cash_counted', label: t('px.till_col_counted'), align: 'right', render: (r) => baht(r.cash_counted) },
    {
      key: 'variance', label: t('px.till_col_variance'), align: 'right',
      render: (r) => <span className={r.variance !== 0 ? 'font-medium text-destructive' : 'text-muted-foreground'}>{baht(r.variance)}</span>,
    },
    { key: 'generated_by', label: t('px.till_col_opened_by') },
    { key: 'status', label: t('fin.col_status'), render: (r) => statusBadge(r) },
    {
      key: 'id', label: t('px.till_col_actions'),
      render: (r) => r.status === 'Variance' ? (
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" className="h-7 gap-1 text-green-700 hover:bg-green-50"
            disabled={approveVariance.isPending}
            onClick={() => setVarianceId({ sessionNo: String(r.till_session_id), variance: r.variance })}>
            <CheckCircle2 className="size-3.5" />{t('fin.approve')}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-destructive hover:bg-destructive/10"
            onClick={() => { setVarianceId({ sessionNo: String(r.till_session_id), variance: r.variance }); setRejectReason(''); }}>
            <XCircle className="size-3.5" />{t('px.till_reject')}
          </Button>
        </div>
      ) : null,
    },
  ];

  return (
    <ModulePage
      title={t('px.till_title')}
      description={t('px.till_desc')}
      query={q}
      actions={
        <div className="flex items-center gap-2">
          {/* Blind-close policy toggle — the server gates changes to manager duties ('ar'/'exec'). */}
          <Button size="sm" variant={blind ? 'default' : 'outline'} disabled={putBlind.isPending || settingsQ.isLoading}
            title={t('px.till_blind_setting_hint')}
            onClick={() => putBlind.mutate(!blind)}>
            <EyeOff className="mr-1.5 size-4" />{blind ? t('px.till_blind_on') : t('px.till_blind_off')}
          </Button>
          {openTillNow && (
            <Button size="sm" variant="secondary" onClick={() => { setCountedCash(''); setCloseResult(null); setCloseDialogOpen(true); }}>
              <Lock className="mr-1.5 size-4" />{t('px.till_close_btn')}
            </Button>
          )}
          <Button size="sm" onClick={() => setOpenDialogOpen(true)}>
            <CircleDollarSign className="mr-1.5 size-4" />{t('px.till_new_till')}
          </Button>
        </div>
      }
      stats={
        <>
          <StatCard label={t('px.till_stat_open')} value={num(openSessions)} icon={CircleDollarSign} tone={openSessions > 0 ? 'primary' : 'default'} />
          <StatCard label={t('px.till_stat_pending_variance')} value={num(varianceSessions)} icon={AlertTriangle} tone={varianceSessions > 0 ? 'warning' : 'default'} />
          <StatCard label={t('px.till_stat_total_sales')} value={baht(totalSales)} icon={Banknote} hint={t('px.till_hint_current_session')} />
        </>
      }
      statsClassName="xl:grid-cols-3"
    >
      <DataTable
        rows={d?.reports ?? []}
        rowKey={(r) => r.id}
        emptyState={{ icon: CircleDollarSign, title: t('px.till_empty_title'), description: t('px.till_empty_desc') }}
        columns={columns}
      />

      {/* Open till dialog */}
      <Dialog open={openDialogOpen} onOpenChange={setOpenDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('px.till_dialog_open_title')}</DialogTitle></DialogHeader>
          <Card className="border-0 shadow-none">
            <CardHeader className="p-0 pb-3"><CardTitle className="text-sm text-muted-foreground">{t('px.till_opening_float_title')}</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="space-y-2">
                <Label htmlFor="float">{t('px.till_float_label')}</Label>
                <Input id="float" type="number" min="0" step="0.01" placeholder="0.00"
                  value={openFloat} onChange={(e) => setOpenFloat(e.target.value)} />
              </div>
            </CardContent>
          </Card>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenDialogOpen(false)}>{t('fin.cancel')}</Button>
            <Button disabled={openTill.isPending}
              onClick={() => openTill.mutate(parseFloat(openFloat || '0'))}>
              {t('px.till_open_till_btn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close till dialog — blind-aware: expected cash is shown only when the policy is off; with blind
          close on, the cashier submits the count first and the variance is revealed after. */}
      <Dialog open={closeDialogOpen} onOpenChange={(o) => { if (!o) { setCloseDialogOpen(false); setCloseResult(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('px.till_close_title', { session_no: openTillNow?.session_no ?? '' })}</DialogTitle>
          </DialogHeader>
          {closeResult ? (
            <div className="space-y-2">
              <p className="text-sm">{t('px.till_close_result_expected', { amount: baht(closeResult.expected_cash) })}</p>
              <p className={`text-sm font-medium ${closeResult.variance !== 0 ? 'text-destructive' : 'text-green-700'}`}>
                {t('px.till_close_result_variance', { amount: baht(closeResult.variance) })}
              </p>
              {closeResult.variance_status === 'PendingApproval' && (
                <p className="text-sm text-muted-foreground">{t('px.till_close_result_pending')}</p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {blind ? (
                <p className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <EyeOff className="size-4 shrink-0" />{t('px.till_blind_notice')}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('px.till_expected_label')}: <span className="font-medium text-foreground">{xQ.data?.expected_cash != null ? baht(xQ.data.expected_cash) : '…'}</span>
                </p>
              )}
              <div className="space-y-2">
                <Label htmlFor="counted">{t('px.till_counted_label')}</Label>
                <Input id="counted" type="number" min="0" step="0.01" placeholder="0.00"
                  value={countedCash} onChange={(e) => setCountedCash(e.target.value)} />
              </div>
            </div>
          )}
          <DialogFooter>
            {closeResult ? (
              <Button onClick={() => { setCloseDialogOpen(false); setCloseResult(null); }}>{t('px.till_close_done')}</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setCloseDialogOpen(false)}>{t('fin.cancel')}</Button>
                <Button disabled={closeTill.isPending || countedCash === ''} onClick={() => closeTill.mutate()}>
                  <Lock className="mr-1.5 size-4" />{t('px.till_close_submit')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Variance approval dialog */}
      {varianceId && (
        <Dialog open onOpenChange={() => { setVarianceId(null); setRejectReason(''); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="size-5 text-destructive" />
                {t('px.till_cash_variance', { amount: baht(varianceId.variance) })}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{t('px.till_variance_dialog_desc')}</p>
            <div className="space-y-2">
              <Label htmlFor="var-reason">{t('px.till_reject_reason_label')}</Label>
              <textarea id="var-reason" className="min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                value={rejectReason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setRejectReason(e.target.value)}
                placeholder={t('px.till_reason_placeholder')} rows={2} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setVarianceId(null); setRejectReason(''); }}>{t('fin.cancel')}</Button>
              <Button variant="destructive" disabled={rejectVariance.isPending}
                onClick={() => rejectVariance.mutate({ sessionNo: varianceId.sessionNo, reason: rejectReason })}>
                {t('px.till_reject')}
              </Button>
              <Button disabled={approveVariance.isPending}
                onClick={() => approveVariance.mutate(varianceId.sessionNo)}>
                <CheckCircle2 className="mr-1.5 size-4" />{t('px.till_approve_variance_btn')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ModulePage>
  );
}
