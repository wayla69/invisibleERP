'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ListChecks, PieChart, PlayCircle, Tags, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { SimpleBarChart } from '@/components/charts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const currentPeriod = () => new Date().toISOString().slice(0, 7);

interface Segment { id: number; segment_type: string; code: string; name: string }
interface SegmentsResp { segments: Segment[]; count: number }
interface Rule { id: number; name: string; from_account_code: string; to_segment_type: string; driver: string }
interface RulesResp { rules: Rule[]; count: number }
interface ReportSeg {
  segment_type: string;
  code: string;
  name: string;
  allocated_costs: number;
  contribution_margin: number;
}
interface ReportResp {
  period: string;
  entity_net_income: number;
  segments: ReportSeg[];
  run_id: number | null;
}

export default function ProfitabilityPage() {
  return (
    <div>
      <PageHeader
        title="กำไรตามมิติ (Profitability)"
        description="วิเคราะห์กำไรส่วนเพิ่ม (contribution margin) ตามมิติธุรกิจ พร้อมการปันส่วนต้นทุนตามกฎ"
      />
      <Tabs
        tabs={[
          { key: 'report', label: 'รายงานกำไร', content: <ReportTab /> },
          { key: 'segments', label: 'มิติ (Segments)', content: <SegmentsTab /> },
          { key: 'rules', label: 'กฎการปันส่วน', content: <RulesTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── รายงานกำไรตามมิติ ─────────────────────────
function ReportTab() {
  const qc = useQueryClient();
  const [period, setPeriod] = useState(currentPeriod());
  const [segmentType, setSegmentType] = useState('');

  const q = useQuery<ReportResp>({
    queryKey: ['profit-report', period, segmentType],
    queryFn: () =>
      api(`/api/profitability/report?period=${encodeURIComponent(period)}${segmentType ? `&segment_type=${encodeURIComponent(segmentType)}` : ''}`),
    enabled: /^\d{4}-\d{2}$/.test(period),
  });

  const run = useMutation({
    mutationFn: () =>
      api<{ run_id: number; rules_applied: number; lines_created: number; status: string }>('/api/profitability/run', {
        method: 'POST',
        body: JSON.stringify({ period }),
      }),
    onSuccess: (r) => {
      notifySuccess(`ปันส่วนสำเร็จ (run #${r.run_id}) · ${r.rules_applied} กฎ · ${r.lines_created} รายการ`);
      qc.invalidateQueries({ queryKey: ['profit-report'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const chartData = q.data?.segments.map((s) => ({ name: s.name || s.code, margin: s.contribution_margin })) ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2">
          <Label htmlFor="profit-period">งวด (YYYY-MM)</Label>
          <Input id="profit-period" className="max-w-[160px]" placeholder="2026-06" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="profit-segtype">มิติ (เว้นว่าง = ทั้งหมด)</Label>
          <Input id="profit-segtype" className="max-w-[200px]" placeholder="เช่น branch, product" value={segmentType} onChange={(e) => setSegmentType(e.target.value)} />
        </div>
        <Button variant="outline" disabled={run.isPending || !/^\d{4}-\d{2}$/.test(period)} onClick={() => run.mutate()}>
          <PlayCircle className="size-4" /> {run.isPending ? 'กำลังปันส่วน…' : 'เดินปันส่วนต้นทุน'}
        </Button>
      </div>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                label="กำไรสุทธิ (กิจการ)"
                value={baht(q.data.entity_net_income)}
                icon={Wallet}
                tone={q.data.entity_net_income >= 0 ? 'success' : 'danger'}
              />
              <StatCard label="จำนวนมิติ" value={q.data.segments.length} icon={PieChart} tone="primary" />
              <StatCard
                label="ต้นทุนปันส่วนรวม"
                value={baht(q.data.segments.reduce((a, s) => a + s.allocated_costs, 0))}
                tone="warning"
                hint={q.data.run_id != null ? `อ้างอิงรอบปันส่วน #${q.data.run_id}` : 'ยังไม่มีรอบปันส่วน'}
              />
            </div>

            {chartData.length > 0 && (
              <Card className="gap-4 p-5">
                <CardHeader className="p-0">
                  <CardTitle className="text-base">กำไรส่วนเพิ่มตามมิติ (Contribution Margin)</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <SimpleBarChart data={chartData} xKey="name" yKey="margin" fmt={(v) => baht(v)} />
                </CardContent>
              </Card>
            )}

            <DataTable
              rows={q.data.segments}
              rowKey={(r) => `${r.segment_type}-${r.code}`}
              columns={[
                { key: 'segment_type', label: 'มิติ' },
                { key: 'code', label: 'รหัส' },
                { key: 'name', label: 'ชื่อ', render: (r) => <span className="font-medium">{r.name}</span> },
                { key: 'allocated_costs', label: 'ต้นทุนปันส่วน', align: 'right', render: (r) => <span className="tabular">{baht(r.allocated_costs)}</span> },
                {
                  key: 'contribution_margin',
                  label: 'กำไรส่วนเพิ่ม',
                  align: 'right',
                  render: (r) => (
                    <span className={`tabular ${r.contribution_margin < 0 ? 'font-semibold text-destructive' : ''}`}>{baht(r.contribution_margin)}</span>
                  ),
                },
              ]}
              emptyState={
                segmentType
                  ? {
                      icon: PieChart,
                      title: 'ไม่พบมิติที่ตรงกับตัวกรอง',
                      description: 'ไม่มีมิติประเภทนี้ในงวดที่เลือก ลองล้างตัวกรองเพื่อดูทุกมิติ',
                      action: (
                        <Button variant="outline" size="sm" onClick={() => setSegmentType('')}>
                          ล้างตัวกรอง
                        </Button>
                      ),
                    }
                  : {
                      icon: PieChart,
                      title: 'ยังไม่มีมิติสำหรับงวดนี้',
                      description: 'กด “เดินปันส่วนต้นทุน” เพื่อปันส่วนต้นทุนและสร้างรายงานกำไรตามมิติ',
                    }
              }
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── มิติ (segments) ─────────────────────────
function SegmentsTab() {
  const q = useQuery<SegmentsResp>({ queryKey: ['profit-segments'], queryFn: () => api('/api/profitability/segments') });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard label="จำนวนมิติ" value={q.data.count} icon={Tags} tone="primary" />
          </div>
          <DataTable
            rows={q.data.segments}
            rowKey={(r) => r.id}
            columns={[
              { key: 'segment_type', label: 'ประเภทมิติ' },
              { key: 'code', label: 'รหัส', render: (r) => <span className="font-medium">{r.code}</span> },
              { key: 'name', label: 'ชื่อ' },
            ]}
            emptyState={{
              icon: Tags,
              title: 'ยังไม่มีมิติ',
              description: 'เพิ่มมิติธุรกิจ (เช่น สาขา ผลิตภัณฑ์) เพื่อใช้ในการปันส่วนต้นทุนและวิเคราะห์กำไร',
            }}
          />
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── กฎการปันส่วน ─────────────────────────
function RulesTab() {
  const q = useQuery<RulesResp>({ queryKey: ['profit-rules'], queryFn: () => api('/api/profitability/rules') });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard label="จำนวนกฎ" value={q.data.count} icon={PieChart} tone="primary" />
          </div>
          <DataTable
            rows={q.data.rules}
            rowKey={(r) => r.id}
            columns={[
              { key: 'name', label: 'ชื่อกฎ', render: (r) => <span className="font-medium">{r.name}</span> },
              { key: 'from_account_code', label: 'จากบัญชี' },
              { key: 'to_segment_type', label: 'ปันสู่มิติ' },
              { key: 'driver', label: 'วิธีปันส่วน' },
            ]}
            emptyState={{
              icon: ListChecks,
              title: 'ยังไม่มีกฎการปันส่วน',
              description: 'สร้างกฎการปันส่วนเพื่อกระจายต้นทุนจากบัญชีไปยังมิติธุรกิจตามตัวขับ',
            }}
          />
        </div>
      )}
    </StateView>
  );
}
