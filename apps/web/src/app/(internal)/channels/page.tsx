'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plug, RefreshCw, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

const sel = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm';
const PLATFORMS = ['grab', 'lineman', 'foodpanda', 'robinhood'];

export default function ChannelsPage() {
  return (
    <div>
      <PageHeader title="ช่องทางเดลิเวอรี (Aggregators)" description="เชื่อม Grab / LINE MAN / Foodpanda / Robinhood — รับออเดอร์เข้า, ส่งสถานะกลับ, ซิงก์เมนู และ auto-86" />
      <Tabs tabs={[{ key: 'orders', label: 'ออเดอร์เดลิเวอรี', content: <Orders /> }, { key: 'adapters', label: 'การเชื่อมต่อ', content: <Adapters /> }, { key: 'avail', label: 'ความพร้อมขาย (86)', content: <Availability /> }]} />
    </div>
  );
}

function Orders() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['channel-orders'], queryFn: () => api('/api/channels/orders') });
  const setStatus = useMutation({ mutationFn: (v: { no: string; status: string }) => api(`/api/channels/orders/${v.no}/status`, { method: 'POST', body: JSON.stringify({ status: v.status }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['channel-orders'] }) });
  const FS = ['accepted', 'preparing', 'ready', 'out_for_delivery', 'completed', 'rejected'];
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable rows={q.data.orders} columns={[
          { key: 'order_no', label: 'เลขที่' },
          { key: 'platform', label: 'แพลตฟอร์ม', render: (r: any) => <Badge>{r.platform}</Badge> },
          { key: 'ext_order_id', label: 'อ้างอิงแพลตฟอร์ม' },
          { key: 'total', label: 'ยอด', align: 'right', render: (r: any) => baht(r.total) },
          { key: 'fulfillment_status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.fulfillment_status === 'completed' ? 'paid' : 'open')}>{r.fulfillment_status ?? '—'}</Badge> },
          { key: 'act', label: 'อัปเดตสถานะ', render: (r: any) => <select className={sel} value={r.fulfillment_status ?? ''} onChange={(e) => setStatus.mutate({ no: r.order_no, status: e.target.value })}><option value="">—</option>{FS.map((f) => <option key={f} value={f}>{f}</option>)}</select> },
        ]} emptyText="ยังไม่มีออเดอร์เดลิเวอรี" />
      )}
    </StateView>
  );
}

function Adapters() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['adapters'], queryFn: () => api('/api/channels/adapters') });
  const [f, setF] = useState({ platform: 'grab', store_ref: '' });
  const [msg, setMsg] = useState('');
  const save = useMutation({ mutationFn: () => api('/api/channels/adapters', { method: 'POST', body: JSON.stringify({ platform: f.platform, store_ref: f.store_ref || undefined }) }), onSuccess: () => { setMsg('✅ เชื่อมต่อแล้ว'); qc.invalidateQueries({ queryKey: ['adapters'] }); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const sync = useMutation({ mutationFn: (p: string) => api(`/api/channels/${p}/menu-sync`, { method: 'POST' }), onSuccess: (r: any) => setMsg(`✅ ซิงก์เมนู ${r.count} รายการไป ${r.platform}`), onError: (e: any) => setMsg(`❌ ${e.message}`) });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">เพิ่มการเชื่อมต่อ</h3>
        <div className="flex flex-wrap gap-2">
          <select className={sel} value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })}>{PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}</select>
          <Input className="max-w-[200px]" placeholder="Store ID ของแพลตฟอร์ม" value={f.store_ref} onChange={(e) => setF({ ...f, store_ref: e.target.value })} />
          <Button disabled={save.isPending} onClick={() => save.mutate()}><Plug className="size-4" /> เชื่อมต่อ</Button>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.adapters} columns={[
          { key: 'platform', label: 'แพลตฟอร์ม' }, { key: 'store_ref', label: 'Store ID' },
          { key: 'enabled', label: 'เปิดใช้', render: (r: any) => r.enabled ? <Badge variant={statusVariant('paid')}>ใช้งาน</Badge> : '—' },
          { key: 'act', label: '', render: (r: any) => <Button size="sm" variant="outline" disabled={sync.isPending} onClick={() => sync.mutate(r.platform)}><Send className="size-4" /> ซิงก์เมนู</Button> },
        ]} emptyText="ยังไม่มีการเชื่อมต่อ" />}
      </StateView>
    </div>
  );
}

function Availability() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['availability'], queryFn: () => api('/api/pos/scale/availability') });
  const [msg, setMsg] = useState('');
  const recompute = useMutation({ mutationFn: () => api('/api/pos/scale/availability/recompute', { method: 'POST' }), onSuccess: (r: any) => { setMsg(`✅ ปรับปรุง ${r.count} รายการ`); qc.invalidateQueries({ queryKey: ['availability'] }); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  return (
    <div className="space-y-4">
      <Card className="flex-row items-center gap-3 p-5">
        <Button disabled={recompute.isPending} onClick={() => recompute.mutate()}><RefreshCw className={`size-4 ${recompute.isPending ? 'animate-spin' : ''}`} /> คำนวณ auto-86 ใหม่</Button>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.items} columns={[
          { key: 'sku', label: 'SKU' }, { key: 'name', label: 'ชื่อ' },
          { key: 'is_available', label: 'พร้อมขาย', render: (r: any) => <Badge variant={statusVariant(r.is_available ? 'paid' : 'cancelled')}>{r.is_available ? 'พร้อม' : '86 (หมด)'}</Badge> },
        ]} emptyText="ไม่มีสินค้าที่ติดตามสต๊อก" />}
      </StateView>
    </div>
  );
}
