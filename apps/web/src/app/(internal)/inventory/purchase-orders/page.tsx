'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Coins, Hourglass, SearchX } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { readQueryParam } from '@/lib/url';
import { useLang } from '@/lib/i18n';
import { ModulePage } from '@/components/module-page';
import { SearchInput } from '@/components/search-input';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { statusVariant } from '@/components/ui';

interface PO { PO_No: string; PO_Date: string; Supplier_Name?: string; Total_Amount: number; Status: string }

export default function PurchaseOrdersPage() {
  const { t } = useLang();
  const q = useQuery<{ purchase_orders: PO[] }>({ queryKey: ['pos'], queryFn: () => api('/api/inventory/purchase-orders?limit=50') });
  const rows = q.data?.purchase_orders ?? [];

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  // Seed the search box from a ⌘K spotlight deep-link (?q=). Done in an effect (not a useState initializer)
  // so the server-rendered markup stays '' and there's no hydration mismatch.
  useEffect(() => { const q = readQueryParam('q'); if (q) setSearch(q); }, []);

  const statuses = useMemo(() => Array.from(new Set(rows.map((r) => r.Status).filter(Boolean))), [rows]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter && r.Status !== statusFilter) return false;
      if (!term) return true;
      return (r.PO_No ?? '').toLowerCase().includes(term) || (r.Supplier_Name ?? '').toLowerCase().includes(term);
    });
  }, [rows, search, statusFilter]);

  // Summary over the loaded window (honestly labelled — recent POs shown, not an all-time total).
  const summary = useMemo(() => {
    const total = rows.reduce((a, r) => a + Number(r.Total_Amount ?? 0), 0);
    const open = rows.filter((r) => statusVariant(r.Status) !== 'success').length;
    return { count: rows.length, total, open };
  }, [rows]);

  return (
    <ModulePage
      title={t('inv.po_title')}
      description={t('inv.po_subtitle')}
      query={q}
      toolbarClassName="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      toolbar={
        <>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t('inv.po_search_ph')}
            ariaLabel={t('inv.po_search_aria')}
            count={q.data ? t('inv.count_items', { n: num(filtered.length) }) : undefined}
          />
          {statuses.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('fin.col_status')}>
              <Button variant={statusFilter === null ? 'secondary' : 'ghost'} size="sm" onClick={() => setStatusFilter(null)}>
                {t('inv.all')}
              </Button>
              {statuses.map((s) => (
                <Button
                  key={s}
                  variant={statusFilter === s ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={statusFilter === s}
                  onClick={() => setStatusFilter((c) => (c === s ? null : s))}
                >
                  {s}
                </Button>
              ))}
            </div>
          )}
        </>
      }
      statsClassName="sm:grid-cols-3 xl:grid-cols-3"
      stats={
        q.data && (
          <>
            <StatCard label={t('inv.po_shown')} value={num(summary.count)} icon={ClipboardList} tone="primary" hint={t('inv.po_last50')} />
            <StatCard label={t('inv.po_total_value')} value={baht(summary.total)} icon={Coins} tone="default" hint={t('inv.from_shown')} />
            <StatCard
              label={t('inv.po_open')}
              value={num(summary.open)}
              icon={Hourglass}
              tone={summary.open > 0 ? 'warning' : 'success'}
              hint={t('inv.po_open_hint')}
            />
          </>
        )
      }
    >
      {q.data && (
        <DataTable
          rows={filtered}
          rowKey={(r) => r.PO_No}
          emptyState={
            search || statusFilter
              ? {
                  icon: SearchX,
                  title: t('inv.no_match_po'),
                  description: t('inv.no_match_desc'),
                  action: (
                    <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter(null); }}>
                      {t('inv.clear_filter')}
                    </Button>
                  ),
                }
              : { icon: ClipboardList, title: t('inv.po_empty_title'), description: t('inv.po_empty_desc') }
          }
          columns={[
            { key: 'PO_No', label: t('iv.col_po_no') },
            { key: 'PO_Date', label: t('dash.col_date'), render: (r) => thaiDate(r.PO_Date) },
            { key: 'Supplier_Name', label: t('inv.col_supplier'), render: (r) => r.Supplier_Name || '—' },
            { key: 'Total_Amount', label: t('fin.col_amount'), align: 'right', render: (r) => <span className="tabular">{baht(r.Total_Amount)}</span> },
            { key: 'Status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
          ]}
        />
      )}
    </ModulePage>
  );
}
