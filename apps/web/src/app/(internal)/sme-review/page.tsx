'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, TriangleAlert, Check, PenLine, Download } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useLang } from '@/lib/i18n';

// SME-02 (docs/49 item 1) — independent-review attestation of the SME-01 self-approval review + the
// cross-period self-approval REGISTRY (docs/49 item 2 — the owner/auditor evidence browse & CSV export).
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

export default function SmeReviewPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('smerev.title')} description={t('smerev.desc')} />
      <Tabs
        urlParam="tab"
        tabs={[
          { key: 'signoff', label: t('smerev.tab_signoff'), content: <SignoffTab /> },
          { key: 'registry', label: t('smerev.tab_registry'), content: <RegistryTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Sign-off (SME-02 attestation) ─────────────────────────
function SignoffTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [period, setPeriod] = useState(thisMonth());
  const [signOpen, setSignOpen] = useState(false);
  const [note, setNote] = useState('');

  const statusQ = useQuery<any>({ queryKey: ['sme-review-status', period], queryFn: () => api(`/api/sme-review/status?period=${period}`) });
  const itemsQ = useQuery<any>({ queryKey: ['sme-review-items', period], queryFn: () => api(`/api/sme-review/items?period=${period}`) });
  const st = statusQ.data;

  const signoff = useMutation({
    mutationFn: () => api('/api/sme-review/signoff', { method: 'POST', body: JSON.stringify({ period, note: note.trim() || undefined }) }),
    onSuccess: () => {
      notifySuccess(t('smerev.signed'));
      setSignOpen(false); setNote('');
      qc.invalidateQueries({ queryKey: ['sme-review-status', period] });
    },
    onError: (e: any) => notifyError(e?.message || t('smerev.sign_failed')),
  });

  const legBadge = (kind: 'accountant' | 'platform') => {
    const signed = (st?.signoffs ?? []).find((s: any) => s.kind === kind);
    return (
      <Badge variant={signed ? 'success' : 'secondary'} className="gap-1">
        {signed ? <Check className="size-3" /> : null}
        {t(`smerev.leg_${kind}`)}{signed ? ` · ${signed.username}` : ` · ${t('smerev.outstanding')}`}
      </Badge>
    );
  };

  return (
    <div>
      <div className="mb-4 flex items-end gap-3">
        <div>
          <Label htmlFor="period">{t('smerev.period')}</Label>
          <Input id="period" type="month" value={period} onChange={(e) => setPeriod(e.target.value || thisMonth())} className="w-44" />
        </div>
      </div>

      <StateView q={statusQ}>
        {st && (
          <div className="space-y-6">
            <div className={`flex items-center gap-2 rounded-lg border p-4 text-sm ${st.complete ? 'border-success/30 bg-success/10 text-success' : 'border-warning/30 bg-warning/10 text-warning-foreground'}`}>
              {st.complete ? <ShieldCheck className="size-5" /> : <TriangleAlert className="size-5" />}
              <span className="font-medium">
                {st.item_count === 0 ? t('smerev.none') : st.complete ? t('smerev.attested') : t('smerev.awaiting', { legs: (st.outstanding ?? []).map((k: string) => t(`smerev.leg_${k}`)).join(', ') })}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <StatCard label={t('smerev.items')} value={num(st.item_count)} />
              <StatCard label={t('smerev.total')} value={`฿${num(st.total_amount)}`} />
              <StatCard label={t('smerev.legs_signed')} value={`${(st.signoffs ?? []).length}/2`} />
            </div>

            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>{t('smerev.attestations')}</CardTitle>
                <Button size="sm" onClick={() => setSignOpen(true)}><PenLine className="mr-1 size-4" />{t('smerev.sign')}</Button>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {legBadge('accountant')}
                {legBadge('platform')}
              </CardContent>
            </Card>

            <StateView q={itemsQ}>
              {itemsQ.data && (
                <DataTable
                  rows={itemsQ.data.items ?? []}
                  emptyText={t('smerev.no_items')}
                  columns={ITEM_COLUMNS(t)}
                />
              )}
            </StateView>
          </div>
        )}
      </StateView>

      <Dialog open={signOpen} onOpenChange={setSignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('smerev.sign_title', { period })}</DialogTitle>
            <DialogDescription>{t('smerev.sign_desc')}</DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="note">{t('smerev.note')}</Label>
            <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={t('smerev.note_ph')} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSignOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => signoff.mutate()} disabled={signoff.isPending}>{t('smerev.confirm_sign')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ───────────────────────── Registry (cross-period browse + CSV export) ─────────────────────────
function RegistryTab() {
  const { t } = useLang();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [event, setEvent] = useState('');
  const [q, setQ] = useState('');

  const qs = () => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (event) p.set('event', event);
    if (q.trim()) p.set('q', q.trim());
    return p.toString();
  };
  const reg = useQuery<any>({ queryKey: ['sme-registry', from, to, event, q], queryFn: () => api(`/api/sme-review/registry?${qs()}`) });
  const r = reg.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div><Label htmlFor="from">{t('smerev.from')}</Label><Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" /></div>
        <div><Label htmlFor="to">{t('smerev.to')}</Label><Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" /></div>
        <div><Label htmlFor="event">{t('smerev.event')}</Label><Input id="event" value={event} onChange={(e) => setEvent(e.target.value)} placeholder={t('smerev.event_ph')} className="w-48" /></div>
        <div className="flex-1 min-w-48"><Label htmlFor="q">{t('smerev.search')}</Label><Input id="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('smerev.search_ph')} /></div>
        <Button variant="outline" onClick={() => apiDownload(`/api/sme-review/registry/export?${qs()}`, 'sme-self-approvals.csv')}>
          <Download className="mr-1 size-4" />{t('smerev.export')}
        </Button>
      </div>

      <StateView q={reg}>
        {r && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <StatCard label={t('smerev.items')} value={num(r.count)} />
              <StatCard label={t('smerev.total')} value={`฿${num(r.total_amount)}`} />
              <StatCard label={t('smerev.periods')} value={num((r.by_period ?? []).length)} />
            </div>

            {(r.by_period ?? []).length > 0 && (
              <Card>
                <CardHeader><CardTitle>{t('smerev.by_period')}</CardTitle></CardHeader>
                <CardContent>
                  <DataTable
                    rows={r.by_period}
                    columns={[
                      { key: 'period', label: t('smerev.period') },
                      { key: 'count', label: t('smerev.items'), render: (x: any) => num(x.count) },
                      { key: 'total_amount', label: t('smerev.total'), render: (x: any) => `฿${num(x.total_amount)}` },
                      { key: 'complete', label: t('smerev.attested_col'), render: (x: any) => <Badge variant={x.complete ? 'success' : 'warning'}>{x.complete ? t('smerev.done') : t('smerev.pending')}</Badge> },
                    ]}
                  />
                </CardContent>
              </Card>
            )}

            <DataTable rows={r.items ?? []} emptyText={t('smerev.no_items')} columns={ITEM_COLUMNS(t, true)} />
          </div>
        )}
      </StateView>
    </div>
  );
}

// Shared self-approval columns (the registry adds a period column).
function ITEM_COLUMNS(t: (k: string, p?: any) => string, withPeriod = false) {
  const cols: any[] = [{ key: 'at', label: t('smerev.col_at'), render: (r: any) => new Date(r.at).toLocaleString() }];
  if (withPeriod) cols.push({ key: 'period', label: t('smerev.period') });
  cols.push(
    { key: 'event', label: t('smerev.col_event') },
    { key: 'ref', label: t('smerev.col_ref') },
    { key: 'username', label: t('smerev.col_user') },
    { key: 'amount', label: t('smerev.col_amount'), render: (r: any) => (r.amount != null ? `฿${num(r.amount)}` : '—') },
    { key: 'reason', label: t('smerev.col_reason') },
  );
  return cols;
}
