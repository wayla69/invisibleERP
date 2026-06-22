'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Factory, Plus, Play, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

type Wo = {
  wo_no: string; bom_code: string; product_name: string; uom: string;
  qty_planned: number; qty_produced: number; status: string;
  material_cost: number; labor_cost: number; overhead_cost: number; total_cost: number; unit_cost: number;
};

export default function ManufacturingPage() {
  const qc = useQueryClient();
  const q = useQuery<{ work_orders: Wo[]; count: number }>({ queryKey: ['work-orders'], queryFn: () => api('/api/manufacturing/work-orders') });
  const [bomCode, setBomCode] = useState('');
  const [qty, setQty] = useState('');
  const [msg, setMsg] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: ['work-orders'] });
  const create = useMutation({
    mutationFn: () => api<Wo>('/api/manufacturing/work-orders', { method: 'POST', body: JSON.stringify({ bom_code: bomCode, qty_planned: Number(qty) || 0 }) }),
    onSuccess: (r) => { setMsg(`✅ สร้างใบสั่งผลิต ${r.wo_no} (ต้นทุนรวม ${baht(r.total_cost)})`); setBomCode(''); setQty(''); refresh(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const act = useMutation({
    mutationFn: (p: { woNo: string; action: 'issue' | 'complete' }) => api<any>(`/api/manufacturing/work-orders/${p.woNo}/${p.action}`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r) => { setMsg(r.status === 'Released' ? `✅ เบิกวัตถุดิบเข้างาน (WIP ${baht(r.wip_cost)}) — ${r.entry_no}` : `✅ ปิดงานผลิต รับสินค้าสำเร็จรูป (${baht(r.fg_value)}) — ${r.entry_no}`); refresh(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const wos = q.data?.work_orders ?? [];
  const wip = wos.filter((w) => w.status === 'Released').reduce((a, w) => a + w.total_cost, 0);
  const fg = wos.filter((w) => w.status === 'Completed').reduce((a, w) => a + w.total_cost, 0);

  return (
    <div>
      <PageHeader title="ใบสั่งผลิต (Manufacturing)" description="ผลิตสินค้าจากสูตร (BOM) · เบิกวัตถุดิบ→งานระหว่างทำ (WIP)→สินค้าสำเร็จรูป · ลงบัญชีอัตโนมัติ" />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard label="ใบสั่งผลิต" value={q.data?.count ?? 0} icon={Factory} tone="primary" />
        <StatCard label="งานระหว่างทำ (WIP)" value={baht(wip)} tone="primary" />
        <StatCard label="สินค้าสำเร็จรูปที่ผลิต" value={baht(fg)} tone="primary" />
      </div>

      <Card className="mb-5 gap-3 p-5">
        <h3 className="text-base font-semibold">สร้างใบสั่งผลิต</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>รหัสสูตร (BOM)</Label><Input value={bomCode} onChange={(e) => setBomCode(e.target.value)} placeholder="BOM-CAKE" className="w-44" /></div>
          <div className="grid gap-1.5"><Label>จำนวนผลิต</Label><Input type="number" min="0" value={qty} onChange={(e) => setQty(e.target.value)} className="w-32" /></div>
          <Button onClick={() => create.mutate()} disabled={!bomCode || !qty || create.isPending}><Plus className="size-4" /> สร้าง</Button>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={wos}
            columns={[
              { key: 'wo_no', label: 'เลขที่ใบสั่งผลิต' },
              { key: 'product_name', label: 'สินค้า', render: (r: Wo) => `${r.product_name ?? ''} (${r.bom_code})` },
              { key: 'qty_planned', label: 'จำนวน', align: 'right', render: (r: Wo) => `${r.qty_planned} ${r.uom ?? ''}` },
              { key: 'material_cost', label: 'วัตถุดิบ', align: 'right', render: (r: Wo) => <span className="tabular">{baht(r.material_cost)}</span> },
              { key: 'total_cost', label: 'ต้นทุนรวม', align: 'right', render: (r: Wo) => <span className="tabular">{baht(r.total_cost)}</span> },
              { key: 'unit_cost', label: 'ต้นทุน/หน่วย', align: 'right', render: (r: Wo) => <span className="tabular">{baht(r.unit_cost)}</span> },
              { key: 'status', label: 'สถานะ', render: (r: Wo) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              {
                key: 'action',
                label: 'ดำเนินการ',
                sortable: false,
                render: (r: Wo) =>
                  r.status === 'Open' ? (
                    <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate({ woNo: r.wo_no, action: 'issue' })}><Play className="size-4" /> เบิกวัตถุดิบ</Button>
                  ) : r.status === 'Released' ? (
                    <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate({ woNo: r.wo_no, action: 'complete' })}><CheckCircle2 className="size-4" /> ปิดงาน/รับสินค้า</Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  ),
              },
            ]}
            emptyText="ยังไม่มีใบสั่งผลิต"
          />
        )}
      </StateView>
    </div>
  );
}
