'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Calculator } from 'lucide-react';
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
import { Label } from '@/components/ui/label';

const sel = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm';

export default function PricingPage() {
  return (
    <div>
      <PageHeader title="กฎราคา & โปรโมชั่น (Pricing)" description="Happy hour, ส่วนลด %/บาท, ราคาตายตัว, ซื้อ1แถม1, ลดตามจำนวน, ค่าบริการ, ปัดเศษสตางค์" />
      <Tabs tabs={[
        { key: 'rules', label: 'กฎราคา', content: <Rules /> },
        { key: 'quote', label: 'ทดลองคำนวณ', content: <QuotePreview /> },
        { key: 'combo', label: 'ชุดเซ็ต (Combo)', content: <Combos /> },
      ]} />
    </div>
  );
}

function Rules() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['price-rules'], queryFn: () => api('/api/pricing/rules') });
  const [f, setF] = useState<any>({ name: '', type: 'percent', scope: 'item', target_id: '', channel: 'any', dow: '', time_start: '', time_end: '', value: '', min_qty: '1', priority: '100', stackable: false });
  const [msg, setMsg] = useState('');
  const save = useMutation({
    mutationFn: () => api('/api/pricing/rules', { method: 'POST', body: JSON.stringify({ name: f.name, type: f.type, scope: f.scope, target_id: f.target_id || undefined, channel: f.channel, dow: f.dow || undefined, time_start: f.time_start || undefined, time_end: f.time_end || undefined, value: f.value ? Number(f.value) : 0, min_qty: Number(f.min_qty) || 1, priority: Number(f.priority) || 100, stackable: f.stackable }) }),
    onSuccess: () => { setMsg('✅ บันทึกกฎแล้ว'); setF({ ...f, name: '', target_id: '', value: '' }); qc.invalidateQueries({ queryKey: ['price-rules'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/pricing/rules/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['price-rules'] }) });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">เพิ่มกฎราคา</h3>
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-[180px]" placeholder="ชื่อกฎ" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select className={sel} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['percent', 'amount', 'fixed', 'bogo', 'qty_break'].map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <select className={sel} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>{['item', 'category', 'all'].map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <Input className="max-w-[120px]" placeholder="SKU/หมวด" value={f.target_id} onChange={(e) => setF({ ...f, target_id: e.target.value })} />
          <select className={sel} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{['any', 'dine_in', 'takeaway', 'delivery'].map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <Input className="max-w-[90px]" placeholder="ค่า" type="number" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
          <Input className="max-w-[80px]" placeholder="ขั้นต่ำ" type="number" value={f.min_qty} onChange={(e) => setF({ ...f, min_qty: e.target.value })} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input className="max-w-[110px]" placeholder="วัน 1-7" value={f.dow} onChange={(e) => setF({ ...f, dow: e.target.value })} />
          <Input className="max-w-[90px]" placeholder="เริ่ม HH:MM" value={f.time_start} onChange={(e) => setF({ ...f, time_start: e.target.value })} />
          <Input className="max-w-[90px]" placeholder="ถึง HH:MM" value={f.time_end} onChange={(e) => setF({ ...f, time_end: e.target.value })} />
          <Input className="max-w-[90px]" placeholder="ลำดับ" type="number" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} />
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.stackable} onChange={(e) => setF({ ...f, stackable: e.target.checked })} /> ซ้อนได้</label>
          <Button disabled={!f.name || save.isPending} onClick={() => save.mutate()}><Plus className="size-4" /> บันทึก</Button>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable rows={q.data.rules} columns={[
            { key: 'name', label: 'ชื่อ' }, { key: 'type', label: 'ชนิด' }, { key: 'scope', label: 'ขอบเขต' },
            { key: 'target_id', label: 'เป้าหมาย' }, { key: 'channel', label: 'ช่องทาง' },
            { key: 'value', label: 'ค่า', align: 'right' },
            { key: 'window', label: 'เวลา', render: (r: any) => r.time_start ? `${r.time_start}-${r.time_end}` : '—' },
            { key: 'stackable', label: 'ซ้อน', render: (r: any) => r.stackable ? <Badge>ได้</Badge> : '—' },
            { key: 'act', label: '', render: (r: any) => <Button size="sm" variant="destructive" onClick={() => del.mutate(r.id)}><Trash2 className="size-4" /></Button> },
          ]} emptyText="ยังไม่มีกฎราคา" />
        )}
      </StateView>
    </div>
  );
}

interface QLine { sku: string; qty: number; unit_price: number }
function QuotePreview() {
  const [lines, setLines] = useState<QLine[]>([{ sku: '', qty: 1, unit_price: 0 }]);
  const [ctx, setCtx] = useState({ channel: 'any', party_size: '', service_charge_pct: '', rounding: '' });
  const [res, setRes] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const setLine = (i: number, p: Partial<QLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const run = useMutation({
    mutationFn: () => api('/api/pricing/quote', { method: 'POST', body: JSON.stringify({ channel: ctx.channel, party_size: ctx.party_size ? Number(ctx.party_size) : undefined, service_charge_pct: ctx.service_charge_pct ? Number(ctx.service_charge_pct) : undefined, rounding: ctx.rounding ? Number(ctx.rounding) : undefined, lines: lines.filter((l) => l.sku).map((l) => ({ sku: l.sku, qty: Number(l.qty), unit_price: Number(l.unit_price) })) }) }),
    onSuccess: (r: any) => { setRes(r); setMsg(''); }, onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">ทดลองคำนวณราคา</h3>
        {lines.map((l, i) => (
          <div key={i} className="flex gap-2">
            <Input placeholder="SKU" value={l.sku} onChange={(e) => setLine(i, { sku: e.target.value })} />
            <Input className="max-w-[90px]" type="number" placeholder="จำนวน" value={l.qty} onChange={(e) => setLine(i, { qty: +e.target.value })} />
            <Input className="max-w-[110px]" type="number" placeholder="ราคา/หน่วย" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: +e.target.value })} />
            <Button variant="destructive" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, { sku: '', qty: 1, unit_price: 0 }])}><Plus className="size-4" /> เพิ่มรายการ</Button>
        <div className="flex flex-wrap gap-2">
          <select className={sel} value={ctx.channel} onChange={(e) => setCtx({ ...ctx, channel: e.target.value })}>{['any', 'dine_in', 'takeaway', 'delivery'].map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <Input className="max-w-[110px]" type="number" placeholder="จำนวนคน" value={ctx.party_size} onChange={(e) => setCtx({ ...ctx, party_size: e.target.value })} />
          <Input className="max-w-[130px]" type="number" placeholder="ค่าบริการ %" value={ctx.service_charge_pct} onChange={(e) => setCtx({ ...ctx, service_charge_pct: e.target.value })} />
          <Input className="max-w-[120px]" type="number" placeholder="ปัดเศษ" value={ctx.rounding} onChange={(e) => setCtx({ ...ctx, rounding: e.target.value })} />
          <Button disabled={run.isPending || !lines.some((l) => l.sku)} onClick={() => run.mutate()}><Calculator className="size-4" /> คำนวณ</Button>
        </div>
        <Msg ok={false}>{msg}</Msg>
      </Card>
      {res && (
        <Card className="gap-2 p-5">
          <DataTable rows={res.lines} columns={[
            { key: 'sku', label: 'SKU' }, { key: 'qty', label: 'จำนวน', align: 'right' },
            { key: 'gross', label: 'รวม', align: 'right', render: (r: any) => baht(r.gross) },
            { key: 'discount', label: 'ส่วนลด', align: 'right', render: (r: any) => baht(r.discount) },
            { key: 'net', label: 'สุทธิ', align: 'right', render: (r: any) => baht(r.net) },
            { key: 'applied_rules', label: 'กฎที่ใช้', render: (r: any) => (r.applied_rules || []).join(', ') || '—' },
          ]} />
          <div className="space-y-0.5 text-right text-sm">
            <div>ส่วนลดรายการ {baht(res.line_discount_total)} · ส่วนลดบิล {baht(res.order_discount)}</div>
            <div>ค่าบริการ {baht(res.service_charge)} · ปัดเศษ {baht(res.rounding_adjustment)}</div>
            <div className="text-xl">รวมสุทธิ <strong>{baht(res.total)}</strong></div>
          </div>
        </Card>
      )}
    </div>
  );
}

function Combos() {
  const [sku, setSku] = useState('');
  const [comps, setComps] = useState<{ component_sku: string; qty: number; unit_price_override?: number }[]>([{ component_sku: '', qty: 1 }]);
  const [msg, setMsg] = useState('');
  const loaded = useQuery<any>({ queryKey: ['combo', sku], queryFn: () => api(`/api/pricing/combos/${sku}`), enabled: false });
  const save = useMutation({
    mutationFn: () => api(`/api/pricing/combos/${sku}`, { method: 'PUT', body: JSON.stringify({ components: comps.filter((c) => c.component_sku).map((c) => ({ component_sku: c.component_sku, qty: Number(c.qty), unit_price_override: c.unit_price_override != null ? Number(c.unit_price_override) : undefined })) }) }),
    onSuccess: (r: any) => setMsg(`✅ บันทึกชุด ${r.combo_sku} (${r.components} รายการ)`), onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const setComp = (i: number, p: any) => setComps((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));
  return (
    <Card className="gap-3 p-5">
      <h3 className="text-base font-semibold">กำหนดส่วนประกอบของชุดเซ็ต</h3>
      <div className="flex gap-2">
        <Input className="max-w-[180px]" placeholder="SKU ชุดเซ็ต" value={sku} onChange={(e) => setSku(e.target.value)} />
        <Button variant="outline" disabled={!sku} onClick={async () => { const r = await loaded.refetch(); if (r.data?.components?.length) setComps(r.data.components); }}>โหลด</Button>
      </div>
      {comps.map((c, i) => (
        <div key={i} className="flex gap-2">
          <Input placeholder="SKU ส่วนประกอบ" value={c.component_sku} onChange={(e) => setComp(i, { component_sku: e.target.value })} />
          <Input className="max-w-[90px]" type="number" placeholder="จำนวน" value={c.qty} onChange={(e) => setComp(i, { qty: +e.target.value })} />
          <Input className="max-w-[130px]" type="number" placeholder="ราคา (เลือก)" value={c.unit_price_override ?? ''} onChange={(e) => setComp(i, { unit_price_override: e.target.value ? +e.target.value : undefined })} />
          <Button variant="destructive" size="icon" onClick={() => setComps((cs) => cs.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={() => setComps((cs) => [...cs, { component_sku: '', qty: 1 }])}><Plus className="size-4" /> เพิ่มส่วนประกอบ</Button>
      <Button className="w-fit" disabled={!sku || save.isPending} onClick={() => save.mutate()}>บันทึกชุดเซ็ต</Button>
      <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
    </Card>
  );
}
