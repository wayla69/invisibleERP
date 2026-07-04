'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck2, Layers, PackageSearch, SearchX } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

const cols = (t: (k: string) => string) => [
  { key: 'lot_no', label: t('iv.lot_col_lot') },
  { key: 'item_id', label: t('iv.lot_item') },
  { key: 'location_id', label: t('iv.lot_location') },
  { key: 'balance', label: t('iv.lot_balance'), align: 'right' as const, render: (r: any) => num(r.balance) },
  { key: 'expiry_date', label: t('iv.lot_expiry'), render: (r: any) => thaiDate(r.expiry_date) },
  { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
];

export default function LotsPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('iv.lot_title')} description={t('iv.lot_desc')} />
      <Tabs tabs={[{ key: 'ledger', label: t('iv.lot_tab_ledger'), content: <Ledger /> }, { key: 'expiry', label: t('iv.lot_tab_expiry'), content: <Expiry /> }, { key: 'fefo', label: 'FEFO', content: <Fefo /> }]} />
    </div>
  );
}

function Ledger() {
  const { t } = useLang();
  const [item, setItem] = useState('');
  const q = useQuery<any>({ queryKey: ['lots', item], queryFn: () => api(`/api/lots${item ? `?item_id=${encodeURIComponent(item)}` : ''}`) });
  return (
    <div className="space-y-3">
      <Input className="max-w-xs" placeholder={t('iv.lot_filter_ph')} value={item} onChange={(e) => setItem(e.target.value)} />
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.lots}
            columns={cols(t)}
            emptyState={
              item
                ? {
                    icon: SearchX,
                    title: t('iv.lot_nomatch_title'),
                    description: t('iv.lot_nomatch_desc'),
                    action: (
                      <Button variant="outline" size="sm" onClick={() => setItem('')}>
                        {t('inv.clear_filter')}
                      </Button>
                    ),
                  }
                : { icon: Layers, title: t('iv.lot_empty_title'), description: t('iv.lot_empty_desc') }
            }
          />
        )}
      </StateView>
    </div>
  );
}

function Expiry() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['lots-expiry'], queryFn: () => api('/api/lots/expiry') });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('iv.lot_stat_expired')} value={num(q.data.summary.expired)} tone="warning" />
            <StatCard label={t('iv.lot_stat_d0_7')} value={num(q.data.summary.d0_7)} tone="warning" />
            <StatCard label={t('iv.lot_stat_d8_30')} value={num(q.data.summary.d8_30)} />
            <StatCard label={t('iv.lot_stat_d31')} value={num(q.data.summary.d31_plus)} tone="success" />
          </div>
          <DataTable
            rows={[...q.data.buckets.expired, ...q.data.buckets.d0_7, ...q.data.buckets.d8_30]}
            columns={[...cols(t), { key: 'days_to_expiry', label: t('iv.lot_days_left'), align: 'right' as const, render: (r: any) => num(r.days_to_expiry) }]}
            emptyState={{ icon: CalendarCheck2, title: t('iv.lot_exp_empty_title'), description: t('iv.lot_exp_empty_desc') }}
          />
        </div>
      )}
    </StateView>
  );
}

function Fefo() {
  const { t } = useLang();
  const [item, setItem] = useState('');
  const q = useQuery<any>({ queryKey: ['lots-fefo', item], queryFn: () => api(`/api/lots/fefo/${encodeURIComponent(item)}`), enabled: !!item });
  return (
    <div className="space-y-3">
      <Input className="max-w-xs" placeholder={t('iv.lot_item_ph')} value={item} onChange={(e) => setItem(e.target.value)} />
      {item && (
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.lots}
              columns={cols(t)}
              emptyState={{ icon: PackageSearch, title: t('iv.lot_fefo_empty_title'), description: t('iv.lot_fefo_empty_desc') }}
            />
          )}
        </StateView>
      )}
    </div>
  );
}
