'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plug, PlugZap, PackageSearch, RefreshCw, SearchX, Send, ShoppingBag } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { SearchInput } from '@/components/search-input';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
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
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const orders: any[] = q.data?.orders ?? [];
  const statuses = useMemo(() => Array.from(new Set(orders.map((o) => o.fulfillment_status).filter(Boolean))), [orders]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (statusFilter && o.fulfillment_status !== statusFilter) return false;
      if (!term) return true;
      return [o.order_no, o.ext_order_id, o.platform].some((v) => String(v ?? '').toLowerCase().includes(term));
    });
  }, [orders, search, statusFilter]);
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SearchInput value={search} onChange={setSearch} placeholder="ค้นหาเลขที่ / อ้างอิง / แพลตฟอร์ม…" ariaLabel="ค้นหาออเดอร์เดลิเวอรี" count={`${filtered.length} รายการ`} />
            {statuses.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="กรองตามสถานะ">
                <Button variant={statusFilter === null ? 'secondary' : 'ghost'} size="sm" onClick={() => setStatusFilter(null)}>ทั้งหมด</Button>
                {statuses.map((s) => (
                  <Button key={s} variant={statusFilter === s ? 'secondary' : 'ghost'} size="sm" aria-pressed={statusFilter === s} onClick={() => setStatusFilter((c) => (c === s ? null : s))}>{s}</Button>
                ))}
              </div>
            )}
          </div>
        <DataTable rows={filtered} rowKey={(r: any) => r.order_no} columns={[
          { key: 'order_no', label: 'เลขที่' },
          { key: 'platform', label: 'แพลตฟอร์ม', render: (r: any) => <Badge>{r.platform}</Badge> },
          { key: 'ext_order_id', label: 'อ้างอิงแพลตฟอร์ม' },
          { key: 'total', label: 'ยอด', align: 'right', render: (r: any) => baht(r.total) },
          { key: 'fulfillment_status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.fulfillment_status === 'completed' ? 'paid' : 'open')}>{r.fulfillment_status ?? '—'}</Badge> },
          { key: 'act', label: 'อัปเดตสถานะ', sortable: false, render: (r: any) => <select className={sel} value={r.fulfillment_status ?? ''} aria-label="อัปเดตสถานะ" onChange={(e) => setStatus.mutate({ no: r.order_no, status: e.target.value })}><option value="">—</option>{FS.map((f) => <option key={f} value={f}>{f}</option>)}</select> },
        ]} emptyState={
          search || statusFilter
            ? {
                icon: SearchX,
                title: 'ไม่พบออเดอร์ที่ตรงกับตัวกรอง',
                description: 'ลองปรับคำค้นหา หรือล้างตัวกรองเพื่อดูออเดอร์ทั้งหมด',
                action: (
                  <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter(null); }}>
                    ล้างตัวกรอง
                  </Button>
                ),
              }
            : { icon: ShoppingBag, title: 'ยังไม่มีออเดอร์เดลิเวอรี', description: 'ออเดอร์จาก Grab / LINE MAN / Foodpanda / Robinhood จะแสดงที่นี่เมื่อเชื่อมต่อแล้ว' }
        } />
        </div>
      )}
    </StateView>
  );
}

function Adapters() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['adapters'], queryFn: () => api('/api/channels/adapters') });
  const [f, setF] = useState({ platform: 'grab', store_ref: '' });
  const save = useMutation({ mutationFn: () => api('/api/channels/adapters', { method: 'POST', body: JSON.stringify({ platform: f.platform, store_ref: f.store_ref || undefined }) }), onSuccess: () => { notifySuccess('เชื่อมต่อแล้ว'); qc.invalidateQueries({ queryKey: ['adapters'] }); }, onError: (e: any) => notifyError(e.message) });
  const sync = useMutation({ mutationFn: (p: string) => api(`/api/channels/${p}/menu-sync`, { method: 'POST' }), onSuccess: (r: any) => notifySuccess(`ซิงก์เมนู ${r.count} รายการไป ${r.platform}`), onError: (e: any) => notifyError(e.message) });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">เพิ่มการเชื่อมต่อ</h3>
        <div className="flex flex-wrap gap-2">
          <select className={sel} value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })}>{PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}</select>
          <Input className="max-w-[200px]" placeholder="Store ID ของแพลตฟอร์ม" value={f.store_ref} onChange={(e) => setF({ ...f, store_ref: e.target.value })} />
          <Button disabled={save.isPending} onClick={() => save.mutate()}><Plug className="size-4" /> เชื่อมต่อ</Button>
        </div>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.adapters} columns={[
          { key: 'platform', label: 'แพลตฟอร์ม' }, { key: 'store_ref', label: 'Store ID' },
          { key: 'enabled', label: 'เปิดใช้', render: (r: any) => r.enabled ? <Badge variant={statusVariant('paid')}>ใช้งาน</Badge> : '—' },
          { key: 'act', label: '', render: (r: any) => <Button size="sm" variant="outline" disabled={sync.isPending} onClick={() => sync.mutate(r.platform)}><Send className="size-4" /> ซิงก์เมนู</Button> },
        ]} emptyState={{ icon: PlugZap, title: 'ยังไม่มีการเชื่อมต่อ', description: 'เพิ่มการเชื่อมต่อแพลตฟอร์มด้านบนเพื่อเริ่มรับออเดอร์และซิงก์เมนู' }} />}
      </StateView>
    </div>
  );
}

function Availability() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['availability'], queryFn: () => api('/api/pos/scale/availability') });
  const recompute = useMutation({ mutationFn: () => api('/api/pos/scale/availability/recompute', { method: 'POST' }), onSuccess: (r: any) => { notifySuccess(`ปรับปรุง ${r.count} รายการ`); qc.invalidateQueries({ queryKey: ['availability'] }); }, onError: (e: any) => notifyError(e.message) });
  const [search, setSearch] = useState('');
  const items: any[] = q.data?.items ?? [];
  const filteredItems = useMemo(() => { const t = search.trim().toLowerCase(); if (!t) return items; return items.filter((i) => [i.sku, i.name].some((v) => String(v ?? '').toLowerCase().includes(t))); }, [items, search]);
  return (
    <div className="space-y-4">
      <Card className="flex-row items-center gap-3 p-5">
        <Button disabled={recompute.isPending} onClick={() => recompute.mutate()}><RefreshCw className={`size-4 ${recompute.isPending ? 'animate-spin' : ''}`} /> คำนวณ auto-86 ใหม่</Button>
      </Card>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-3">
            <SearchInput value={search} onChange={setSearch} placeholder="ค้นหา SKU / ชื่อ…" ariaLabel="ค้นหาสินค้า" count={`${filteredItems.length} รายการ`} />
            <DataTable rows={filteredItems} rowKey={(r: any) => r.sku} columns={[
              { key: 'sku', label: 'SKU' }, { key: 'name', label: 'ชื่อ' },
              { key: 'is_available', label: 'พร้อมขาย', render: (r: any) => <Badge variant={statusVariant(r.is_available ? 'paid' : 'cancelled')}>{r.is_available ? 'พร้อม' : '86 (หมด)'}</Badge> },
            ]} emptyState={
              search
                ? {
                    icon: SearchX,
                    title: 'ไม่พบสินค้าที่ตรงกับการค้นหา',
                    description: 'ลองปรับคำค้นหา หรือล้างเพื่อดูสินค้าทั้งหมด',
                    action: (
                      <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                        ล้างตัวกรอง
                      </Button>
                    ),
                  }
                : { icon: PackageSearch, title: 'ไม่มีสินค้าที่ติดตามสต๊อก', description: 'สินค้าที่ผูกกับการติดตามสต๊อกจะแสดงสถานะความพร้อมขาย (86) ที่นี่' }
            } />
          </div>
        )}
      </StateView>
    </div>
  );
}
