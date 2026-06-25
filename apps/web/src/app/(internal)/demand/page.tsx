'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { LineChart, FlaskConical, History, Target, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// ── API contract (apps/api/src/modules/demand-ml) ─────────────────────────────
interface Metrics { algorithm: string; wape: number; mase: number; rmse: number; bias: number; n_test: number }
interface ForecastResp {
  item_id: string; algorithm: string; selected_by: string; horizon: number; data_days: number;
  forecast: number[]; metrics: Metrics; candidates: Metrics[];
}
interface BacktestResp { item_id: string; data_days: number; test_size: number; candidates: Metrics[]; best: Metrics }
interface ForecastRow {
  itemId: string; algorithm: string; selectedBy: string; horizon: number; dataDays: number;
  wape: number; mase: number; rmse: number; bias: number; createdBy: string | null; createdAt: string;
}
interface AccuracyResp { runs: number; avg_wape: number | null; avg_mase: number | null; by_algorithm: { algorithm: string; runs: number; avg_wape: number | null }[] }

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

const ALGOS = ['', 'naive', 'moving_average', 'ses', 'holt', 'croston'];

export default function DemandPage() {
  return (
    <div>
      <PageHeader
        title="พยากรณ์ความต้องการ (Demand ML)"
        description="พยากรณ์ยอดขายรายสินค้าด้วยหลายอัลกอริทึม เลือกโมเดลที่แม่นที่สุดอัตโนมัติ (WAPE ต่ำสุด) — ต้องมีประวัติการขายอย่างน้อย 14 วัน"
      />
      <Tabs
        tabs={[
          { key: 'forecast', label: 'พยากรณ์', content: <ForecastTab /> },
          { key: 'backtest', label: 'เทียบโมเดล', content: <BacktestTab /> },
          { key: 'history', label: 'ประวัติ & ความแม่น', content: <HistoryTab /> },
        ]}
      />
    </div>
  );
}

function MetricsTable({ rows, best }: { rows: Metrics[]; best?: string }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.algorithm}
      emptyText="ไม่มีผลการประเมิน"
      columns={[
        {
          key: 'algorithm',
          label: 'อัลกอริทึม',
          render: (r) => (
            <span className="font-medium">
              {r.algorithm} {best === r.algorithm && <Badge variant="success" className="ml-1">ดีสุด</Badge>}
            </span>
          ),
        },
        { key: 'wape', label: 'WAPE', align: 'right', render: (r) => <span className="tabular">{pct(r.wape)}</span> },
        { key: 'mase', label: 'MASE', align: 'right', render: (r) => <span className="tabular">{r.mase?.toFixed(2)}</span> },
        { key: 'rmse', label: 'RMSE', align: 'right', render: (r) => <span className="tabular">{num(Math.round(r.rmse))}</span> },
        { key: 'bias', label: 'Bias', align: 'right', render: (r) => <span className="tabular">{r.bias?.toFixed(2)}</span> },
        { key: 'n_test', label: 'จุดทดสอบ', align: 'right', render: (r) => <span className="tabular">{num(r.n_test)}</span> },
      ]}
    />
  );
}

function ForecastTab() {
  const [itemId, setItemId] = useState('');
  const [horizon, setHorizon] = useState('14');
  const [algorithm, setAlgorithm] = useState('');

  const run = useMutation({
    mutationFn: () =>
      api<ForecastResp>('/api/demand/forecast', {
        method: 'POST',
        body: JSON.stringify({ item_id: itemId, horizon: Number(horizon) || 14, algorithm: algorithm || undefined }),
      }),
    onError: (e: any) => notifyError(e.message),
  });

  const r = run.data;

  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4">
        <CardHeader><CardTitle className="text-base">สร้างพยากรณ์</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="fc-item">รหัสสินค้า</Label>
              <Input id="fc-item" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="เช่น ITEM-001" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fc-h">จำนวนวันที่พยากรณ์</Label>
              <Input id="fc-h" type="number" min="1" max="90" value={horizon} onChange={(e) => setHorizon(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fc-algo">อัลกอริทึม</Label>
              <select id="fc-algo" className={selectCls} value={algorithm} onChange={(e) => setAlgorithm(e.target.value)}>
                {ALGOS.map((a) => <option key={a} value={a}>{a === '' ? 'เลือกอัตโนมัติ (แม่นสุด)' : a}</option>)}
              </select>
            </div>
          </div>
          <Button disabled={run.isPending || !itemId.trim()} onClick={() => run.mutate()}>
            <Sparkles className="size-4" /> {run.isPending ? 'กำลังพยากรณ์…' : 'พยากรณ์'}
          </Button>
        </CardContent>
      </Card>

      {r && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="โมเดลที่เลือก" value={r.algorithm} icon={LineChart} tone="primary" hint={r.selected_by === 'lowest_wape' ? 'เลือกอัตโนมัติ' : 'กำหนดเอง'} />
            <StatCard label="ความคลาดเคลื่อน (WAPE)" value={pct(r.metrics.wape)} tone="info" />
            <StatCard label="ข้อมูลที่ใช้ (วัน)" value={num(r.data_days)} tone="default" />
            <StatCard label="ยอดรวมที่พยากรณ์" value={num(Math.round(r.forecast.reduce((a, b) => a + b, 0)))} tone="success" hint={`${r.horizon} วัน`} />
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ค่าพยากรณ์รายวัน</h3>
            <DataTable
              rows={r.forecast.map((v, i) => ({ day: i + 1, qty: v }))}
              rowKey={(x) => x.day}
              pageSize={0}
              dense
              columns={[
                { key: 'day', label: 'วันที่ (จากวันนี้)', render: (x) => `วันที่ +${x.day}` },
                { key: 'qty', label: 'จำนวนที่พยากรณ์', align: 'right', render: (x) => <span className="tabular">{num(Math.round(x.qty))}</span> },
              ]}
            />
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">เปรียบเทียบโมเดลที่ทดสอบ</h3>
            <MetricsTable rows={r.candidates} best={r.algorithm} />
          </div>
        </div>
      )}
    </div>
  );
}

function BacktestTab() {
  const [itemId, setItemId] = useState('');
  const [testSize, setTestSize] = useState('7');

  const run = useMutation({
    mutationFn: () =>
      api<BacktestResp>('/api/demand/backtest', {
        method: 'POST',
        body: JSON.stringify({ item_id: itemId, test_size: Number(testSize) || undefined }),
      }),
    onError: (e: any) => notifyError(e.message),
  });

  const r = run.data;

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">ทดสอบย้อนหลัง (Backtest)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">เปรียบเทียบความแม่นของทุกอัลกอริทึมบนข้อมูลจริงโดยไม่บันทึกผล — ใช้เลือกโมเดลที่เหมาะกับสินค้าแต่ละตัว</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid grow gap-2">
              <Label htmlFor="bt-item">รหัสสินค้า</Label>
              <Input id="bt-item" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="เช่น ITEM-001" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bt-size">ขนาดชุดทดสอบ (วัน)</Label>
              <Input id="bt-size" type="number" min="1" value={testSize} onChange={(e) => setTestSize(e.target.value)} className="max-w-[160px]" />
            </div>
            <Button disabled={run.isPending || !itemId.trim()} onClick={() => run.mutate()}>
              <FlaskConical className="size-4" /> {run.isPending ? 'กำลังทดสอบ…' : 'ทดสอบ'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {r && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="โมเดลแนะนำ" value={r.best.algorithm} icon={Target} tone="success" />
            <StatCard label="WAPE (ดีสุด)" value={pct(r.best.wape)} tone="info" />
            <StatCard label="ข้อมูลที่ใช้ (วัน)" value={num(r.data_days)} tone="default" />
          </div>
          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ผลการทดสอบทุกโมเดล</h3>
            <MetricsTable rows={r.candidates} best={r.best.algorithm} />
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryTab() {
  const q = useQuery<{ count: number; forecasts: ForecastRow[] }>({ queryKey: ['demand-history'], queryFn: () => api('/api/demand/forecasts?limit=100') });
  const acc = useQuery<AccuracyResp>({ queryKey: ['demand-accuracy'], queryFn: () => api('/api/demand/accuracy') });

  return (
    <div className="space-y-5">
      <StateView q={acc}>
        {acc.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="จำนวนการพยากรณ์" value={num(acc.data.runs)} icon={History} tone="primary" />
            <StatCard label="WAPE เฉลี่ย" value={pct(acc.data.avg_wape)} tone="info" />
            <StatCard label="MASE เฉลี่ย" value={acc.data.avg_mase != null ? acc.data.avg_mase.toFixed(2) : '—'} tone="default" />
          </div>
        )}
      </StateView>

      {acc.data && acc.data.by_algorithm.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ความแม่นแยกตามอัลกอริทึม</h3>
          <DataTable
            rows={acc.data.by_algorithm}
            rowKey={(r) => r.algorithm}
            columns={[
              { key: 'algorithm', label: 'อัลกอริทึม', render: (r) => <span className="font-medium">{r.algorithm}</span> },
              { key: 'runs', label: 'จำนวนครั้ง', align: 'right', render: (r) => <span className="tabular">{num(r.runs)}</span> },
              { key: 'avg_wape', label: 'WAPE เฉลี่ย', align: 'right', render: (r) => <span className="tabular">{pct(r.avg_wape)}</span> },
            ]}
          />
        </div>
      )}

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ประวัติการพยากรณ์ล่าสุด</h3>
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.forecasts}
              rowKey={(_r, i) => i}
              emptyState={{ icon: History, title: 'ยังไม่มีประวัติการพยากรณ์', description: 'สร้างพยากรณ์จากแท็บ "พยากรณ์" แล้วผลจะถูกบันทึกไว้ที่นี่' }}
              columns={[
                { key: 'createdAt', label: 'เมื่อ', render: (r) => thaiDate(r.createdAt) },
                { key: 'itemId', label: 'สินค้า', render: (r) => <span className="font-medium">{r.itemId}</span> },
                { key: 'algorithm', label: 'โมเดล' },
                { key: 'horizon', label: 'ช่วง (วัน)', align: 'right', render: (r) => <span className="tabular">{num(r.horizon)}</span> },
                { key: 'wape', label: 'WAPE', align: 'right', render: (r) => <span className="tabular">{pct(r.wape)}</span> },
                { key: 'dataDays', label: 'ข้อมูล (วัน)', align: 'right', render: (r) => <span className="tabular">{num(r.dataDays)}</span> },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}
