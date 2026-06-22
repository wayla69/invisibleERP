'use client';

import { useQuery } from '@tanstack/react-query';
import { Banknote, Receipt, ReceiptText, Target, TrendingUp, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { DataTable } from '@/components/data-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendAreaChart, SimpleBarChart } from '@/components/charts';

interface Kpi {
  as_of: string;
  sales: { mtd: number; mtd_orders: number; ytd: number; avg_order_mtd: number };
  receivables: { open_ar: number; overdue_ar: number; overdue_count: number };
  payables: { open_ap: number };
  pipeline: { open_value: number; weighted_value: number; open_count: number };
}
interface SalesCube {
  period_type: string;
  start: string;
  end: string;
  rows: { period: string; total_sales: number; total_orders: number; avg_order: number; total_tax: number }[];
  totals: { total_sales: number; total_orders: number };
}
interface FinanceTrend {
  months: number;
  trend: { period: string; revenue: number; expense: number; gross_profit: number; margin_pct: number }[];
}
interface PipelineTrend {
  months: number;
  trend: { month: string; open: number; won: number; lost: number; open_value: number; won_value: number; total_created: number; win_rate_pct: number }[];
}
interface Snapshots {
  start: string;
  end: string;
  snapshots: { date: string; total_sales: number; total_orders: number; avg_order_value: number; open_ar: number; open_ap: number; pipeline_value: number; weighted_pipeline: number }[];
  count: number;
}

export default function BiPage() {
  const kpi = useQuery<Kpi>({ queryKey: ['bi-kpi'], queryFn: () => api('/api/bi/kpi') });
  const cube = useQuery<SalesCube>({ queryKey: ['bi-cube'], queryFn: () => api('/api/bi/sales-cube?period=month&months=6') });
  const finance = useQuery<FinanceTrend>({ queryKey: ['bi-finance'], queryFn: () => api('/api/bi/finance-trend?months=6') });
  const pipeline = useQuery<PipelineTrend>({ queryKey: ['bi-pipeline'], queryFn: () => api('/api/bi/pipeline-trend?months=6') });
  const snaps = useQuery<Snapshots>({ queryKey: ['bi-snapshots'], queryFn: () => api('/api/bi/snapshots?days=30') });

  const k = kpi.data;
  const cubeData = (cube.data?.rows ?? []).map((r) => ({ ...r, label: r.period.slice(0, 7) }));
  const financeData = (finance.data?.trend ?? []).map((r) => ({ ...r, label: r.period }));
  const pipelineData = pipeline.data?.trend ?? [];

  return (
    <div>
      <PageHeader title="BI Analytics" description="แดชบอร์ดวิเคราะห์ธุรกิจ — ยอดขาย, การเงิน, ลูกหนี้/เจ้าหนี้ และไปป์ไลน์งานขาย" />

      <div className="space-y-6">
        <StateView q={kpi}>
          {k && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="ยอดขายเดือนนี้ (MTD)" value={baht(k.sales.mtd)} icon={Banknote} tone="primary" hint={`${num(k.sales.mtd_orders)} ออเดอร์`} />
              <StatCard label="ยอดขายสะสมปีนี้ (YTD)" value={baht(k.sales.ytd)} icon={TrendingUp} tone="default" hint={`เฉลี่ย/ออเดอร์ ${baht(k.sales.avg_order_mtd)}`} />
              <StatCard label="ลูกหนี้คงค้าง (AR)" value={baht(k.receivables.open_ar)} icon={ReceiptText} tone={k.receivables.overdue_ar > 0 ? 'warning' : 'default'} hint={`เกินกำหนด ${baht(k.receivables.overdue_ar)} · ${num(k.receivables.overdue_count)} ใบ`} />
              <StatCard label="เจ้าหนี้คงค้าง (AP)" value={baht(k.payables.open_ap)} icon={Receipt} tone={k.payables.open_ap > 0 ? 'danger' : 'success'} hint="ยอดค้างชำระ" />
            </div>
          )}
        </StateView>

        <StateView q={kpi}>
          {k && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label="ไปป์ไลน์เปิดอยู่" value={baht(k.pipeline.open_value)} icon={Target} tone="info" hint={`${num(k.pipeline.open_count)} ดีล`} />
              <StatCard label="ไปป์ไลน์ถ่วงน้ำหนัก" value={baht(k.pipeline.weighted_value)} icon={Wallet} tone="info" hint="ตามความน่าจะเป็นของแต่ละขั้น" />
              <StatCard label="เฉลี่ยต่อออเดอร์ (MTD)" value={baht(k.sales.avg_order_mtd)} icon={TrendingUp} tone="default" hint={`ข้อมูล ณ ${thaiDate(k.as_of)}`} />
            </div>
          )}
        </StateView>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">แนวโน้มการเงิน — รายได้ (6 เดือน)</CardTitle>
            </CardHeader>
            <CardContent>
              <StateView q={finance}>
                {financeData.length ? (
                  <TrendAreaChart data={financeData} xKey="label" yKey="revenue" fmt={(v) => baht(v)} />
                ) : (
                  <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">ยังไม่มีข้อมูลการเงินที่ลงบัญชีแล้ว</div>
                )}
              </StateView>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">ยอดขายรายเดือน (Sales Cube)</CardTitle>
            </CardHeader>
            <CardContent>
              <StateView q={cube}>
                {cubeData.length ? (
                  <SimpleBarChart data={cubeData} xKey="label" yKey="total_sales" color="var(--chart-2)" fmt={(v) => baht(v)} />
                ) : (
                  <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">ยังไม่มียอดขายในช่วงนี้</div>
                )}
              </StateView>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="text-base">แนวโน้มไปป์ไลน์ (สร้างใหม่รายเดือน)</CardTitle>
            </CardHeader>
            <CardContent>
              <StateView q={pipeline}>
                {pipelineData.length ? (
                  <SimpleBarChart data={pipelineData} xKey="month" yKey="open_value" color="var(--chart-3)" fmt={(v) => baht(v)} />
                ) : (
                  <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">ยังไม่มีดีลในช่วงนี้</div>
                )}
              </StateView>
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">สรุปไปป์ไลน์รายเดือน</CardTitle>
            </CardHeader>
            <CardContent>
              <StateView q={pipeline}>
                <DataTable
                  rows={pipelineData}
                  dense
                  columns={[
                    { key: 'month', label: 'เดือน' },
                    { key: 'open', label: 'เปิด', align: 'right', render: (r) => num(r.open) },
                    { key: 'won', label: 'ชนะ', align: 'right', render: (r) => num(r.won) },
                    { key: 'win_rate_pct', label: '% ชนะ', align: 'right', render: (r) => `${num(r.win_rate_pct)}%` },
                  ]}
                  emptyText="ไม่มีข้อมูล"
                />
              </StateView>
            </CardContent>
          </Card>
        </div>

        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">สแน็ปช็อตรายวัน (30 วัน)</h3>
          <StateView q={snaps}>
            <DataTable
              rows={snaps.data?.snapshots ?? []}
              columns={[
                { key: 'date', label: 'วันที่', render: (r) => thaiDate(r.date) },
                { key: 'total_sales', label: 'ยอดขาย', align: 'right', render: (r) => <span className="tabular">{baht(r.total_sales)}</span> },
                { key: 'total_orders', label: 'ออเดอร์', align: 'right', render: (r) => num(r.total_orders) },
                { key: 'open_ar', label: 'ลูกหนี้', align: 'right', render: (r) => <span className="tabular">{baht(r.open_ar)}</span> },
                { key: 'open_ap', label: 'เจ้าหนี้', align: 'right', render: (r) => <span className="tabular">{baht(r.open_ap)}</span> },
                { key: 'pipeline_value', label: 'ไปป์ไลน์', align: 'right', render: (r) => <span className="tabular">{baht(r.pipeline_value)}</span> },
              ]}
              emptyText="ยังไม่มีสแน็ปช็อต"
            />
          </StateView>
        </div>
      </div>
    </div>
  );
}
