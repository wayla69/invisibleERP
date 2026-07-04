'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Banknote, Hourglass, Plus, Receipt, SearchX, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { readQueryParam } from '@/lib/url';
import { PageHeader } from '@/components/page-header';
import { SearchInput } from '@/components/search-input';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { statusVariant } from '@/components/ui';
import { useLang } from '@/lib/i18n';

interface Order {
  Sale_No: string;
  Sale_Date: string;
  Customer_Name?: string;
  Total: number;
  Payment_Method?: string;
  Status: string;
}

export default function PosPage() {
  const { t } = useLang();
  const q = useQuery<{ orders: Order[] }>({ queryKey: ['orders'], queryFn: () => api('/api/pos/orders?limit=50') });
  const orders = q.data?.orders ?? [];

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  // Seed the search box from a ⌘K spotlight deep-link (?q=) after mount, avoiding a hydration mismatch.
  useEffect(() => { const q = readQueryParam('q'); if (q) setSearch(q); }, []);

  // Distinct statuses present in the loaded window — drives the quick-filter chips.
  const statuses = useMemo(() => Array.from(new Set(orders.map((o) => o.Status).filter(Boolean))), [orders]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (statusFilter && o.Status !== statusFilter) return false;
      if (!term) return true;
      return (o.Sale_No ?? '').toLowerCase().includes(term) || (o.Customer_Name ?? '').toLowerCase().includes(term);
    });
  }, [orders, search, statusFilter]);

  // Summary over the loaded window. Labelled honestly ("ที่แสดง") — it reflects the recent orders on this
  // page, not an all-time aggregate (that lives on the dashboard, which queries server-side totals).
  const summary = useMemo(() => {
    const total = orders.reduce((a, o) => a + Number(o.Total ?? 0), 0);
    const open = orders.filter((o) => statusVariant(o.Status) !== 'success').length;
    return { count: orders.length, total, avg: orders.length ? total / orders.length : 0, open };
  }, [orders]);

  return (
    <div>
      <PageHeader
        title={t('px.poshome_title')}
        description={t('px.poshome_desc')}
        actions={
          <Button asChild>
            <Link href="/pos/register">
              <Plus className="size-4" /> {t('px.poshome_open_register')}
            </Link>
          </Button>
        }
      />
      <StateView q={q}>
        {q.data && (
          <div className="space-y-6">
            {/* Summary band — derived from the recent orders shown on this page */}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('px.poshome_stat_shown')} value={num(summary.count)} icon={Receipt} tone="primary" hint={t('px.poshome_stat_shown_hint')} />
              <StatCard label={t('px.poshome_stat_total')} value={baht(summary.total)} icon={Banknote} tone="default" hint={t('px.poshome_stat_total_hint')} />
              <StatCard label={t('px.poshome_stat_avg')} value={baht(summary.avg)} icon={TrendingUp} tone="info" />
              <StatCard
                label={t('px.poshome_stat_open')}
                value={num(summary.open)}
                icon={Hourglass}
                tone={summary.open > 0 ? 'warning' : 'success'}
                hint={t('px.poshome_stat_open_hint')}
              />
            </div>

            {/* Toolbar: free-text search + status quick-filter chips (client-side) */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={t('px.poshome_search_placeholder')}
                ariaLabel={t('px.poshome_search_aria')}
              />
              {statuses.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('px.poshome_filter_status_aria')}>
                  <Button variant={statusFilter === null ? 'secondary' : 'ghost'} size="sm" onClick={() => setStatusFilter(null)}>
                    {t('px.poshome_all')}
                  </Button>
                  {statuses.map((s) => (
                    <Button
                      key={s}
                      variant={statusFilter === s ? 'secondary' : 'ghost'}
                      size="sm"
                      aria-pressed={statusFilter === s}
                      onClick={() => setStatusFilter((cur) => (cur === s ? null : s))}
                    >
                      {s}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            <DataTable
              rows={filtered}
              rowKey={(r) => r.Sale_No}
              emptyState={
                search || statusFilter
                  ? {
                      icon: SearchX,
                      title: t('px.poshome_empty_filtered_title'),
                      description: t('px.poshome_empty_filtered_desc'),
                      action: (
                        <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter(null); }}>
                          {t('inv.clear_filter')}
                        </Button>
                      ),
                    }
                  : {
                      icon: Receipt,
                      title: t('px.poshome_empty_title'),
                      description: t('px.poshome_empty_desc'),
                      action: (
                        <Button asChild size="sm">
                          <Link href="/pos/new">
                            <Plus className="size-4" /> {t('px.poshome_create_order')}
                          </Link>
                        </Button>
                      ),
                    }
              }
              columns={[
                { key: 'Sale_No', label: t('dash.col_no') },
                { key: 'Sale_Date', label: t('dash.col_date'), render: (r) => thaiDate(r.Sale_Date) },
                { key: 'Customer_Name', label: t('fin.col_customer'), render: (r) => r.Customer_Name || '—' },
                { key: 'Total', label: t('fin.col_amount'), align: 'right', render: (r) => <span className="tabular">{baht(r.Total)}</span> },
                { key: 'Payment_Method', label: t('px.poshome_col_payment'), render: (r) => r.Payment_Method || '—' },
                { key: 'Status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
              ]}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}
