'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Lightbulb, AlertTriangle, PackagePlus, Sparkles, Gauge, TrendingDown } from 'lucide-react';
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

// ── API contract (apps/api/src/modules/analytics) ─────────────────────────────
interface Prediction {
  item_id: string; item_name: string; uom: string; current_stock: number; avg_daily_sales: number;
  lead_time_days: number; days_of_stock: number | null; predicted_stockout_date: string | null;
  reorder_point: number; urgency: 'critical' | 'warning' | 'ok'; confidence: string;
}
interface ReplResp { items: Prediction[]; count: number; critical: number; warning: number }
interface MovementAnomaly { item_id: string; item_name: string; movement_type: string; recent_qty: number; hist_avg: number; z_score: number; event_count: number; severity: 'critical' | 'warning' }
interface StocktakeVariance { item_id: string; item_name: string; stocktake_date: string | null; expected_qty: number; counted_qty: number; variance: number; variance_pct: number; severity: 'critical' | 'warning' }
interface AnomalyResp {
  movement_anomalies: MovementAnomaly[];
  stocktake_variances: StocktakeVariance[];
  summary: { total_anomalies: number; critical_count: number; warning_count: number; analysis_days: number; generated_at: string };
}
interface SummaryResp {
  replenishment: { critical: number; warning: number; top_items: Prediction[] };
  anomalies: { total_anomalies: number; critical_count: number; warning_count: number; analysis_days: number };
  insight: string;
}

const urgencyBadge = (u: string) =>
  u === 'critical' ? <Badge variant="destructive">วิกฤต</Badge> : u === 'warning' ? <Badge variant="warning">เฝ้าระวัง</Badge> : <Badge variant="success">ปกติ</Badge>;
const sevBadge = (s: string) => (s === 'critical' ? <Badge variant="destructive">วิกฤต</Badge> : <Badge variant="warning">เฝ้าระวัง</Badge>);

/** AI insight callout — renders the model's (or rule-based fallback) narrative text. */
function InsightCard({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="flex gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
      <Lightbulb className="mt-0.5 size-5 shrink-0 text-primary" />
      <p className="text-sm leading-relaxed whitespace-pre-line">{text}</p>
    </div>
  );
}

export default function InsightsWorkspace({ initialSummary }: { initialSummary?: unknown }) {
  return (
    <div>
      <PageHeader
        title="ข้อมูลเชิงลึก (Insights)"
        description="สรุปสัญญาณสำคัญจากข้อมูลจริง — สินค้าที่ควรเติมสต๊อก ความผิดปกติของการเคลื่อนไหว/การนับสต๊อก และคำแนะนำที่สรุปโดย AI"
      />
      <Tabs
        tabs={[
          { key: 'overview', label: 'ภาพรวม', content: <OverviewTab initialData={initialSummary} /> },
          { key: 'anomalies', label: 'ความผิดปกติ', content: <AnomaliesTab /> },
          { key: 'replenishment', label: 'เติมสต๊อก', content: <ReplenishmentTab /> },
        ]}
      />
    </div>
  );
}

function OverviewTab({ initialData }: { initialData?: unknown }) {
  const q = useQuery<SummaryResp>({ queryKey: ['insights-summary'], queryFn: () => api('/api/analytics/dashboard-summary'), initialData: (initialData as SummaryResp | undefined) ?? undefined });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="ต้องเติมสต๊อกด่วน" value={num(q.data.replenishment.critical)} icon={PackagePlus} tone="danger" />
            <StatCard label="ควรเฝ้าระวังสต๊อก" value={num(q.data.replenishment.warning)} tone="warning" />
            <StatCard label="ความผิดปกติ (7 วัน)" value={num(q.data.anomalies.total_anomalies)} icon={AlertTriangle} tone={q.data.anomalies.critical_count ? 'danger' : 'default'} hint={`วิกฤต ${num(q.data.anomalies.critical_count)}`} />
            <StatCard label="ระดับวิกฤตรวม" value={num(q.data.replenishment.critical + q.data.anomalies.critical_count)} icon={Gauge} tone="primary" />
          </div>

          <div>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground"><Sparkles className="size-4" /> สรุปโดย AI</h3>
            <InsightCard text={q.data.insight} />
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">สินค้าที่ควรเติมสต๊อกก่อน (Top 3)</h3>
            <DataTable
              rows={q.data.replenishment.top_items}
              rowKey={(r) => r.item_id}
              emptyText="ยังไม่มีสินค้าที่ต้องเติมสต๊อก"
              columns={[
                { key: 'item_name', label: 'สินค้า', render: (r) => <span className="font-medium">{r.item_name}</span> },
                { key: 'current_stock', label: 'คงเหลือ', align: 'right', render: (r) => <span className="tabular">{num(r.current_stock)} {r.uom}</span> },
                { key: 'days_of_stock', label: 'เหลือพอ (วัน)', align: 'right', render: (r) => <span className="tabular">{r.days_of_stock ?? '—'}</span> },
                { key: 'urgency', label: 'ระดับ', render: (r) => urgencyBadge(r.urgency) },
              ]}
            />
          </div>
        </div>
      )}
    </StateView>
  );
}

function AnomaliesTab() {
  const [days, setDays] = useState(30);
  const q = useQuery<AnomalyResp>({ queryKey: ['insights-anomalies', days], queryFn: () => api(`/api/analytics/anomalies?days=${days}`) });
  const [insight, setInsight] = useState<{ key: string; text: string } | null>(null);

  const askInsight = useMutation({
    mutationFn: (a: MovementAnomaly) =>
      api<{ insight: string }>('/api/analytics/insight', { method: 'POST', body: JSON.stringify({ type: 'anomaly', data: a }) }),
    onSuccess: (r, a) => setInsight({ key: a.item_id + a.movement_type, text: r.insight }),
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {[7, 30, 90].map((d) => (
          <Button key={d} variant={days === d ? 'default' : 'outline'} size="sm" onClick={() => setDays(d)}>
            {d} วัน
          </Button>
        ))}
      </div>

      <StateView q={q}>
        {q.data && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="ความผิดปกติทั้งหมด" value={num(q.data.summary.total_anomalies)} icon={AlertTriangle} tone="primary" />
              <StatCard label="ระดับวิกฤต" value={num(q.data.summary.critical_count)} tone="danger" />
              <StatCard label="เฝ้าระวัง" value={num(q.data.summary.warning_count)} tone="warning" />
            </div>

            {insight && <InsightCard text={insight.text} />}

            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">การเคลื่อนไหวสต๊อกผิดปกติ (Z-score)</h3>
              <DataTable
                rows={q.data.movement_anomalies}
                rowKey={(r) => r.item_id + r.movement_type}
                emptyState={{ icon: AlertTriangle, title: 'ไม่พบความผิดปกติของการเคลื่อนไหว', description: 'การเคลื่อนไหวสต๊อกในช่วงนี้อยู่ในเกณฑ์ปกติ' }}
                columns={[
                  { key: 'item_name', label: 'สินค้า', render: (r) => <span className="font-medium">{r.item_name}</span> },
                  { key: 'movement_type', label: 'ประเภท', render: (r) => <Badge variant="info">{r.movement_type}</Badge> },
                  { key: 'recent_qty', label: 'ล่าสุด', align: 'right', render: (r) => <span className="tabular">{num(r.recent_qty)}</span> },
                  { key: 'hist_avg', label: 'ค่าเฉลี่ยปกติ', align: 'right', render: (r) => <span className="tabular">{num(r.hist_avg)}</span> },
                  { key: 'z_score', label: 'Z-score', align: 'right', render: (r) => <span className="tabular">{r.z_score}</span> },
                  { key: 'severity', label: 'ระดับ', render: (r) => sevBadge(r.severity) },
                  {
                    key: '_ai',
                    label: 'AI',
                    sortable: false,
                    render: (r) => (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={askInsight.isPending}
                        onClick={() => askInsight.mutate(r)}
                      >
                        <Sparkles className="size-3.5" /> คำแนะนำ
                      </Button>
                    ),
                  },
                ]}
              />
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ผลต่างจากการนับสต๊อก (Stocktake variance)</h3>
              <DataTable
                rows={q.data.stocktake_variances}
                rowKey={(r) => r.item_id}
                emptyState={{ icon: TrendingDown, title: 'ไม่พบผลต่างผิดปกติ', description: 'การนับสต๊อกล่าสุดตรงกับระบบภายในเกณฑ์ที่ยอมรับได้' }}
                columns={[
                  { key: 'item_name', label: 'สินค้า', render: (r) => <span className="font-medium">{r.item_name}</span> },
                  { key: 'stocktake_date', label: 'วันที่นับ', render: (r) => thaiDate(r.stocktake_date) },
                  { key: 'expected_qty', label: 'ระบบ', align: 'right', render: (r) => <span className="tabular">{num(r.expected_qty)}</span> },
                  { key: 'counted_qty', label: 'นับได้', align: 'right', render: (r) => <span className="tabular">{num(r.counted_qty)}</span> },
                  { key: 'variance', label: 'ผลต่าง', align: 'right', render: (r) => <span className="tabular">{num(r.variance)}</span> },
                  { key: 'variance_pct', label: '%', align: 'right', render: (r) => <span className="tabular">{r.variance_pct}%</span> },
                  { key: 'severity', label: 'ระดับ', render: (r) => sevBadge(r.severity) },
                ]}
              />
            </div>
          </>
        )}
      </StateView>
    </div>
  );
}

function ReplenishmentTab() {
  const q = useQuery<ReplResp>({ queryKey: ['insights-repl'], queryFn: () => api('/api/analytics/replenishment?limit=100') });
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="รายการที่ควรเติม" value={num(q.data.count)} icon={PackagePlus} tone="primary" />
            <StatCard label="ด่วน (วิกฤต)" value={num(q.data.critical)} tone="danger" />
            <StatCard label="เฝ้าระวัง" value={num(q.data.warning)} tone="warning" />
          </div>
        )}
      </StateView>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.items}
            rowKey={(r) => r.item_id}
            onRowClick={(r) => setSelected((id) => (id === r.item_id ? null : r.item_id))}
            emptyState={{ icon: PackagePlus, title: 'ไม่มีสินค้าที่ต้องเติมสต๊อก', description: 'สต๊อกทุกตัวอยู่ในระดับที่เพียงพอตามยอดขายและ Lead Time' }}
            columns={[
              { key: 'item_name', label: 'สินค้า', render: (r) => <span className="font-medium">{r.item_name}</span> },
              { key: 'current_stock', label: 'คงเหลือ', align: 'right', render: (r) => <span className="tabular">{num(r.current_stock)} {r.uom}</span> },
              { key: 'avg_daily_sales', label: 'ขายเฉลี่ย/วัน', align: 'right', render: (r) => <span className="tabular">{num(r.avg_daily_sales)}</span> },
              { key: 'days_of_stock', label: 'เหลือพอ (วัน)', align: 'right', render: (r) => <span className="tabular">{r.days_of_stock ?? '—'}</span> },
              { key: 'lead_time_days', label: 'Lead time', align: 'right', render: (r) => <span className="tabular">{num(r.lead_time_days)}</span> },
              { key: 'reorder_point', label: 'จุดสั่งซื้อ', align: 'right', render: (r) => <span className="tabular">{num(r.reorder_point)}</span> },
              { key: 'predicted_stockout_date', label: 'คาดว่าหมด', render: (r) => thaiDate(r.predicted_stockout_date) },
              { key: 'urgency', label: 'ระดับ', render: (r) => urgencyBadge(r.urgency) },
            ]}
          />
        )}
      </StateView>

      {selected && <ReplItemDetail itemId={selected} />}
    </div>
  );
}

function ReplItemDetail({ itemId }: { itemId: string }) {
  const q = useQuery<Prediction & { insight: string }>({
    queryKey: ['insights-repl-item', itemId],
    queryFn: () => api(`/api/analytics/replenishment/${encodeURIComponent(itemId)}`),
  });
  return (
    <Card className="gap-4 border-primary/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4" /> คำแนะนำการเติมสต๊อก — {q.data?.item_name ?? itemId}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <StateView q={q}>
          {q.data && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard label="คงเหลือ" value={`${num(q.data.current_stock)} ${q.data.uom}`} tone="primary" />
                <StatCard label="ขายเฉลี่ย/วัน" value={num(q.data.avg_daily_sales)} />
                <StatCard label="จุดสั่งซื้อ" value={num(q.data.reorder_point)} tone="warning" />
                <StatCard label="คาดว่าหมด" value={q.data.predicted_stockout_date ? thaiDate(q.data.predicted_stockout_date) : '—'} tone={q.data.urgency === 'critical' ? 'danger' : 'default'} />
              </div>
              <InsightCard text={q.data.insight} />
            </div>
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}
