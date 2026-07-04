'use client';

// การ์ดลูกหนี้ (Customer AR cards) — master/detail. The list is the open-AR credit positions
// (GET /api/finance/ar/credit-positions, one row per customer with tenant_id + exposure/overdue/hold);
// selecting one drills into its running-balance statement (GET /api/finance/ar/statement?tenant_id=…).
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';

import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { SearchInput } from '@/components/search-input';
import { AccountStatement, type StatementData } from '@/components/account-statement';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

const today = () => new Date().toISOString().slice(0, 10);
const yearStart = () => today().slice(0, 4) + '-01-01';

type Position = {
  tenant_id: number;
  customer: string;
  credit_term: number | null;
  credit_limit: number;
  exposure: number;
  overdue: number;
  max_overdue_days: number;
  on_hold: boolean;
};

export function CustomerCardsClient() {
  const { t } = useLang();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Position | null>(null);
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());

  const listQ = useQuery<{ positions: Position[] }>({ queryKey: ['ar-positions'], queryFn: () => api('/api/finance/ar/credit-positions') });
  const stmtQ = useQuery<StatementData>({
    queryKey: ['ar-statement', selected?.tenant_id, from, to],
    queryFn: () => api(`/api/finance/ar/statement?tenant_id=${selected!.tenant_id}&from=${from}&to=${to}`),
    enabled: selected != null,
  });

  const positions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (listQ.data?.positions ?? []).filter((p) => !q || p.customer?.toLowerCase().includes(q));
  }, [listQ.data, search]);

  return (
    <div>
      <PageHeader title={t('fnx.cust.title')} description={t('fnx.cust.desc')} />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-3">
          <SearchInput value={search} onChange={setSearch} placeholder={t('fnx.cust.search_ph')} count={t('fnx.cust.count', { n: positions.length })} />
          <StateView q={listQ}>
            <div className="space-y-2">
              {positions.length === 0 && (
                <Card className="p-6 text-center text-sm text-muted-foreground">{t('fnx.cust.empty')}</Card>
              )}
              {positions.map((p) => (
                <button
                  key={p.tenant_id}
                  type="button"
                  onClick={() => setSelected(p)}
                  className={cn(
                    'w-full rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected?.tenant_id === p.tenant_id && 'ring-2 ring-primary',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{p.customer}</span>
                    {p.on_hold && <Badge variant="destructive">{t('fnx.cust.badge_hold')}</Badge>}
                  </div>
                  <div className="mt-1 flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('fnx.cust.outstanding')}</span>
                    <span className="tabular font-medium">{baht(p.exposure)}</span>
                  </div>
                  {p.overdue > 0.005 && (
                    <div className="mt-0.5 flex items-center justify-between text-xs text-destructive">
                      <span>{t('fnx.cust.overdue_days', { days: p.max_overdue_days })}</span>
                      <span className="tabular">{baht(p.overdue)}</span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          </StateView>
        </div>

        <div className="lg:col-span-2">
          {selected ? (
            <AccountStatement
              title={selected.customer}
              side="ar"
              query={stmtQ}
              from={from}
              to={to}
              setFrom={setFrom}
              setTo={setTo}
              filename={`ar-statement-${selected.customer}-${from}_${to}.csv`}
            />
          ) : (
            <AccountStatement title="" side="ar" query={stmtQ} from={from} to={to} setFrom={setFrom} setTo={setTo} filename="" empty />
          )}
        </div>
      </div>
    </div>
  );
}
