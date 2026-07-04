'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Banknote, Landmark, Vault, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';

// W3 — cash banking. Batch till safe-drops into a bank deposit (Dr bank / Cr 1000), reconcile to statement.
interface Dep { id: number; deposit_no: string; bank_account_id: number; amount: number; status: string; deposit_date: string | null; journal_no: string | null; created_at: string }
interface Resp { deposits: Dep[]; count: number; unreconciled: number; cash_in_safe: number; undeposited_drops: number }
interface Drops { drops: { movement_no: string; amount: number; reason: string | null; created_at: string }[]; count: number; total: number }
interface Bank { id: number; bank_name: string; account_no: string }

export default function CashBankingPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<Resp>({ queryKey: ['bank-deposits'], queryFn: () => api('/api/bank/deposits'), refetchInterval: 30_000 });
  const drops = useQuery<Drops>({ queryKey: ['undeposited-drops'], queryFn: () => api('/api/bank/deposits/undeposited-drops') });
  const banks = useQuery<{ accounts: Bank[] }>({ queryKey: ['bank-accounts'], queryFn: () => api('/api/bank/accounts') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['bank-deposits'] }); qc.invalidateQueries({ queryKey: ['undeposited-drops'] }); };
  const [bankId, setBankId] = useState('');

  const deposit = useMutation({
    mutationFn: () => api('/api/bank/deposits', { method: 'POST', body: JSON.stringify({ bank_account_id: Number(bankId), deposit_date: new Date().toISOString().slice(0, 10) }) }),
    onSuccess: (r: any) => { notifySuccess(t('fnx.cashbank.toast_deposited', { no: r.deposit_no, amount: baht(r.amount), n: r.drops_banked })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reconcile = useMutation({
    mutationFn: (id: number) => api(`/api/bank/deposits/${id}/reconcile`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('fnx.cashbank.toast_reconciled')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const d = q.data;
  return (
    <ModulePage
      title={t('fnx.cashbank.title')}
      description={t('fnx.cashbank.desc')}
      query={q}
      stats={d && (
        <>
          <StatCard label={t('fnx.cashbank.stat_cash_in_safe')} value={baht(d.cash_in_safe)} icon={Vault} tone={d.cash_in_safe > 0 ? 'warning' : 'success'} hint={t('fnx.cashbank.n_items', { n: num(d.undeposited_drops) })} />
          <StatCard label={t('fnx.cashbank.stat_total_deposits')} value={num(d.count)} icon={Landmark} tone="primary" />
          <StatCard label={t('fnx.cashbank.stat_unreconciled')} value={num(d.unreconciled)} icon={Banknote} tone={d.unreconciled > 0 ? 'warning' : 'success'} />
        </>
      )}
      statsClassName="xl:grid-cols-3"
    >
      {/* deposit form */}
      <div className="mb-4 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label={t('fnx.cashbank.field_bank')} className="min-w-[220px]">
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={bankId} onChange={(e) => setBankId(e.target.value)}>
              <option value="">{t('fnx.cashbank.select_account')}</option>
              {(banks.data?.accounts ?? []).map((b) => <option key={b.id} value={b.id}>{b.bank_name} {b.account_no}</option>)}
            </select>
          </FormField>
          <div className="text-sm text-muted-foreground">{t('fnx.cashbank.ready_to_deposit')} <strong className="text-foreground">{baht(drops.data?.total ?? 0)}</strong> ({t('fnx.cashbank.n_items', { n: num(drops.data?.count ?? 0) })})</div>
          <Button disabled={deposit.isPending || !bankId || (drops.data?.count ?? 0) === 0} onClick={() => deposit.mutate()}>{t('fnx.cashbank.deposit_all')}</Button>
        </div>
      </div>

      {d && (
        <DataTable
          rows={d.deposits}
          rowKey={(r) => r.deposit_no}
          emptyState={{ icon: Landmark, title: t('fnx.cashbank.empty_title'), description: t('fnx.cashbank.empty_desc') }}
          columns={[
            { key: 'deposit_no', label: t('dash.col_no'), render: (r) => <span className="font-mono text-sm">{r.deposit_no}</span> },
            { key: 'deposit_date', label: t('fnx.cashbank.col_deposit_date'), render: (r) => r.deposit_date ?? thaiDate(r.created_at) },
            { key: 'amount', label: t('fnx.cashbank.col_amount'), align: 'right', render: (r) => baht(r.amount) },
            { key: 'journal_no', label: t('fnx.cashbank.col_journal'), render: (r) => r.journal_no ? <span className="font-mono text-xs">{r.journal_no}</span> : '—' },
            { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={r.status === 'Reconciled' ? 'success' : 'warning'}>{r.status === 'Reconciled' ? t('fnx.cashbank.status_reconciled') : t('fnx.cashbank.status_pending')}</Badge> },
            { key: 'actions', label: '', align: 'right', render: (r) => r.status !== 'Reconciled' ? (
              <Button size="sm" variant="outline" disabled={reconcile.isPending} onClick={() => reconcile.mutate(r.id)}><CheckCircle2 className="size-4" /> {t('fnx.cashbank.reconcile')}</Button>
            ) : null },
          ]}
        />
      )}
    </ModulePage>
  );
}
