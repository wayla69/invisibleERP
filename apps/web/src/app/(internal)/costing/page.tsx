'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, Coins, ShieldCheck, Save, Boxes } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
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

const methodVariant = (m: string) =>
  m === 'FIFO' ? 'info' : m === 'AVG' ? 'secondary' : m === 'STD' ? 'warning' : 'muted';

export default function CostingPage() {
  return (
    <div>
      <PageHeader
        title="ต้นทุนสินค้า (Inventory Costing)"
        description="วิธีคิดต้นทุน FIFO / AVG / STD แบบ opt-in ต่อรายการ และมูลค่าสต็อกที่กระทบกับบัญชี 1200"
      />
      <Tabs
        tabs={[
          { key: 'valuation', label: 'มูลค่าสต็อก (Valuation)', content: <ValuationTab /> },
          { key: 'config', label: 'ตั้งค่าวิธีคิดต้นทุน', content: <ConfigTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Valuation ─────────────────────────
function ValuationTab() {
  const q = useQuery<any>({ queryKey: ['costing-valuation'], queryFn: () => api('/api/costing/valuation') });
  const items: any[] = q.data?.items ?? [];

  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="มูลค่าสต็อกรวม" value={baht(q.data.total_value)} icon={Coins} tone="primary" />
            <StatCard label="ยอดบัญชี 1200 (GL)" value={baht(q.data.gl_1200)} icon={Calculator} tone="info" />
            <StatCard label="จำนวนรายการ" value={num(items.length)} icon={Boxes} tone="default" />
            <StatCard
              label="กระทบยอดกับ GL"
              value={<Badge variant={q.data.ties ? 'success' : 'destructive'}>{q.data.ties ? 'ตรงกัน' : 'ไม่ตรง'}</Badge>}
              icon={ShieldCheck}
              tone={q.data.ties ? 'success' : 'danger'}
            />
          </div>
          <DataTable
            rows={items}
            columns={[
              { key: 'item_id', label: 'รหัสสินค้า' },
              { key: 'method', label: 'วิธีคิดต้นทุน', render: (r: any) => <Badge variant={methodVariant(r.method)}>{r.method}</Badge> },
              { key: 'qty', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{num(r.qty)}</span> },
              { key: 'unit_cost', label: 'ต้นทุน/หน่วย', align: 'right', render: (r: any) => <span className="tabular">{baht(r.unit_cost)}</span> },
              { key: 'value', label: 'มูลค่า', align: 'right', render: (r: any) => <span className="tabular">{baht(r.value)}</span> },
            ]}
            emptyText="ยังไม่มีรายการที่ตั้งค่าวิธีคิดต้นทุน"
          />
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── Config ─────────────────────────
function ConfigTab() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['costing-config'], queryFn: () => api('/api/costing/config') });

  const [itemId, setItemId] = useState('');
  const [method, setMethod] = useState<'FIFO' | 'AVG' | 'STD'>('FIFO');
  const [standardCost, setStandardCost] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api<{ item_id: string | null; method: string }>('/api/costing/config', {
        method: 'PUT',
        body: JSON.stringify({
          item_id: itemId || null,
          method,
          standard_cost: method === 'STD' && standardCost !== '' ? Number(standardCost) : null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['costing-config'] });
      qc.invalidateQueries({ queryKey: ['costing-valuation'] });
    },
  });

  const config: any[] = q.data?.config ?? [];

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">ตั้งค่าวิธีคิดต้นทุน</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">เว้นว่างรหัสสินค้าเพื่อกำหนดค่าเริ่มต้นของทั้งกิจการ (tenant default)</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="cfg-item">รหัสสินค้า</Label>
              <Input id="cfg-item" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="(ค่าเริ่มต้น)" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cfg-method">วิธีคิดต้นทุน</Label>
              <select
                id="cfg-method"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={method}
                onChange={(e) => setMethod(e.target.value as any)}
              >
                <option value="FIFO">FIFO</option>
                <option value="AVG">AVG (ถัวเฉลี่ย)</option>
                <option value="STD">STD (มาตรฐาน)</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cfg-std">ต้นทุนมาตรฐาน</Label>
              <Input
                id="cfg-std"
                type="number"
                min="0"
                value={standardCost}
                onChange={(e) => setStandardCost(e.target.value)}
                disabled={method !== 'STD'}
                placeholder={method === 'STD' ? '0.00' : '—'}
              />
            </div>
          </div>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            <Save className="size-4" /> {save.isPending ? 'กำลังบันทึก…' : 'บันทึกการตั้งค่า'}
          </Button>
          {save.error && <Msg>{(save.error as Error).message}</Msg>}
          {save.data && <Msg ok>✅ บันทึก {save.data.item_id ?? 'ค่าเริ่มต้น'} · {save.data.method}</Msg>}
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={config}
            columns={[
              { key: 'item_id', label: 'รหัสสินค้า', render: (r: any) => r.item_id ?? '(ค่าเริ่มต้น)' },
              { key: 'method', label: 'วิธีคิดต้นทุน', render: (r: any) => <Badge variant={methodVariant(r.method)}>{r.method}</Badge> },
              { key: 'standard_cost', label: 'ต้นทุนมาตรฐาน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.standard_cost)}</span> },
              { key: 'avg_cost', label: 'ต้นทุนถัวเฉลี่ย', align: 'right', render: (r: any) => <span className="tabular">{baht(r.avg_cost)}</span> },
              { key: 'on_hand', label: 'คงเหลือ', align: 'right', render: (r: any) => <span className="tabular">{num(r.on_hand)}</span> },
            ]}
            emptyText="ยังไม่มีการตั้งค่าวิธีคิดต้นทุน"
          />
        )}
      </StateView>
    </div>
  );
}
