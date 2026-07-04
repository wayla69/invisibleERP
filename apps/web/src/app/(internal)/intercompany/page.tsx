'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, HandCoins, Scale, SearchX } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { useLang } from '@/lib/i18n';

interface IcTxn {
  ic_no: string;
  from_tenant_id: number;
  to_tenant_id: number;
  amount: number;
  settled_amount: number;
  outstanding: number;
  currency: string;
  category: string;
  status: string;
  txn_date: string;
  description: string | null;
}
interface IcListResp { ic_transactions: IcTxn[]; count: number }
interface ReconResp {
  total_due_from: number;
  total_due_to: number;
  eliminates: boolean;
  difference: number;
  by_tenant: { tenant_id: number; due_from: number; due_to: number }[];
  by_pair: { from_tenant_id: number; to_tenant_id: number; gross: number; settled: number; outstanding: number; count: number }[];
}

export default function IntercompanyPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('fnx.ico.title')}
        description={t('fnx.ico.subtitle')}
      />
      <Tabs
        tabs={[
          { key: 'txns', label: t('fnx.ico.tab_txns'), content: <TransactionsTab /> },
          { key: 'recon', label: t('fnx.ico.tab_recon'), content: <ReconciliationTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── รายการระหว่างบริษัท ─────────────────────────
function TransactionsTab() {
  const { t } = useLang();
  const [status, setStatus] = useState('');
  const q = useQuery<IcListResp>({
    queryKey: ['ic-list', status],
    queryFn: () => api(`/api/intercompany${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  });

  const statuses = ['', 'Open', 'Partial', 'Settled'];
  const d = q.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {statuses.map((s) => (
          <Button key={s || 'all'} size="sm" variant={status === s ? 'default' : 'outline'} onClick={() => setStatus(s)}>
            {s || t('fnx.ico.filter_all')}
          </Button>
        ))}
      </div>

      <StateView q={q}>
        {d && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('fnx.ico.stat_count')} value={d.count} icon={ArrowLeftRight} tone="primary" />
              <StatCard label={t('fnx.ico.stat_total')} value={baht(d.ic_transactions.reduce((a, x) => a + x.amount, 0))} icon={HandCoins} />
              <StatCard
                label={t('fnx.ico.stat_outstanding')}
                value={baht(d.ic_transactions.reduce((a, x) => a + x.outstanding, 0))}
                tone="warning"
              />
            </div>
            <DataTable
              rows={d.ic_transactions}
              rowKey={(r) => r.ic_no}
              columns={[
                { key: 'ic_no', label: t('dash.col_no'), render: (r) => <span className="font-medium">{r.ic_no}</span> },
                { key: 'txn_date', label: t('dash.col_date'), render: (r) => thaiDate(r.txn_date) },
                { key: 'from_tenant_id', label: t('fnx.ico.col_from'), align: 'right', render: (r) => <span className="tabular">#{r.from_tenant_id}</span> },
                { key: 'to_tenant_id', label: t('fnx.ico.col_to'), align: 'right', render: (r) => <span className="tabular">#{r.to_tenant_id}</span> },
                { key: 'category', label: t('fnx.ico.col_category') },
                { key: 'amount', label: t('fnx.ico.col_value'), align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'settled_amount', label: t('fnx.ico.col_settled'), align: 'right', render: (r) => <span className="tabular">{baht(r.settled_amount)}</span> },
                { key: 'outstanding', label: t('fin.col_outstanding'), align: 'right', render: (r) => <span className="tabular">{baht(r.outstanding)}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                { key: '_act', label: '', sortable: false, render: (r) => <SettleButton txn={r} /> },
              ]}
              emptyState={
                status
                  ? {
                      icon: SearchX,
                      title: t('fnx.ico.empty_filtered_title'),
                      description: t('fnx.ico.empty_filtered_desc'),
                      action: (
                        <Button variant="outline" size="sm" onClick={() => setStatus('')}>
                          {t('inv.clear_filter')}
                        </Button>
                      ),
                    }
                  : {
                      icon: ArrowLeftRight,
                      title: t('fnx.ico.empty_title'),
                      description: t('fnx.ico.empty_desc'),
                    }
              }
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── ชำระรายการ (settle) ─────────────────────────
function SettleButton({ txn }: { txn: IcTxn }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(txn.outstanding));

  const settle = useMutation({
    mutationFn: () =>
      api<{ ic_no: string; settled_amount: number; status: string }>(`/api/intercompany/${encodeURIComponent(txn.ic_no)}/settle`, {
        method: 'POST',
        body: JSON.stringify({ amount: Number(amount) }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('fnx.ico.settle_success', { amount: baht(r.settled_amount), status: r.status }));
      qc.invalidateQueries({ queryKey: ['ic-list'] });
      qc.invalidateQueries({ queryKey: ['ic-recon'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  if (txn.status === 'Settled') return <span className="text-xs text-muted-foreground">{t('fnx.ico.fully_settled')}</span>;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <HandCoins className="size-4" /> {t('fnx.ico.settle')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('fnx.ico.settle_title', { ic_no: txn.ic_no })}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="settle-amt">{t('fnx.ico.settle_amount_label', { outstanding: baht(txn.outstanding) })}</Label>
          <Input
            id="settle-amt"
            type="number"
            min="0"
            max={txn.outstanding}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={settle.isPending || !(Number(amount) > 0)}
            onClick={() => settle.mutate()}
          >
            {settle.isPending ? t('fnx.ico.settling') : t('fnx.ico.settle_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── ตัดรายการระหว่างกัน ─────────────────────────
function ReconciliationTab() {
  const { t } = useLang();
  const q = useQuery<ReconResp>({ queryKey: ['ic-recon'], queryFn: () => api('/api/intercompany/reconciliation') });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('fnx.ico.stat_due_from')} value={baht(q.data.total_due_from)} icon={Scale} tone="primary" />
            <StatCard label={t('fnx.ico.stat_due_to')} value={baht(q.data.total_due_to)} icon={Scale} tone="info" />
            <StatCard label={t('fnx.ico.stat_difference')} value={baht(q.data.difference)} tone={Math.abs(q.data.difference) < 0.01 ? 'success' : 'danger'} />
            <StatCard
              label={t('fnx.ico.stat_eliminable')}
              value={<Badge variant={q.data.eliminates ? 'success' : 'destructive'}>{q.data.eliminates ? t('fnx.ico.balanced') : t('fnx.ico.unbalanced')}</Badge>}
            />
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('fnx.ico.by_company')}</h3>
            <DataTable
              rows={q.data.by_tenant}
              rowKey={(r) => r.tenant_id}
              columns={[
                { key: 'tenant_id', label: t('fnx.ico.col_company'), render: (r) => <span className="font-medium">#{r.tenant_id}</span> },
                { key: 'due_from', label: 'Due-From', align: 'right', render: (r) => <span className="tabular">{baht(r.due_from)}</span> },
                { key: 'due_to', label: 'Due-To', align: 'right', render: (r) => <span className="tabular">{baht(r.due_to)}</span> },
              ]}
              emptyState={{ icon: Scale, title: t('fnx.ico.empty_balances') }}
            />
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('fnx.ico.by_pair')}</h3>
            <DataTable
              rows={q.data.by_pair}
              rowKey={(r) => `${r.from_tenant_id}-${r.to_tenant_id}`}
              columns={[
                { key: 'pair', label: t('fnx.ico.col_pair'), render: (r) => <span className="font-medium">#{r.from_tenant_id} → #{r.to_tenant_id}</span> },
                { key: 'count', label: t('fnx.ico.col_qty'), align: 'right', render: (r) => <span className="tabular">{r.count}</span> },
                { key: 'gross', label: t('fnx.ico.col_gross'), align: 'right', render: (r) => <span className="tabular">{baht(r.gross)}</span> },
                { key: 'settled', label: t('fnx.ico.col_settled'), align: 'right', render: (r) => <span className="tabular">{baht(r.settled)}</span> },
                { key: 'outstanding', label: t('fin.col_outstanding'), align: 'right', render: (r) => <span className="tabular">{baht(r.outstanding)}</span> },
              ]}
              emptyState={{ icon: Scale, title: t('fnx.ico.empty_outstanding') }}
            />
          </div>
        </div>
      )}
    </StateView>
  );
}
