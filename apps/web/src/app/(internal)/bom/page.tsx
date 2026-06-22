'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, Msg } from '@/components/tabs';
import { statusVariant } from '@/components/ui';

const g = (r: any, ...keys: string[]) => { for (const k of keys) if (r[k] != null) return r[k]; return ''; };

function Library() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['bom-master'], queryFn: () => api('/api/bom/master') });
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [sell, setSell] = useState(0); const [labor, setLabor] = useState(0);
  const [lines, setLines] = useState([{ item_id: '', qty_use_uom: 1, conv_factor: 1 }]);
  const setLine = (i: number, p: any) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const add = useMutation({
    mutationFn: () => api<{ bom_code: string }>('/api/bom/master', { method: 'POST', body: JSON.stringify({ bom_code: code, product_name: name, selling_price: Number(sell), labor_cost: Number(labor), lines: lines.filter((l) => l.item_id).map((l) => ({ item_id: l.item_id, qty_use_uom: Number(l.qty_use_uom), conv_factor: Number(l.conv_factor) })) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['bom-master'] }); setCode(''); setName(''); },
  });
  return (
    <div className="space-y-4">
      <Card className="max-w-3xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">สร้าง/แก้สูตร (BoM)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
            <Input placeholder="รหัสสูตร" value={code} onChange={(e) => setCode(e.target.value)} />
            <Input placeholder="ชื่อสินค้า" value={name} onChange={(e) => setName(e.target.value)} />
            <Input className="sm:max-w-[110px]" type="number" placeholder="ราคาขาย" value={sell} onChange={(e) => setSell(+e.target.value)} />
            <Input className="sm:max-w-[110px]" type="number" placeholder="ค่าแรง" value={labor} onChange={(e) => setLabor(+e.target.value)} />
          </div>
          <p className="text-sm text-muted-foreground">วัตถุดิบ (Item ID · จำนวนใช้ · อัตราแปลง)</p>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[2fr_1fr_1fr_auto] gap-2">
                <Input placeholder="Item ID" value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} />
                <Input type="number" value={l.qty_use_uom} onChange={(e) => setLine(i, { qty_use_uom: +e.target.value })} />
                <Input type="number" value={l.conv_factor} onChange={(e) => setLine(i, { conv_factor: +e.target.value })} />
                <Button variant="destructive" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setLines((ls) => [...ls, { item_id: '', qty_use_uom: 1, conv_factor: 1 }])}>
              <Plus className="size-4" /> วัตถุดิบ
            </Button>
            <Button disabled={!code || add.isPending} onClick={() => add.mutate()}>บันทึกสูตร</Button>
          </div>
          {add.error && <Msg>{(add.error as Error).message}</Msg>}
          {add.data && <Msg ok>✅ บันทึก {add.data.bom_code}</Msg>}
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.boms} columns={[
          { key: 'code', label: 'รหัส', render: (r) => g(r, 'bomCode', 'bom_code') },
          { key: 'product', label: 'สินค้า', render: (r) => g(r, 'productName', 'product_name') },
          { key: 'sell', label: 'ราคาขาย', align: 'right', render: (r) => baht(g(r, 'sellingPrice', 'selling_price')) },
          { key: 'cost', label: 'ต้นทุน/หน่วย', align: 'right', render: (r) => baht(g(r, 'costPerUnit', 'cost_per_unit')) },
          { key: 'margin', label: 'กำไร %', align: 'right', render: (r) => <span className="tabular">{`${Number(g(r, 'marginPct', 'margin_pct') || 0).toFixed(1)}%`}</span> },
        ]} />}
      </StateView>
    </div>
  );
}

function Submissions() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['bom-sub'], queryFn: () => api('/api/bom/submissions') });
  const approve = useMutation({ mutationFn: (id: number) => api(`/api/bom/submissions/${id}/approve`, { method: 'PATCH' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['bom-sub'] }) });
  return (
    <StateView q={q}>
      {q.data && <DataTable rows={q.data.submissions} columns={[
        { key: 'code', label: 'รหัส', render: (r) => g(r, 'bomCode', 'bom_code') },
        { key: 'product', label: 'สินค้า', render: (r) => g(r, 'productName', 'product_name') },
        { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(g(r, 'status') || 'Pending')}>{g(r, 'status') || 'Pending'}</Badge> },
        { key: 'x', label: '', sortable: false, render: (r) => (g(r, 'status') === 'Approved' ? <Check className="size-4 text-success" /> : <Button size="sm" onClick={() => approve.mutate(g(r, 'id'))}>อนุมัติ</Button>) },
      ]} />}
    </StateView>
  );
}

export default function Bom() {
  return (
    <div>
      <PageHeader title="สูตรผลิตกลาง (BoM Master)" description="คลังสูตรการผลิตและคำขออนุมัติ" />
      <Tabs tabs={[{ key: 'lib', label: 'คลังสูตร', content: <Library /> }, { key: 'sub', label: 'คำขออนุมัติจากลูกค้า', content: <Submissions /> }]} />
    </div>
  );
}
