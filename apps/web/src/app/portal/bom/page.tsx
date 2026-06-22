'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Play, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Line { item_id: string; use_uom?: string; qty_use_uom: number; unit_cost?: number }

export default function PortalBomPage() {
  const qc = useQueryClient();
  const list = useQuery<any>({ queryKey: ['portal-bom'], queryFn: () => api('/api/portal/bom') });
  const [hdr, setHdr] = useState({ bom_code: '', product_name: '', yield_qty: '1', yield_uom: '', selling_price: '' });
  const [lines, setLines] = useState<Line[]>([]);
  const [ln, setLn] = useState({ item_id: '', use_uom: '', qty_use_uom: '', unit_cost: '' });
  const [msg, setMsg] = useState('');

  const create = useMutation({
    mutationFn: () => api('/api/portal/bom', {
      method: 'POST',
      body: JSON.stringify({
        bom_code: hdr.bom_code, product_name: hdr.product_name || undefined,
        yield_qty: hdr.yield_qty ? Number(hdr.yield_qty) : undefined, yield_uom: hdr.yield_uom || undefined,
        selling_price: hdr.selling_price ? Number(hdr.selling_price) : undefined, lines,
      }),
    }),
    onSuccess: () => { setMsg(`✅ บันทึกสูตร ${hdr.bom_code}`); setHdr({ bom_code: '', product_name: '', yield_qty: '1', yield_uom: '', selling_price: '' }); setLines([]); qc.invalidateQueries({ queryKey: ['portal-bom'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const run = useMutation({
    mutationFn: (code: string) => { const q = prompt(`จำนวนแบตช์ที่ผลิตสำหรับ ${code}`); return q ? api(`/api/portal/bom/${encodeURIComponent(code)}/production-runs`, { method: 'POST', body: JSON.stringify({ batch_qty: Number(q) }) }) : Promise.resolve(null); },
    onSuccess: (r) => { if (r) { setMsg('✅ บันทึกการผลิตแล้ว'); qc.invalidateQueries({ queryKey: ['portal-bom'] }); } },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  function addLine() {
    if (!ln.item_id || !ln.qty_use_uom) return;
    setLines((ls) => [...ls, { item_id: ln.item_id, use_uom: ln.use_uom || undefined, qty_use_uom: Number(ln.qty_use_uom), unit_cost: ln.unit_cost ? Number(ln.unit_cost) : undefined }]);
    setLn({ item_id: '', use_uom: '', qty_use_uom: '', unit_cost: '' });
  }
  const g = (r: any, a: string, b: string) => r[a] ?? r[b];

  return (
    <div className="space-y-4">
      <PageHeader title="สูตรการผลิต (BoM)" description="สร้างสูตรของร้าน บันทึกส่วนผสมและต้นทุน และบันทึกการผลิต" />
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">สร้างสูตรใหม่</h3>
        <div className="grid gap-2 sm:grid-cols-5">
          <Input placeholder="รหัสสูตร *" value={hdr.bom_code} onChange={(e) => setHdr({ ...hdr, bom_code: e.target.value })} />
          <Input placeholder="ชื่อสินค้า" value={hdr.product_name} onChange={(e) => setHdr({ ...hdr, product_name: e.target.value })} />
          <Input type="number" placeholder="ผลผลิต" value={hdr.yield_qty} onChange={(e) => setHdr({ ...hdr, yield_qty: e.target.value })} />
          <Input placeholder="หน่วย" value={hdr.yield_uom} onChange={(e) => setHdr({ ...hdr, yield_uom: e.target.value })} />
          <Input type="number" placeholder="ราคาขาย" value={hdr.selling_price} onChange={(e) => setHdr({ ...hdr, selling_price: e.target.value })} />
        </div>
        <Label>ส่วนผสม</Label>
        <div className="grid gap-2 sm:grid-cols-5">
          <Input placeholder="รหัสวัตถุดิบ" value={ln.item_id} onChange={(e) => setLn({ ...ln, item_id: e.target.value })} />
          <Input placeholder="หน่วยใช้" value={ln.use_uom} onChange={(e) => setLn({ ...ln, use_uom: e.target.value })} />
          <Input type="number" placeholder="จำนวนใช้" value={ln.qty_use_uom} onChange={(e) => setLn({ ...ln, qty_use_uom: e.target.value })} />
          <Input type="number" placeholder="ต้นทุน/หน่วย" value={ln.unit_cost} onChange={(e) => setLn({ ...ln, unit_cost: e.target.value })} />
          <Button variant="outline" onClick={addLine}><Plus className="size-4" /> เพิ่มส่วนผสม</Button>
        </div>
        {lines.length > 0 && (
          <DataTable
            rows={lines.map((l, i) => ({ ...l, _i: i }))}
            columns={[
              { key: 'item_id', label: 'วัตถุดิบ' },
              { key: 'qty_use_uom', label: 'จำนวน', align: 'right', render: (r: any) => num(r.qty_use_uom) },
              { key: 'use_uom', label: 'หน่วย' },
              { key: 'unit_cost', label: 'ต้นทุน', align: 'right', render: (r: any) => r.unit_cost != null ? baht(r.unit_cost) : '—' },
              { key: 'act', label: '', render: (r: any) => <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== r._i))}><Trash2 className="size-4" /></Button> },
            ]}
            dense
          />
        )}
        <Button className="w-fit" disabled={!hdr.bom_code || create.isPending} onClick={() => create.mutate()}>บันทึกสูตร</Button>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={list}>
        {list.data && (
          <DataTable
            rows={list.data.boms ?? list.data.bom ?? list.data.items ?? []}
            columns={[
              { key: 'bom_code', label: 'รหัสสูตร', render: (r: any) => g(r, 'bom_code', 'bomCode') },
              { key: 'product_name', label: 'สินค้า', render: (r: any) => g(r, 'product_name', 'productName') ?? '—' },
              { key: 'yield_qty', label: 'ผลผลิต', align: 'right', render: (r: any) => num(g(r, 'yield_qty', 'yieldQty')) },
              { key: 'selling_price', label: 'ราคาขาย', align: 'right', render: (r: any) => baht(g(r, 'selling_price', 'sellingPrice')) },
              { key: 'act', label: '', render: (r: any) => <Button size="sm" variant="outline" onClick={() => run.mutate(g(r, 'bom_code', 'bomCode'))}><Play className="size-4" /> ผลิต</Button> },
            ]}
            emptyText="ยังไม่มีสูตรการผลิต"
          />
        )}
      </StateView>
    </div>
  );
}
