'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wallet, TrendingUp, AlertTriangle, HeartPulse } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { TrendAreaChart } from '@/components/charts';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

const GRADE_TONE: Record<string, 'success' | 'info' | 'warning' | 'danger'> = { A: 'success', B: 'success', C: 'info', D: 'warning', E: 'danger' };

export default function CashflowPage() {
  const [weeks, setWeeks] = useState(8);
  const q = useQuery<any>({ queryKey: ['cashflow', weeks], queryFn: () => api(`/api/finance/cashflow?weeks=${weeks}`) });

  return (
    <div>
      <PageHeader
        title="กระแสเงินสด (Cash-flow forecast)"
        description="พยากรณ์เงินสดรายสัปดาห์จากเงินสดตั้งต้น + ลูกหนี้ + เจ้าหนี้ + ยอดขาย POS · พร้อมคะแนนสุขภาพการเงิน"
        actions={
          <div className="grid gap-1"><Label htmlFor="weeks" className="text-xs">ช่วง (สัปดาห์)</Label><Input id="weeks" type="number" min={1} max={26} value={weeks} onChange={(e) => setWeeks(Math.max(1, Math.min(26, +e.target.value)))} className="h-9 w-32" /></div>
        }
      />
      <StateView q={q}>
        {q.data && (
          <>
            <div className="mb-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
              <StatCard label="เงินสดตั้งต้น" value={baht(q.data.opening_cash)} icon={Wallet} />
              <StatCard label="ยอดขาย/วัน (run-rate)" value={baht(q.data.pos_daily_run_rate)} icon={TrendingUp} tone="info" />
              <StatCard
                label="ยอดต่ำสุดที่คาดการณ์"
                value={baht(q.data.summary.min_projected_balance)}
                icon={AlertTriangle}
                tone={q.data.summary.min_projected_balance < 0 ? 'danger' : 'success'}
                hint={q.data.summary.first_shortfall_week ? `⚠️ เงินสดอาจติดลบสัปดาห์ที่ ${q.data.summary.first_shortfall_week} (${q.data.summary.first_shortfall_date})` : 'เงินสดเพียงพอตลอดช่วง'}
              />
              <StatCard
                label="สุขภาพการเงิน"
                value={`${q.data.health.score}/100 · ${q.data.health.grade}`}
                icon={HeartPulse}
                tone={GRADE_TONE[q.data.health.grade] ?? 'info'}
                hint={`เงินสดอยู่ได้ ~${q.data.health.days_cash_on_hand ?? '∞'} วัน · ค้างชำระลูกหนี้ ${q.data.health.overdue_ar_pct}%`}
              />
            </div>

            <Card className="mb-4 gap-3 p-4">
              <h3 className="text-sm font-semibold text-muted-foreground">เงินสดคงเหลือที่คาดการณ์ (รายสัปดาห์)</h3>
              <TrendAreaChart data={q.data.weekly} xKey="week_start" yKey="projected_balance" fmt={(v) => baht(v)} color={q.data.summary.min_projected_balance < 0 ? 'var(--destructive)' : 'var(--chart-1)'} />
            </Card>

            <Card className="gap-3 p-4">
              <h3 className="text-sm font-semibold text-muted-foreground">รายละเอียดรายสัปดาห์</h3>
              <DataTable
                rows={q.data.weekly}
                rowKey={(r: any) => r.week}
                columns={[
                  { key: 'week', label: 'สัปดาห์', render: (r: any) => `#${r.week} (${r.week_start})` },
                  { key: 'ar_inflow', label: 'รับจากลูกหนี้', align: 'right', render: (r: any) => baht(r.ar_inflow) },
                  { key: 'pos_inflow', label: 'ขาย POS', align: 'right', render: (r: any) => baht(r.pos_inflow) },
                  { key: 'ap_outflow', label: 'จ่ายเจ้าหนี้', align: 'right', render: (r: any) => <span className="text-destructive">−{baht(r.ap_outflow)}</span> },
                  { key: 'net', label: 'สุทธิ', align: 'right', render: (r: any) => <span className={r.net < 0 ? 'text-destructive' : 'text-success'}>{baht(r.net)}</span> },
                  { key: 'projected_balance', label: 'คงเหลือ', align: 'right', render: (r: any) => <strong className={r.projected_balance < 0 ? 'text-destructive' : ''}>{baht(r.projected_balance)}</strong> },
                ]}
              />
            </Card>
          </>
        )}
      </StateView>
    </div>
  );
}
