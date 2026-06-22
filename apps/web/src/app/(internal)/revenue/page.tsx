'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleDollarSign, Coins, PlayCircle, ScrollText } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

const currentPeriod = () => new Date().toISOString().slice(0, 7); // YYYY-MM

interface Schedule {
  schedule_no: string;
  source_ref: string | null;
  total_amount: number;
  start_period: string;
  end_period: string;
  months: number;
  status: string;
  recognized_amount: number;
  remaining_amount: number;
  deferral_journal_no: string | null;
}
interface SchedulesResp { schedules: Schedule[]; count: number }
interface DeferredResp {
  as_of: string | null;
  deferred_balance: number;
  gl_unearned: number;
  reconciled: boolean;
  by_schedule: { schedule_no: string; total: number; recognized: number; remaining: number }[];
}

export default function RevenuePage() {
  return (
    <div>
      <PageHeader
        title="รับรู้รายได้ (Revenue Recognition)"
        description="รายได้รอตัดบัญชี — รับเงินล่วงหน้าเข้าบัญชี 2400 แล้วทยอยรับรู้เป็นรายได้ 4000 แบบเส้นตรง"
      />
      <Tabs
        tabs={[
          { key: 'deferred', label: 'รายได้รอตัดบัญชี', content: <DeferredTab /> },
          { key: 'schedules', label: 'ตารางรับรู้', content: <SchedulesTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── รายได้รอตัดบัญชี + เดินรายการรับรู้ ─────────────────────────
function DeferredTab() {
  const qc = useQueryClient();
  const q = useQuery<DeferredResp>({ queryKey: ['rev-deferred'], queryFn: () => api('/api/revenue/deferred') });
  const [period, setPeriod] = useState(currentPeriod());
  const [msg, setMsg] = useState('');

  const recognize = useMutation({
    mutationFn: () =>
      api<{ period: string; recognized_count: number; total_recognized: number }>(
        `/api/revenue/recognize?period=${encodeURIComponent(period)}`,
        { method: 'POST' },
      ),
    onSuccess: (r) => {
      setMsg(`✅ รับรู้ ${r.recognized_count} รายการ · รวม ${baht(r.total_recognized)} (งวด ${r.period})`);
      qc.invalidateQueries({ queryKey: ['rev-deferred'] });
      qc.invalidateQueries({ queryKey: ['rev-schedules'] });
    },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">เดินรายการรับรู้รายได้ (Run Recognition)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="rev-period">งวด (YYYY-MM)</Label>
              <Input
                id="rev-period"
                className="max-w-[160px]"
                placeholder="2026-06"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
              />
            </div>
            <Button
              disabled={recognize.isPending || !/^\d{4}-\d{2}$/.test(period)}
              onClick={() => recognize.mutate()}
            >
              <PlayCircle className="size-4" /> {recognize.isPending ? 'กำลังรับรู้…' : 'รับรู้รายได้งวดนี้'}
            </Button>
          </div>
          <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="รายได้รอตัดบัญชี (คงเหลือ)" value={baht(q.data.deferred_balance)} icon={Coins} tone="primary" />
              <StatCard label="ยอดบัญชี 2400 (GL)" value={baht(q.data.gl_unearned)} icon={CircleDollarSign} />
              <StatCard
                label="กระทบยอด"
                value={<Badge variant={q.data.reconciled ? 'success' : 'destructive'}>{q.data.reconciled ? 'ตรงกัน' : 'ไม่ตรง'}</Badge>}
              />
            </div>
            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">แยกตามตารางรับรู้</h3>
              <DataTable
                rows={q.data.by_schedule}
                rowKey={(r) => r.schedule_no}
                columns={[
                  { key: 'schedule_no', label: 'เลขตาราง' },
                  { key: 'total', label: 'มูลค่ารวม', align: 'right', render: (r) => <span className="tabular">{baht(r.total)}</span> },
                  { key: 'recognized', label: 'รับรู้แล้ว', align: 'right', render: (r) => <span className="tabular">{baht(r.recognized)}</span> },
                  { key: 'remaining', label: 'คงเหลือ', align: 'right', render: (r) => <span className="tabular">{baht(r.remaining)}</span> },
                ]}
                emptyText="ยังไม่มีรายได้รอตัดบัญชี"
              />
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── ตารางรับรู้รายได้ ─────────────────────────
function SchedulesTab() {
  const q = useQuery<SchedulesResp>({ queryKey: ['rev-schedules'], queryFn: () => api('/api/revenue/schedules') });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="จำนวนตาราง" value={q.data.count} icon={ScrollText} tone="primary" />
            <StatCard
              label="มูลค่ารวม"
              value={baht(q.data.schedules.reduce((a, s) => a + s.total_amount, 0))}
              icon={Coins}
            />
            <StatCard
              label="รับรู้แล้ว"
              value={baht(q.data.schedules.reduce((a, s) => a + s.recognized_amount, 0))}
              tone="success"
            />
            <StatCard
              label="คงเหลือ (รอรับรู้)"
              value={baht(q.data.schedules.reduce((a, s) => a + s.remaining_amount, 0))}
              tone="warning"
            />
          </div>
          <DataTable
            rows={q.data.schedules}
            rowKey={(r) => r.schedule_no}
            columns={[
              { key: 'schedule_no', label: 'เลขตาราง', render: (r) => <span className="font-medium">{r.schedule_no}</span> },
              { key: 'source_ref', label: 'อ้างอิง', render: (r) => r.source_ref ?? '—' },
              { key: 'start_period', label: 'งวดเริ่ม' },
              { key: 'end_period', label: 'งวดสิ้นสุด' },
              { key: 'months', label: 'เดือน', align: 'right', render: (r) => <span className="tabular">{r.months}</span> },
              { key: 'total_amount', label: 'มูลค่ารวม', align: 'right', render: (r) => <span className="tabular">{baht(r.total_amount)}</span> },
              { key: 'recognized_amount', label: 'รับรู้แล้ว', align: 'right', render: (r) => <span className="tabular">{baht(r.recognized_amount)}</span> },
              { key: 'remaining_amount', label: 'คงเหลือ', align: 'right', render: (r) => <span className="tabular">{baht(r.remaining_amount)}</span> },
              { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            ]}
            emptyText="ยังไม่มีตารางรับรู้รายได้"
          />
        </div>
      )}
    </StateView>
  );
}
