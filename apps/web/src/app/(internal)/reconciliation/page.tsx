'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Scale, ListChecks, ShieldCheck, X, Download, Link2 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { useMe, hasPerm } from '@/lib/auth';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

export default function ReconciliationPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const me = useMe();
  // SoD R06: reconciliation preparer (recon_prep) ≠ certifier (approvals/gl_close).
  // The certify button is hidden from recon_prep-only users to prevent self-certification.
  const canCertify = hasPerm(me.data, 'approvals', 'gl_close', 'exec');
  const [selected, setSelected] = useState<number | null>(null);
  const q = useQuery<any>({ queryKey: ['recon-periods'], queryFn: () => api('/api/recon/periods') });

  return (
    <ModulePage
      title={t('fnx.recon.title')}
      description={t('fnx.recon.desc')}
    >
      <div className="space-y-6">
        <ControlAccountPack />
        <OpenPeriod onDone={() => qc.invalidateQueries({ queryKey: ['recon-periods'] })} />

        <StateView q={q}>
          {q.data && (
            <div className="space-y-5">
              <StatCard label={t('fnx.recon.stat_count')} value={num(q.data.count)} icon={Scale} tone="primary" className="max-w-xs" />
              <DataTable
                rows={q.data.periods}
                onRowClick={(r: any) => setSelected(r.id)}
                columns={[
                  { key: 'period', label: t('fnx.recon.col_period') },
                  { key: 'account_code', label: t('fnx.recon.col_account') },
                  { key: 'gl_balance', label: t('fnx.recon.col_gl'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.gl_balance)}</span> },
                  { key: 'subledger_balance', label: t('fnx.recon.col_subledger'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.subledger_balance)}</span> },
                  { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                  { key: 'prepared_by', label: t('fnx.recon.col_prepared_by'), render: (r: any) => r.prepared_by ?? '—' },
                  { key: 'certified_by', label: t('fnx.recon.col_certified_by'), render: (r: any) => r.certified_by ?? '—' },
                ]}
                emptyState={{
                  icon: Scale,
                  title: t('fnx.recon.empty_title'),
                  description: t('fnx.recon.empty_desc'),
                }}
              />
            </div>
          )}
        </StateView>

        {selected != null && <PeriodDetail id={selected} onClose={() => setSelected(null)} canCertify={canCertify} />}
      </div>
    </ModulePage>
  );
}

// ────────── REC-04 control-account reconciliation pack (sub-ledger ↔ GL, period-end overview) ──────────
function ControlAccountPack() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['recon-controls'], queryFn: () => api('/api/finance/reconciliation/controls') });
  const d = q.data;
  return (
    <Card className="gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck className="size-4 text-muted-foreground" /> {t('fnx.recon.control_pack_title')}</h3>
        {d && (
          d.all_reconciled
            ? <Badge variant="success">{t('fnx.recon.all_reconciled')}</Badge>
            : <Badge variant="destructive">{t('fnx.recon.exceptions', { n: num(d.exceptions) })}</Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{t('fnx.recon.control_pack_desc')}</p>
      <StateView q={q}>
        {d && (
          <DataTable
            rows={d.lines}
            rowKey={(r: any) => r.account}
            columns={[
              { key: 'account', label: t('fnx.recon.col_account'), render: (r: any) => <span className="font-mono text-sm">{r.account}</span> },
              { key: 'label', label: t('fnx.recon.col_label') },
              { key: 'sub_ledger', label: t('fnx.recon.col_subledger_balance'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.sub_ledger)}</span> },
              { key: 'gl_control', label: t('fnx.recon.col_gl_control'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.gl_control)}</span> },
              { key: 'variance', label: t('fnx.recon.col_variance'), align: 'right', render: (r: any) => <span className={`tabular ${Math.abs(r.variance) >= 0.01 ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>{baht(r.variance)}</span> },
              { key: 'reconciled', label: t('fin.col_status'), render: (r: any) => <Badge variant={r.reconciled ? 'success' : 'destructive'}>{r.reconciled ? t('fnx.recon.match') : t('fnx.recon.mismatch')}</Badge> },
            ]}
            emptyState={{ title: t('fnx.recon.no_data') }}
            dense
          />
        )}
      </StateView>
      {d?.as_of && <p className="text-xs text-muted-foreground">{t('fnx.recon.as_of', { date: thaiDate(d.as_of) })}</p>}
    </Card>
  );
}

// ───────────────────────── open a new recon period ─────────────────────────
function OpenPeriod({ onDone }: { onDone: () => void }) {
  const { t } = useLang();
  const [accountCode, setAccountCode] = useState('');
  const [period, setPeriod] = useState('2026-06');

  const open = useMutation({
    mutationFn: () => api<any>('/api/recon/periods', { method: 'POST', body: JSON.stringify({ account_code: accountCode, period }) }),
    onSuccess: (r) => {
      notifySuccess(t('fnx.recon.toast_opened', { period: r.period, account: r.account_code }));
      setAccountCode('');
      onDone();
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="max-w-2xl gap-4 p-5">
      <h3 className="text-base font-semibold">{t('fnx.recon.open_period_title')}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="recon-acct">{t('fnx.recon.field_account_code')}</Label>
          <Input id="recon-acct" value={accountCode} onChange={(e) => setAccountCode(e.target.value)} placeholder={t('fnx.recon.placeholder_account')} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="recon-period">{t('fnx.recon.field_period')}</Label>
          <Input id="recon-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-06" />
        </div>
      </div>
      <div>
        <Button disabled={open.isPending || !accountCode || !/^\d{4}-\d{2}$/.test(period)} onClick={() => open.mutate()}>
          {open.isPending ? t('fnx.recon.opening') : t('fnx.recon.open_period')}
        </Button>
      </div>
    </Card>
  );
}

// ───────────────────────── period detail: summary + import GL / auto-match / certify ─────────────────────────
function PeriodDetail({ id, onClose, canCertify }: { id: number; onClose: () => void; canCertify: boolean }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['recon-summary', id], queryFn: () => api(`/api/recon/periods/${id}/summary`) });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['recon-summary', id] });
    qc.invalidateQueries({ queryKey: ['recon-periods'] });
  };

  const importGl = useMutation({
    mutationFn: () => api<any>(`/api/recon/periods/${id}/import-gl`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('fnx.recon.toast_imported', { n: num(r.imported) })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const autoMatch = useMutation({
    mutationFn: () => api<any>(`/api/recon/periods/${id}/auto-match`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('fnx.recon.toast_matched', { pairs: num(r.matched_pairs), unmatched: num(r.unmatched_gl) })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const certify = useMutation({
    mutationFn: () => api<any>(`/api/recon/periods/${id}/certify`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('fnx.recon.toast_certified', { by: r.certified_by })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <ListChecks className="size-4 text-muted-foreground" /> {t('fnx.recon.detail_title', { id })}
        </h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {t('fnx.recon.period_account', { period: q.data.period, account: q.data.account_code })}{' '}
              <Badge variant={statusVariant(q.data.status)}>{q.data.status}</Badge>
              {q.data.prepared_by && <span>{t('fnx.recon.prepared_by', { by: q.data.prepared_by })}</span>}
              {q.data.certified_by && <span>{t('fnx.recon.certified_by', { by: q.data.certified_by, at: thaiDate(q.data.certified_at) })}</span>}
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('fnx.recon.col_gl')} value={baht(q.data.gl_balance)} tone="primary" />
              <StatCard label={t('fnx.recon.col_subledger')} value={baht(q.data.subledger_balance)} />
              <StatCard label={t('fnx.recon.stat_total_items')} value={num(q.data.items?.total)} />
              <StatCard label={t('fnx.recon.stat_matched')} value={num(q.data.items?.matched)} tone="success" hint={t('fnx.recon.matched_hint', { gl: num(q.data.items?.unmatched_gl), sub: num(q.data.items?.unmatched_subledger) })} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={importGl.isPending} onClick={() => importGl.mutate()}>
                <Download className="size-4" /> {importGl.isPending ? t('fnx.recon.importing') : t('fnx.recon.import_gl')}
              </Button>
              <Button size="sm" variant="outline" disabled={autoMatch.isPending} onClick={() => autoMatch.mutate()}>
                <Link2 className="size-4" /> {autoMatch.isPending ? t('fnx.recon.matching') : t('fnx.recon.automatch')}
              </Button>
              {/* SoD R06: certify is approvals/gl_close only — recon_prep cannot self-certify */}
              {canCertify && (
                <Button size="sm" disabled={certify.isPending} onClick={() => certify.mutate()}>
                  <ShieldCheck className="size-4" /> {certify.isPending ? t('fnx.recon.certifying') : t('fnx.recon.certify')}
                </Button>
              )}
            </div>
          </div>
        )}
      </StateView>
    </Card>
  );
}
