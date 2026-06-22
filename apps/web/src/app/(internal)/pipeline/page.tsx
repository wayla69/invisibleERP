'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Target, TrendingUp, Layers } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { SimpleBarChart } from '@/components/charts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Msg } from '@/components/tabs';
import { statusVariant } from '@/components/ui';

// GET /api/pipeline/stages → BARE ARRAY of DB rows (camelCase)
interface Stage { id: number; name: string; sequence: number; defaultProbability: number; isWon: boolean; isLost: boolean }
// GET /api/pipeline/opportunities → { opportunities: [...], count }
interface Opp { id: number; opp_no: string; name: string; account_name: string | null; stage_id: number | null; stage_name: string | null; probability: number; expected_value: number; status: string; assigned_to: string | null; created_at: string }
// GET /api/pipeline/forecast → { by_stage: [...], total_pipeline, weighted_pipeline }
interface ForecastRow { stage: string; probability: number; count: number; total_value: number; weighted_value: number }
interface Forecast { by_stage: ForecastRow[]; total_pipeline: number; weighted_pipeline: number }

export default function PipelinePage() {
  const qc = useQueryClient();
  const stages = useQuery<Stage[]>({ queryKey: ['pipeline-stages'], queryFn: () => api('/api/pipeline/stages') });
  const opps = useQuery<{ opportunities: Opp[]; count: number }>({ queryKey: ['pipeline-opps'], queryFn: () => api('/api/pipeline/opportunities') });
  const forecast = useQuery<Forecast>({ queryKey: ['pipeline-forecast'], queryFn: () => api('/api/pipeline/forecast') });

  const [name, setName] = useState('');
  const [expectedValue, setExpectedValue] = useState('');
  const [stageName, setStageName] = useState('');

  // Map stage_id → name (list endpoint returns stage_name=null; resolve client-side)
  const stageById = new Map((stages.data ?? []).map((s) => [s.id, s.name]));

  const create = useMutation({
    mutationFn: () =>
      api('/api/pipeline/opportunities', {
        method: 'POST',
        body: JSON.stringify({
          name,
          expected_value: Number(expectedValue) || 0,
          stage_name: stageName || undefined,
        }),
      }),
    onSuccess: () => {
      setName(''); setExpectedValue(''); setStageName('');
      qc.invalidateQueries({ queryKey: ['pipeline-opps'] });
      qc.invalidateQueries({ queryKey: ['pipeline-forecast'] });
    },
  });

  const move = useMutation({
    mutationFn: (v: { id: number; stage_name: string }) =>
      api(`/api/pipeline/opportunities/${v.id}/move`, { method: 'POST', body: JSON.stringify({ stage_name: v.stage_name }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pipeline-opps'] });
      qc.invalidateQueries({ queryKey: ['pipeline-forecast'] });
    },
  });

  const selectCls =
    'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

  const chartData = (forecast.data?.by_stage ?? []).map((r) => ({ name: r.stage, weighted: r.weighted_value }));

  return (
    <div>
      <PageHeader title="โอกาสการขาย (Sales Pipeline)" description="ติดตามดีลตามขั้นตอน พยากรณ์ยอดขายแบบถ่วงน้ำหนัก" />

      <div className="space-y-6">
        {/* Forecast KPIs + chart */}
        <StateView q={forecast}>
          {forecast.data && (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label="มูลค่า Pipeline รวม" value={baht(forecast.data.total_pipeline)} icon={Layers} tone="primary" />
                <StatCard label="พยากรณ์ถ่วงน้ำหนัก" value={baht(forecast.data.weighted_pipeline)} icon={TrendingUp} tone="success" hint="ตามความน่าจะเป็นของแต่ละขั้น" />
                <StatCard label="ดีลที่เปิดอยู่" value={num((forecast.data.by_stage ?? []).reduce((s, r) => s + r.count, 0))} icon={Target} tone="info" />
              </div>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">พยากรณ์ถ่วงน้ำหนักตามขั้นตอน</CardTitle>
                </CardHeader>
                <CardContent>
                  {chartData.length ? (
                    <SimpleBarChart data={chartData} xKey="name" yKey="weighted" color="var(--chart-2)" fmt={(v) => baht(v)} />
                  ) : (
                    <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">ยังไม่มีดีลที่เปิดอยู่</div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </StateView>

        {/* Create opportunity */}
        <Card className="max-w-2xl gap-4">
          <CardHeader>
            <CardTitle className="text-base">สร้างโอกาสการขาย</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="opp-name">ชื่อดีล</Label>
                <Input id="opp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ดีล ABC Corp" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="opp-value">มูลค่าคาดการณ์ (฿)</Label>
                <Input id="opp-value" type="number" min="0" value={expectedValue} onChange={(e) => setExpectedValue(e.target.value)} placeholder="0" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="opp-stage">ขั้นตอน</Label>
                <select id="opp-stage" className={selectCls} value={stageName} onChange={(e) => setStageName(e.target.value)}>
                  <option value="">— ค่าเริ่มต้น (Prospect) —</option>
                  {(stages.data ?? []).map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={create.isPending || !name.trim()} onClick={() => create.mutate()}>
                <Plus className="size-4" /> {create.isPending ? 'กำลังบันทึก…' : 'สร้างดีล'}
              </Button>
            </div>
            {create.error && <Msg>{(create.error as Error).message}</Msg>}
            {!!create.data && <Msg ok>✅ สร้างดีลสำเร็จ: {(create.data as Opp).opp_no}</Msg>}
            {move.error && <Msg>{(move.error as Error).message}</Msg>}
          </CardContent>
        </Card>

        {/* Opportunities list */}
        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">โอกาสการขายทั้งหมด</h3>
          <StateView q={opps}>
            {opps.data && (
              <DataTable
                rows={opps.data.opportunities}
                columns={[
                  { key: 'opp_no', label: 'เลขที่' },
                  { key: 'name', label: 'ชื่อดีล' },
                  { key: 'account_name', label: 'ลูกค้า', render: (r: Opp) => r.account_name ?? '—' },
                  {
                    key: 'stage_id',
                    label: 'ขั้นตอน',
                    render: (r: Opp) => {
                      const label = r.stage_name ?? (r.stage_id != null ? stageById.get(r.stage_id) : null) ?? '—';
                      return <Badge variant={statusVariant(label)}>{label}</Badge>;
                    },
                  },
                  { key: 'probability', label: 'โอกาส (%)', align: 'right', render: (r: Opp) => <span className="tabular">{num(r.probability)}%</span> },
                  { key: 'expected_value', label: 'มูลค่า', align: 'right', render: (r: Opp) => <span className="tabular">{baht(r.expected_value)}</span> },
                  { key: 'status', label: 'สถานะ', render: (r: Opp) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                  { key: 'created_at', label: 'สร้างเมื่อ', render: (r: Opp) => thaiDate(r.created_at) },
                  {
                    key: 'move',
                    label: 'ย้ายขั้น',
                    sortable: false,
                    render: (r: Opp) => (
                      <select
                        className={selectCls}
                        defaultValue=""
                        disabled={move.isPending}
                        onChange={(e) => { if (e.target.value) move.mutate({ id: r.id, stage_name: e.target.value }); }}
                      >
                        <option value="">ย้ายไปยัง…</option>
                        {(stages.data ?? []).map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
                      </select>
                    ),
                  },
                ]}
              />
            )}
          </StateView>
        </div>
      </div>
    </div>
  );
}
