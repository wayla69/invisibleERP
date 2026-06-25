'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Disc3, Plus, Trash2, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

interface Segment { id?: number; label: string; prize_kind: string; prize_points: number; coupon_kind?: string; coupon_value?: number; weight: number; stock: number | null; won_count?: number }
interface Wheel { id: number; wheel_code: string; name: string; cost_points: number; daily_free_spins: number; active: boolean; segments: Segment[] }

const emptySeg = (): Segment => ({ label: '', prize_kind: 'points', prize_points: 10, weight: 1, stock: null });

export default function WheelsPage() {
  const qc = useQueryClient();
  const list = useQuery<{ wheels: Wheel[]; count: number }>({ queryKey: ['loy-wheels'], queryFn: () => api('/api/loyalty/wheels') });

  const [name, setName] = useState('');
  const [cost, setCost] = useState(0);
  const [freeSpins, setFreeSpins] = useState(1);
  const [segs, setSegs] = useState<Segment[]>([{ label: 'รางวัลใหญ่', prize_kind: 'points', prize_points: 100, weight: 1, stock: 10 }, { label: 'แต้มปลอบใจ', prize_kind: 'points', prize_points: 5, weight: 5, stock: null }, { label: 'เสียใจด้วย', prize_kind: 'none', prize_points: 0, weight: 4, stock: null }]);
  const [msg, setMsg] = useState('');
  const setSeg = (i: number, p: Partial<Segment>) => setSegs((a) => a.map((s, j) => (j === i ? { ...s, ...p } : s)));

  const create = useMutation({
    mutationFn: () => api('/api/loyalty/wheels', { method: 'POST', body: JSON.stringify({
      name, cost_points: Number(cost), daily_free_spins: Number(freeSpins),
      segments: segs.map((s) => ({ label: s.label, prize_kind: s.prize_kind, prize_points: Number(s.prize_points) || 0, coupon_kind: s.coupon_kind, coupon_value: Number(s.coupon_value) || 0, weight: Number(s.weight) || 0, stock: s.stock === null || (s.stock as any) === '' ? null : Number(s.stock) })),
    }) }),
    onSuccess: () => { setMsg('✅ สร้างวงล้อแล้ว'); setName(''); qc.invalidateQueries({ queryKey: ['loy-wheels'] }); },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });
  const toggle = useMutation({ mutationFn: (w: Wheel) => api(`/api/loyalty/wheels/${w.id}`, { method: 'PATCH', body: JSON.stringify({ active: !w.active }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-wheels'] }) });

  const totalWeight = segs.reduce((a, s) => a + (Number(s.weight) || 0), 0);

  return (
    <div>
      <PageHeader title="วงล้อนำโชค (Spin-the-wheel)" description="ตั้งค่าวงล้อลุ้นรางวัล — สมาชิกใช้แต้ม (หรือสิทธิ์ฟรีรายวัน) หมุนลุ้น โอกาสออกตามน้ำหนัก (provably-fair)" actions={<Link href="/loyalty/members"><Button variant="outline"><Users className="size-4" /> สมาชิก</Button></Link>} />

      <div className="space-y-6">
        <Card className="gap-4">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4" /> สร้างวงล้อ</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5 sm:col-span-1"><Label>ชื่อวงล้อ</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="วงล้อปีใหม่" /></div>
              <div className="grid gap-1.5"><Label>ใช้แต้ม/ครั้ง (0=ฟรี)</Label><Input type="number" min="0" value={cost} onChange={(e) => setCost(+e.target.value)} /></div>
              <div className="grid gap-1.5"><Label>ฟรี/วัน (ครั้ง)</Label><Input type="number" min="0" value={freeSpins} onChange={(e) => setFreeSpins(+e.target.value)} /></div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between"><Label>ช่องรางวัล (น้ำหนักรวม {totalWeight})</Label><Button type="button" size="sm" variant="outline" onClick={() => setSegs((a) => [...a, emptySeg()])}><Plus className="size-3.5" /> เพิ่มช่อง</Button></div>
              <div className="hidden grid-cols-6 gap-2 px-2 text-xs font-medium text-muted-foreground sm:grid">
                <span className="col-span-2">ป้ายรางวัล</span><span>ชนิด</span><span>มูลค่า</span><span>น้ำหนัก</span><span>สต๊อก</span>
              </div>
              {segs.map((s, i) => (
                <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-border/60 p-2 sm:grid-cols-6">
                  <Input className="sm:col-span-2" value={s.label} onChange={(e) => setSeg(i, { label: e.target.value })} placeholder="ป้ายรางวัล" aria-label={`ป้ายรางวัล ช่องที่ ${i + 1}`} />
                  <select className={selectCls} value={s.prize_kind} onChange={(e) => setSeg(i, { prize_kind: e.target.value })} aria-label={`ชนิดรางวัล ช่องที่ ${i + 1}`}><option value="points">แต้ม</option><option value="coupon">คูปอง</option><option value="none">ไม่ได้</option></select>
                  <Input type="number" inputMode="numeric" min="0" value={s.prize_kind === 'points' ? s.prize_points : (s.coupon_value ?? 0)} onChange={(e) => setSeg(i, s.prize_kind === 'points' ? { prize_points: +e.target.value } : { coupon_value: +e.target.value })} placeholder="มูลค่า" title="มูลค่า (แต้ม/คูปอง)" aria-label={`มูลค่า ช่องที่ ${i + 1}`} />
                  <Input type="number" inputMode="numeric" min="0" value={s.weight} onChange={(e) => setSeg(i, { weight: +e.target.value })} placeholder="น้ำหนัก" title="น้ำหนัก (โอกาส)" aria-label={`น้ำหนัก ช่องที่ ${i + 1}`} />
                  <div className="flex items-center gap-1">
                    <Input type="number" inputMode="numeric" min="0" value={s.stock ?? ''} onChange={(e) => setSeg(i, { stock: e.target.value === '' ? null : +e.target.value })} placeholder="สต๊อก ∞" title="สต๊อก (ว่าง=ไม่จำกัด)" aria-label={`สต๊อก ช่องที่ ${i + 1}`} />
                    {segs.length > 1 && <button type="button" onClick={() => setSegs((a) => a.filter((_, j) => j !== i))} aria-label={`ลบช่องที่ ${i + 1}`} className="text-muted-foreground hover:text-destructive"><Trash2 className="size-4" /></button>}
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">โอกาสออก = น้ำหนักช่อง ÷ น้ำหนักรวม (เฉพาะช่องที่ยังมีสต๊อก). ปล่อยสต๊อกว่าง = ไม่จำกัด.</p>
            </div>
            <div className="flex items-center gap-3"><Button onClick={() => { setMsg(''); create.mutate(); }} disabled={!name.trim() || totalWeight <= 0 || create.isPending}>{create.isPending ? 'กำลังสร้าง…' : 'สร้างวงล้อ'}</Button>{msg && <span className={msg.startsWith('✅') ? 'text-sm text-success' : 'text-sm text-destructive'}>{msg}</span>}</div>
          </CardContent>
        </Card>

        <StateView q={list}>
          {list.data?.wheels?.map((w) => (
            <Card key={w.id} className="gap-3">
              <CardHeader className="pb-0"><CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2"><Disc3 className="size-4" /> {w.name} <span className="font-mono text-xs text-muted-foreground">{w.wheel_code}</span></span>
                <span className="flex items-center gap-2 text-sm font-normal text-muted-foreground">{w.cost_points > 0 ? `${num(w.cost_points)} แต้ม/ครั้ง` : 'ฟรี'} · ฟรี {w.daily_free_spins}/วัน
                  <button onClick={() => toggle.mutate(w)}>{w.active ? <Badge variant="success">เปิด</Badge> : <Badge variant="muted">ปิด</Badge>}</button></span>
              </CardTitle></CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {w.segments.map((s) => (
                    <div key={s.id} className="rounded-lg border border-border/60 px-3 py-1.5 text-xs">
                      <span className="font-medium">{s.label}</span> · {s.prize_kind === 'points' ? `${num(s.prize_points)} แต้ม` : s.prize_kind === 'coupon' ? `คูปอง ${num(s.coupon_value ?? 0)}` : 'ไม่ได้'} · น้ำหนัก {s.weight} · {s.stock == null ? 'สต๊อก ∞' : `เหลือ ${num(s.stock)}`} · ออก {num(s.won_count ?? 0)}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </StateView>
      </div>
    </div>
  );
}
