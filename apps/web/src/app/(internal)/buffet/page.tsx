'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Timer, Utensils } from 'lucide-react';
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

interface Pkg {
  id: number;
  code: string;
  name: string;
  name_en: string | null;
  price_per_pax: number;
  time_limit_min: number;
  overtime_fee_per_pax: number;
  active: boolean;
  item_skus: string[];
}

export default function BuffetPage() {
  return (
    <div>
      <PageHeader
        title="บุฟเฟต์ (Buffet packages)"
        description="จัดการแพ็กเกจบุฟเฟต์แบบต่อหัว + เวลาทานต่อโต๊ะ — ลูกค้าเลือกได้จากหน้าสั่งอาหารผ่าน QR"
      />
      <Tabs tabs={[{ key: 'pkgs', label: 'แพ็กเกจบุฟเฟต์', content: <Packages /> }]} />
    </div>
  );
}

function Packages() {
  const qc = useQueryClient();
  const q = useQuery<{ packages: Pkg[] }>({ queryKey: ['buffet-packages'], queryFn: () => api('/api/restaurant/buffet/packages') });
  const packages = q.data?.packages ?? [];

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [timeLimit, setTimeLimit] = useState('90');
  const [overtime, setOvertime] = useState('0');
  const [skus, setSkus] = useState('');
  const [msg, setMsg] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api<Pkg>('/api/restaurant/buffet/packages', {
        method: 'POST',
        body: JSON.stringify({
          code,
          name,
          price_per_pax: Number(price),
          time_limit_min: Number(timeLimit),
          overtime_fee_per_pax: Number(overtime),
          item_skus: skus.split(',').map((s) => s.trim()).filter(Boolean),
        }),
      }),
    onSuccess: (p) => {
      setMsg(`✅ เพิ่มแพ็กเกจ ${p.code} · ${p.name}`);
      setCode(''); setName(''); setPrice(''); setSkus('');
      qc.invalidateQueries({ queryKey: ['buffet-packages'] });
    },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });

  const avgPrice = packages.length ? packages.reduce((s, p) => s + p.price_per_pax, 0) / packages.length : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="แพ็กเกจทั้งหมด" value={num(packages.length)} icon={Utensils} tone="primary" />
        <StatCard label="ราคาเฉลี่ย/ท่าน" value={baht(avgPrice)} icon={Utensils} tone="default" />
        <StatCard label="ใช้งานอยู่" value={num(packages.filter((p) => p.active).length)} icon={Timer} tone="success" />
      </div>

      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">เพิ่มแพ็กเกจบุฟเฟต์</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="bf-code">รหัส</Label>
              <Input id="bf-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="เช่น STD" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bf-name">ชื่อแพ็กเกจ</Label>
              <Input id="bf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น บุฟเฟต์มาตรฐาน" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bf-price">ราคา/ท่าน (บาท)</Label>
              <Input id="bf-price" type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="299" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bf-time">เวลาทาน (นาที)</Label>
              <Input id="bf-time" type="number" min="1" value={timeLimit} onChange={(e) => setTimeLimit(e.target.value)} placeholder="90" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bf-ot">ค่าปรับเกินเวลา/ท่าน (บาท)</Label>
              <Input id="bf-ot" type="number" min="0" value={overtime} onChange={(e) => setOvertime(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="bf-skus">เมนูที่รวมในบุฟเฟต์ (SKU คั่นด้วย ,)</Label>
              <Input id="bf-skus" value={skus} onChange={(e) => setSkus(e.target.value)} placeholder="เช่น BF01, BF02, BF03" />
            </div>
          </div>
          <Button disabled={!code || !name || price === '' || create.isPending} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? 'กำลังบันทึก…' : 'เพิ่มแพ็กเกจ'}
          </Button>
          <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">แพ็กเกจบุฟเฟต์</h3>
        <StateView q={q}>
          <DataTable
            rows={packages}
            rowKey={(r) => r.id}
            columns={[
              { key: 'code', label: 'รหัส' },
              { key: 'name', label: 'ชื่อแพ็กเกจ' },
              { key: 'price_per_pax', label: 'ราคา/ท่าน', align: 'right', render: (r) => <span className="tabular">{baht(r.price_per_pax)}</span> },
              { key: 'time_limit_min', label: 'เวลา (นาที)', align: 'right', render: (r) => num(r.time_limit_min) },
              { key: 'overtime_fee_per_pax', label: 'เกินเวลา/ท่าน', align: 'right', render: (r) => <span className="tabular">{r.overtime_fee_per_pax > 0 ? baht(r.overtime_fee_per_pax) : '—'}</span> },
              { key: 'item_skus', label: 'จำนวนเมนู', align: 'right', render: (r) => num(r.item_skus.length) },
              { key: 'active', label: 'สถานะ', render: (r) => <Badge variant={r.active ? 'success' : 'muted'}>{r.active ? 'ใช้งาน' : 'ปิด'}</Badge> },
            ]}
            emptyText="ยังไม่มีแพ็กเกจบุฟเฟต์"
          />
        </StateView>
      </div>
    </div>
  );
}
