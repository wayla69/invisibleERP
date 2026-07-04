'use client';

// การ์ดเจ้าหนี้ (Vendor AP cards) — master/detail. The list is derived from the AP aging
// (GET /api/finance/ap/aging), grouped by vendor name → outstanding + worst days-overdue; selecting a
// vendor drills into its running-balance statement (GET /api/finance/ap/statement?vendor=…).
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { SearchInput } from '@/components/search-input';
import { AccountStatement, type StatementData } from '@/components/account-statement';
import { Card } from '@/components/ui/card';

const today = () => new Date().toISOString().slice(0, 10);
const yearStart = () => today().slice(0, 4) + '-01-01';

type AgingRow = { ref: string; party: string | null; due_date: string | null; outstanding: number; days_overdue: number; bucket: string };
type Vendor = { vendor: string; outstanding: number; max_days_overdue: number; open_bills: number };

export function VendorCardsClient() {
  const { t } = useLang();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());

  const agingQ = useQuery<{ rows: AgingRow[] }>({ queryKey: ['ap-aging'], queryFn: () => api('/api/finance/ap/aging') });
  const stmtQ = useQuery<StatementData>({
    queryKey: ['ap-statement', selected, from, to],
    queryFn: () => api(`/api/finance/ap/statement?vendor=${encodeURIComponent(selected!)}&from=${from}&to=${to}`),
    enabled: selected != null,
  });

  const vendors = useMemo(() => {
    const by = new Map<string, Vendor>();
    for (const r of agingQ.data?.rows ?? []) {
      const name = r.party ?? '—';
      const cur = by.get(name) ?? { vendor: name, outstanding: 0, max_days_overdue: 0, open_bills: 0 };
      cur.outstanding += r.outstanding;
      cur.max_days_overdue = Math.max(cur.max_days_overdue, r.days_overdue ?? 0);
      cur.open_bills += 1;
      by.set(name, cur);
    }
    const q = search.trim().toLowerCase();
    return [...by.values()]
      .filter((v) => !q || v.vendor.toLowerCase().includes(q))
      .sort((a, b) => b.max_days_overdue - a.max_days_overdue || b.outstanding - a.outstanding);
  }, [agingQ.data, search]);

  return (
    <div>
      <PageHeader title={t('fnx.vend.title')} description={t('fnx.vend.desc')} />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-3">
          <SearchInput value={search} onChange={setSearch} placeholder={t('fnx.vend.search_ph')} count={t('fnx.vend.count', { n: vendors.length })} />
          <StateView q={agingQ}>
            <div className="space-y-2">
              {vendors.length === 0 && (
                <Card className="p-6 text-center text-sm text-muted-foreground">{t('fnx.vend.empty')}</Card>
              )}
              {vendors.map((v) => (
                <button
                  key={v.vendor}
                  type="button"
                  onClick={() => setSelected(v.vendor)}
                  className={cn(
                    'w-full rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected === v.vendor && 'ring-2 ring-primary',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{v.vendor}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{t('fnx.vend.bills', { n: v.open_bills })}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('fnx.vend.outstanding')}</span>
                    <span className="tabular font-medium">{baht(v.outstanding)}</span>
                  </div>
                  {v.max_days_overdue > 0 && (
                    <div className="mt-0.5 text-xs text-destructive">{t('fnx.vend.max_overdue_days', { days: v.max_days_overdue })}</div>
                  )}
                </button>
              ))}
            </div>
          </StateView>
        </div>

        <div className="lg:col-span-2">
          {selected ? (
            <AccountStatement
              title={selected}
              side="ap"
              query={stmtQ}
              from={from}
              to={to}
              setFrom={setFrom}
              setTo={setTo}
              filename={`ap-statement-${selected}-${from}_${to}.csv`}
            />
          ) : (
            <AccountStatement title="" side="ap" query={stmtQ} from={from} to={to} setFrom={setFrom} setTo={setTo} filename="" empty />
          )}
        </div>
      </div>
    </div>
  );
}
