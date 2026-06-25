'use client';

import { useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { BarChart3, Clock, ShieldAlert, Users, TrendingUp, Soup } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { SimpleBarChart } from '@/components/charts';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

// Business-day (Asia/Bangkok) today, as YYYY-MM-DD.
function bkkToday(): string {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
const pct = (v: unknown) => `${Number(v ?? 0).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

const QUADRANT: Record<string, 'success' | 'warning' | 'info' | 'muted'> = {
  Star: 'success', Plowhorse: 'warning', Puzzle: 'info', Dog: 'muted',
};
const AVAIL: Record<string, 'success' | 'warning' | 'destructive' | 'muted'> = {
  ok: 'success', low: 'warning', out: 'destructive', unknown: 'muted',
};

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">{children}</div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="gap-3 p-4">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      {children}
    </Card>
  );
}

export default function RestaurantAnalyticsPage() {
  const [from, setFrom] = useState(bkkToday());
  const [to, setTo] = useState(bkkToday());
  const win = `from=${from}&to=${to}`;
  const useReport = <T,>(key: string, url: string): UseQueryResult<T> =>
    useQuery<T>({ queryKey: [key, from, to], queryFn: () => api<T>(url) });

  return (
    <div>
      <PageHeader
        title="วิเคราะห์ร้านอาหาร (Restaurant analytics)"
        description="Menu engineering · ช่วงเวลาขายดี · การยกเลิก/ส่วนลด · พนักงาน · แนวโน้ม · ความพร้อมเมนู"
        actions={
          <div className="flex items-end gap-2">
            <div className="grid gap-1"><Label htmlFor="from" className="text-xs">ตั้งแต่</Label><Input id="from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" /></div>
            <div className="grid gap-1"><Label htmlFor="to" className="text-xs">ถึง</Label><Input id="to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" /></div>
          </div>
        }
      />
      <Tabs
        tabs={[
          { key: 'menu', label: 'Menu engineering', content: <MenuEngineering url={`/api/analytics/menu-engineering?${win}`} /> },
          { key: 'daypart', label: 'ช่วงเวลาขายดี', content: <Daypart url={`/api/analytics/daypart?${win}`} /> },
          { key: 'voids', label: 'ยกเลิก/ส่วนลด', content: <Voids url={`/api/analytics/voids-discounts?${win}`} /> },
          { key: 'staff', label: 'พนักงาน', content: <Staff url={`/api/analytics/staff-performance?${win}`} /> },
          { key: 'trend', label: 'แนวโน้ม', content: <Trend url={`/api/analytics/sales-trend?${win}`} /> },
          { key: 'avail', label: 'ความพร้อมเมนู', content: <Availability /> },
        ]}
      />
    </div>
  );

  // ── Menu engineering matrix ──
  function MenuEngineering({ url }: { url: string }) {
    const q = useReport<any>('me', url);
    return (
      <StateView q={q}>
        {q.data && (
          <>
            <Grid>
              <StatCard label="เมนูที่ขาย" value={num(q.data.summary.items)} icon={BarChart3} />
              <StatCard label="จำนวนที่ขาย" value={num(q.data.summary.units_sold)} />
              <StatCard label="กำไรส่วนเพิ่มรวม" value={baht(q.data.summary.total_contribution)} tone="success" />
              <StatCard label="⭐ Star" value={num(q.data.summary.stars)} tone="success" />
              <StatCard label="🐴 Plowhorse" value={num(q.data.summary.plowhorses)} tone="warning" />
              <StatCard label="❓ Puzzle / 🐶 Dog" value={`${num(q.data.summary.puzzles)} / ${num(q.data.summary.dogs)}`} tone="info" />
            </Grid>
            <Section title="เมนูจัดกลุ่มตามความนิยม × กำไร (70% rule × contribution margin)">
              <DataTable
                rows={q.data.items}
                rowKey={(r: any) => r.item_id}
                emptyState={{ icon: BarChart3, title: 'ไม่มีเมนูที่ขายในช่วงนี้', description: 'ปรับช่วงวันที่ด้านบนให้ครอบคลุมวันที่มีการขาย แล้วดูใหม่' }}
                columns={[
                  { key: 'name', label: 'เมนู' },
                  { key: 'quadrant', label: 'กลุ่ม', render: (r: any) => <Badge variant={QUADRANT[r.quadrant] ?? 'muted'}>{r.quadrant_th} ({r.quadrant})</Badge> },
                  { key: 'qty', label: 'ขาย', align: 'right', render: (r: any) => num(r.qty) },
                  { key: 'mix_share', label: 'สัดส่วน', align: 'right', render: (r: any) => pct(Number(r.mix_share) * 100) },
                  { key: 'unit_margin', label: 'กำไร/จาน', align: 'right', render: (r: any) => baht(r.unit_margin) },
                  { key: 'contribution', label: 'กำไรรวม', align: 'right', render: (r: any) => baht(r.contribution) },
                  { key: 'action', label: 'คำแนะนำ', render: (r: any) => <span className="text-xs text-muted-foreground">{r.action_th}</span> },
                ]}
              />
            </Section>
          </>
        )}
      </StateView>
    );
  }

  // ── Daypart / busiest hours ──
  function Daypart({ url }: { url: string }) {
    const q = useReport<any>('daypart', url);
    return (
      <StateView q={q}>
        {q.data && (
          <>
            <Grid>
              <StatCard label="ยอดขาย" value={baht(q.data.summary.revenue)} tone="success" icon={Clock} />
              <StatCard label="จำนวนบิล" value={num(q.data.summary.txns)} />
              <StatCard label="บิลเฉลี่ย" value={baht(q.data.summary.avg_ticket)} />
              <StatCard label="ชั่วโมงพีก" value={q.data.summary.peak_hour != null ? `${q.data.summary.peak_hour}:00` : '—'} tone="info" />
              <StatCard label="ช่วงพีก" value={q.data.by_daypart.find((d: any) => d.daypart === q.data.summary.peak_daypart)?.label_th ?? '—'} tone="info" />
            </Grid>
            <Section title="ยอดขายรายชั่วโมง (เวลาไทย)">
              <SimpleBarChart data={q.data.by_hour.filter((h: any) => h.revenue > 0)} xKey="hour" yKey="revenue" fmt={(v) => baht(v)} />
            </Section>
            <Section title="ตามช่วงเวลา">
              <DataTable
                rows={q.data.by_daypart}
                rowKey={(r: any) => r.daypart}
                emptyState={{ icon: Clock, title: 'ไม่มียอดขายในช่วงนี้', description: 'ปรับช่วงวันที่ด้านบนให้ครอบคลุมวันที่มีการขาย แล้วดูใหม่' }}
                columns={[
                  { key: 'label_th', label: 'ช่วง' },
                  { key: 'revenue', label: 'ยอดขาย', align: 'right', render: (r: any) => baht(r.revenue) },
                  { key: 'txns', label: 'บิล', align: 'right', render: (r: any) => num(r.txns) },
                  { key: 'avg_ticket', label: 'บิลเฉลี่ย', align: 'right', render: (r: any) => baht(r.avg_ticket) },
                ]}
              />
            </Section>
          </>
        )}
      </StateView>
    );
  }

  // ── Voids / discounts ──
  function Voids({ url }: { url: string }) {
    const q = useReport<any>('voids', url);
    return (
      <StateView q={q}>
        {q.data && (
          <>
            <Grid>
              <StatCard label="เหตุการณ์" value={num(q.data.summary.events)} icon={ShieldAlert} />
              <StatCard label="ยกเลิก (ครั้ง)" value={num(q.data.summary.void_count)} tone="danger" />
              <StatCard label="อัตรายกเลิก" value={pct(q.data.summary.void_rate_pct)} tone="warning" />
              <StatCard label="ส่วนลดรวม" value={baht(q.data.summary.discount_amount)} />
            </Grid>
            <Section title="ตามเหตุผล">
              <DataTable rows={q.data.by_reason} rowKey={(r: any, i) => r.reason_code + i} emptyState={{ icon: ShieldAlert, title: 'ไม่มีการยกเลิก/ส่วนลดในช่วงนี้', description: 'ปรับช่วงวันที่ด้านบน หากต้องการดูข้อมูลช่วงอื่น' }} columns={[
                { key: 'reason_code', label: 'เหตุผล' },
                { key: 'count', label: 'ครั้ง', align: 'right', render: (r: any) => num(r.count) },
                { key: 'amount', label: 'มูลค่า', align: 'right', render: (r: any) => baht(r.amount) },
              ]} />
            </Section>
            <Section title="ตามพนักงาน">
              <DataTable rows={q.data.by_actor} rowKey={(r: any, i) => r.requested_by + i} emptyState={{ icon: ShieldAlert, title: 'ไม่มีการยกเลิก/ส่วนลดในช่วงนี้', description: 'ปรับช่วงวันที่ด้านบน หากต้องการดูข้อมูลช่วงอื่น' }} columns={[
                { key: 'requested_by', label: 'พนักงาน' },
                { key: 'count', label: 'ครั้ง', align: 'right', render: (r: any) => num(r.count) },
                { key: 'amount', label: 'มูลค่า', align: 'right', render: (r: any) => baht(r.amount) },
              ]} />
            </Section>
          </>
        )}
      </StateView>
    );
  }

  // ── Staff performance ──
  function Staff({ url }: { url: string }) {
    const q = useReport<any>('staff', url);
    return (
      <StateView q={q}>
        {q.data && (
          <>
            <Grid>
              <StatCard label="พนักงาน" value={num(q.data.summary.staff)} icon={Users} />
              <StatCard label="ยอดขายรวม" value={baht(q.data.summary.revenue)} tone="success" />
              <StatCard label="จำนวนบิล" value={num(q.data.summary.sales)} />
            </Grid>
            <Section title="ผลงานพนักงาน (เรียงตามยอดขาย)">
              <DataTable rows={q.data.staff} rowKey={(r: any) => r.staff} emptyState={{ icon: Users, title: 'ไม่มีข้อมูลพนักงานในช่วงนี้', description: 'ปรับช่วงวันที่ด้านบนให้ครอบคลุมวันที่มีการขาย แล้วดูใหม่' }} columns={[
                { key: 'staff', label: 'พนักงาน' },
                { key: 'sales', label: 'บิล', align: 'right', render: (r: any) => num(r.sales) },
                { key: 'revenue', label: 'ยอดขาย', align: 'right', render: (r: any) => baht(r.revenue) },
                { key: 'avg_ticket', label: 'บิลเฉลี่ย', align: 'right', render: (r: any) => baht(r.avg_ticket) },
                { key: 'voids', label: 'ยกเลิก', align: 'right', render: (r: any) => `${num(r.voids)} (${baht(r.void_amount)})` },
                { key: 'discounts', label: 'ส่วนลด', align: 'right', render: (r: any) => `${num(r.discounts)} (${baht(r.discount_amount)})` },
              ]} />
            </Section>
          </>
        )}
      </StateView>
    );
  }

  // ── Sales trend vs prior window ──
  function Trend({ url }: { url: string }) {
    const q = useReport<any>('trend', url);
    return (
      <StateView q={q}>
        {q.data && (
          <Grid>
            <StatCard
              label="ยอดขาย (ช่วงนี้)"
              value={baht(q.data.current.revenue)}
              icon={TrendingUp}
              tone="success"
              trend={{ value: pct(q.data.revenue_delta_pct), direction: Number(q.data.revenue_delta) >= 0 ? 'up' : 'down' }}
              hint={`ช่วงก่อน ${baht(q.data.previous.revenue)} (${q.data.previous.from} – ${q.data.previous.to})`}
            />
            <StatCard label="จำนวนบิล" value={num(q.data.current.txns)} hint={`${q.data.txn_delta >= 0 ? '+' : ''}${num(q.data.txn_delta)} vs ช่วงก่อน`} />
            <StatCard label="บิลเฉลี่ย" value={baht(q.data.current.avg_ticket)} hint={`${q.data.avg_ticket_delta >= 0 ? '+' : ''}${baht(q.data.avg_ticket_delta)} vs ช่วงก่อน`} />
            <StatCard label="ช่วงเวลา" value={`${q.data.window_days} วัน`} />
          </Grid>
        )}
      </StateView>
    );
  }

  // ── Menu availability forecast (servings remaining) ── (current stock, not date-windowed)
  function Availability() {
    const q = useQuery<any>({ queryKey: ['availability'], queryFn: () => api('/api/menu/availability/forecast?low=5') });
    return (
      <StateView q={q}>
        {q.data && (
          <>
            <Grid>
              <StatCard label="เมนู (มีสูตร)" value={num(q.data.summary.dishes)} icon={Soup} />
              <StatCard label="หมด (ควร 86)" value={num(q.data.summary.out)} tone="danger" />
              <StatCard label="ใกล้หมด" value={num(q.data.summary.low)} tone="warning" />
              <StatCard label="พร้อมขาย" value={num(q.data.summary.ok)} tone="success" />
              <StatCard label="วัตถุดิบใกล้หมด" value={num(q.data.summary.low_ingredients)} tone="warning" />
            </Grid>
            <Section title="ทำได้อีกกี่จาน (จากวัตถุดิบที่จำกัดที่สุด)">
              <DataTable rows={q.data.items} rowKey={(r: any) => r.sku} emptyState={{ icon: Soup, title: 'ยังไม่มีเมนูที่มีสูตร', description: 'เพิ่มสูตร/BoM ให้เมนู เพื่อให้ระบบคำนวณจำนวนที่ทำได้จากวัตถุดิบคงเหลือ' }} columns={[
                { key: 'name', label: 'เมนู' },
                { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={AVAIL[r.status] ?? 'muted'}>{r.status}</Badge> },
                { key: 'servings_left', label: 'ทำได้อีก', align: 'right', render: (r: any) => (r.servings_left == null ? '—' : num(r.servings_left)) },
                { key: 'limiting', label: 'วัตถุดิบที่จำกัด', render: (r: any) => r.limiting_ingredient ? `${r.limiting_ingredient.description ?? r.limiting_ingredient.item_id} (${num(r.limiting_ingredient.stock)})` : '—' },
              ]} />
            </Section>
            {q.data.low_ingredients.length > 0 && (
              <Section title="วัตถุดิบใกล้/ถึงจุดสั่งซื้อ">
                <DataTable rows={q.data.low_ingredients} rowKey={(r: any) => r.item_id} columns={[
                  { key: 'description', label: 'วัตถุดิบ', render: (r: any) => r.description ?? r.item_id },
                  { key: 'stock', label: 'คงเหลือ', align: 'right', render: (r: any) => num(r.stock) },
                  { key: 'reorder_point', label: 'จุดสั่งซื้อ', align: 'right', render: (r: any) => num(r.reorder_point) },
                ]} />
              </Section>
            )}
          </>
        )}
      </StateView>
    );
  }
}
