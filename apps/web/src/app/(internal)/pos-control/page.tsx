'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
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
import { statusVariant } from '@/components/ui';

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

const ACTION_OPTS: [string, string][] = [['void', 'ยกเลิกบิล (void)'], ['discount', 'ส่วนลด'], ['price_override', 'แก้ราคา'], ['no_sale', 'เปิดลิ้นชัก (no sale)'], ['return', 'คืนสินค้า']];
const APPLIES_OPTS: [string, string][] = [['all', 'ทั้งหมด'], ['void', 'ยกเลิก'], ['discount', 'ส่วนลด'], ['price_override', 'แก้ราคา'], ['no_sale', 'เปิดลิ้นชัก'], ['return', 'คืนสินค้า'], ['refund', 'คืนเงิน'], ['paid_out', 'จ่ายออก']];

function Field({ label, htmlFor, hint, className, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function PosControlPage() {
  return (
    <div>
      <PageHeader title="ควบคุม POS (พักบิล & อนุมัติ)" description="บิลที่พักไว้ (park/recall), การอนุมัติของผู้จัดการ, รหัสเหตุผล และบันทึกการตรวจสอบ (audit)" />
      <Tabs tabs={[
        { key: 'held', label: 'บิลที่พัก', content: <Held /> },
        { key: 'override', label: 'การอนุมัติ', content: <Overrides /> },
        { key: 'reasons', label: 'รหัสเหตุผล', content: <ReasonCodes /> },
        { key: 'audit', label: 'บันทึกตรวจสอบ', content: <AuditLog /> },
      ]} />
    </div>
  );
}

function ReasonCodes() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['reason-codes'], queryFn: () => api('/api/pos/audit/reason-codes') });
  const [f, setF] = useState({ code: '', label: '', applies_to: 'all' });
  const [msg, setMsg] = useState('');
  const save = useMutation({
    mutationFn: () => api('/api/pos/audit/reason-codes', { method: 'POST', body: JSON.stringify({ code: f.code, label: f.label, applies_to: f.applies_to }) }),
    onSuccess: () => { setMsg('✅ บันทึกแล้ว'); setF({ code: '', label: '', applies_to: 'all' }); qc.invalidateQueries({ queryKey: ['reason-codes'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/pos/audit/reason-codes/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['reason-codes'] }) });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">เพิ่มรหัสเหตุผล</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="รหัส" htmlFor="rc-code"><Input id="rc-code" placeholder="เช่น VOID01" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
            <Field label="คำอธิบาย" htmlFor="rc-label"><Input id="rc-label" placeholder="เช่น ลูกค้ายกเลิก" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
            <Field label="ใช้กับ" htmlFor="rc-applies">
              <select id="rc-applies" className={selectCls} value={f.applies_to} onChange={(e) => setF({ ...f, applies_to: e.target.value })}>{APPLIES_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </Field>
          </div>
          <Button disabled={!f.code || !f.label || save.isPending} onClick={() => { setMsg(''); save.mutate(); }}>{save.isPending ? 'กำลังบันทึก…' : 'บันทึก'}</Button>
          {msg && <Msg ok={msg.startsWith('✅')}>{msg}</Msg>}
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.reason_codes} rowKey={(r: any) => r.id} columns={[
          { key: 'code', label: 'รหัส' }, { key: 'label', label: 'คำอธิบาย' },
          { key: 'applies_to', label: 'ใช้กับ', render: (r: any) => APPLIES_OPTS.find(([v]) => v === r.applies_to)?.[1] ?? r.applies_to },
          { key: 'act', label: '', sortable: false, render: (r: any) => <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate(r.id)}>ปิดใช้</Button> },
        ]} emptyText="ยังไม่มีรหัสเหตุผล" />}
      </StateView>
    </div>
  );
}

function AuditLog() {
  const q = useQuery<any>({ queryKey: ['pos-audit'], queryFn: () => api('/api/pos/audit?limit=100') });
  return (
    <StateView q={q}>
      {q.data && <DataTable rows={q.data.entries} columns={[
        { key: 'ts', label: 'เวลา', render: (r: any) => thaiDate(r.ts) },
        { key: 'actor', label: 'ผู้ทำ' },
        { key: 'action', label: 'การทำงาน', render: (r: any) => <Badge variant={statusVariant('open')}>{r.action}</Badge> },
        { key: 'entity_id', label: 'อ้างอิง' },
        { key: 'meta', label: 'เหตุผล/ผู้อนุมัติ', render: (r: any) => r.meta ? `${r.meta.reason_code ?? ''} ${r.meta.approved_by ? '· ' + r.meta.approved_by : ''}`.trim() || '—' : '—' },
      ]} emptyText="ยังไม่มีบันทึกตรวจสอบ" />}
    </StateView>
  );
}

function Held() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['held'], queryFn: () => api('/api/pos/held') });
  const act = useMutation({ mutationFn: (v: { no: string; op: string }) => api(`/api/pos/held/${v.no}/${v.op}`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['held'] }), onError: (e: any) => toast.error(e.message) });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable
          rows={q.data.held}
          rowKey={(r: any) => r.hold_no}
          columns={[
            { key: 'hold_no', label: 'เลขที่' },
            { key: 'label', label: 'ป้าย/โต๊ะ' },
            { key: 'customer_name', label: 'ลูกค้า', render: (r: any) => r.customer_name || '—' },
            { key: 'created_by', label: 'พักโดย' },
            { key: 'created_at', label: 'เวลา', render: (r: any) => thaiDate(r.created_at) },
            { key: 'act', label: '', sortable: false, render: (r: any) => <div className="flex gap-1"><Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ no: r.hold_no, op: 'recall' })}>เรียกคืน</Button><Button size="sm" variant="destructive" onClick={() => { if (window.confirm(`ทิ้งบิลที่พักไว้ ${r.hold_no}? การกระทำนี้ย้อนกลับไม่ได้`)) act.mutate({ no: r.hold_no, op: 'discard' }); }}>ทิ้ง</Button></div> },
          ]}
          emptyText="ไม่มีบิลที่พักไว้"
        />
      )}
    </StateView>
  );
}

function Overrides() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['overrides'], queryFn: () => api('/api/pos/overrides') });
  const [f, setF] = useState({ action: 'discount', sale_no: '', amount: '', reason: '', approved_by: '' });
  const [msg, setMsg] = useState('');
  const isVoid = f.action === 'void';
  const create = useMutation({
    mutationFn: () => api('/api/pos/override', { method: 'POST', body: JSON.stringify({ action: f.action, sale_no: f.sale_no || undefined, amount: f.amount ? Number(f.amount) : undefined, reason: f.reason || undefined, approved_by: f.approved_by || undefined }) }),
    onSuccess: (r: any) => { setMsg(`✅ บันทึก ${r.override_no}`); setF({ action: 'discount', sale_no: '', amount: '', reason: '', approved_by: '' }); qc.invalidateQueries({ queryKey: ['overrides'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">บันทึกการอนุมัติ</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="ประเภท" htmlFor="ov-action">
              <select id="ov-action" className={selectCls} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>{ACTION_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </Field>
            <Field label="เลขที่บิล" htmlFor="ov-sale"><Input id="ov-sale" placeholder="SALE-…" value={f.sale_no} onChange={(e) => setF({ ...f, sale_no: e.target.value })} /></Field>
            <Field label="จำนวน (บาท)" htmlFor="ov-amt"><Input id="ov-amt" type="number" inputMode="decimal" placeholder="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label={<>เหตุผล {isVoid && <span className="text-destructive">*</span>}</>} htmlFor="ov-reason"><Input id="ov-reason" placeholder="เหตุผลการอนุมัติ" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
            <Field label={<>ผู้อนุมัติ {isVoid && <span className="text-destructive">*</span>}</>} htmlFor="ov-appr"><Input id="ov-appr" placeholder="ชื่อผู้จัดการที่อนุมัติ" value={f.approved_by} onChange={(e) => setF({ ...f, approved_by: e.target.value })} /></Field>
          </div>
          {isVoid && <p className="text-xs text-muted-foreground">การยกเลิก (void) ย้อนกลับการขาย — ต้องระบุ <strong>เหตุผล</strong> และ <strong>ผู้อนุมัติ</strong> และยืนยันก่อนบันทึก</p>}
          <Button disabled={create.isPending} onClick={() => {
            setMsg('');
            // A void reverses a sale — require a reason + approver and confirm before recording.
            if (f.action === 'void') {
              if (!f.reason.trim() || !f.approved_by.trim()) { setMsg('❌ การยกเลิก (void) ต้องระบุเหตุผลและผู้อนุมัติ'); return; }
              if (!window.confirm(`ยืนยันการยกเลิกบิล ${f.sale_no || '(ไม่ระบุ)'}? การกระทำนี้ย้อนกลับไม่ได้`)) return;
            }
            create.mutate();
          }}>{create.isPending ? 'กำลังบันทึก…' : 'บันทึก'}</Button>
          {msg && <Msg ok={msg.startsWith('✅')}>{msg}</Msg>}
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.overrides}
            rowKey={(r: any) => r.override_no}
            columns={[
              { key: 'override_no', label: 'เลขที่' },
              { key: 'action', label: 'การทำงาน', render: (r: any) => ACTION_OPTS.find(([v]) => v === r.action)?.[1] ?? r.action },
              { key: 'sale_no', label: 'บิล', render: (r: any) => r.sale_no || '—' },
              { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => r.amount != null ? <span className="tabular">{baht(r.amount)}</span> : '—' },
              { key: 'reason', label: 'เหตุผล', render: (r: any) => r.reason || '—' },
              { key: 'requested_by', label: 'ขอโดย' },
              { key: 'approved_by', label: 'อนุมัติโดย', render: (r: any) => r.approved_by || '—' },
            ]}
            emptyText="ยังไม่มีรายการอนุมัติ"
          />
        )}
      </StateView>
    </div>
  );
}
