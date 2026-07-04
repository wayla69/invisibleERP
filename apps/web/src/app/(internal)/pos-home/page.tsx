'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Banknote, ClipboardList, CreditCard, Receipt, ReceiptText, ShoppingCart, Store, Users, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SimpleBarChart } from '@/components/charts';
import { statusVariant } from '@/components/ui';

// Business-day "today" (Asia/Bangkok) as YYYY-MM-DD, matching how sales are dated server-side.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());

interface Summary {
  total_orders: number;
  total_sales: number;
  total_tax: number;
  total_discount: number;
  avg_order_value: number;
  top_items: { Item_Description: string; total_qty: number; total_revenue: number }[];
  by_payment: { Payment_Method: string; order_count: number; amount: number }[];
}
interface Sessions {
  sessions: { Cashier: string; Sale_Date: string; session_total: number; order_count: number }[];
}
interface Orders {
  orders: { Sale_No: string; Sale_Date: string; Total: number; Status: string; Payment_Method: string; Cashier: string }[];
}

const QUICK = [
  { labelKey: 'pos.quick_register', href: '/pos/register', icon: ShoppingCart },
  { labelKey: 'pos.quick_control', href: '/pos-control', icon: ClipboardList },
  { labelKey: 'pos.quick_terminals', href: '/payments/terminals', icon: CreditCard },
  { labelKey: 'pos.quick_branches', href: '/branches', icon: Store },
];

export default function PosHomePage() {
  const { t } = useLang();
  const q = useQuery<Summary>({ queryKey: ['pos-summary', today], queryFn: () => api(`/api/pos/summary?start_date=${today}&end_date=${today}`) });
  const sess = useQuery<Sessions>({ queryKey: ['pos-sessions'], queryFn: () => api('/api/pos/sessions') });
  const recent = useQuery<Orders>({ queryKey: ['pos-recent'], queryFn: () => api('/api/pos/orders?limit=8') });

  const d = q.data;
  const payments = (d?.by_payment ?? []).map((p) => ({ name: p.Payment_Method || '—', amount: p.amount }));

  return (
    <div>
      <PageHeader title={t('pos.title')} description={`${t('pos.subtitle')} · ${thaiDate(today)}`} />

      {/* Quick actions */}
      <div className="mb-6 flex flex-wrap gap-2">
        {QUICK.map((a) => (
          <Button key={a.href} asChild variant="outline" size="sm" className="gap-2">
            <Link href={a.href}>
              <a.icon className="size-4" />
              {t(a.labelKey)}
            </Link>
          </Button>
        ))}
      </div>

      <StateView q={q}>
        {d && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('dash.today_sales')} value={baht(d.total_sales)} icon={Banknote} tone="primary" hint={t('pos.bills_n', { n: num(d.total_orders) })} />
              <StatCard label={t('pos.avg_bill')} value={baht(d.avg_order_value)} icon={Receipt} tone="default" hint={t('pos.per_bill')} />
              <StatCard label={t('pos.vat')} value={baht(d.total_tax)} icon={Receipt} tone="default" hint={t('pos.vat_hint')} />
              <StatCard label={t('pos.discount')} value={baht(d.total_discount)} icon={Banknote} tone={d.total_discount > 0 ? 'warning' : 'success'} hint={t('pos.discount_hint')} />
            </div>

            <div className="grid gap-4 lg:grid-cols-5">
              <Card className="lg:col-span-3">
                <CardHeader>
                  <CardTitle className="text-base">{t('dash.top_items')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {d.top_items.length ? (
                    <SimpleBarChart
                      data={d.top_items.slice(0, 6).map((t) => ({ name: t.Item_Description, revenue: t.total_revenue }))}
                      xKey="name"
                      yKey="revenue"
                      color="var(--chart-2)"
                      fmt={(v) => baht(v)}
                    />
                  ) : (
                    <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">{t('dash.no_sales_today')}</div>
                  )}
                </CardContent>
              </Card>
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base">{t('pos.by_payment')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {payments.length ? (
                    <SimpleBarChart data={payments} xKey="name" yKey="amount" color="var(--chart-1)" fmt={(v) => baht(v)} />
                  ) : (
                    <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">{t('pos.no_payments')}</div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('pos.open_tills')}</h3>
                <DataTable
                  rows={sess.data?.sessions ?? []}
                  emptyState={{
                    icon: Wallet,
                    title: t('pos.no_tills_title'),
                    description: t('pos.no_tills_desc'),
                  }}
                  columns={[
                    { key: 'Cashier', label: t('pos.col_cashier'), render: (r) => (
                      <span className="inline-flex items-center gap-1.5"><Users className="size-3.5 text-muted-foreground" />{r.Cashier}</span>
                    ) },
                    { key: 'order_count', label: t('pos.col_bills'), align: 'right', render: (r) => num(r.order_count) },
                    { key: 'session_total', label: t('pos.col_session_total'), align: 'right', render: (r) => baht(r.session_total) },
                  ]}
                />
              </div>
              <div>
                <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('pos.recent_bills')}</h3>
                <DataTable
                  rows={recent.data?.orders ?? []}
                  emptyState={{
                    icon: ReceiptText,
                    title: t('pos.no_bills_title'),
                    description: t('pos.no_bills_desc'),
                  }}
                  columns={[
                    { key: 'Sale_No', label: t('dash.col_no') },
                    { key: 'Total', label: t('dash.col_total'), align: 'right', render: (r) => baht(r.Total) },
                    { key: 'Payment_Method', label: t('dash.col_payment') },
                    { key: 'Status', label: t('dash.col_status'), render: (r) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
                  ]}
                />
              </div>
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}
