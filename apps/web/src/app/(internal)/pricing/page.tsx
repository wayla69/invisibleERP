'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calculator, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const sel = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

// Enum value → Thai label. The raw value is what we submit; the label is only for display.
const TYPE_OPTS: [string, string][] = [['percent', 'ส่วนลด %'], ['amount', 'ส่วนลด (บาท)'], ['fixed', 'ราคาตายตัว'], ['bogo', 'ซื้อ 1 แถม 1'], ['qty_break', 'ลดตามจำนวน']];
const SCOPE_OPTS: [string, string][] = [['item', 'รายสินค้า (SKU)'], ['category', 'หมวดหมู่'], ['all', 'ทั้งบิล']];
const CHANNEL_OPTS: [string, string][] = [['any', 'ทุกช่องทาง'], ['dine_in', 'ทานที่ร้าน'], ['takeaway', 'กลับบ้าน'], ['delivery', 'เดลิเวอรี']];
const labelOf = (opts: [string, string][], v: string) => opts.find(([k]) => k === v)?.[1] ?? v;

/** Labelled form field — a label tied to its control, with an optional helper line. */
function Field({ label, htmlFor, hint, className, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function LabeledSelect({ id, value, onChange, options }: { id: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <select id={id} className={cn(sel, 'w-full')} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

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
  const set = (p: Record<string, unknown>) => setF((cur: any) => ({ ...cur, ...p }));
  const save = useMutation({
    mutationFn: () => api('/api/pricing/rules', { method: 'POST', body: JSON.stringify({ name: f.name, type: f.type, scope: f.scope, target_id: f.target_id || undefined, channel: f.channel, dow: f.dow || undefined, time_start: f.time_start || undefined, time_end: f.time_end || undefined, value: f.value ? Number(f.value) : 0, min_qty: Number(f.min_qty) || 1, priority: Number(f.priority) || 100, stackable: f.stackable }) }),
    onSuccess: () => { setMsg('✅ บันทึกกฎแล้ว'); setF({ ...f, name: '', target_id: '', value: '' }); qc.invalidateQueries({ queryKey: ['price-rules'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/pricing/rules/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['price-rules'] }) });

  // The "value" field means different things per type — hint accordingly.
  const valueHint = f.type === 'percent' ? 'เป็นเปอร์เซ็นต์ (เช่น 10 = 10%)'
    : f.type === 'amount' ? 'ส่วนลดเป็นบาท' : f.type === 'fixed' ? 'ราคาขายใหม่ (บาท)' : 'ระบุค่าตามชนิดกฎ';
  const targetDisabled = f.scope === 'all';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">เพิ่มกฎราคา</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            onSubmit={(e) => { e.preventDefault(); setMsg(''); if (f.name && !save.isPending) save.mutate(); }}
          >
            <Field label={<>ชื่อกฎ <span className="text-destructive">*</span></>} htmlFor="pr-name" className="sm:col-span-2 lg:col-span-1">
              <Input id="pr-name" placeholder="เช่น Happy Hour −20%" value={f.name} onChange={(e) => set({ name: e.target.value })} required />
            </Field>
            <Field label="ชนิดกฎ" htmlFor="pr-type">
              <LabeledSelect id="pr-type" value={f.type} onChange={(v) => set({ type: v })} options={TYPE_OPTS} />
            </Field>
            <Field label="ขอบเขต" htmlFor="pr-scope">
              <LabeledSelect id="pr-scope" value={f.scope} onChange={(v) => set({ scope: v })} options={SCOPE_OPTS} />
            </Field>
            <Field label="เป้าหมาย (SKU / หมวด)" htmlFor="pr-target" hint={targetDisabled ? 'ใช้กับทั้งบิล — ไม่ต้องระบุ' : undefined}>
              <Input id="pr-target" placeholder="เช่น SKU001 หรือ เครื่องดื่ม" value={f.target_id} disabled={targetDisabled} onChange={(e) => set({ target_id: e.target.value })} />
            </Field>
            <Field label="ช่องทาง" htmlFor="pr-channel">
              <LabeledSelect id="pr-channel" value={f.channel} onChange={(v) => set({ channel: v })} options={CHANNEL_OPTS} />
            </Field>
            <Field label="ค่า" htmlFor="pr-value" hint={valueHint}>
              <Input id="pr-value" type="number" inputMode="decimal" step="0.01" placeholder="0" value={f.value} onChange={(e) => set({ value: e.target.value })} />
            </Field>
            <Field label="จำนวนขั้นต่ำ" htmlFor="pr-minqty" hint="ต้องซื้ออย่างน้อยกี่ชิ้นจึงมีผล">
              <Input id="pr-minqty" type="number" inputMode="numeric" min={1} placeholder="1" value={f.min_qty} onChange={(e) => set({ min_qty: e.target.value })} />
            </Field>
            <Field label="วันที่ใช้ (1–7)" htmlFor="pr-dow" hint="เช่น 1,3,5 — เว้นว่าง = ทุกวัน">
              <Input id="pr-dow" placeholder="ทุกวัน" value={f.dow} onChange={(e) => set({ dow: e.target.value })} />
            </Field>
            <Field label="เวลาเริ่ม" htmlFor="pr-tstart" hint="เว้นว่าง = ทั้งวัน">
              <Input id="pr-tstart" type="time" value={f.time_start} onChange={(e) => set({ time_start: e.target.value })} />
            </Field>
            <Field label="เวลาสิ้นสุด" htmlFor="pr-tend">
              <Input id="pr-tend" type="time" value={f.time_end} onChange={(e) => set({ time_end: e.target.value })} />
            </Field>
            <Field label="ลำดับความสำคัญ" htmlFor="pr-priority" hint="เลขน้อย = มาก่อน">
              <Input id="pr-priority" type="number" inputMode="numeric" placeholder="100" value={f.priority} onChange={(e) => set({ priority: e.target.value })} />
            </Field>
            <div className="flex items-end">
              <label className="flex h-9 items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-primary" checked={f.stackable} onChange={(e) => set({ stackable: e.target.checked })} />
                ซ้อนกับกฎอื่นได้
              </label>
            </div>
          </form>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!f.name || save.isPending} onClick={() => { setMsg(''); save.mutate(); }}>
              <Plus className="size-4" /> {save.isPending ? 'กำลังบันทึก…' : 'บันทึกกฎ'}
            </Button>
            {!f.name && <span className="text-xs text-muted-foreground">กรอกชื่อกฎก่อนบันทึก</span>}
          </div>
          {msg && <Msg ok={msg.startsWith('✅')}>{msg}</Msg>}
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.rules}
            rowKey={(r: any) => r.id}
            emptyText="ยังไม่มีกฎราคา — เพิ่มด้านบน"
            columns={[
              { key: 'name', label: 'ชื่อ' },
              { key: 'type', label: 'ชนิด', render: (r: any) => labelOf(TYPE_OPTS, r.type) },
              { key: 'scope', label: 'ขอบเขต', render: (r: any) => labelOf(SCOPE_OPTS, r.scope) },
              { key: 'target_id', label: 'เป้าหมาย', render: (r: any) => r.target_id || '—' },
              { key: 'channel', label: 'ช่องทาง', render: (r: any) => labelOf(CHANNEL_OPTS, r.channel) },
              { key: 'value', label: 'ค่า', align: 'right', render: (r: any) => <span className="tabular">{r.value ?? '—'}</span> },
              { key: 'window', label: 'เวลา', render: (r: any) => r.time_start ? `${r.time_start}–${r.time_end}` : '—' },
              { key: 'stackable', label: 'ซ้อน', align: 'center', render: (r: any) => r.stackable ? <Badge>ได้</Badge> : <span className="text-muted-foreground">—</span> },
              { key: 'act', label: '', sortable: false, render: (r: any) => <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" aria-label={`ลบกฎ ${r.name}`} disabled={del.isPending} onClick={() => del.mutate(r.id)}><Trash2 className="size-4" /></Button> },
            ]}
          />
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
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ทดลองคำนวณราคา</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="hidden grid-cols-[2fr_1fr_1fr_auto] gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid">
              <span>SKU</span><span className="text-right">จำนวน</span><span className="text-right">ราคา/หน่วย</span><span className="w-9" />
            </div>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-center">
                <Input className="col-span-2 sm:col-span-1" placeholder="SKU" aria-label={`SKU รายการที่ ${i + 1}`} value={l.sku} onChange={(e) => setLine(i, { sku: e.target.value })} />
                <Input type="number" inputMode="numeric" className="text-right tabular" placeholder="จำนวน" aria-label={`จำนวน รายการที่ ${i + 1}`} value={l.qty} onChange={(e) => setLine(i, { qty: +e.target.value })} />
                <Input type="number" inputMode="decimal" className="text-right tabular" placeholder="ราคา/หน่วย" aria-label={`ราคาต่อหน่วย รายการที่ ${i + 1}`} value={l.unit_price} onChange={(e) => setLine(i, { unit_price: +e.target.value })} />
                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label={`ลบรายการที่ ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
              </div>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, { sku: '', qty: 1, unit_price: 0 }])}><Plus className="size-4" /> เพิ่มรายการ</Button>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="ช่องทาง" htmlFor="q-channel">
              <LabeledSelect id="q-channel" value={ctx.channel} onChange={(v) => setCtx({ ...ctx, channel: v })} options={CHANNEL_OPTS} />
            </Field>
            <Field label="จำนวนคน" htmlFor="q-party" hint="สำหรับค่าบริการกลุ่มใหญ่">
              <Input id="q-party" type="number" inputMode="numeric" placeholder="—" value={ctx.party_size} onChange={(e) => setCtx({ ...ctx, party_size: e.target.value })} />
            </Field>
            <Field label="ค่าบริการ %" htmlFor="q-svc">
              <Input id="q-svc" type="number" inputMode="decimal" placeholder="—" value={ctx.service_charge_pct} onChange={(e) => setCtx({ ...ctx, service_charge_pct: e.target.value })} />
            </Field>
            <Field label="ปัดเศษ (บาท)" htmlFor="q-round" hint="เช่น 1 = ปัดเป็นบาท">
              <Input id="q-round" type="number" inputMode="decimal" placeholder="—" value={ctx.rounding} onChange={(e) => setCtx({ ...ctx, rounding: e.target.value })} />
            </Field>
          </div>
          <Button disabled={run.isPending || !lines.some((l) => l.sku)} onClick={() => { setMsg(''); run.mutate(); }}>
            <Calculator className="size-4" /> {run.isPending ? 'กำลังคำนวณ…' : 'คำนวณ'}
          </Button>
          {msg && <Msg ok={false}>{msg}</Msg>}
        </CardContent>
      </Card>
      {res && (
        <Card className="gap-2 p-5">
          <DataTable
            rows={res.lines}
            rowKey={(r: any, i) => `${r.sku}-${i}`}
            columns={[
              { key: 'sku', label: 'SKU' },
              { key: 'qty', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{r.qty}</span> },
              { key: 'gross', label: 'รวม', align: 'right', render: (r: any) => baht(r.gross) },
              { key: 'discount', label: 'ส่วนลด', align: 'right', render: (r: any) => baht(r.discount) },
              { key: 'net', label: 'สุทธิ', align: 'right', render: (r: any) => baht(r.net) },
              { key: 'applied_rules', label: 'กฎที่ใช้', render: (r: any) => (r.applied_rules || []).join(', ') || '—' },
            ]}
          />
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">กำหนดส่วนประกอบของชุดเซ็ต (Combo)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="SKU ชุดเซ็ต" htmlFor="cb-sku" className="w-full sm:max-w-[220px]">
            <Input id="cb-sku" placeholder="เช่น SET001" value={sku} onChange={(e) => setSku(e.target.value)} />
          </Field>
          <Button variant="outline" disabled={!sku} onClick={async () => { const r = await loaded.refetch(); if (r.data?.components?.length) setComps(r.data.components); }}>โหลดชุดเดิม</Button>
        </div>
        <div className="space-y-2">
          <div className="hidden grid-cols-[2fr_1fr_1fr_auto] gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid">
            <span>SKU ส่วนประกอบ</span><span className="text-right">จำนวน</span><span className="text-right">ราคา (เลือก)</span><span className="w-9" />
          </div>
          {comps.map((c, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-center">
              <Input className="col-span-2 sm:col-span-1" placeholder="SKU ส่วนประกอบ" aria-label={`SKU ส่วนประกอบที่ ${i + 1}`} value={c.component_sku} onChange={(e) => setComp(i, { component_sku: e.target.value })} />
              <Input type="number" inputMode="numeric" className="text-right tabular" placeholder="จำนวน" aria-label={`จำนวน ส่วนประกอบที่ ${i + 1}`} value={c.qty} onChange={(e) => setComp(i, { qty: +e.target.value })} />
              <Input type="number" inputMode="decimal" className="text-right tabular" placeholder="ราคา (เลือก)" aria-label={`ราคา ส่วนประกอบที่ ${i + 1}`} value={c.unit_price_override ?? ''} onChange={(e) => setComp(i, { unit_price_override: e.target.value ? +e.target.value : undefined })} />
              <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label={`ลบส่วนประกอบที่ ${i + 1}`} onClick={() => setComps((cs) => cs.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setComps((cs) => [...cs, { component_sku: '', qty: 1 }])}><Plus className="size-4" /> เพิ่มส่วนประกอบ</Button>
          <Button disabled={!sku || save.isPending} onClick={() => { setMsg(''); save.mutate(); }}>{save.isPending ? 'กำลังบันทึก…' : 'บันทึกชุดเซ็ต'}</Button>
        </div>
        {msg && <Msg ok={msg.startsWith('✅')}>{msg}</Msg>}
      </CardContent>
    </Card>
  );
}
