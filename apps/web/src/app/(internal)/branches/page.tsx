'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Store, Building2, ShoppingCart, CircleDollarSign, PlusCircle, CalendarSearch } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
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

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => new Date().toISOString().slice(0, 8) + '01';

interface Branch {
  id: number;
  code: string;
  name: string;
  is_hq: boolean;
  address: string | null;
  phone: string | null;
  active: boolean;
  created_at: string | null;
}
interface BranchesResp { branches: Branch[]; count: number }
interface ConsolRow { branch_id: number | null; code: string; name: string; is_hq: boolean; orders: number; subtotal: number; tax: number; total_sales: number }
interface ConsolResp { from: string | null; to: string | null; branches: ConsolRow[]; totals: { orders: number; total_sales: number } }

export default function BranchesPage() {
  return (
    <div>
      <PageHeader
        title="สาขา & ยอดขายรวม (Branches & HQ)"
        description="จัดการสาขา/หน้าร้าน แต่ละสาขาขายอิสระ (รองรับออฟไลน์) แล้วส่งยอดขายขึ้นมารวมที่สำนักงานใหญ่"
      />
      <Tabs
        tabs={[
          { key: 'branches', label: 'สาขา', content: <BranchesTab /> },
          { key: 'consolidated', label: 'ยอดขายรวมแยกตามสาขา', content: <ConsolidatedTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── สาขา (list + create) ─────────────────────────
function BranchesTab() {
  const qc = useQueryClient();
  const q = useQuery<BranchesResp>({ queryKey: ['branches'], queryFn: () => api('/api/branches') });
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [isHq, setIsHq] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api<Branch>('/api/branches', { method: 'POST', body: JSON.stringify({ code, name, is_hq: isHq }) }),
    onSuccess: (b) => {
      notifySuccess(`เพิ่มสาขา ${b.code} — ${b.name} แล้ว`);
      setCode(''); setName(''); setIsHq(false);
      qc.invalidateQueries({ queryKey: ['branches'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: (b: Branch) => api(`/api/branches/${b.id}`, { method: 'PATCH', body: JSON.stringify({ active: !b.active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['branches'] }),
  });

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">เพิ่มสาขาใหม่</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="b-code">รหัสสาขา</Label>
              <Input id="b-code" className="max-w-[140px]" placeholder="BKK01" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="b-name">ชื่อสาขา</Label>
              <Input id="b-name" className="max-w-[240px]" placeholder="สาขาสีลม" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" checked={isHq} onChange={(e) => setIsHq(e.target.checked)} />
              สำนักงานใหญ่ (HQ)
            </label>
            <Button disabled={create.isPending || !code.trim() || !name.trim()} onClick={() => create.mutate()}>
              <PlusCircle className="size-4" /> {create.isPending ? 'กำลังบันทึก…' : 'เพิ่มสาขา'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <StatCard label="จำนวนสาขา" value={q.data.count} icon={Store} tone="primary" />
            </div>
            <DataTable
              rows={q.data.branches}
              rowKey={(r) => r.id}
              columns={[
                { key: 'code', label: 'รหัส', render: (r) => <span className="font-medium">{r.code}</span> },
                { key: 'name', label: 'ชื่อสาขา' },
                { key: 'is_hq', label: 'ประเภท', render: (r) => (r.is_hq ? <Badge variant="success">HQ</Badge> : <Badge variant="secondary">สาขา</Badge>) },
                { key: 'active', label: 'สถานะ', render: (r) => (r.active ? <Badge variant="success">ใช้งาน</Badge> : <Badge variant="destructive">ปิด</Badge>) },
                { key: 'created_at', label: 'วันที่สร้าง', render: (r) => (r.created_at ? thaiDate(r.created_at) : '—') },
                {
                  key: 'actions', label: '', align: 'right',
                  render: (r) => (
                    <Button variant="outline" size="sm" disabled={toggleActive.isPending} onClick={() => toggleActive.mutate(r)}>
                      {r.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                    </Button>
                  ),
                },
              ]}
              emptyState={{
                icon: Store,
                title: 'ยังไม่มีสาขา',
                description: 'เพิ่มสาขาหรือหน้าร้านแรกของคุณได้จากแบบฟอร์ม “เพิ่มสาขาใหม่” ด้านบน',
              }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── ยอดขายรวมแยกตามสาขา ─────────────────────────
function ConsolidatedTab() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const q = useQuery<ConsolResp>({
    queryKey: ['branch-consolidated', from, to],
    queryFn: () => api(`/api/branches/consolidated?from=${from}&to=${to}`),
  });

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">ช่วงเวลา</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="c-from">ตั้งแต่</Label>
              <Input id="c-from" type="date" className="max-w-[180px]" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="c-to">ถึง</Label>
              <Input id="c-to" type="date" className="max-w-[180px]" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="จำนวนสาขาที่มียอด" value={q.data.branches.length} icon={Building2} tone="primary" />
              <StatCard label="จำนวนบิล" value={q.data.totals.orders} icon={ShoppingCart} tone="default" />
              <StatCard label="ยอดขายรวม" value={baht(q.data.totals.total_sales)} icon={CircleDollarSign} tone="success" />
            </div>
            <DataTable
              rows={q.data.branches}
              rowKey={(r) => `${r.branch_id ?? 'none'}`}
              columns={[
                { key: 'code', label: 'สาขา', render: (r) => <span className="font-medium">{r.code}{r.is_hq ? ' (HQ)' : ''}</span> },
                { key: 'name', label: 'ชื่อ' },
                { key: 'orders', label: 'บิล', align: 'right', render: (r) => <span className="tabular">{r.orders.toLocaleString()}</span> },
                { key: 'subtotal', label: 'ยอดก่อน VAT', align: 'right', render: (r) => <span className="tabular">{baht(r.subtotal)}</span> },
                { key: 'tax', label: 'VAT', align: 'right', render: (r) => <span className="tabular">{baht(r.tax)}</span> },
                { key: 'total_sales', label: 'ยอดขายรวม', align: 'right', render: (r) => <span className="tabular font-medium">{baht(r.total_sales)}</span> },
              ]}
              emptyState={{
                icon: CalendarSearch,
                title: 'ไม่มียอดขายในช่วงเวลานี้',
                description: 'ยังไม่มียอดขายของสาขาในช่วงที่เลือก — ลองปรับช่วงวันที่ด้านบนแล้วดูอีกครั้ง',
              }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}
