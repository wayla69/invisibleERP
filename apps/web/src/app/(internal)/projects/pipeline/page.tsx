'use client';

import { useQuery } from '@tanstack/react-query';
import { Trophy, TrendingDown, Target, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { SimpleBarChart, TrendAreaChart } from '@/components/charts';
import { Card } from '@/components/ui/card';

const STAGE_LABEL: Record<string, string> = {
  prospecting: 'ค้นหา', qualification: 'คัดกรอง', proposal: 'เสนอราคา', negotiation: 'เจรจา', won: 'ชนะ', lost: 'แพ้',
};
const STAGE_ORDER = ['prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost'];

export default function PipelineDashboardPage() {
  const q = useQuery<any>({ queryKey: ['crm', 'winloss'], queryFn: () => api('/api/crm/pipeline/win-loss?months=12') });
  const d = q.data;
  const s = d?.summary;
  const winRatePct = s?.win_rate != null ? Math.round(s.win_rate * 1000) / 10 : 0;

  const byStage = STAGE_ORDER
    .filter((k) => s?.by_stage?.[k])
    .map((k) => ({ stage: STAGE_LABEL[k] ?? k, amount: s.by_stage[k].amount, count: s.by_stage[k].count }));
  const lossReasons = (d?.loss_reasons ?? []).slice(0, 8).map((r: any) => ({ reason: r.reason, amount: r.amount }));
  const monthly = (d?.monthly ?? []).map((m: any) => ({ month: m.month, win_rate: m.win_rate_pct }));

  return (
    <div>
      <PageHeader title="ไปป์ไลน์การขาย — Win / Loss" description="วิเคราะห์อัตราชนะ มูลค่าถ่วงน้ำหนัก เหตุผลที่แพ้ และผลงานรายเซลส์ — ดีลที่ชนะแปลงเป็นโครงการได้" />

      <StateView q={q}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="อัตราชนะ (Win rate)" value={`${winRatePct}%`} icon={Target} tone="primary" hint="ชนะ ÷ (ชนะ+แพ้)" />
            <StatCard label="คาดการณ์ถ่วงน้ำหนัก" value={baht(s?.weighted_forecast ?? 0)} icon={Wallet} tone="info" hint={`เปิดอยู่ ${baht(s?.open_amount ?? 0)}`} />
            <StatCard label="มูลค่าที่ชนะ" value={baht(s?.won_amount ?? 0)} icon={Trophy} tone="success" />
            <StatCard label="มูลค่าที่แพ้" value={baht(s?.lost_amount ?? 0)} icon={TrendingDown} tone="danger" />
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            <Card className="gap-3 p-5 lg:col-span-3">
              <h3 className="text-base font-semibold">มูลค่าตามขั้นตอน (Pipeline by stage)</h3>
              {byStage.length ? <SimpleBarChart data={byStage} xKey="stage" yKey="amount" fmt={(v) => baht(v)} /> : <Empty />}
            </Card>
            <Card className="gap-3 p-5 lg:col-span-2">
              <h3 className="text-base font-semibold">เหตุผลที่แพ้ (Loss reasons)</h3>
              {lossReasons.length ? <SimpleBarChart data={lossReasons} xKey="reason" yKey="amount" color="var(--destructive)" fmt={(v) => baht(v)} /> : <Empty text="ยังไม่มีดีลที่แพ้" />}
            </Card>
          </div>

          <Card className="gap-3 p-5">
            <h3 className="text-base font-semibold">แนวโน้มอัตราชนะรายเดือน</h3>
            {monthly.length ? <TrendAreaChart data={monthly} xKey="month" yKey="win_rate" color="var(--chart-3)" fmt={(v) => `${v}%`} /> : <Empty />}
          </Card>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ผลงานรายเจ้าของดีล (By owner)</h3>
            <DataTable
              rows={d?.by_owner ?? []}
              columns={[
                { key: 'owner', label: 'เจ้าของดีล' },
                { key: 'won', label: 'ชนะ', align: 'right' },
                { key: 'lost', label: 'แพ้', align: 'right' },
                { key: 'open', label: 'เปิดอยู่', align: 'right' },
                { key: 'win_rate', label: 'อัตราชนะ', align: 'right', render: (r: any) => (
                  <div className="ml-auto flex w-28 items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-success" style={{ width: `${Math.min(100, r.win_rate)}%` }} /></div>
                    <span className="tabular w-10 text-right text-xs">{r.win_rate}%</span>
                  </div>
                ) },
                { key: 'won_amount', label: 'มูลค่าที่ชนะ', align: 'right', render: (r: any) => <span className="tabular">{baht(r.won_amount)}</span> },
              ]}
              emptyState={{ icon: Trophy, title: 'ยังไม่มีข้อมูล', description: 'สร้างโอกาสการขายในไปป์ไลน์เพื่อดูผลงานรายเซลส์' }}
            />
          </div>
        </div>
      </StateView>
    </div>
  );
}

function Empty({ text = 'ยังไม่มีข้อมูล' }: { text?: string }) {
  return <div className="py-12 text-center text-sm text-muted-foreground">{text}</div>;
}
