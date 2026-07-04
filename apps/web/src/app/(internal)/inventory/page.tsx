'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import Link from 'next/link';
import { CalendarClock, Hourglass, Package, SearchX, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useLang } from '@/lib/i18n';
import { ModulePage } from '@/components/module-page';
import { SearchInput } from '@/components/search-input';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';

interface StockResp {
  snapshot_date: string | null;
  items: { Item_ID: string; Item_Description: string; UOM: string; AV_QTY: string; Total_Stock: string; Expiry_Date: string | null }[];
  total: number;
  low_stock_count: number;
}

const DAY_MS = 86_400_000;
const SOON_DAYS = 30;

// Expiry visual cue only (tone for the cell + the summary count). Compared against the device clock, which
// for in-store use ≈ Asia/Bangkok; this never feeds a posting, so the business-day nuance doesn't apply.
function expiryTone(v: string | null): 'destructive' | 'warning' | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.floor((t - Date.now()) / DAY_MS);
  if (days < 0) return 'destructive';
  if (days <= SOON_DAYS) return 'warning';
  return null;
}

export default function InventoryPage() {
  const { t } = useLang();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [lowOnly, setLowOnly] = useState(false);

  // Debounce the free-text search so we don't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const q = useQuery<StockResp>({
    queryKey: ['stock', debounced, lowOnly],
    queryFn: () => api(`/api/inventory/stock?limit=200&low_only=${lowOnly}${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`),
    // Keep the previous table visible while a new filter loads — no skeleton flash on every search/toggle.
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const filtering = debounced.length > 0 || lowOnly;

  // "Expiring soon / expired" count over the loaded rows (honestly scoped to what's shown).
  const expiringSoon = useMemo(() => (d?.items ?? []).filter((it) => expiryTone(it.Expiry_Date)).length, [d]);

  return (
    <ModulePage
      title={t('inv.title')}
      description={t('inv.subtitle')}
      query={q}
      toolbar={
        <>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t('inv.search_ph')}
            ariaLabel={t('inv.search_aria')}
            count={d ? t('inv.count_items', { n: num(d.items.length) }) : undefined}
          />
          <Button variant={lowOnly ? 'default' : 'outline'} aria-pressed={lowOnly} onClick={() => setLowOnly((v) => !v)}>
            <TriangleAlert className="size-4" /> {t('inv.low_only')}
          </Button>
          {q.isFetching && !q.isLoading && <span className="text-xs text-muted-foreground">{t('inv.updating')}</span>}
        </>
      }
      stats={
        d && (
          <>
            <StatCard label="Snapshot" value={d.snapshot_date ? thaiDate(d.snapshot_date) : '—'} icon={CalendarClock} hint={t('inv.snapshot_hint')} />
            <StatCard label={t('inv.total_items')} value={num(d.total)} icon={Package} tone="primary" />
            <StatCard label={t('inv.low_stock')} value={num(d.low_stock_count)} icon={TriangleAlert} tone={d.low_stock_count > 0 ? 'warning' : 'success'} hint={t('dash.need_restock')} />
            <StatCard
              label={t('inv.expiring')}
              value={num(expiringSoon)}
              icon={Hourglass}
              tone={expiringSoon > 0 ? 'danger' : 'success'}
              hint={t('inv.from_shown')}
            />
          </>
        )
      }
    >
      {d && (
        <DataTable
          rows={d.items}
          rowKey={(r) => r.Item_ID}
          emptyState={
            filtering
              ? {
                  icon: SearchX,
                  title: t('inv.no_match_items'),
                  description: t('inv.no_match_desc'),
                  action: (
                    <Button variant="outline" size="sm" onClick={() => { setSearch(''); setLowOnly(false); }}>
                      {t('inv.clear_filter')}
                    </Button>
                  ),
                }
              : { icon: Package, title: t('inv.empty_title'), description: t('inv.empty_desc') }
          }
          columns={[
            { key: 'Item_ID', label: 'Item ID', render: (r) => <Link className="font-medium text-primary hover:underline" href={`/inventory/${encodeURIComponent(r.Item_ID)}`}>{r.Item_ID}</Link> },
            { key: 'Item_Description', label: t('inv.col_name') },
            { key: 'UOM', label: t('inv.col_uom') },
            { key: 'AV_QTY', label: t('inv.col_onhand'), align: 'right', render: (r) => <span className={cn('tabular', Number(r.AV_QTY) <= 0 && 'font-semibold text-destructive')}>{num(r.AV_QTY)}</span> },
            {
              key: 'Expiry_Date',
              label: t('inv.col_expiry'),
              render: (r) => {
                const tone = expiryTone(r.Expiry_Date);
                return (
                  <span className={cn(tone === 'destructive' && 'font-medium text-destructive', tone === 'warning' && 'text-warning-foreground dark:text-warning')}>
                    {r.Expiry_Date ? thaiDate(r.Expiry_Date) : '—'}
                  </span>
                );
              },
            },
          ]}
        />
      )}
    </ModulePage>
  );
}
