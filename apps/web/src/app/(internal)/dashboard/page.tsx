'use client';

import { useQuery } from '@tanstack/react-query';
import { Banknote, Gauge, Package, Receipt, ShoppingCart, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendAreaChart, SimpleBarChart } from '@/components/charts';
import { statusVariant } from '@/components/ui';

interface Dash {
  today: { sales: number; orders: number };
  month: { sales: number; orders: number };
  low_stock_count: number;
  outstanding_ap: number;
  top_items_today: { Item_Description: string; qty: number; revenue: number }[];
  recent_orders: { Sale_No: string; Sale_Date: string; Total: number; Status: string; Payment_Method: string }[];
}
interface Trend {
  days: number;
  trend: { date: string; sales: number; orders: number }[];
}
interface Widget { key: string; label: string; label_en: string; unit: string; value: number }

export default function DashboardPage() {
  const q = useQuery<Dash>({ queryKey: ['dashboard'], queryFn: () => api('/api/dashboard') });
  const t = useQuery<Trend>({ queryKey: ['dashboard-trend'], queryFn: () => api('/api/dashboard/sales-trend?days=14') });
  const mine = useQuery<{ role: string; configured: boolean; widgets: Widget[] }>({ queryKey: ['dashboard-mine'], queryFn: () => api('/api/dashboard/layout/me') });
  const d = q.data;

  const trendData = (t.data?.trend ?? []).map((r) => ({ ...r, label: thaiDate(r.date) }));
  const topItems = (d?.top_items_today ?? []).slice(0, 6).map((r) => ({ name: r.Item_Description, revenue: r.revenue }));
  const myWidgets = mine.data?.widgets ?? [];

  return (
    <div>
      <PageHeader title="แดชบอร์ด" description="ภาพรวมธุรกิจแบบเรียลไทม์" />
      {myWidgets.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ตัวชี้วัดตามบทบาท (Your role KPIs)</h3>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {myWidgets.map((w) => (
              <StatCard key={w.key} label={w.label} value={w.unit === 'baht' ? baht(w.value) : num(w.value)} icon={Gauge} tone="default" hint={w.label_en} />
            ))}
          </div>
        </div>
      )}
      <StateView q={q}>
        {d && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="ยอดขายวันนี้" value={baht(d.today.sales)} icon={Banknote} tone="primary" hint={`${num(d.today.orders)} ออเดอร์`} />
              <StatCard label="ยอดขายเดือนนี้" value={baht(d.month.sales)} icon={TrendingUp} tone="default" hint={`${num(d.month.orders)} ออเดอร์`} />
              <StatCard label="สต๊อกต่ำ (≤0)" value={num(d.low_stock_count)} icon={Package} tone={d.low_stock_count > 0 ? 'warning' : 'success'} hint="ต้องเติมสินค้า" />
              <StatCard label="เจ้าหนี้คงค้าง (AP)" value={baht(d.outstanding_ap)} icon={Receipt} tone={d.outstanding_ap > 0 ? 'danger' : 'success'} hint="ยอดค้างชำระ" />
            </div>

            <div className="grid gap-4 lg:grid-cols-5">
              <Card className="lg:col-span-3">
                <CardHeader>
                  <CardTitle className="text-base">แนวโน้มยอดขาย (14 วัน)</CardTitle>
                </CardHeader>
                <CardContent>
                  {trendData.length ? (
                    <TrendAreaChart data={trendData} xKey="label" yKey="sales" fmt={(v) => baht(v)} />
                  ) : (
                    <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">ยังไม่มีข้อมูลยอดขาย</div>
                  )}
                </CardContent>
              </Card>
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base">สินค้าขายดีวันนี้</CardTitle>
                </CardHeader>
                <CardContent>
                  {topItems.length ? (
                    <SimpleBarChart data={topItems} xKey="name" yKey="revenue" color="var(--chart-2)" fmt={(v) => baht(v)} />
                  ) : (
                    <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">ยังไม่มียอดขายวันนี้</div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-3 text-sm font-semibold text-muted-foreground">สินค้าขายดีวันนี้</h3>
                <DataTable
                  rows={d.top_items_today}
                  columns={[
                    { key: 'Item_Description', label: 'สินค้า' },
                    { key: 'qty', label: 'จำนวน', align: 'right', render: (r) => num(r.qty) },
                    { key: 'revenue', label: 'รายได้', align: 'right', render: (r) => baht(r.revenue) },
                  ]}
                />
              </div>
              <div>
                <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ออเดอร์ล่าสุด</h3>
                <DataTable
                  rows={d.recent_orders}
                  columns={[
                    { key: 'Sale_No', label: 'เลขที่' },
                    { key: 'Sale_Date', label: 'วันที่', render: (r) => thaiDate(r.Sale_Date) },
                    { key: 'Total', label: 'ยอด', align: 'right', render: (r) => baht(r.Total) },
                    { key: 'Payment_Method', label: 'ชำระ' },
                    { key: 'Status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
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
