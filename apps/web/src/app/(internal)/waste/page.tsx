'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, TriangleAlert, Coins } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notifySuccess, notifyError } from '@/lib/notify';

// W1 — waste / spoilage logging. Reason-coded ingredient waste; costed waste posts Dr 5810 / Cr 1200.
interface Waste { waste_no: string; item_id: string; item_description: string | null; qty: number; uom: string | null; reason_code: string; unit_cost: number; total_cost: number; journal_no: string | null; logged_by: string | null; created_at: string }
interface Resp { waste: Waste[]; count: number; total_qty: number; total_cost: number; by_reason: { reason: string; qty: number; cost: number; count: number }[] }

const REASON_TH: Record<string, string> = { damage: 'ชำรุด/เสียหาย', expiry: 'หมดอายุ', spoilage: 'เน่าเสีย', overproduction: 'ทำเกิน', prep_error: 'เตรียมผิด', other: 'อื่น ๆ' };

export default function WastePage() {
  const qc = useQueryClient();
  const q = useQuery<Resp>({ queryKey: ['waste'], queryFn: () => api('/api/inventory/waste'), refetchInterval: 30_000 });
  const d = q.data;

  const [form, setForm] = useState({ item_id: '', qty: '', reason_code: 'spoilage', unit_cost: '', notes: '' });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const log = useMutation({
    mutationFn: () => api('/api/inventory/waste', { method: 'POST', body: JSON.stringify({
      item_id: form.item_id, qty: Number(form.qty), reason_code: form.reason_code,
      unit_cost: form.unit_cost ? Number(form.unit_cost) : undefined, notes: form.notes || undefined,
    }) }),
    onSuccess: (r: any) => { notifySuccess(`บันทึกของเสีย ${r.waste_no}${r.total_cost ? ` (${baht(r.total_cost)})` : ''}`); setForm({ item_id: '', qty: '', reason_code: 'spoilage', unit_cost: '', notes: '' }); qc.invalidateQueries({ queryKey: ['waste'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <ModulePage
      title="ของเสีย / ทิ้ง (Waste & spoilage)"
      description="บันทึกของเสียพร้อมเหตุผล — ตัดสต๊อกวัตถุดิบ และถ้าระบุต้นทุนจะลงบัญชี Dr 5810 ของเสีย / Cr 1200 สินค้าคงคลัง; ใช้วิเคราะห์ต้นทุนอาหารที่สูญเสีย"
      query={q}
      stats={d && (
        <>
          <StatCard label="มูลค่าของเสีย (รวม)" value={baht(d.total_cost)} icon={Coins} tone={d.total_cost > 0 ? 'warning' : 'success'} />
          <StatCard label="จำนวนรายการ" value={num(d.count)} icon={Trash2} tone="default" />
          <StatCard label="เหตุผลที่เสียมากสุด" value={d.by_reason[0] ? (REASON_TH[d.by_reason[0].reason] ?? d.by_reason[0].reason) : '—'} icon={TriangleAlert} tone={d.by_reason.length ? 'danger' : 'default'} hint={d.by_reason[0] ? baht(d.by_reason[0].cost) : ''} />
          <StatCard label="ปริมาณรวม" value={num(d.total_qty)} icon={Trash2} tone="default" />
        </>
      )}
      statsClassName="xl:grid-cols-4"
    >
      <div className="mb-4 rounded-xl border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">บันทึกของเสีย</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <FormField label="รหัสวัตถุดิบ"><Input value={form.item_id} onChange={(e) => set('item_id', e.target.value)} placeholder="เช่น PORK" /></FormField>
          <FormField label="จำนวน"><Input type="number" min={0} step="any" value={form.qty} onChange={(e) => set('qty', e.target.value)} /></FormField>
          <FormField label="เหตุผล">
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.reason_code} onChange={(e) => set('reason_code', e.target.value)}>
              {Object.entries(REASON_TH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </FormField>
          <FormField label="ต้นทุน/หน่วย (ไม่บังคับ)"><Input type="number" min={0} step="any" value={form.unit_cost} onChange={(e) => set('unit_cost', e.target.value)} placeholder="ถ้าระบุ → ลงบัญชี" /></FormField>
          <div className="flex items-end"><Button disabled={log.isPending || !form.item_id || !form.qty} onClick={() => log.mutate()}>บันทึก</Button></div>
        </div>
      </div>

      {/* by-reason breakdown */}
      {d && d.by_reason.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {d.by_reason.map((r) => (
            <Badge key={r.reason} variant="outline" className="gap-1.5 py-1.5">
              {REASON_TH[r.reason] ?? r.reason}: <strong>{baht(r.cost)}</strong> <span className="text-muted-foreground">({num(r.qty)} · {r.count})</span>
            </Badge>
          ))}
        </div>
      )}

      {d && (
        <DataTable
          rows={d.waste}
          rowKey={(r) => r.waste_no}
          emptyState={{ icon: Trash2, title: 'ยังไม่มีการบันทึกของเสีย', description: 'บันทึกของเสีย/ของหมดอายุจากฟอร์มด้านบนเพื่อตามต้นทุนอาหารที่สูญเสีย' }}
          columns={[
            { key: 'waste_no', label: 'เลขที่', render: (r) => <span className="font-mono text-sm">{r.waste_no}</span> },
            { key: 'item', label: 'วัตถุดิบ', render: (r) => r.item_description || r.item_id },
            { key: 'qty', label: 'จำนวน', align: 'right', render: (r) => `${num(r.qty)}${r.uom ? ' ' + r.uom : ''}` },
            { key: 'reason', label: 'เหตุผล', render: (r) => <Badge variant="muted">{REASON_TH[r.reason_code] ?? r.reason_code}</Badge> },
            { key: 'total_cost', label: 'มูลค่า', align: 'right', render: (r) => r.total_cost > 0 ? baht(r.total_cost) : '—' },
            { key: 'journal_no', label: 'บัญชี', render: (r) => r.journal_no ? <span className="font-mono text-xs">{r.journal_no}</span> : '—' },
            { key: 'created_at', label: 'วันที่', render: (r) => thaiDate(r.created_at) },
          ]}
        />
      )}
    </ModulePage>
  );
}
