'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, FilePlus2, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring';

// Subcontractor management (docs/35 P2, PROJ-16). A subcontract reserves BoQ budget; the subcontractor's
// valuations are certified maker-checker → AP + WIP + retention payable + WHT.
export default function SubcontractsPage() {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [active, setActive] = useState('');
  const subs = useQuery<any>({ queryKey: ['subcon', active], queryFn: () => api(`/api/subcontracts/project/${active}`), enabled: !!active });
  const boq = useQuery<any>({ queryKey: ['subcon-boq', active], queryFn: () => api(`/api/projects/${active}/boq`), enabled: !!active });
  const [f, setF] = useState({ vendor_name: '', boq_line_id: '', amount: '', retention_pct: '10', wht_pct: '3' });
  const [vals, setVals] = useState<Record<string, string>>({}); // subcontract_no → draft valuation_no
  const refresh = () => qc.invalidateQueries({ queryKey: ['subcon', active] });

  const create = useMutation({
    mutationFn: () => api('/api/subcontracts', { method: 'POST', body: JSON.stringify({ project_code: active, vendor_name: f.vendor_name || undefined, retention_pct: Number(f.retention_pct) || 0, wht_pct: Number(f.wht_pct) || 0, scope: [{ boq_line_id: Number(f.boq_line_id), amount: Number(f.amount) || 0 }] }) }),
    onSuccess: () => { notifySuccess('สร้างสัญญาผู้รับเหมาช่วงแล้ว (ผูกงบ BoQ)'); setF({ vendor_name: '', boq_line_id: '', amount: '', retention_pct: '10', wht_pct: '3' }); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const raiseVal = useMutation({
    mutationFn: (v: { subNo: string; pct: number }) => api(`/api/subcontracts/${v.subNo}/valuations`, { method: 'POST', body: JSON.stringify({ pct_complete: v.pct }) }),
    onSuccess: (d: any, v) => { setVals((s) => ({ ...s, [v.subNo]: d.valuation_no })); notifySuccess(`สร้างงวด ${d.valuation_no} (ร่าง) — รอผู้มีอำนาจรับรอง`); },
    onError: (e: any) => notifyError(e.message),
  });
  const certifyVal = useMutation({
    mutationFn: (valNo: string) => api(`/api/subcontracts/valuations/${valNo}/certify`, { method: 'POST' }),
    onSuccess: (_d, valNo) => { notifySuccess('รับรองงวดแล้ว — ลงบัญชี AP/WIP/ประกันผลงาน/WHT'); setVals((s) => { const n = { ...s }; Object.keys(n).forEach((k) => n[k] === valNo && delete n[k]); return n; }); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const d = subs.data;
  return (
    <div>
      <PageHeader title="ผู้รับเหมาช่วง (Subcontracts)" description="ผูกงบ BoQ · งวดงานผู้รับเหมาช่วง maker-checker · หักประกันผลงาน + ภาษี ณ ที่จ่าย (PROJ-16)" />
      <Card className="mb-5 flex flex-wrap items-end gap-3 p-5">
        <div className="grid gap-1.5"><Label>รหัสโครงการ</Label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="PRJ-…" /></div>
        <Button variant="outline" onClick={() => setActive(code.trim())} disabled={!code.trim()}><Search className="size-4" /> เปิดโครงการ</Button>
      </Card>

      {active && (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <StatCard label="มูลค่าสัญญาช่วงรวม" value={baht(d?.subcontract_value ?? 0)} />
            <StatCard label="รับรองสะสม" value={baht(d?.certified_to_date ?? 0)} />
            <StatCard label="เงินประกันผลงานค้างจ่าย" value={baht(d?.retention_payable ?? 0)} />
          </div>

          <Card className="mb-5 gap-3 p-5">
            <h3 className="text-base font-semibold">สร้างสัญญาผู้รับเหมาช่วง ({active})</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="grid gap-1.5"><Label>ผู้รับเหมาช่วง</Label><Input value={f.vendor_name} onChange={(e) => setF({ ...f, vendor_name: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>รายการ BoQ (ขอบเขต)</Label>
                <select className={selectCls} value={f.boq_line_id} onChange={(e) => setF({ ...f, boq_line_id: e.target.value })}>
                  <option value="">— เลือกรายการ —</option>
                  {(boq.data?.lines ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.description ?? `#${l.line_no}`} · เหลือ {baht(l.remaining ?? l.budget_amount)}</option>)}
                </select>
              </div>
              <div className="grid gap-1.5"><Label>มูลค่า</Label><Input type="number" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>ประกันผลงาน %</Label><Input type="number" min="0" value={f.retention_pct} onChange={(e) => setF({ ...f, retention_pct: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>WHT %</Label><Input type="number" min="0" value={f.wht_pct} onChange={(e) => setF({ ...f, wht_pct: e.target.value })} /></div>
            </div>
            <div><Button onClick={() => create.mutate()} disabled={!f.boq_line_id || !f.amount || create.isPending}><Plus className="size-4" /> สร้างสัญญา</Button></div>
          </Card>

          <StateView q={subs}>{d && (
            <DataTable
              rows={d.subcontracts ?? []}
              rowKey={(r: any) => r.subcontract_no}
              columns={[
                { key: 'subcontract_no', label: 'เลขที่' },
                { key: 'vendor_name', label: 'ผู้รับเหมาช่วง' },
                { key: 'contract_value', label: 'มูลค่า', align: 'right', render: (r: any) => <span className="tabular">{baht(r.contract_value)}</span> },
                { key: 'certified_to_date', label: 'รับรองแล้ว', align: 'right', render: (r: any) => <span className="tabular">{baht(r.certified_to_date)}</span> },
                { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={r.status === 'active' ? 'default' : 'secondary'}>{r.status}</Badge> },
                { key: 'actions', label: '', align: 'right', render: (r: any) => (
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => { const pct = prompt('% แล้วเสร็จสะสมของสัญญาช่วง'); if (pct) raiseVal.mutate({ subNo: r.subcontract_no, pct: Number(pct) }); }}><FilePlus2 className="size-3.5" /> สร้างงวด</Button>
                    {vals[r.subcontract_no] && <Button size="sm" onClick={() => certifyVal.mutate(vals[r.subcontract_no]!)}><CheckCircle2 className="size-3.5" /> รับรอง {vals[r.subcontract_no]}</Button>}
                  </div>
                ) },
              ]}
            />
          )}</StateView>
        </>
      )}
    </div>
  );
}
