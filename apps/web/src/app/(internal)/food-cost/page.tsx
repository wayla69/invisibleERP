'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Utensils, Percent, TrendingUp, AlertTriangle, Scale } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface MarginItem { sku: string; name: string; price: number; cost: number; margin: number; margin_pct: number; food_cost_pct: number; has_recipe: boolean; costed: boolean }
interface FoodCost { target_pct: number; summary: { items: number; costed: number; uncosted: number; avg_food_cost_pct: number; over_target: number }; items: MarginItem[] }
interface Ingredient { ingredient_item_id: string; description: string | null; cost: number; recipes_using: number }
interface VarItem { item_id: string; description: string | null; unit_cost: number; theoretical_use: number; actual_use: number; variance_qty: number; theoretical_cost: number; actual_cost: number; variance_cost: number; variance_pct: number; anomaly: string }
interface Variance { from: string; to: string; summary: { items: number; theoretical_cost: number; actual_cost: number; variance_cost: number; variance_pct: number; unfavorable_cost: number; favorable_cost: number; anomalies: number }; items: VarItem[] }

export default function FoodCostPage() {
  return (
    <div>
      <PageHeader title="ต้นทุนอาหาร & กำไรต่อจาน (Food cost)" description="ต้นทุนตามสูตร เทียบราคาขาย — มาร์จิน % ต่อเมนู, วัตถุดิบที่ดันต้นทุน และส่วนต่างต้นทุนจริง" />
      <Tabs tabs={[
        { key: 'menu', label: 'กำไรต่อเมนู', content: <Margins /> },
        { key: 'ingredients', label: 'ต้นทุนวัตถุดิบ', content: <Ingredients /> },
        { key: 'variance', label: 'ส่วนต่าง (จริง vs ทฤษฎี)', content: <VarianceTab /> },
      ]} />
    </div>
  );
}

function VarianceTab() {
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() + 7 * 3600 * 1000 - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const q = useQuery<Variance>({ queryKey: ['food-variance', from, to], queryFn: () => api(`/api/menu/food-cost/variance?from=${from}&to=${to}`) });
  const s = q.data?.summary;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div><Label>ตั้งแต่</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" /></div>
        <div><Label>ถึง</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" /></div>
      </div>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="ต้นทุนตามทฤษฎี" value={baht(s?.theoretical_cost ?? 0)} icon={Utensils} tone="primary" hint="ตามสูตร × ยอดขาย" />
              <StatCard label="ส่วนต่างสุทธิ" value={baht(s?.variance_cost ?? 0)} icon={Scale} tone={(s?.variance_cost ?? 0) > 0 ? 'danger' : 'success'} hint={`${s?.variance_pct ?? 0}% ของทฤษฎี`} />
              <StatCard label="ส่วนเกิน (ขาดทุน)" value={baht(s?.unfavorable_cost ?? 0)} icon={AlertTriangle} tone={(s?.unfavorable_cost ?? 0) > 0 ? 'warning' : 'default'} hint="ใช้เกินสูตร (ของเสีย/ตัก)" />
              <StatCard label="รายการผิดปกติ" value={num(s?.anomalies ?? 0)} icon={TrendingUp} tone={(s?.anomalies ?? 0) > 0 ? 'danger' : 'default'} />
            </div>
            <DataTable
              rows={q.data.items}
              rowKey={(r) => r.item_id}
              columns={[
                { key: 'item_id', label: 'วัตถุดิบ', render: (r) => <span>{r.description ?? r.item_id}</span> },
                { key: 'theoretical_use', label: 'ใช้ตามสูตร', align: 'right', render: (r) => num(r.theoretical_use) },
                { key: 'actual_use', label: 'ใช้จริง', align: 'right', render: (r) => num(r.actual_use) },
                { key: 'variance_qty', label: 'ส่วนต่าง', align: 'right', render: (r) => <span className="tabular">{r.variance_qty}</span> },
                { key: 'variance_cost', label: 'ส่วนต่าง (฿)', align: 'right', render: (r) => <span className={r.variance_cost > 0 ? 'text-destructive tabular' : 'text-success tabular'}>{baht(r.variance_cost)}</span> },
                { key: 'variance_pct', label: '% ', align: 'right', render: (r) => <Badge variant={r.anomaly === 'High' ? 'destructive' : r.anomaly === 'Medium' ? 'warning' : 'muted'}>{r.variance_pct}%</Badge> },
              ]}
              emptyText="ยังไม่มีข้อมูลการนับสต๊อก (EOD count) ในช่วงนี้"
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

function Margins() {
  const q = useQuery<FoodCost>({ queryKey: ['food-cost'], queryFn: () => api('/api/menu/food-cost') });
  const s = q.data?.summary;
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="เมนูทั้งหมด" value={num(s?.items ?? 0)} icon={Utensils} tone="primary" hint={`คิดต้นทุนแล้ว ${num(s?.costed ?? 0)} · ยังไม่คิด ${num(s?.uncosted ?? 0)}`} />
            <StatCard label="ต้นทุนอาหารเฉลี่ย" value={`${s?.avg_food_cost_pct ?? 0}%`} icon={Percent} tone={(s?.avg_food_cost_pct ?? 0) > (q.data.target_pct) ? 'warning' : 'success'} hint={`เป้าหมาย ≤ ${q.data.target_pct}%`} />
            <StatCard label="เกินเป้าต้นทุน" value={num(s?.over_target ?? 0)} icon={AlertTriangle} tone={(s?.over_target ?? 0) > 0 ? 'danger' : 'default'} hint={`> ${q.data.target_pct}% food cost`} />
            <StatCard label="เมนูคิดต้นทุนแล้ว" value={num(s?.costed ?? 0)} icon={TrendingUp} tone="info" />
          </div>
          <DataTable
            rows={q.data.items}
            rowKey={(r) => r.sku}
            columns={[
              { key: 'name', label: 'เมนู', render: (r) => <span>{r.name}{!r.costed && <Badge variant="muted" className="ml-2 text-[10px]">ยังไม่คิดต้นทุน</Badge>}</span> },
              { key: 'price', label: 'ราคาขาย', align: 'right', render: (r) => <span className="tabular">{baht(r.price)}</span> },
              { key: 'cost', label: 'ต้นทุน', align: 'right', render: (r) => <span className="tabular">{baht(r.cost)}</span> },
              { key: 'margin', label: 'กำไร', align: 'right', render: (r) => <span className="tabular">{baht(r.margin)}</span> },
              { key: 'food_cost_pct', label: 'ต้นทุน %', align: 'right', render: (r) => <Badge variant={r.food_cost_pct > q.data!.target_pct ? 'destructive' : r.costed ? 'success' : 'muted'}>{r.food_cost_pct}%</Badge> },
              { key: 'margin_pct', label: 'มาร์จิน %', align: 'right', render: (r) => <span className="tabular">{r.margin_pct}%</span> },
            ]}
            emptyText="ยังไม่มีเมนู"
          />
        </div>
      )}
    </StateView>
  );
}

function Ingredients() {
  const q = useQuery<{ ingredients: Ingredient[] }>({ queryKey: ['ingredient-cost'], queryFn: () => api('/api/menu/ingredient-cost') });
  return (
    <StateView q={q}>
      <DataTable
        rows={q.data?.ingredients ?? []}
        rowKey={(r) => r.ingredient_item_id}
        columns={[
          { key: 'ingredient_item_id', label: 'วัตถุดิบ' },
          { key: 'description', label: 'รายละเอียด', render: (r) => r.description ?? '—' },
          { key: 'recipes_using', label: 'ใช้ในสูตร', align: 'right', render: (r) => num(r.recipes_using) },
          { key: 'cost', label: 'ต้นทุนรวม/เสิร์ฟ', align: 'right', render: (r) => <span className="tabular">{baht(r.cost)}</span> },
        ]}
        emptyText="ยังไม่มีสูตร/วัตถุดิบ"
      />
    </StateView>
  );
}
