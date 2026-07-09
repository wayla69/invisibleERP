'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Landmark, Scale, Wallet, RefreshCw, X, CheckCircle2, FileText, Clock, Check, Ban } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function BankPage() {
  const { t } = useLang();
  const [selected, setSelected] = useState<number | null>(null);
  const q = useQuery<any>({ queryKey: ['bank-accounts'], queryFn: () => api('/api/bank/accounts') });

  return (
    <ModulePage
      title={t('fnx.bank.title')}
      description={t('fnx.bank.desc')}
      query={q}
      statsClassName="xl:grid-cols-3"
      stats={
        q.data && (
          <>
            <StatCard label={t('fnx.bank.stat_count')} value={num(q.data.count)} icon={Landmark} tone="primary" />
            <StatCard
              label={t('fnx.bank.stat_opening_total')}
              value={baht((q.data.accounts ?? []).reduce((a: number, b: any) => a + Number(b.opening_balance ?? 0), 0))}
              icon={Wallet}
            />
          </>
        )
      }
    >
      {q.data && (
        <>
          {/* G9 (audit): a new bank account is created PendingApproval and must be activated by a
              DIFFERENT user before it can bank cash. */}
          <PendingBankAccounts onChanged={() => q.refetch()} />
          <DataTable
            rows={q.data.accounts}
            onRowClick={(r: any) => setSelected(r.id)}
            columns={[
              { key: 'bank_name', label: t('fnx.bank.col_bank') },
              { key: 'account_no', label: t('fnx.bank.col_account_no') },
              { key: 'gl_account_code', label: t('fnx.bank.col_gl_account') },
              { key: 'currency', label: t('fnx.bank.col_currency') },
              { key: 'opening_balance', label: t('fnx.bank.col_opening'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.opening_balance)}</span> },
            ]}
            emptyState={{
              icon: Landmark,
              title: t('fnx.bank.empty_title'),
              description: t('fnx.bank.empty_desc'),
            }}
          />
          {selected != null && <Reconciliation bankAccountId={selected} onClose={() => setSelected(null)} />}
        </>
      )}
    </ModulePage>
  );
}

// ───────────────────────── per-account reconciliation + auto-match ─────────────────────────
function Reconciliation({ bankAccountId, onClose }: { bankAccountId: number; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['bank-recon', bankAccountId], queryFn: () => api(`/api/bank/accounts/${bankAccountId}/reconciliation`) });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['bank-recon', bankAccountId] });
    qc.invalidateQueries({ queryKey: ['bank-pending-adj'] });
  };
  const autoMatch = useMutation({
    mutationFn: () => api<any>(`/api/bank/accounts/${bankAccountId}/auto-match`, { method: 'POST' }),
    onSuccess: (r) => {
      notifySuccess(t('fnx.bank.toast_automatch', { n: num(r.matched) }));
      refresh();
    },
    onError: (e: any) => notifyError(e.message),
  });
  // File import: upload the bank's own CSV/XLSX export (Thai/English headers, BE dates) → same import
  // pipeline as the JSON endpoint, auto-matching immediately.
  const importFile = useMutation({
    mutationFn: async (f: File) => {
      const isXlsx = /\.xlsx$/i.test(f.name);
      const body = isXlsx
        ? { xlsx: btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer()))), auto_match: true }
        : { csv: await f.text(), auto_match: true };
      return api<any>(`/api/bank/accounts/${bankAccountId}/statements/import-file`, { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: (r) => {
      notifySuccess(t('fnx.bank.toast_file_imported', { n: num(r.line_count), m: num(r.auto_match?.matched ?? 0) }));
      refresh();
    },
    onError: (e: any) => notifyError(e.message),
  });
  // BANK-02: request a fee/interest adjustment on an unmatched statement line (posts a Draft JE — needs approval).
  const requestAdj = useMutation({
    mutationFn: ({ lineId, kind }: { lineId: number; kind: 'fee' | 'interest' }) => api<any>(`/api/bank/lines/${lineId}/adjustment`, { method: 'POST', body: JSON.stringify({ kind }) }),
    onSuccess: () => { notifySuccess(t('fnx.bank.toast_adj_requested')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Scale className="size-4 text-muted-foreground" /> {t('fnx.bank.recon_heading', { id: bankAccountId })}
        </h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('fnx.bank.stat_gl_balance')} value={baht(q.data.gl_balance)} tone="primary" />
              <StatCard label={t('fnx.bank.stat_statement_balance')} value={baht(q.data.statement_balance)} />
              <StatCard label={t('fnx.bank.stat_matched')} value={baht(q.data.matched_total)} tone="success" />
              <StatCard
                label={t('fnx.bank.stat_difference')}
                value={baht(q.data.difference)}
                tone={Math.abs(Number(q.data.difference)) < 0.01 ? 'success' : 'danger'}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={autoMatch.isPending} onClick={() => autoMatch.mutate()}>
                <RefreshCw className="size-4" /> {autoMatch.isPending ? t('fnx.bank.matching') : t('fnx.bank.automatch')}
              </Button>
              <Button size="sm" variant="outline" asChild disabled={importFile.isPending}>
                <label className="cursor-pointer">
                  <FileText className="size-4" /> {importFile.isPending ? t('fnx.bank.importing') : t('fnx.bank.import_file')}
                  <input type="file" accept=".csv,.xlsx" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile.mutate(f); e.target.value = ''; }} />
                </label>
              </Button>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <h4 className="mb-3 text-sm font-semibold text-muted-foreground">{t('fnx.bank.unmatched_statement_title')}</h4>
                <DataTable
                  rows={q.data.unmatched_statement}
                  columns={[
                    { key: 'date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.date) },
                    { key: 'description', label: t('fnx.bank.col_description'), render: (r: any) => r.description ?? '—' },
                    { key: 'amount', label: t('fnx.bank.col_amount'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                    { key: 'adj', label: t('fnx.bank.col_adjust'), align: 'right', render: (r: any) => (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" disabled={requestAdj.isPending} onClick={() => requestAdj.mutate({ lineId: r.statement_line_id, kind: 'fee' })}>{t('fnx.bank.fee')}</Button>
                        <Button size="sm" variant="outline" disabled={requestAdj.isPending} onClick={() => requestAdj.mutate({ lineId: r.statement_line_id, kind: 'interest' })}>{t('fnx.bank.interest')}</Button>
                      </div>
                    ) },
                  ]}
                  emptyState={{
                    icon: CheckCircle2,
                    title: t('fnx.bank.empty_stmt_title'),
                    description: t('fnx.bank.empty_stmt_desc'),
                  }}
                  dense
                />
              </div>
              <div>
                <h4 className="mb-3 text-sm font-semibold text-muted-foreground">{t('fnx.bank.unmatched_book_title')}</h4>
                <DataTable
                  rows={q.data.unmatched_book}
                  columns={[
                    { key: 'entry_no', label: t('fnx.bank.col_account_no') },
                    { key: 'entry_date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.entry_date) },
                    { key: 'amount', label: t('fnx.bank.col_amount'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                  ]}
                  emptyState={{
                    icon: FileText,
                    title: t('fnx.bank.empty_book_title'),
                    description: t('fnx.bank.empty_book_desc'),
                  }}
                  dense
                />
              </div>
            </div>

            <PendingAdjustments onChanged={refresh} />
          </div>
        )}
      </StateView>
    </Card>
  );
}

// ───────── BANK-02 pending bank adjustments (Draft JE awaiting an independent approver) ─────────
// G9 (audit): bank-account creation maker-checker — a new account is PendingApproval + inactive until a
// DISTINCT approver activates it (self-approval → 403 SOD_VIOLATION); a pending account cannot bank cash.
function PendingBankAccounts({ onChanged }: { onChanged: () => void }) {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['bank-accounts-pending'], queryFn: () => api('/api/bank/accounts/pending') });
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'approve' | 'reject' }) => api<any>(`/api/bank/accounts/${id}/${action}`, { method: 'POST', body: action === 'reject' ? JSON.stringify({}) : undefined }),
    onSuccess: (_r, v) => { notifySuccess(v.action === 'approve' ? t('fnx.bank.toast_acct_approved') : t('fnx.bank.toast_acct_rejected')); q.refetch(); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });
  const rows = q.data?.pending ?? [];
  if (!rows.length) return null;
  return (
    <Card className="border-amber-300 p-4 dark:border-amber-700">
      <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold"><Clock className="size-4" /> {t('fnx.bank.pending_acct_title')}</h4>
      <p className="mb-3 text-sm text-muted-foreground">{t('fnx.bank.pending_acct_desc')}</p>
      <DataTable
        rows={rows}
        rowKey={(r: any) => r.id}
        columns={[
          { key: 'bank_name', label: t('fnx.bank.col_bank') },
          { key: 'account_no', label: t('fnx.bank.col_account_no') },
          { key: 'gl_account_code', label: t('fnx.bank.col_gl_account') },
          { key: 'opening_balance', label: t('fnx.bank.col_opening'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.opening_balance)}</span> },
          { key: 'requested_by', label: t('fnx.bank.col_requested_by'), render: (r: any) => r.requested_by ?? '—' },
          { key: 'act', label: '', align: 'right', render: (r: any) => (
            <div className="flex justify-end gap-1">
              <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, action: 'approve' })}><Check className="size-4" /> {t('fin.approve')}</Button>
              <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, action: 'reject' })}><Ban className="size-4" /> {t('fnx.bank.reject')}</Button>
            </div>
          ) },
        ]}
        emptyState={{ title: t('fnx.bank.empty_pending') }}
        dense
      />
    </Card>
  );
}

function PendingAdjustments({ onChanged }: { onChanged: () => void }) {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['bank-pending-adj'], queryFn: () => api('/api/bank/adjustments/pending') });
  const decide = useMutation({
    mutationFn: ({ lineId, action }: { lineId: number; action: 'approve' | 'reject' }) => api<any>(`/api/bank/lines/${lineId}/adjustment/${action}`, { method: 'POST', body: action === 'reject' ? JSON.stringify({}) : undefined }),
    onSuccess: (_r, v) => { notifySuccess(v.action === 'approve' ? t('fnx.bank.toast_adj_approved') : t('fnx.bank.toast_adj_rejected')); q.refetch(); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });
  const rows = q.data?.pending ?? [];
  if (!rows.length) return null;
  return (
    <div>
      <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground"><Clock className="size-4" /> {t('fnx.bank.pending_adj_title')}</h4>
      <DataTable
        rows={rows}
        rowKey={(r: any) => r.statement_line_id}
        columns={[
          { key: 'date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.date) },
          { key: 'description', label: t('fnx.bank.col_description'), render: (r: any) => r.description ?? '—' },
          { key: 'journal_no', label: t('fnx.bank.col_journal_draft'), render: (r: any) => <span className="font-mono text-sm">{r.journal_no}</span> },
          { key: 'amount', label: t('fnx.bank.col_amount'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
          { key: 'act', label: '', align: 'right', render: (r: any) => (
            <div className="flex justify-end gap-1">
              <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ lineId: r.statement_line_id, action: 'approve' })}><Check className="size-4" /> {t('fin.approve')}</Button>
              <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ lineId: r.statement_line_id, action: 'reject' })}><Ban className="size-4" /> {t('fnx.bank.reject')}</Button>
            </div>
          ) },
        ]}
        emptyState={{ title: t('fnx.bank.empty_pending') }}
        dense
      />
    </div>
  );
}
