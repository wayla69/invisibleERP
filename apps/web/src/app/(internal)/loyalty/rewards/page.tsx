'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Gift, Plus, Search, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

interface Reward { id: number; reward_code: string; name: string; type: string; point_cost: number; cash_value: number; coupon_kind: string | null; coupon_value: number; stock: number | null; per_member_limit: number | null; tier_min: number | null; active: boolean }

export default function RewardsPage() {
  const qc = useQueryClient();
  const list = useQuery<{ rewards: Reward[]; count: number }>({ queryKey: ['loy-rewards'], queryFn: () => api('/api/loyalty/rewards') });

  const [form, setForm] = useState({ name: '', type: 'evoucher', point_cost: 100, cash_value: 0, coupon_kind: 'amount', coupon_value: 0, stock: '', per_member_limit: '' });
  const [msg, setMsg] = useState('');
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const create = useMutation({
    mutationFn: () => api('/api/loyalty/rewards', { method: 'POST', body: JSON.stringify({
      name: form.name, type: form.type, point_cost: Number(form.point_cost), cash_value: Number(form.cash_value),
      coupon_kind: form.coupon_kind, coupon_value: Number(form.coupon_value),
      ...(form.stock !== '' ? { stock: Number(form.stock) } : {}),
      ...(form.per_member_limit !== '' ? { per_member_limit: Number(form.per_member_limit) } : {}),
    }) }),
    onSuccess: () => { setMsg('✅ เพิ่มของรางวัลแล้ว'); setForm({ name: '', type: 'evoucher', point_cost: 100, cash_value: 0, coupon_kind: 'amount', coupon_value: 0, stock: '', per_member_limit: '' }); qc.invalidateQueries({ queryKey: ['loy-rewards'] }); },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });
  const toggle = useMutation({
    mutationFn: (r: Reward) => api(`/api/loyalty/rewards/${r.id}`, { method: 'PATCH', body: JSON.stringify({ active: !r.active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-rewards'] }),
  });

  const [search, setSearch] = useState('');
  const [active, setActive] = useState<'all' | 'on' | 'off'>('all');
  const rewards = list.data?.rewards ?? [];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rewards.filter((r) => {
      if (active === 'on' && !r.active) return false;
      if (active === 'off' && r.active) return false;
      if (!term) return true;
      return [r.reward_code, r.name, r.type].some((v) => String(v ?? '').toLowerCase().includes(term));
    });
  }, [rewards, search, active]);

  return (
    <div>
      <PageHeader
        title="ของรางวัล (Rewards)"
        description="แคตตาล็อกของรางวัล — สมาชิกใช้แต้มแลกเป็นรหัส (โค้ด) ใช้ครั้งเดียวที่จุดขาย"
        actions={<Link href="/loyalty/members"><Button variant="outline"><Users className="size-4" /> สมาชิก</Button></Link>}
      />

      <div className="space-y-6">
        <Card className="gap-4">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4" /> เพิ่มของรางวัล</CardTitle></CardHeader>
          <CardContent>
            <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); setMsg(''); create.mutate(); }}>
              <div className="grid gap-1.5 sm:col-span-2"><Label>ชื่อรางวัล</Label><Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="เช่น คูปองส่วนลด ฿50" required /></div>
              <div className="grid gap-1.5"><Label>ประเภท</Label>
                <select className={selectCls} value={form.type} onChange={(e) => set({ type: e.target.value })}>
                  <option value="evoucher">e-Voucher</option><option value="discount">ส่วนลด</option><option value="product">สินค้า/ของแถม</option><option value="privilege">สิทธิพิเศษ</option>
                </select>
              </div>
              <div className="grid gap-1.5"><Label>ใช้กี่แต้ม</Label><Input type="number" min="1" value={form.point_cost} onChange={(e) => set({ point_cost: +e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>มูลค่า (บาท)</Label><Input type="number" min="0" value={form.cash_value} onChange={(e) => set({ cash_value: +e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>ชนิดคูปอง</Label>
                <select className={selectCls} value={form.coupon_kind} onChange={(e) => set({ coupon_kind: e.target.value })}>
                  <option value="amount">ลดเป็นบาท</option><option value="percent">ลดเป็น %</option><option value="free_item">ของแถม</option>
                </select>
              </div>
              <div className="grid gap-1.5"><Label>มูลค่าคูปอง</Label><Input type="number" min="0" value={form.coupon_value} onChange={(e) => set({ coupon_value: +e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>สต๊อก (ว่าง=ไม่จำกัด)</Label><Input type="number" min="0" value={form.stock} onChange={(e) => set({ stock: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>จำกัด/คน (ว่าง=ไม่จำกัด)</Label><Input type="number" min="1" value={form.per_member_limit} onChange={(e) => set({ per_member_limit: e.target.value })} /></div>
              <div className="flex items-end"><Button type="submit" disabled={!form.name.trim() || create.isPending}>{create.isPending ? 'กำลังบันทึก…' : 'เพิ่มรางวัล'}</Button></div>
            </form>
            {msg && <p className={msg.startsWith('✅') ? 'mt-2 text-sm text-success' : 'mt-2 text-sm text-destructive'}>{msg}</p>}
          </CardContent>
        </Card>

        <StateView q={list}>
          {list.data && (
            <div className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative w-full sm:max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาชื่อ / รหัส / ประเภท…" className="pl-9" aria-label="ค้นหาของรางวัล" inputMode="search" enterKeyHint="search" />
                </div>
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="กรองตามสถานะ">
                  {([['all', 'ทั้งหมด'], ['on', 'เปิด'], ['off', 'ปิด']] as const).map(([v, l]) => (
                    <Button key={v} variant={active === v ? 'secondary' : 'ghost'} size="sm" aria-pressed={active === v} onClick={() => setActive(v)}>{l}</Button>
                  ))}
                </div>
              </div>
            <DataTable
              rows={filtered}
              rowKey={(r) => r.id}
              emptyText={search || active !== 'all' ? 'ไม่พบของรางวัลที่ตรงกับตัวกรอง' : 'ยังไม่มีของรางวัล — เพิ่มด้านบน'}
              columns={[
                { key: 'reward_code', label: 'รหัส', render: (r) => <span className="font-mono text-xs">{r.reward_code}</span> },
                { key: 'name', label: 'ชื่อ', render: (r) => <span className="inline-flex items-center gap-1.5"><Gift className="size-3.5 text-muted-foreground" />{r.name}</span> },
                { key: 'type', label: 'ประเภท', render: (r) => <Badge variant="info">{r.type}</Badge> },
                { key: 'point_cost', label: 'แต้ม', align: 'right', render: (r) => <span className="tabular">{num(r.point_cost)}</span> },
                { key: 'cash_value', label: 'มูลค่า', align: 'right', render: (r) => baht(r.cash_value) },
                { key: 'stock', label: 'สต๊อก', align: 'right', render: (r) => r.stock == null ? '∞' : num(r.stock) },
                { key: 'per_member_limit', label: 'จำกัด/คน', align: 'right', render: (r) => r.per_member_limit == null ? '∞' : num(r.per_member_limit) },
                { key: 'active', label: 'สถานะ', align: 'center', render: (r) => <button onClick={() => toggle.mutate(r)} className="cursor-pointer">{r.active ? <Badge variant="success">เปิด</Badge> : <Badge variant="muted">ปิด</Badge>}</button> },
              ]}
            />
            </div>
          )}
        </StateView>
      </div>
    </div>
  );
}
