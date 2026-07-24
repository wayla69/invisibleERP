'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Banknote, Receipt, ShoppingCart, TrendingUp, TriangleAlert, Bell, Megaphone } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { Card, CardContent } from '@/components/ui/card';

export default function PortalDashboard() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['portal-dashboard'], queryFn: () => api('/api/portal/dashboard') });
  const d = q.data;
  return (
    <div>
      <PageHeader title={t('pt.dash.hello', { tenant: d?.tenant ?? '' })} description={t('pt.dash.desc')} />
      <Campaigns />
      <StateView q={q}>
        {d && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label={t('pt.dash.today_sales')} value={baht(d.today_sales)} icon={Banknote} tone="primary" />
              <StatCard label={t('pt.dash.today_orders')} value={num(d.today_orders)} icon={Receipt} />
              <StatCard label={t('pt.dash.mtd_sales')} value={baht(d.mtd_sales)} icon={TrendingUp} />
              <StatCard label={t('pt.dash.open_orders')} value={num(d.open_orders)} icon={ShoppingCart} />
              <StatCard label={t('pt.dash.low_stock')} value={num(d.low_stock_items)} icon={TriangleAlert} tone={d.low_stock_items > 0 ? 'danger' : 'success'} />
            </div>
            {d.auto_reorder && (
              <Card className="gap-0 border-warning/40 bg-warning/10 p-5">
                <CardContent className="flex items-start gap-3 px-0 text-sm">
                  <Bell className="mt-0.5 size-5 shrink-0 text-warning-foreground dark:text-warning" />
                  <p className="text-foreground">
                    {t('pt.dash.auto_prefix')} <strong>{d.auto_reorder.pending_no}</strong> {t('pt.dash.auto_lines', { n: d.auto_reorder.lines })} —
                    {' '}{t('pt.dash.auto_goto')}{' '}
                    <Link href="/portal/inventory" className="font-medium text-primary hover:underline">
                      {t('nav.portal_inventory')}
                    </Link>{' '}
                    {t('pt.dash.auto_suffix')}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </StateView>
    </div>
  );
}

// Active Popup/Ticker campaigns shown to the customer (api/marketing/campaigns/active is cust-accessible).
function Campaigns() {
  const q = useQuery<any>({ queryKey: ['portal-campaigns'], queryFn: () => api('/api/marketing/campaigns/active') });
  const list = q.data?.campaigns ?? [];
  if (!list.length) return null;
  const g = (c: any, ...keys: string[]) => keys.map((k) => c[k]).find((v) => v != null && v !== '') ?? '';
  return (
    <div className="mb-4 space-y-2">
      {list.map((c: any, i: number) => (
        <Card key={i} className="gap-0 border-primary/30 bg-primary/5 p-4">
          <CardContent className="flex items-start gap-3 px-0 text-sm">
            <Megaphone className="mt-0.5 size-5 shrink-0 text-primary" />
            <div>
              <div className="font-semibold text-foreground">{g(c, 'campaignName', 'campaign_name', 'name', 'title')}</div>
              <div className="text-muted-foreground">{g(c, 'content', 'message', 'body', 'description')}</div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
