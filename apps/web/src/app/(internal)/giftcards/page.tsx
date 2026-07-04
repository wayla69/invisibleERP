'use client';

import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { CreditCard, Wallet, BadgeCheck, Receipt, X } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

// Gift-card / store-credit register: every card + the OUTSTANDING liability (Σ Active balances = the
// unredeemed 2200 Customer-Deposits exposure) + per-card txn drill-down. The list/audit view the
// gift-card backend (issue/redeem/balance) never had — finance can size the liability, ops can look a card up.

const selectCls =
  'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

const statusTone = (s: string): 'success' | 'secondary' | 'destructive' =>
  s === 'Active' ? 'success' : s === 'Void' ? 'destructive' : 'secondary';
const STATUS_KEYS = ['Active', 'Redeemed', 'Void'];

interface GiftCard {
  card_no: string; initial_amount: number; balance: number; status: string; currency: string;
  note: string | null; issued_by: string | null; created_at: string | null;
}
interface CardsResp { cards: GiftCard[]; count: number; total: number; active: number; outstanding: number }

export default function GiftCardsPage() {
  const { t } = useLang();
  const statusLabel = (s: string) => (STATUS_KEYS.includes(s) ? t(`px.gift_status_${s}`) : s);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [pick, setPick] = useState<string | null>(null);

  const q = useQuery<CardsResp>({
    queryKey: ['gift-cards', status, search],
    queryFn: () => api(`/api/pos/gift-cards?${new URLSearchParams({ ...(status && { status }), ...(search && { search }) })}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;

  return (
    <div>
      <PageHeader
        title={t('px.gift_title')}
        description={t('px.gift_desc')}
      />
      <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('px.gift_filter_status')}>
            <option value="">{t('px.gift_all_status')}</option>
            <option value="Active">{t('px.gift_opt_active')}</option>
            <option value="Redeemed">{t('px.gift_opt_redeemed')}</option>
            <option value="Void">{t('px.gift_opt_void')}</option>
          </select>
          <Input className="w-full sm:w-64" placeholder={t('px.gift_search_ph')} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t('px.gift_search_aria')} />
          {q.isFetching && !q.isLoading && <span className="text-xs text-muted-foreground">{t('px.gift_updating')}</span>}
        </div>
        <StateView q={q}>
          {d && (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <StatCard label={t('px.gift_stat_total')} value={num(d.total)} icon={CreditCard} tone="primary" hint={t('px.gift_stat_total_hint', { count: num(d.count) })} />
                <StatCard label={t('px.gift_stat_active')} value={num(d.active)} icon={BadgeCheck} tone="success" />
                <StatCard label={t('px.gift_stat_outstanding')} value={`฿${num(d.outstanding)}`} icon={Wallet} tone={d.outstanding > 0 ? 'warning' : 'success'} hint={t('px.gift_stat_outstanding_hint')} />
              </div>
              <DataTable
                rows={d.cards}
                rowKey={(r) => r.card_no}
                emptyState={{ icon: CreditCard, title: t('px.gift_empty_title'), description: t('px.gift_empty_desc') }}
                columns={[
                  { key: 'card_no', label: t('px.gift_col_cardno'), render: (r) => <span className="font-mono text-sm">{r.card_no}</span> },
                  { key: 'initial_amount', label: t('px.gift_col_initial'), align: 'right', render: (r) => <span className="tabular text-muted-foreground">฿{num(r.initial_amount)}</span> },
                  { key: 'balance', label: t('px.gift_col_balance'), align: 'right', render: (r) => <span className={cn('tabular font-medium', r.balance > 0 && 'text-success')}>฿{num(r.balance)}</span> },
                  { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusTone(r.status)}>{statusLabel(r.status)}</Badge> },
                  { key: 'issued_by', label: t('px.gift_col_issued_by'), render: (r) => r.issued_by ?? '—' },
                  { key: 'created_at', label: t('px.gift_col_issued_date'), render: (r) => (r.created_at ? thaiDate(r.created_at) : '—') },
                  { key: 'act', label: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" onClick={() => setPick(r.card_no)}><Receipt className="size-4" />{t('px.gift_history_btn')}</Button> },
                ]}
              />
            </>
          )}
        </StateView>
        {pick && <TxnHistory cardNo={pick} onClose={() => setPick(null)} />}
      </div>
    </div>
  );
}

interface Txn { txn_no: string; type: string; amount: number; balance_after: number; ref_doc: string | null; created_at: string | null }
interface TxnResp { card_no: string; initial_amount: number; balance: number; status: string; txns: Txn[] }

function TxnHistory({ cardNo, onClose }: { cardNo: string; onClose: () => void }) {
  const { t } = useLang();
  const statusLabel = (s: string) => (STATUS_KEYS.includes(s) ? t(`px.gift_status_${s}`) : s);
  const q = useQuery<TxnResp>({ queryKey: ['gift-card-txns', cardNo], queryFn: () => api(`/api/pos/gift-cards/${encodeURIComponent(cardNo)}/txns`) });
  const d = q.data;
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="font-semibold">{t('px.gift_txn_title')} <span className="font-mono">{cardNo}</span></h3>
          {d && <p className="text-sm text-muted-foreground">{t('px.gift_txn_initial')} ฿{num(d.initial_amount)} · {t('px.gift_txn_balance')} ฿{num(d.balance)} · {statusLabel(d.status)}</p>}
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label={t('px.gift_close')}><X className="size-4" /></Button>
      </div>
      <StateView q={q}>
        {d && (
          <DataTable
            rows={d.txns}
            rowKey={(r) => r.txn_no}
            emptyState={{ icon: Receipt, title: t('px.gift_txn_empty_title'), description: t('px.gift_txn_empty_desc') }}
            columns={[
              { key: 'created_at', label: t('dash.col_date'), render: (r) => (r.created_at ? thaiDate(r.created_at) : '—') },
              { key: 'type', label: t('px.gift_col_type'), render: (r) => <Badge variant={r.type === 'Redeem' ? 'destructive' : 'success'}>{r.type}</Badge> },
              { key: 'amount', label: t('inv.col_qty'), align: 'right', render: (r) => <span className={cn('tabular font-medium', r.amount < 0 ? 'text-destructive' : 'text-success')}>{r.amount < 0 ? '−' : '+'}฿{num(Math.abs(r.amount))}</span> },
              { key: 'balance_after', label: t('px.gift_col_balance_after'), align: 'right', render: (r) => <span className="tabular">฿{num(r.balance_after)}</span> },
              { key: 'ref_doc', label: t('px.gift_col_refdoc'), render: (r) => <span className="font-mono text-xs text-muted-foreground">{r.ref_doc ?? '—'}</span> },
            ]}
          />
        )}
      </StateView>
    </Card>
  );
}
